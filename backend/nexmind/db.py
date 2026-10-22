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


def database_url() -> str | None:
    for key in ("NEXMIND_DATABASE_URL", "DATABASE_URL", "POSTGRES_URL"):
        v = os.environ.get(key)
        if v and v.startswith(("postgres://", "postgresql://")):
            return v
    return None


def _fix_row(r: Any) -> dict:
    d = dict(r)
    for k, v in d.items():
        if isinstance(v, memoryview):
            d[k] = bytes(v)
    return d


class _Cursor:
    def __init__(self, cur: Any):
        self._cur = cur

    @property
    def rowcount(self) -> int:
        return self._cur.rowcount

    def fetchall(self) -> list[dict]:
        if self._cur.description is None:
            return []
        return [_fix_row(r) for r in self._cur.fetchall()]

    def fetchone(self) -> dict | None:
        if self._cur.description is None:
            return None
        r = self._cur.fetchone()
        return _fix_row(r) if r is not None else None


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
    def __init__(self, path: Path | None = None, url: str | None = None):
        self.url = url if url is not None else database_url()
        self.dialect = "postgres" if self.url else "sqlite"
        self.path = Path(path) if path else None
        self._lock = threading.RLock()
        self._pg: Any = None
        if self.dialect == "sqlite":
            if self.path is None:
                raise ValueError("SQLite needs a file path")
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

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
        import psycopg
        from psycopg.rows import dict_row

        if self._pg is None or self._pg.closed or self._pg.broken:
            # prepare_threshold=None keeps it compatible with PgBouncer / Neon pooled endpoints
            self._pg = psycopg.connect(self.url, row_factory=dict_row, prepare_threshold=None, connect_timeout=15)
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
            if self.dialect == "postgres" and type(e).__name__ in {"OperationalError", "InterfaceError"}:
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
