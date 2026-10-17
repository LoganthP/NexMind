"""Workspaces (isolated project spaces), uploads / git ingestion, sources and jobs."""
from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Callable, Literal

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..config import settings
from ..db import dumps, loads, new_id, now
from ..ingest.files import ARCHIVE_EXT, IngestError, collapse_single_root, git_clone, safe_extract_tar, safe_extract_zip, validate_git_url
from ..state import db, jobs, store

router = APIRouter(prefix="/api", tags=["workspaces"])


class WorkspaceIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)
    kind: Literal['code', 'docs'] = 'code'


class WorkspacePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=500)


class GitIn(BaseModel):
    url: str
    branch: str | None = None
    token: str | None = Field(default=None, repr=False)  # optional access token for private repos; never stored


class LocalIn(BaseModel):
    path: str


def ws_dir(ws_id: str) -> Path:
    return settings.workspaces_dir / ws_id


def infer_kind(ws: dict) -> str:
    k = ws.get("kind")
    if k:
        return k
    stats = loads(ws.get("stats"), {})
    if stats.get("documents", 0) > 0 and stats.get("files", 0) == 0:
        return "docs"
    return "code"


def get_ws(ws_id: str) -> dict:
    ws = db.one("SELECT * FROM workspaces WHERE id=?", (ws_id,))
    if not ws:
        raise HTTPException(404, "Workspace not found")
    if not ws.get("kind"):
        ws["kind"] = infer_kind(ws)
    return ws


def _ws_out(ws: dict) -> dict:
    counts = db.one("SELECT (SELECT COUNT(*) FROM sources WHERE workspace_id=w.id) AS sources, (SELECT COUNT(*) FROM threads WHERE workspace_id=w.id) AS threads FROM workspaces w WHERE w.id=?", (ws["id"],)) or {}
    return {
        "id": ws["id"], "name": ws["name"], "description": ws["description"], "status": ws["status"],
        "created_at": ws["created_at"], "updated_at": ws["updated_at"], "stats": loads(ws["stats"], {}),
        "source_count": counts.get("sources", 0), "thread_count": counts.get("threads", 0),
        "kind": infer_kind(ws),
    }


@router.post("/workspaces", status_code=201)
def create_workspace(body: WorkspaceIn) -> dict:
    ws_id = new_id("ws_")
    t = now()
    db.execute(
        "INSERT INTO workspaces(id,name,description,created_at,updated_at,status,stats,kind) VALUES(?,?,?,?,?,?,?,?)",
        (ws_id, body.name.strip(), body.description.strip(), t, t, "empty", "{}", body.kind),
    )
    ws_dir(ws_id).mkdir(parents=True, exist_ok=True)
    return _ws_out(get_ws(ws_id))


@router.get("/workspaces")
def list_workspaces() -> list[dict]:
    return [_ws_out(w) for w in db.query("SELECT * FROM workspaces ORDER BY updated_at DESC")]


@router.get("/workspaces/{ws_id}")
def read_workspace(ws_id: str) -> dict:
    return _ws_out(get_ws(ws_id))


@router.patch("/workspaces/{ws_id}")
def patch_workspace(ws_id: str, body: WorkspacePatch) -> dict:
    ws = get_ws(ws_id)
    db.execute("UPDATE workspaces SET name=?, description=?, updated_at=? WHERE id=?", (body.name or ws["name"], body.description if body.description is not None else ws["description"], now(), ws_id))
    return _ws_out(get_ws(ws_id))


@router.delete("/workspaces/{ws_id}", status_code=204)
def delete_workspace(ws_id: str) -> None:
    get_ws(ws_id)
    store.clear(ws_id)
    with db.tx() as c:
        c.execute("DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE workspace_id=?)", (ws_id,))
        for t in ("threads", "jobs", "sources", "insights"):
            c.execute(f"DELETE FROM {t} WHERE workspace_id=?", (ws_id,))
        c.execute("DELETE FROM workspaces WHERE id=?", (ws_id,))
    shutil.rmtree(ws_dir(ws_id), ignore_errors=True)


# ----------------------------------------------------------------------------- sources

@router.get("/workspaces/{ws_id}/sources")
def list_sources(ws_id: str) -> list[dict]:
    get_ws(ws_id)
    return [{k: v for k, v in s.items() if k != "path"} for s in db.query("SELECT * FROM sources WHERE workspace_id=? ORDER BY created_at", (ws_id,))]


@router.delete("/workspaces/{ws_id}/sources/{source_id}")
def delete_source(ws_id: str, source_id: str) -> dict:
    get_ws(ws_id)
    src = db.one("SELECT * FROM sources WHERE id=? AND workspace_id=?", (source_id, ws_id))
    if not src:
        raise HTTPException(404, "Source not found")
    db.execute("DELETE FROM sources WHERE id=?", (source_id,))
    shutil.rmtree(ws_dir(ws_id) / "sources" / source_id, ignore_errors=True)
    job = jobs.submit(ws_id, "rebuild")
    return {"job_id": job}


@router.get("/workspaces/{ws_id}/sources/{source_id}/raw")
def raw_file(ws_id: str, source_id: str, path: str):
    """Serve an original uploaded file (e.g. to render a PDF page next to a node)."""
    get_ws(ws_id)
    src = db.one("SELECT * FROM sources WHERE id=? AND workspace_id=?", (source_id, ws_id))
    if not src:
        raise HTTPException(404, "Source not found")
    root = Path(src["path"]).resolve()
    target = (root / path).resolve()
    if root not in target.parents or not target.is_file():
        raise HTTPException(404, "File not found")
    return FileResponse(target)


# ----------------------------------------------------------------------------- ingestion

def _safe_name(name: str) -> str:
    base = Path(name.replace("\\", "/")).name
    base = re.sub(r"[^A-Za-z0-9._\- ()]", "_", base).strip(" .") or "file"
    return base[:150]


def _is_archive(name: str) -> bool:
    return name.lower().endswith(ARCHIVE_EXT)


async def _save_upload(up: UploadFile, dest: Path) -> int:
    limit = settings.max_upload_mb * 1024 * 1024
    size = 0
    dest.parent.mkdir(parents=True, exist_ok=True)
    with open(dest, "wb") as out:
        while True:
            chunk = await up.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                out.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(413, f"'{up.filename}' exceeds the {settings.max_upload_mb} MB upload limit")
            out.write(chunk)
    return size


def _register_source(ws_id: str, source_id: str, name: str, kind: str, origin: str, path: Path, size: int = 0) -> None:
    db.execute(
        "INSERT INTO sources(id,workspace_id,name,kind,origin,path,size,file_count,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        (source_id, ws_id, name, kind, origin, str(path), size, 0, now()),
    )


def _drop_source(ws_id: str, source_id: str) -> None:
    db.execute("DELETE FROM sources WHERE id=?", (source_id,))
    shutil.rmtree(ws_dir(ws_id) / "sources" / source_id, ignore_errors=True)
    shutil.rmtree(ws_dir(ws_id) / "uploads" / source_id, ignore_errors=True)


def _extract_step(ws_id: str, source_id: str, archive: Path, dest: Path) -> Callable:
    def step(emit) -> None:
        emit("progress", phase="extract", percent=2, message=f"Extracting {archive.name}…")
        try:
            n = safe_extract_zip(archive, dest) if archive.name.lower().endswith(".zip") else safe_extract_tar(archive, dest)
            root = collapse_single_root(dest)
            db.execute("UPDATE sources SET path=?, file_count=? WHERE id=?", (str(root), n, source_id))
            emit("log", level="info", message=f"Extracted {n} files from {archive.name}")
        except Exception as e:
            _drop_source(ws_id, source_id)
            if isinstance(e, IngestError):
                raise
            raise IngestError(f"Could not extract {archive.name}: {e}") from e
        finally:
            shutil.rmtree(archive.parent, ignore_errors=True)

    return step


def _clone_step(ws_id: str, source_id: str, url: str, branch: str | None, dest: Path, token: str | None = None) -> Callable:
    def step(emit) -> None:
        emit("progress", phase="clone", percent=2, message=f"Cloning {url}…")
        try:
            git_clone(url, dest, branch, token)
            n = sum(1 for _ in dest.rglob("*") if _.is_file())
            db.execute("UPDATE sources SET path=?, file_count=? WHERE id=?", (str(dest), n, source_id))
            emit("log", level="info", message=f"Cloned {url} ({n} files)")
        except Exception:
            _drop_source(ws_id, source_id)
            raise

    return step


@router.post("/workspaces/{ws_id}/ingest", status_code=202)
async def ingest(ws_id: str, files: list[UploadFile] = File(default=[]), git_url: str | None = Form(default=None), branch: str | None = Form(default=None), git_token: str | None = Form(default=None)) -> dict:
    """Upload PDFs / DOCX / Markdown / code files / .zip / .tar.gz archives and/or a public git URL.
    The graph is (re)built in the background; subscribe to /ws/workspaces/{id} for live progress."""
    ws = get_ws(ws_id)
    if ws.get("kind") == "docs" and git_url:
        raise HTTPException(400, "Document workspaces take PDFs, Word, Markdown, text and zip files.")
    files = [f for f in files if f.filename]
    if not files and not git_url:
        raise HTTPException(400, "Provide at least one file or a git_url")
    if ws.get("kind") == "code" and files and not git_url:
        def _is_doc_only(name: str) -> bool:
            return Path(name).suffix.lower() in {".pdf", ".docx"}
        if all(_is_doc_only(f.filename or "") for f in files):
            raise HTTPException(400, "Project workspaces take repositories or project archives. Use a Documents workspace for PDFs.")
    prepare: list[Callable] = []
    source_ids: list[str] = []
    base = ws_dir(ws_id)

    loose = [f for f in files if not _is_archive(f.filename or "")]
    archives = [f for f in files if _is_archive(f.filename or "")]

    for up in archives:
        sid = new_id("src_")
        name = _safe_name(up.filename or "archive")
        arc_path = base / "uploads" / sid / name
        size = await _save_upload(up, arc_path)
        dest = base / "sources" / sid
        _register_source(ws_id, sid, re.sub(r"(\.tar\.gz|\.tar\.bz2|\.tgz|\.zip|\.tar)$", "", name, flags=re.I), "archive", name, dest, size)
        prepare.append(_extract_step(ws_id, sid, arc_path, dest))
        source_ids.append(sid)

    if loose:
        sid = new_id("src_")
        dest = base / "sources" / sid
        total = 0
        used: set[str] = set()
        for up in loose:
            name = _safe_name(up.filename or "file")
            stem, dot, ext = name.rpartition(".")
            k = 1
            while name in used:
                name = f"{stem or name}_{k}{dot}{ext}" if dot else f"{name}_{k}"
                k += 1
            used.add(name)
            total += await _save_upload(up, dest / name)
        label = loose[0].filename if len(loose) == 1 else f"{len(loose)} uploaded files"
        _register_source(ws_id, sid, label or "Uploaded files", "files", "upload", dest, total)
        db.execute("UPDATE sources SET file_count=? WHERE id=?", (len(loose), sid))
        source_ids.append(sid)

    if git_url:
        try:
            url = validate_git_url(git_url)
        except IngestError as e:
            raise HTTPException(400, str(e)) from e
        sid = new_id("src_")
        dest = base / "sources" / sid
        label = url.rstrip("/").removesuffix(".git").split("/")[-1]
        _register_source(ws_id, sid, label, "git", url, dest)
        prepare.append(_clone_step(ws_id, sid, url, branch, dest, git_token))
        source_ids.append(sid)

    job_id = jobs.submit(ws_id, "ingest", prepare)
    return {"job_id": job_id, "source_ids": source_ids}


@router.post("/workspaces/{ws_id}/ingest/git", status_code=202)
def ingest_git(ws_id: str, body: GitIn) -> dict:
    ws = get_ws(ws_id)
    if ws.get("kind") == "docs":
        raise HTTPException(400, "Document workspaces take PDFs, Word, Markdown, text and zip files.")
    try:
        url = validate_git_url(body.url)
    except IngestError as e:
        raise HTTPException(400, str(e)) from e
    sid = new_id("src_")
    dest = ws_dir(ws_id) / "sources" / sid
    _register_source(ws_id, sid, url.rstrip("/").removesuffix(".git").split("/")[-1], "git", url, dest)
    job_id = jobs.submit(ws_id, "ingest", [_clone_step(ws_id, sid, url, body.branch, dest, body.token)])
    return {"job_id": job_id, "source_ids": [sid]}


def require_local(request: Request) -> None:
    host = request.client.host if request.client else ""
    if not settings.allow_local_paths:
        raise HTTPException(403, "Local folder access is disabled (NEXMIND_ALLOW_LOCAL_PATHS=false)")
    if host not in ("127.0.0.1", "::1", "localhost", "testclient"):
        raise HTTPException(403, "Local folder access is only available from the machine running NexMind")


@router.post("/workspaces/{ws_id}/ingest/local", status_code=202)
def ingest_local(ws_id: str, body: LocalIn, request: Request) -> dict:
    """Index a folder that already exists on this machine, in place (nothing is copied or modified)."""
    ws = get_ws(ws_id)
    if ws.get("kind") == "docs":
        raise HTTPException(400, "Document workspaces take PDFs, Word, Markdown, text and zip files.")
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
    sid = new_id("src_")
    _register_source(ws_id, sid, p.name or str(p), "local", str(p), p)
    return {"job_id": jobs.submit(ws_id, "ingest"), "source_ids": [sid]}


@router.get("/fs/list", tags=["system"])
def fs_list(request: Request, path: str | None = None) -> dict:
    """Folder browser for the 'Local folder' picker (loopback only, directories only)."""
    require_local(request)
    import os
    import string

    home = Path.home()
    roots = [{"name": "Home", "path": str(home)}, {"name": "Current folder", "path": str(Path.cwd())}]
    if os.name == "nt":
        roots += [{"name": f"{d}:\\", "path": f"{d}:\\"} for d in string.ascii_uppercase if Path(f"{d}:\\").exists()]
    else:
        roots.append({"name": "/", "path": "/"})
    p = Path(path).expanduser() if path else home
    try:
        p = p.resolve()
        entries = []
        for child in sorted(p.iterdir(), key=lambda c: c.name.lower()):
            try:
                if child.is_dir() and not child.name.startswith("."):
                    entries.append({"name": child.name, "path": str(child)})
            except OSError:
                continue
    except (OSError, PermissionError) as e:
        raise HTTPException(400, f"Cannot open folder: {e}") from e
    parent = str(p.parent) if p.parent != p else None
    return {"path": str(p), "parent": parent, "entries": entries[:500], "roots": roots}


@router.post("/workspaces/{ws_id}/rebuild", status_code=202)
def rebuild(ws_id: str) -> dict:
    get_ws(ws_id)
    return {"job_id": jobs.submit(ws_id, "rebuild")}


# ----------------------------------------------------------------------------- jobs

def _job_out(j: dict) -> dict:
    return {**{k: j[k] for k in ("id", "workspace_id", "kind", "status", "progress", "phase", "message", "error", "created_at", "updated_at")}, "result": loads(j["result"], None)}


@router.get("/jobs/{job_id}")
def read_job(job_id: str) -> dict:
    j = db.one("SELECT * FROM jobs WHERE id=?", (job_id,))
    if not j:
        raise HTTPException(404, "Job not found")
    return _job_out(j)


@router.get("/workspaces/{ws_id}/jobs")
def list_jobs(ws_id: str, limit: int = 20) -> list[dict]:
    get_ws(ws_id)
    return [_job_out(j) for j in db.query("SELECT * FROM jobs WHERE workspace_id=? ORDER BY created_at DESC LIMIT ?", (ws_id, max(1, min(limit, 100))))]
