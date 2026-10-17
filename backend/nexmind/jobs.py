"""Background jobs: ingestion + graph build, with live progress pushed over WebSockets."""
from __future__ import annotations

import logging
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

from .db import DB, dumps, new_id, now
from .events import hub
from .graph.store import GraphStore
from .ingest.pipeline import build_workspace_graph, stream_graph

log = logging.getLogger("nexmind.jobs")


class JobManager:
    def __init__(self, db: DB, store: GraphStore):
        self.db = db
        self.store = store
        self.pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="nexmind-job")
        self._ws_locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()
        # jobs left "running" by a crash/restart can never finish
        self.db.execute("UPDATE jobs SET status='failed', error='Interrupted by server restart' WHERE status IN ('queued','running')")
        self.db.execute("UPDATE workspaces SET status='ready' WHERE status='building' AND EXISTS (SELECT 1 FROM nodes WHERE nodes.workspace_id=workspaces.id)")
        self.db.execute("UPDATE workspaces SET status='empty' WHERE status='building'")

    def _lock_for(self, ws_id: str) -> threading.Lock:
        with self._guard:
            return self._ws_locks.setdefault(ws_id, threading.Lock())

    def submit(self, ws_id: str, kind: str, prepare: list[Callable[[Callable[..., None]], None]] | None = None) -> str:
        job_id = new_id("job_")
        t = now()
        self.db.execute(
            "INSERT INTO jobs(id,workspace_id,kind,status,progress,phase,message,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
            (job_id, ws_id, kind, "queued", 0, "queued", "Waiting for a worker…", t, t),
        )
        self.db.execute("UPDATE workspaces SET status='building', updated_at=? WHERE id=?", (t, ws_id))
        hub.publish(ws_id, {"type": "job_queued", "job_id": job_id, "kind": kind})
        self.pool.submit(self._run, job_id, ws_id, kind, prepare or [])
        return job_id

    def _emit_factory(self, ws_id: str, job_id: str) -> Callable[..., None]:
        last_db = [0.0]

        def emit(type_: str, **kw) -> None:
            hub.publish(ws_id, {"type": type_, "job_id": job_id, **kw})
            if type_ == "progress":
                t = time.time()
                if t - last_db[0] > 0.4:
                    last_db[0] = t
                    self.db.execute(
                        "UPDATE jobs SET progress=?, phase=?, message=?, updated_at=? WHERE id=?",
                        (kw.get("percent", 0), kw.get("phase", ""), kw.get("message", ""), now(), job_id),
                    )

        return emit

    def _run(self, job_id: str, ws_id: str, kind: str, prepare: list) -> None:
        emit = self._emit_factory(ws_id, job_id)
        with self._lock_for(ws_id):
            self.db.execute("UPDATE jobs SET status='running', updated_at=? WHERE id=?", (now(), job_id))
            emit("job_started", kind=kind)
            try:
                for step in prepare:
                    step(emit)
                stats = build_workspace_graph(ws_id, self.db, self.store, emit)
                emit("progress", phase="stream", percent=97, message="Streaming graph to your screen…")
                if stats.get("nodes"):
                    stream_graph(ws_id, self.store, emit)
                self.db.execute(
                    "UPDATE jobs SET status='done', progress=100, phase='done', message='Graph ready', result=?, updated_at=? WHERE id=?",
                    (dumps(stats), now(), job_id),
                )
                if not stats.get("nodes"):
                    self.db.execute("UPDATE workspaces SET status='empty', stats='{}' WHERE id=?", (ws_id,))
                emit("progress", phase="done", percent=100, message="Graph ready")
                emit("job_done", stats=stats)
            except Exception as e:  # noqa: BLE001
                log.error("job %s failed: %s\n%s", job_id, e, traceback.format_exc())
                msg = str(e) or type(e).__name__
                self.db.execute("UPDATE jobs SET status='failed', error=?, updated_at=? WHERE id=?", (msg, now(), job_id))
                has_graph = self.db.one("SELECT 1 AS x FROM nodes WHERE workspace_id=? LIMIT 1", (ws_id,))
                self.db.execute("UPDATE workspaces SET status=? WHERE id=?", ("ready" if has_graph else "error", ws_id))
                emit("job_failed", error=msg)
