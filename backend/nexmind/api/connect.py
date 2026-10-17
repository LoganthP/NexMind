"""Live connect endpoints for CLI and editor extensions."""
from __future__ import annotations

import os
from pathlib import Path
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..db import dumps, loads, new_id, now
from ..state import db, jobs
from .workspaces import _register_source, _ws_out, get_ws, require_local
from ..config import settings

router = APIRouter(prefix="/api", tags=["connect"])

class ConnectIn(BaseModel):
    path: str
    name: str | None = None

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
        
    ws_name = body.name or p.name or str(p)
    
    # Try to find existing live workspace for this path
    existing = db.one(
        "SELECT w.* FROM workspaces w JOIN sources s ON s.workspace_id = w.id WHERE w.kind='live' AND s.path=? LIMIT 1",
        (str(p),)
    )
    
    if existing:
        ws_id = existing["id"]
        source = db.one("SELECT id FROM sources WHERE workspace_id=? AND path=?", (ws_id, str(p)))
        if source:
            db.execute("UPDATE sources SET watch=1 WHERE id=?", (source["id"],))
        # Optional: trigger a rebuild on connection
        jobs.submit(ws_id, "rebuild")
    else:
        ws_id = new_id("ws_")
        t = now()
        db.execute(
            "INSERT INTO workspaces(id,name,description,created_at,updated_at,status,stats,kind) VALUES(?,?,?,?,?,?,?,?)",
            (ws_id, ws_name, "Live connect from CLI", t, t, "empty", "{}", "live"),
        )
        sid = new_id("src_")
        _register_source(ws_id, sid, ws_name, "local", str(p), p)
        db.execute("UPDATE sources SET watch=1 WHERE id=?", (sid,))
        jobs.submit(ws_id, "ingest")
        
    return {"workspace_id": ws_id}
