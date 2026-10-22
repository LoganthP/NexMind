"""Event log: job progress and workspace events, stored in the database.

Replaces WebSockets (not available on Vercel). Browsers poll GET /api/workspaces/{id}/events?after=<seq>;
the request that runs a job also streams the same events directly.
"""
from __future__ import annotations

import asyncio
import threading
import time
from collections import defaultdict
from typing import Any

from .db import DB, dumps, loads


class EventHub:
    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._subs: dict[str, set[asyncio.Queue]] = defaultdict(set)
        self._last_progress: dict[str, dict] = {}
        self._lock = threading.Lock()

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self, workspace_id: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=2000)
        with self._lock:
            self._subs[workspace_id].add(q)
        return q

    def unsubscribe(self, workspace_id: str, q: asyncio.Queue) -> None:
        with self._lock:
            self._subs[workspace_id].discard(q)

    def last_progress(self, workspace_id: str) -> dict | None:
        return self._last_progress.get(workspace_id)

    def publish(self, workspace_id: str, event: dict[str, Any]) -> None:
        event = {"ts": time.time(), "workspace_id": workspace_id, **event}
        if event.get("type") == "progress":
            self._last_progress[workspace_id] = event
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(self._dispatch, workspace_id, event)
        except RuntimeError:  # loop closed during shutdown
            pass

    def _dispatch(self, workspace_id: str, event: dict) -> None:
        with self._lock:
            queues = list(self._subs.get(workspace_id, ()))
        for q in queues:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:  # slow consumer: drop rather than block the pipeline
                pass


hub = EventHub()


class EventLog:
    KEEP = 400

    def __init__(self, db: DB):
        self.db = db

    def add(self, ws_id: str, type_: str, job_id: str | None = None, **data: Any) -> dict:
        ev = {"type": type_, "job_id": job_id, **data}
        t = time.time()
        rows = self.db.run(lambda c: c.execute(
            "INSERT INTO events(workspace_id, job_id, type, data, ts) VALUES(?,?,?,?,?) RETURNING id",
            (ws_id, job_id, type_, dumps(data), t),
        ).fetchall())
        ev["seq"] = rows[0]["id"] if rows else 0
        ev["ts"] = t
        ev["workspace_id"] = ws_id
        hub.publish(ws_id, ev)
        return ev

    def since(self, ws_id: str, after: int = 0, limit: int = 300) -> list[dict]:
        rows = self.db.query(
            "SELECT id, job_id, type, data, ts FROM events WHERE workspace_id=? AND id>? ORDER BY id LIMIT ?",
            (ws_id, int(after), int(limit)),
        )
        return [{"seq": r["id"], "type": r["type"], "job_id": r["job_id"], "ts": r["ts"], "workspace_id": ws_id, **loads(r["data"], {})} for r in rows]

    def latest_seq(self, ws_id: str) -> int:
        r = self.db.one("SELECT MAX(id) AS m FROM events WHERE workspace_id=?", (ws_id,))
        return int(r["m"] or 0) if r else 0

    def prune(self, ws_id: str) -> None:
        last = self.latest_seq(ws_id)
        if last > self.KEEP:
            self.db.execute("DELETE FROM events WHERE workspace_id=? AND id<=?", (ws_id, last - self.KEEP))

    def delete_workspace(self, ws_id: str) -> None:
        self.db.execute("DELETE FROM events WHERE workspace_id=?", (ws_id,))
