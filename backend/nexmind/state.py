"""Process-wide singletons (database, stores, job manager)."""
from __future__ import annotations

from .config import settings
from .db import DB
from .events import EventLog
from .graph.store import GraphStore
from .jobs import JobManager
from .storage import FileStore

settings.ensure_dirs()
db = DB(settings.db_path)
store = GraphStore(db)
files = FileStore(db)
events = EventLog(db)
jobs = JobManager(db, store, files, events)
