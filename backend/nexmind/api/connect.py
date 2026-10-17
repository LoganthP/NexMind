"""Live connect endpoints for CLI and editor extensions."""
from __future__ import annotations

import os
from pathlib import Path
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..db import new_id, now
from ..state import db, jobs
from .workspaces import _register_source, get_ws, require_local, ws_dir
from ..config import settings
from ..watcher import watcher

router = APIRouter(prefix="/api", tags=["connect"])

_sessions: list[dict] = []


class ConnectIn(BaseModel):
    path: str
    name: str | None = None
    watch: bool = True


class WatchIn(BaseModel):
    enabled: bool = True


@router.post("/connect")
def connect_local(body: ConnectIn, request: Request) -> dict:
    require_local(request)

    p = Path(body.path.strip().strip('"')).expanduser()
    try:
        p = p.resolve()
    except OSError as e:
        raise HTTPException(400, f"Invalid path: {e}") from e

    if not p.exists() or not p.is_dir():
        raise HTTPException(400, f"Folder not found: {p}")

    if p == Path(p.anchor):
        raise HTTPException(400, "Choose a project folder, not a drive root")

    ws_name = body.name.strip() if body.name and body.name.strip() else (p.name or str(p))
    watch_val = 1 if body.watch else 0

    # Try to find existing live workspace for this resolved path
    existing = db.one(
        "SELECT w.* FROM workspaces w JOIN sources s ON s.workspace_id = w.id WHERE w.kind='live' AND s.path=? LIMIT 1",
        (str(p),)
    )

    if existing:
        ws_id = existing["id"]
        source = db.one("SELECT id FROM sources WHERE workspace_id=? AND path=?", (ws_id, str(p)))
        if source:
            db.execute("UPDATE sources SET watch=? WHERE id=?", (watch_val, source["id"]))
            if watch_val:
                watcher.register_source(source["id"], p)
            else:
                watcher.unregister_source(source["id"])
        job_id = jobs.submit(ws_id, "rebuild")
        reused = True
        final_name = existing["name"]
    else:
        ws_id = new_id("ws_")
        t = now()
        db.execute(
            "INSERT INTO workspaces(id,name,description,created_at,updated_at,status,stats,kind) VALUES(?,?,?,?,?,?,?,?)",
            (ws_id, ws_name, "Live connect folder", t, t, "empty", "{}", "live"),
        )
        ws_dir(ws_id).mkdir(parents=True, exist_ok=True)
        sid = new_id("src_")
        _register_source(ws_id, sid, ws_name, "local", str(p), p, watch=watch_val)
        if watch_val:
            watcher.register_source(sid, p)
        job_id = jobs.submit(ws_id, "ingest")
        reused = False
        final_name = ws_name

    session_data = {
        "workspace_id": ws_id,
        "name": final_name,
        "path": str(p),
        "job_id": job_id,
        "created_at": now(),
        "reused": reused,
    }
    _sessions.append(session_data)
    while len(_sessions) > 50:
        _sessions.pop(0)

    url = f"{settings.web_url}/app/w/{ws_id}"
    return {
        "workspace_id": ws_id,
        "job_id": job_id,
        "name": final_name,
        "url": url,
        "reused": reused,
    }


@router.get("/connect/sessions")
def get_sessions(since: float = 0.0) -> dict:
    t = now()
    if since > 0:
        matched = [s for s in _sessions if s["created_at"] >= since]
    else:
        matched = list(_sessions)
    return {"now": t, "sessions": matched}


@router.post("/workspaces/{id}/sources/{sid}/watch")
def set_source_watch(id: str, sid: str, body: WatchIn) -> dict:
    get_ws(id)
    src = db.one("SELECT * FROM sources WHERE id=? AND workspace_id=?", (sid, id))
    if not src:
        raise HTTPException(404, "Source not found")
    w = 1 if body.enabled else 0
    db.execute("UPDATE sources SET watch=? WHERE id=? AND workspace_id=?", (w, sid, id))
    if w:
        watcher.register_source(sid, Path(src["path"]))
    else:
        watcher.unregister_source(sid)
    return {"ok": True, "source_id": sid, "watch": w}
