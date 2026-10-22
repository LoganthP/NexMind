"""Graph-build jobs that work on serverless platforms.

A job is a database row. It runs synchronously inside whichever request claims it
(POST /api/jobs/{id}/run, called by the browser or the connect command), streaming its events while
also writing them to the event log so other viewers can follow along by polling.
In local mode (`settings.background_jobs`), jobs additionally start immediately on a worker thread.
"""
from __future__ import annotations

import logging
import queue
import tempfile
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Iterator

from .config import settings
from .db import DB, dumps, now, new_id
from .events import EventLog
from .graph.store import GraphStore
from .ingest.pipeline import build_workspace_graph
from .storage import FileStore, remove_tree

log = logging.getLogger("nexmind.jobs")
_DONE = object()


class JobBusy(Exception):
    """The job is already running elsewhere, finished, or another build of the workspace is running."""


class JobManager:
    def __init__(self, db: DB, store: GraphStore, files: FileStore, events: EventLog):
        self.db = db
        self.store = store
        self.files = files
        self.events = events
        self.pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="nexmind-job") if settings.background_jobs else None
        if settings.background_jobs:
            # single local process: anything left "running" by a crash can never finish
            self.db.execute("UPDATE jobs SET status='failed', error='Interrupted by server restart' WHERE status IN ('queued','running')")
            for w in self.db.query("SELECT id FROM workspaces WHERE status='building'"):
                self.db.execute("UPDATE workspaces SET status=? WHERE id=?", ("ready" if self.store.has_graph(w["id"]) else "empty", w["id"]))

    # ------------------------------------------------------------------ queue
    def submit(self, ws_id: str, kind: str) -> str:
        job_id = new_id("job_")
        t = now()
        # an older job that never started is superseded by this one (it would build the same sources)
        # a job that has not started yet is covered by this newer one (it builds the same sources)
        self.db.execute("UPDATE jobs SET status='done', phase='superseded', progress=100, message='Merged into a newer build', "
                        "result=?, updated_at=? WHERE workspace_id=? AND status='queued'", (dumps({"superseded_by": job_id}), t, ws_id))
        self.db.execute(
            "INSERT INTO jobs(id,workspace_id,kind,status,progress,phase,message,created_at,updated_at,heartbeat) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (job_id, ws_id, kind, "queued", 0, "queued", "Waiting to start…", t, t, 0),
        )
        self.db.execute("UPDATE workspaces SET status='building', updated_at=? WHERE id=?", (t, ws_id))
        self.events.prune(ws_id)
        self.events.add(ws_id, "job_queued", job_id, kind=kind)
        if self.pool is not None:
            self.pool.submit(self._consume, job_id)
        return job_id

    def _consume(self, job_id: str) -> None:
        """Local background worker: wait while another build of the same workspace is running."""
        deadline = time.time() + settings.job_stale_s * 2
        while time.time() < deadline:
            try:
                for _ in self.run(job_id):
                    pass
                return
            except JobBusy:
                row = self.db.one("SELECT status FROM jobs WHERE id=?", (job_id,))
                if not row or row["status"] != "queued":
                    return
                time.sleep(0.5)
            except Exception:  # noqa: BLE001
                log.exception("background job %s crashed", job_id)
                return

    def claim(self, job_id: str) -> dict:
        t = now()
        stale = t - settings.job_stale_s
        n = self.db.execute(
            "UPDATE jobs SET status='running', heartbeat=?, updated_at=?, error=NULL "
            "WHERE id=? AND (status='queued' OR (status='running' AND heartbeat<?)) "
            "AND NOT EXISTS (SELECT 1 FROM jobs j2 WHERE j2.workspace_id=jobs.workspace_id AND j2.id<>jobs.id "
            "AND j2.status='running' AND j2.heartbeat>=?)",
            (t, t, job_id, stale, stale),
        )
        job = self.db.one("SELECT * FROM jobs WHERE id=?", (job_id,))
        if not job:
            raise KeyError(job_id)
        if n != 1:
            raise JobBusy(job["status"])
        return job

    # ------------------------------------------------------------------ run (streams events)
    def run(self, job_id: str) -> Iterator[dict]:
        job = self.claim(job_id)
        q: "queue.Queue" = queue.Queue()
        th = threading.Thread(target=self._execute, args=(job, q), name=f"build-{job_id}", daemon=True)
        th.start()
        while True:
            item = q.get()
            if item is _DONE:
                break
            yield item
        th.join(timeout=5)

    def _execute(self, job: dict, q: "queue.Queue") -> None:
        job_id, ws_id = job["id"], job["workspace_id"]
        last = {"progress": 0.0, "beat": 0.0}

        def emit(type_: str, **kw) -> None:
            if type_ in ("graph_stream_start", "graph_batch", "graph_ready"):
                return  # browsers fetch the finished graph over HTTP instead
            t = time.time()
            if type_ == "progress":
                if t - last["progress"] < 0.35 and kw.get("percent", 0) < 100:
                    q.put({"type": type_, "job_id": job_id, "workspace_id": ws_id, "seq": 0, **kw})
                    return
                last["progress"] = t
                self.db.execute("UPDATE jobs SET progress=?, phase=?, message=?, updated_at=?, heartbeat=? WHERE id=?",
                                (kw.get("percent", 0), kw.get("phase", ""), kw.get("message", ""), t, t, job_id))
                last["beat"] = t
            elif t - last["beat"] > 5:
                self.db.execute("UPDATE jobs SET heartbeat=? WHERE id=?", (t, job_id))
                last["beat"] = t
            q.put(self.events.add(ws_id, type_, job_id, **kw))

        workdir = Path(tempfile.mkdtemp(prefix=f"nexmind-{job_id}-", dir=str(settings.data_dir) if settings.data_dir.exists() else None))
        try:
            emit("job_started", kind=job["kind"])
            emit("progress", phase="scan", percent=1, message="Preparing files…")
            roots: dict[str, Path] = {}
            for src in self.db.query("SELECT * FROM sources WHERE workspace_id=? ORDER BY created_at", (ws_id,)):
                if src.get("stored"):
                    dest = workdir / src["id"]
                    self.files.materialize(src["id"], dest)
                    roots[src["id"]] = dest
                elif src.get("path"):
                    roots[src["id"]] = Path(src["path"])
            stats = build_workspace_graph(ws_id, self.db, self.store, emit, roots=roots)
            self.db.execute("UPDATE jobs SET status='done', progress=100, phase='done', message='Graph ready', result=?, updated_at=? WHERE id=?",
                            (dumps(stats), now(), job_id))
            if not stats.get("nodes"):
                self.db.execute("UPDATE workspaces SET status='empty', stats='{}' WHERE id=?", (ws_id,))
            emit("progress", phase="done", percent=100, message="Graph ready")
            emit("job_done", stats=stats)
        except Exception as e:  # noqa: BLE001
            log.error("job %s failed: %s\n%s", job_id, e, traceback.format_exc())
            msg = str(e) or type(e).__name__
            self.db.execute("UPDATE jobs SET status='failed', error=?, updated_at=? WHERE id=?", (msg, now(), job_id))
            self.db.execute("UPDATE workspaces SET status=? WHERE id=?", ("ready" if self.store.has_graph(ws_id) else "error", ws_id))
            emit("job_failed", error=msg)
        finally:
            remove_tree(workdir)
            q.put(_DONE)

    def run_to_end(self, job_id: str) -> dict:
        """Run synchronously and return the final job row (used by tests and the CLI path)."""
        for _ in self.run(job_id):
            pass
        return self.db.one("SELECT * FROM jobs WHERE id=?", (job_id,)) or {}

    def pending_for(self, ws_id: str) -> dict | None:
        stale = now() - settings.job_stale_s
        return self.db.one(
            "SELECT * FROM jobs WHERE workspace_id=? AND (status='queued' OR (status='running' AND heartbeat<?)) ORDER BY created_at DESC LIMIT 1",
            (ws_id, stale),
        )
