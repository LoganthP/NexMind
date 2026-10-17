"""Tiny SQLite wrapper. Everything NexMind stores (workspaces, graph, chunks, chats, jobs) lives here."""
from __future__ import annotations

import json
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
  kind TEXT DEFAULT 'code'
);
CREATE TABLE IF NOT EXISTS sources(
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT, kind TEXT, origin TEXT,
  path TEXT, size INTEGER DEFAULT 0, file_count INTEGER DEFAULT 0, created_at REAL,
  watch INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sources_ws ON sources(workspace_id);
CREATE TABLE IF NOT EXISTS nodes(
  workspace_id TEXT NOT NULL, id TEXT NOT NULL, type TEXT, label TEXT, props TEXT,
  x REAL, y REAL, z REAL, cluster INTEGER DEFAULT 0, score REAL DEFAULT 0,
  PRIMARY KEY(workspace_id, id)
);
CREATE TABLE IF NOT EXISTS edges(
  workspace_id TEXT NOT NULL, id TEXT NOT NULL, src TEXT, dst TEXT, type TEXT,
  weight REAL DEFAULT 1, props TEXT, PRIMARY KEY(workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_edges_ws ON edges(workspace_id);
CREATE TABLE IF NOT EXISTS chunks(
  workspace_id TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT, node_id TEXT, kind TEXT,
  text TEXT, meta TEXT, PRIMARY KEY(workspace_id, id)
);
CREATE TABLE IF NOT EXISTS clusters(
  workspace_id TEXT NOT NULL, id INTEGER NOT NULL, label TEXT, size INTEGER, color TEXT,
  summary TEXT, PRIMARY KEY(workspace_id, id)
);
CREATE TABLE IF NOT EXISTS insights(
  workspace_id TEXT PRIMARY KEY, data TEXT
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
  created_at REAL, updated_at REAL
);
CREATE INDEX IF NOT EXISTS idx_jobs_ws ON jobs(workspace_id);
"""


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


class DB:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._local = threading.local()
        with self.tx() as c:
            c.executescript(SCHEMA)
            try:
                c.execute("ALTER TABLE workspaces ADD COLUMN kind TEXT DEFAULT 'code'")
            except Exception:
                pass
            try:
                c.execute("ALTER TABLE sources ADD COLUMN watch INTEGER DEFAULT 0")
            except Exception:
                pass

    def _get_conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(str(self.path), timeout=30, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA busy_timeout=10000")
            conn.execute("PRAGMA cache_size=-64000")
            self._local.conn = conn
        return conn

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            conn = self._get_conn()
            try:
                yield conn
                conn.commit()
            except Exception:
                conn.rollback()
                raise

    def close(self) -> None:
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
            self._local.conn = None

    def query(self, sql: str, params: Iterable[Any] = ()) -> list[dict]:
        with self.tx() as c:
            return [dict(r) for r in c.execute(sql, tuple(params)).fetchall()]

    def one(self, sql: str, params: Iterable[Any] = ()) -> dict | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    def execute(self, sql: str, params: Iterable[Any] = ()) -> None:
        with self.tx() as c:
            c.execute(sql, tuple(params))
