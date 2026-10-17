"""WebSocket: live ingestion progress + the graph streaming into the scene node-by-node.

Server → client events (all JSON with `type`, `workspace_id`, `ts`):
  hello, job_queued, job_started, progress, log, graph_stream_start, graph_batch, graph_ready, job_done, job_failed, pong
Client → server: {"type":"ping"} | {"type":"replay_graph"}  (re-stream the current graph to this client only)
"""
from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..config import settings
from ..events import hub
from ..ingest.pipeline import _viz_edge, _viz_node
from ..state import db, store

router = APIRouter()
log = logging.getLogger("nexmind.ws")


async def _replay_graph(ws: WebSocket, ws_id: str) -> None:
    wg = store.get(ws_id)
    nodes = sorted(wg.nodes.values(), key=lambda n: (n["type"] == "Process", -n.get("score", 0)))
    bs = max(10, settings.stream_batch_size)
    await ws.send_json({"type": "graph_stream_start", "nodes": len(nodes), "edges": len(wg.edges), "clusters": wg.clusters, "replay": True})
    sent: set[str] = set()
    pending = list(wg.edges.values())
    for i in range(0, len(nodes), bs):
        batch = nodes[i : i + bs]
        sent.update(n["id"] for n in batch)
        ready = [e for e in pending if e["src"] in sent and e["dst"] in sent]
        ids = {e["id"] for e in ready}
        pending = [e for e in pending if e["id"] not in ids]
        await ws.send_json({"type": "graph_batch", "nodes": [_viz_node(n) for n in batch], "edges": [_viz_edge(e) for e in ready], "replay": True})
        await asyncio.sleep(settings.stream_delay_s)
    await ws.send_json({"type": "graph_ready", "stats": {"nodes": len(nodes), "edges": len(wg.edges)}, "replay": True})


@router.websocket("/ws/workspaces/{ws_id}")
async def workspace_socket(ws: WebSocket, ws_id: str) -> None:
    row = db.one("SELECT id, status FROM workspaces WHERE id=?", (ws_id,))
    if not row:
        await ws.close(code=4404)
        return
    await ws.accept()
    q = hub.subscribe(ws_id)
    await ws.send_json({"type": "hello", "workspace_id": ws_id, "status": row["status"], "last_progress": hub.last_progress(ws_id)})

    async def pump() -> None:
        while True:
            ev = await q.get()
            await ws.send_json(ev)

    async def listen() -> None:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if msg.get("type") == "ping":
                await ws.send_json({"type": "pong"})
            elif msg.get("type") == "replay_graph":
                await _replay_graph(ws, ws_id)

    tasks = [asyncio.create_task(pump()), asyncio.create_task(listen())]
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in done:
            exc = t.exception()
            if exc and not isinstance(exc, (WebSocketDisconnect, asyncio.CancelledError)):
                log.debug("ws closed: %s", exc)
    finally:
        for t in tasks:
            t.cancel()
        hub.unsubscribe(ws_id, q)
