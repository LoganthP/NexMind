"""Process-wide singletons (database, graph store, job manager)."""
from __future__ import annotations

from .config import settings
from .db import DB
from .graph.store import GraphStore
from .jobs import JobManager

settings.ensure_dirs()
db = DB(settings.db_path)
store = GraphStore(db)
jobs = JobManager(db, store)
