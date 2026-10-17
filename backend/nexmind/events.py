"""Real-time event hub.

Background jobs run in worker threads; WebSocket clients live on the asyncio loop. This hub bridges them:
`publish()` is safe to call from any thread, `subscribe()` returns an asyncio.Queue for a WebSocket handler.
"""
from __future__ import annotations

import asyncio
import threading
import time
from collections import defaultdict
from typing import Any


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
