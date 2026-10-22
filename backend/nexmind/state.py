"""Process-wide singletons (database, stores, job manager) with lazy initialization."""
from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any

from .config import settings
from .db import DB, find_database_url, format_db_error
from .events import EventLog
from .graph.store import GraphStore
from .jobs import JobManager
from .storage import FileStore

log = logging.getLogger("nexmind")

_lock = threading.RLock()

_db: DB | None = None
_store: GraphStore | None = None
_files: FileStore | None = None
_events: EventLog | None = None
_jobs: JobManager | None = None

_last_error: Exception | None = None
_last_error_sentence: str | None = None
_last_check_time: float = 0.0
_last_log_time: float = 0.0
_last_url: str | None = None
_last_env_var: str | None = None


def get_db_status(force: bool = False) -> tuple[bool, str | None, str | None, bool]:
    """Check database status, initializing lazily with error caching (at most every 10s).

    Returns:
        (ok: bool, error_sentence: str | None, env_var: str | None, configured: bool)
    """
    global _db, _store, _files, _events, _jobs
    global _last_error, _last_error_sentence, _last_check_time, _last_log_time, _last_url, _last_env_var

    with _lock:
        url, env_var = find_database_url()
        now = time.time()

        # If DATABASE_URL or env var changed in environment, force re-evaluation
        if url != _last_url or env_var != _last_env_var:
            force = True

        # If already initialized and OK, and URL hasn't changed
        if _db is not None and _last_error is None and not force:
            return True, None, env_var, True

        # If we failed recently (< 10s ago) and not forced
        if _last_error_sentence is not None and not force and (now - _last_check_time < 10.0):
            configured = bool(url) or (not settings.hosted)
            return False, _last_error_sentence, env_var, configured

        _last_check_time = now
        _last_url = url
        _last_env_var = env_var

        # If hosted and no database URL configured
        if settings.hosted and not url and os.environ.get("NEXMIND_ALLOW_EPHEMERAL") != "1":
            _db = None
            _store = None
            _files = None
            _events = None
            _jobs = None
            _last_error = None
            _last_error_sentence = (
                "Storage is not set up yet. In Vercel open Storage, add a Postgres database (Neon), "
                "connect it to this project, then redeploy."
            )
            return False, _last_error_sentence, None, False

        # Attempt to create DB and ensure schema
        settings.ensure_dirs()
        try:
            db_inst = DB(settings.db_path, url=url, lazy=True)
            db_inst.ensure_schema()

            _db = db_inst
            _store = GraphStore(_db)
            _files = FileStore(_db)
            _events = EventLog(_db)
            _jobs = JobManager(_db, _store, _files, _events)

            _last_error = None
            _last_error_sentence = None
            return True, None, env_var, True
        except Exception as e:
            _db = None
            _store = None
            _files = None
            _events = None
            _jobs = None
            _last_error = e
            _last_error_sentence = format_db_error(e)

            # Log the full exception once per minute to the Vercel runtime log
            if now - _last_log_time >= 60.0:
                _last_log_time = now
                log.exception("Database connection failed (%s, env_var=%s): %s", _last_error_sentence, env_var, e)

            configured = bool(url) or (not settings.hosted)
            return False, _last_error_sentence, env_var, configured


def get_db() -> DB:
    ok, err, _, _ = get_db_status()
    if not ok:
        raise RuntimeError(err or "Database unavailable")
    assert _db is not None
    return _db


def get_store() -> GraphStore:
    get_db()
    assert _store is not None
    return _store


def get_files() -> FileStore:
    get_db()
    assert _files is not None
    return _files


def get_events() -> EventLog:
    get_db()
    assert _events is not None
    return _events


def get_jobs() -> JobManager:
    get_db()
    assert _jobs is not None
    return _jobs


class _LazyProxy:
    """Transparent proxy that delegates attributes to a lazily initialized target."""

    def __init__(self, getter: Any, fallback_attrs: dict[str, Any] | None = None):
        self._getter = getter
        self._fallback_attrs = fallback_attrs or {}

    def __getattr__(self, name: str) -> Any:
        try:
            target = self._getter()
            return getattr(target, name)
        except Exception:
            if name in self._fallback_attrs:
                val = self._fallback_attrs[name]
                return val() if callable(val) else val
            raise

    def __bool__(self) -> bool:
        return True


def _fallback_dialect() -> str:
    url, _ = find_database_url()
    return "postgres" if url else "sqlite"


def _fallback_persistent() -> bool:
    url, _ = find_database_url()
    return bool(url)


db: Any = _LazyProxy(get_db, {"dialect": _fallback_dialect, "persistent": _fallback_persistent})
store: Any = _LazyProxy(get_store)
files: Any = _LazyProxy(get_files)
events: Any = _LazyProxy(get_events)
jobs: Any = _LazyProxy(get_jobs)
