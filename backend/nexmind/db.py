"""Database layer: SQLite locally, Postgres (Neon / Vercel Postgres) when DATABASE_URL is set.

All SQL in the app is written once with `?` placeholders; this module adapts it to the active dialect.
Serverless-friendly: no background threads, short transactions, one reusable connection per instance.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS workspaces(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  created_at REAL, updated_at REAL, status TEXT DEFAULT 'empty', stats TEXT DEFAULT '{}',
  kind TEXT DEFAULT 'code', owner TEXT
);
CREATE TABLE IF NOT EXISTS sources(
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT, kind TEXT, origin TEXT,
  path TEXT, size BIGINT DEFAULT 0, file_count INTEGER DEFAULT 0, created_at REAL,
  watch INTEGER DEFAULT 0, stored INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sources_ws ON sources(workspace_id);
CREATE TABLE IF NOT EXISTS files(
  source_id TEXT NOT NULL, path TEXT NOT NULL, workspace_id TEXT NOT NULL, size BIGINT DEFAULT 0, data BLOB, sha1 TEXT,
  PRIMARY KEY(source_id, path)
);
CREATE INDEX IF NOT EXISTS idx_files_ws ON files(workspace_id);
CREATE TABLE IF NOT EXISTS graphs(
  workspace_id TEXT PRIMARY KEY, version TEXT, data BLOB, updated_at REAL
);
CREATE TABLE IF NOT EXISTS threads(
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT, created_at REAL, updated_at REAL
);
CREATE INDEX IF NOT EXISTS idx_threads_ws ON threads(workspace_id);
CREATE TABLE IF NOT EXISTS messages(
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT, content TEXT, meta TEXT, created_at REAL
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE TABLE IF NOT EXISTS jobs(
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT, status TEXT, progress REAL DEFAULT 0,
  phase TEXT DEFAULT '', message TEXT DEFAULT '', error TEXT, result TEXT,
  created_at REAL, updated_at REAL, heartbeat REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jobs_ws ON jobs(workspace_id);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, job_id TEXT, type TEXT, data TEXT, ts REAL
);
CREATE INDEX IF NOT EXISTS idx_events_ws ON events(workspace_id, id);
CREATE TABLE IF NOT EXISTS uploads(
  id TEXT PRIMARY KEY, owner TEXT, name TEXT, size BIGINT DEFAULT 0, received BIGINT DEFAULT 0,
  chunks INTEGER DEFAULT 0, created_at REAL
);
CREATE TABLE IF NOT EXISTS upload_chunks(
  upload_id TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB, PRIMARY KEY(upload_id, idx)
);
CREATE TABLE IF NOT EXISTS connect_sessions(
  id TEXT PRIMARY KEY, owner TEXT, workspace_id TEXT, name TEXT, path TEXT, job_id TEXT,
  created_at REAL, reused INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_connect_owner ON connect_sessions(owner, created_at)
"""

# columns added after the first release; added to older databases on start
MIGRATIONS = [
    ("workspaces", "kind", "TEXT DEFAULT 'code'"),
    ("workspaces", "owner", "TEXT"),
    ("sources", "watch", "INTEGER DEFAULT 0"),
    ("sources", "stored", "INTEGER DEFAULT 0"),
    ("jobs", "heartbeat", "REAL DEFAULT 0"),
    ("files", "sha1", "TEXT"),
]
POST_MIGRATION = ["CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner)"]


def new_id(prefix: str = "") -> str:
    return f"{prefix}{uuid.uuid4().hex[:12]}"


def now() -> float:
    return time.time()


def dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, default=str)


def loads(s: str | None, default: Any = None) -> Any:
    if not s:
        return default
    try:
        return json.loads(s)
    except Exception:
        return default


KNOWN_DB_ENV_VARS = (
    "NEXMIND_DATABASE_URL",
    "DATABASE_URL",
    "POSTGRES_URL",
    "POSTGRES_PRISMA_URL",
    "DATABASE_URL_UNPOOLED",
)


def find_database_url() -> tuple[str | None, str | None]:
    """Find the best database URL and the name of the environment variable providing it.

    Accepts: NEXMIND_DATABASE_URL, DATABASE_URL, POSTGRES_URL, POSTGRES_PRISMA_URL,
    DATABASE_URL_UNPOOLED, plus any variable ending in _DATABASE_URL or _POSTGRES_URL.
    Prefers pooled URLs (host containing '-pooler').
    """
    candidates: list[tuple[str, str]] = []

    for k in KNOWN_DB_ENV_VARS:
        v = os.environ.get(k)
        if v and v.startswith(("postgres://", "postgresql://")):
            candidates.append((k, v))

    for k, v in os.environ.items():
        if k in KNOWN_DB_ENV_VARS:
            continue
        if k.endswith(("_DATABASE_URL", "_POSTGRES_URL")):
            if v and v.startswith(("postgres://", "postgresql://")):
                candidates.append((k, v))

    if not candidates:
        return None, None

    for k, v in candidates:
        if "-pooler" in v:
            return v, k

    return candidates[0][1], candidates[0][0]


def database_url() -> str | None:
    return find_database_url()[0]


def sanitize_credentials(text: str) -> str:
    """Remove passwords and sensitive credentials from connection strings and error messages."""
    if not text:
        return text
    import re

    s = re.sub(r"(postgres(?:ql)?://[^:]+:)([^@]+)(@)", r"\1***\3", text)
    s = re.sub(r"(password=)'[^']*'", r"\1'***'", s, flags=re.IGNORECASE)
    s = re.sub(r"(password=)[^\s;]+", r"\1***", s, flags=re.IGNORECASE)
    return s


def format_db_error(e: Exception) -> str:
    """Map common database connection errors to plain human sentences."""
    msg = str(e) or ""
    cls_name = type(e).__name__
    lower_msg = msg.lower()

    if "password authentication failed" in lower_msg or "authentication failed" in lower_msg:
        return "Database password rejected: reconnect Neon in Vercel Storage and redeploy"

    if (
        "could not translate host name" in lower_msg
        or "name or service not known" in lower_msg
        or "connection timed out" in lower_msg
        or "timeout" in lower_msg
        or "connection refused" in lower_msg
        or "network is unreachable" in lower_msg
        or "getaddrinfo failed" in lower_msg
    ):
        return "Database unreachable: check DATABASE_URL"

    first_line = msg.strip().splitlines()[0] if msg.strip() else ""
    sanitized = sanitize_credentials(first_line)
    if sanitized:
        return f"{cls_name}: {sanitized}"
    return cls_name


def connect_postgres(url: str) -> Any:
    """Open a Postgres connection with pg8000 (pure Python, so it always installs on Vercel).

    Understands Neon/Vercel URLs: postgres(ql)://user:pass@host[:port]/db?sslmode=require&channel_binding=...&options=...
    """
    import ssl
    from urllib.parse import parse_qs, unquote, urlparse

    import pg8000.dbapi

    u = urlparse(url)
    q = {k: v[-1] for k, v in parse_qs(u.query).items()}
    host = u.hostname or "localhost"
    local = host in ("localhost", "127.0.0.1", "::1") or host.startswith("/")
    sslmode = (q.get("sslmode") or ("disable" if local else "require")).lower()
    kwargs: dict[str, Any] = {
        "user": unquote(u.username or ""),
        "password": unquote(u.password or "") or None,
        "host": host,
        "port": u.port or 5432,
        "database": unquote((u.path or "/").lstrip("/")) or None,
        "timeout": 20,
        "application_name": "nexmind",
    }
    if "host" in q and q["host"].startswith("/"):  # unix socket (local test servers)
        kwargs.pop("host")
        kwargs.pop("port")
        kwargs["unix_sock"] = q["host"].rstrip("/") + f"/.s.PGSQL.{u.port or 5432}"
    if sslmode not in ("disable", "allow", "prefer"):
        ctx = ssl.create_default_context()
        if sslmode in ("require", "allow", "prefer"):  # encrypted but no CA check, like libpq's 'require'
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        kwargs["ssl_context"] = ctx
    if q.get("options"):
        kwargs["startup_params"] = {"options": q["options"]}
    try:
        return pg8000.dbapi.connect(**kwargs)
    except TypeError:  # very old pg8000 without startup_params
        kwargs.pop("startup_params", None)
        return pg8000.dbapi.connect(**kwargs)


def _fix_row(r: Any, names: list[str] | None = None) -> dict:
    # sqlite3.Row behaves like a mapping; pg8000 returns plain lists (names come from cursor.description)
    d = dict(zip(names, r)) if names is not None and not hasattr(r, "keys") else dict(r)
    for k, v in d.items():
        if isinstance(v, (memoryview, bytearray)):
            d[k] = bytes(v)
    return d


class _Cursor:
    def __init__(self, cur: Any):
        self._cur = cur

    def _names(self) -> list[str]:
        return [c[0] for c in (self._cur.description or [])]

    @property
    def rowcount(self) -> int:
        return self._cur.rowcount

    def fetchall(self) -> list[dict]:
        if self._cur.description is None:
            return []
        names = self._names()
        return [_fix_row(r, names) for r in self._cur.fetchall()]

    def fetchone(self) -> dict | None:
        if self._cur.description is None:
            return None
        r = self._cur.fetchone()
        return _fix_row(r, self._names()) if r is not None else None


class _Tx:
    def __init__(self, conn: Any, dialect: str):
        self.conn = conn
        self.dialect = dialect

    def _sql(self, sql: str) -> str:
        if self.dialect == "postgres":
            return sql.replace("%", "%%").replace("?", "%s")
        return sql

    def execute(self, sql: str, params: Iterable[Any] = ()) -> _Cursor:
        cur = self.conn.cursor()
        cur.execute(self._sql(sql), tuple(params))
        return _Cursor(cur)

    def executemany(self, sql: str, rows: Iterable[Iterable[Any]]) -> None:
        rows = [tuple(r) for r in rows]
        if rows:
            self.conn.cursor().executemany(self._sql(sql), rows)


class DB:
    def __init__(self, path: Path | None = None, url: str | None = None, lazy: bool = False):
        self.url = url if url is not None else database_url()
        self.dialect = "postgres" if self.url else "sqlite"
        self.path = Path(path) if path else None
        self._lock = threading.RLock()
        self._pg: Any = None
        self._schema_initialized = False
        if self.dialect == "sqlite":
            if self.path is None:
                raise ValueError("SQLite needs a file path")
            self.path.parent.mkdir(parents=True, exist_ok=True)
        if not lazy:
            self.ensure_schema()

    def ensure_schema(self) -> None:
        with self._lock:
            if not self._schema_initialized:
                self._init_schema()
                self._schema_initialized = True

    @property
    def persistent(self) -> bool:
        return self.dialect == "postgres"

    # ------------------------------------------------------------------ connections
    def _sqlite(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.path), timeout=30, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    def _postgres(self) -> Any:
        if self._pg is None:
            self._pg = connect_postgres(self.url or "")
        return self._pg

    @contextmanager
    def tx(self) -> Iterator[_Tx]:
        with self._lock:
            if self.dialect == "sqlite":
                conn = self._sqlite()
                try:
                    yield _Tx(conn, "sqlite")
                    conn.commit()
                except Exception:
                    conn.rollback()
                    raise
                finally:
                    conn.close()
            else:
                conn = self._postgres()
                try:
                    yield _Tx(conn, "postgres")
                    conn.commit()
                except Exception:
                    try:
                        conn.rollback()
                    except Exception:
                        self._pg = None
                    raise

    def _run(self, fn):
        try:
            with self.tx() as t:
                return fn(t)
        except Exception as e:
            if self.dialect == "postgres" and (type(e).__name__ in {"OperationalError", "InterfaceError"} or isinstance(e, (ConnectionError, OSError))):
                self._pg = None  # stale serverless connection: reconnect once and retry the whole transaction
                with self.tx() as t:
                    return fn(t)
            raise

    def query(self, sql: str, params: Iterable[Any] = ()) -> list[dict]:
        return self._run(lambda t: t.execute(sql, params).fetchall())

    def one(self, sql: str, params: Iterable[Any] = ()) -> dict | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    def execute(self, sql: str, params: Iterable[Any] = ()) -> int:
        return self._run(lambda t: t.execute(sql, params).rowcount)

    def executemany(self, sql: str, rows: Iterable[Iterable[Any]]) -> None:
        rows = list(rows)
        self._run(lambda t: t.executemany(sql, rows))

    def run(self, fn):
        """Run fn(tx) inside one transaction (retried once on a dropped connection)."""
        return self._run(fn)

    # ------------------------------------------------------------------ schema
    def _ddl(self) -> list[str]:
        sql = SCHEMA
        if self.dialect == "postgres":
            sql = (sql.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "BIGSERIAL PRIMARY KEY")
                      .replace(" REAL", " DOUBLE PRECISION").replace(" BLOB", " BYTEA"))
        return [s.strip() for s in sql.split(";") if s.strip()]

    def _init_schema(self) -> None:
        def create(t: _Tx) -> None:
            for stmt in self._ddl():
                t.execute(stmt)
        self._run(create)
        for table, col, typ in MIGRATIONS:
            if self.dialect == "postgres":
                self.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {col} {typ.replace('REAL', 'DOUBLE PRECISION')}")
            else:
                try:
                    self.execute(f"ALTER TABLE {table} ADD COLUMN {col} {typ}")
                except sqlite3.OperationalError:
                    pass  # column already exists
        for stmt in POST_MIGRATION:
            self.execute(stmt)

    def table_exists(self, name: str) -> bool:
        if self.dialect == "postgres":
            return bool(self.one("SELECT 1 AS x FROM information_schema.tables WHERE table_name=?", (name,)))
        return bool(self.one("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?", (name,)))
