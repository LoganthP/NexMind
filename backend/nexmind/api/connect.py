"""Live connect: link a project folder (e.g. the one open in VS Code) to NexMind.

Two ways, chosen automatically by the connect command:
  * path mode   (NexMind server on the same computer): the folder is indexed in place and watched by the server.
  * upload mode (hosted NexMind, e.g. Vercel): the command zips the folder, uploads it in chunks and re-uploads
                when files change; the server never needs access to the user's disk.
"""
from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..config import settings
from ..db import new_id, now
from ..ingest.files import IngestError
from ..owner import current_owner, isolated
from ..state import db, events, files, jobs
from ..watcher import watcher
from .workspaces import (_tmpdir, add_tree_source, assemble_upload, create_workspace_row, discard_uploads, get_ws,
                         require_local, require_storage)

router = APIRouter(prefix="/api", tags=["connect"])


class ConnectIn(BaseModel):
    path: str
    name: str | None = None
    watch: bool = True


class ConnectUploadIn(BaseModel):
    upload_id: str
    path_hint: str = Field(min_length=1, max_length=1000)  # the folder's path on the user's computer (identity only)
    name: str | None = Field(default=None, max_length=120)
    watch: bool = True


class WatchIn(BaseModel):
    enabled: bool = True


def _owner_clause() -> tuple[str, tuple]:
    if isolated():
        return " AND w.owner=?", (current_owner(),)
    return "", ()


def _record_session(ws_id: str, name: str, path: str, job_id: str, reused: bool) -> None:
    db.execute(
        "INSERT INTO connect_sessions(id, owner, workspace_id, name, path, job_id, created_at, reused) VALUES(?,?,?,?,?,?,?,?)",
        (new_id("cs_"), current_owner(), ws_id, name, path, job_id, now(), 1 if reused else 0),
    )
    db.execute("DELETE FROM connect_sessions WHERE created_at<?", (now() - 86400,))


def _out(ws_id: str, job_id: str, name: str, reused: bool) -> dict:
    return {"workspace_id": ws_id, "job_id": job_id, "name": name, "url": f"/app/w/{ws_id}", "reused": reused}


@router.post("/connect")
def connect_local(body: ConnectIn, request: Request) -> dict:
    """Path mode: the server and the folder are on the same computer."""
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
    name = (body.name or "").strip() or p.name or str(p)
    watch_val = 1 if body.watch else 0
    clause, params = _owner_clause()
    existing = db.one(
        "SELECT w.id, w.name, s.id AS sid FROM workspaces w JOIN sources s ON s.workspace_id=w.id "
        "WHERE w.kind='live' AND s.path=?" + clause + " LIMIT 1", (str(p), *params))
    if existing:
        ws_id, sid, reused, name = existing["id"], existing["sid"], True, existing["name"]
        db.execute("UPDATE sources SET watch=? WHERE id=?", (watch_val, sid))
        job_id = jobs.submit(ws_id, "rebuild")
    else:
        ws_id = create_workspace_row(name, "live", "Live connect folder")
        sid = new_id("src_")
        db.execute(
            "INSERT INTO sources(id,workspace_id,name,kind,origin,path,size,file_count,created_at,watch,stored) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (sid, ws_id, name, "local", str(p), str(p), 0, 0, now(), watch_val, 0),
        )
        job_id = jobs.submit(ws_id, "ingest")
        reused = False
    if watch_val:
        watcher.register_source(sid, p)
    else:
        watcher.unregister_source(sid)
    _record_session(ws_id, name, str(p), job_id, reused)
    return _out(ws_id, job_id, name, reused)


@router.post("/connect/upload")
def connect_upload(body: ConnectUploadIn) -> dict:
    """Upload mode: the connect command uploaded a zip of the folder (hosted NexMind)."""
    require_storage()
    hint = body.path_hint.strip()
    if hint.startswith("browser:"):
        parts = hint.split(":")
        folder_name = parts[1] if len(parts) > 1 and parts[1] else "project"
    else:
        folder_name = Path(hint.replace("\\", "/")).name or "project"
    name = (body.name or "").strip() or folder_name
    clause, params = _owner_clause()
    existing = db.one(
        "SELECT w.id, w.name, s.id AS sid FROM workspaces w JOIN sources s ON s.workspace_id=w.id "
        "WHERE w.kind='live' AND s.origin=? AND s.stored=1" + clause + " LIMIT 1", (hint, *params))
    stage = _tmpdir("nexmind-c-")
    try:
        up_name, archive = assemble_upload(body.upload_id, stage)
        from .workspaces import ingest_archive_file  # local import keeps module import order simple

        if existing:
            ws_id, sid, reused, name = existing["id"], existing["sid"], True, existing["name"]
            out = _tmpdir("nexmind-cx-")
            try:
                from ..ingest.files import collapse_single_root, safe_extract_zip

                safe_extract_zip(archive, out)
                add_tree_source(ws_id, name, "local", hint, collapse_single_root(out), source_id=sid)
            finally:
                shutil.rmtree(out, ignore_errors=True)
            kind = "rebuild"
        else:
            ws_id = create_workspace_row(name, "live", "Live connect folder")
            sid = ingest_archive_file(ws_id, archive, up_name)
            db.execute("UPDATE sources SET kind='local', origin=?, name=? WHERE id=?", (hint, name, sid))
            reused, kind = False, "ingest"
        db.execute("UPDATE sources SET watch=? WHERE id=?", (1 if body.watch else 0, sid))
    except IngestError as e:
        raise HTTPException(400, str(e)) from e
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    discard_uploads([body.upload_id])
    job_id = jobs.submit(ws_id, kind)
    if reused:
        events.add(ws_id, "source_changed", job_id, source_id=sid)
    _record_session(ws_id, name, hint, job_id, reused)
    return _out(ws_id, job_id, name, reused)


@router.get("/connect/sessions")
def get_sessions(since: float = 0.0) -> dict:
    if isolated():
        rows = db.query("SELECT * FROM connect_sessions WHERE owner=? AND created_at>=? ORDER BY created_at", (current_owner(), since))
    else:
        rows = db.query("SELECT * FROM connect_sessions WHERE created_at>=? ORDER BY created_at", (since,))
    return {"now": now(), "sessions": [
        {"workspace_id": r["workspace_id"], "name": r["name"], "path": r["path"], "job_id": r["job_id"],
         "created_at": r["created_at"], "reused": bool(r["reused"])} for r in rows[-50:]]}


@router.post("/workspaces/{id}/sources/{sid}/watch")
def set_source_watch(id: str, sid: str, body: WatchIn) -> dict:
    get_ws(id)
    src = db.one("SELECT * FROM sources WHERE id=? AND workspace_id=?", (sid, id))
    if not src:
        raise HTTPException(404, "Source not found")
    w = 1 if body.enabled else 0
    db.execute("UPDATE sources SET watch=? WHERE id=? AND workspace_id=?", (w, sid, id))
    if not src.get("stored") and src.get("path"):  # folder on this computer: the server watches it
        if w:
            watcher.register_source(sid, Path(src["path"]))
        else:
            watcher.unregister_source(sid)
    return {"ok": True, "source_id": sid, "watch": w}
