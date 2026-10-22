"""Workspaces, sources, uploads (chunked, Vercel-safe), repository downloads and jobs."""
from __future__ import annotations

import mimetypes
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from ..config import settings
from ..db import dumps, loads, new_id, now
from ..ingest.files import ARCHIVE_EXT, IngestError, collapse_single_root, safe_extract_tar, safe_extract_zip, validate_git_url
from ..ingest.remote import fetch_repository
from ..owner import can_access, current_owner, isolated
from ..state import db, events, files, jobs, store
from ..storage import read_source_file

router = APIRouter(prefix="/api", tags=["workspaces"])

DOCS_ONLY_MSG = "Document workspaces take PDFs, Word, Markdown, text and zip files."
LIVE_MSG = "Live workspaces are connected from a folder with the Live connect command."
CODE_PDF_MSG = "Project workspaces take repositories or project archives. Use a Documents workspace for PDFs."
LOCAL_ONLY_MSG = ("Folders on your computer can only be opened by a NexMind server running on your computer. "
                  "In the hosted app, use 'Upload a project folder' or the Live connect command.")


class WorkspaceIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)
    kind: Literal['code', 'docs', 'live'] = 'code'


class WorkspacePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=500)


class GitIn(BaseModel):
    url: str
    branch: str | None = None
    token: str | None = Field(default=None, repr=False)  # optional access token for private repos; never stored


class LocalIn(BaseModel):
    path: str


class FsPickIn(BaseModel):
    title: str | None = None
    initial: str | None = None


class UploadInit(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    size: int = Field(ge=0)
    chunk_size: int | None = Field(default=None, ge=65536)  # optional smaller chunks (slow networks)


class UploadsIngest(BaseModel):
    upload_ids: list[str] = Field(min_length=1, max_length=200)
    name: str | None = Field(default=None, max_length=120)


# ----------------------------------------------------------------------------- helpers

def require_storage() -> None:
    """A hosted deployment without a database would silently lose every workspace."""
    if settings.hosted and not db.persistent and os.environ.get("NEXMIND_ALLOW_EPHEMERAL") != "1":
        raise HTTPException(503, "Storage is not set up yet. In Vercel open Storage, add a Postgres database (Neon), "
                                 "connect it to this project, then redeploy.")


def require_key() -> str | None:
    if isolated() and not current_owner():
        raise HTTPException(401, "This browser has no NexMind key yet. Reload the page and try again.")
    return current_owner()


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
    if not ws or not can_access(ws.get("owner")):
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


def create_workspace_row(name: str, kind: str, description: str = "") -> str:
    require_storage()
    owner = require_key()
    if isolated():
        n = db.one("SELECT COUNT(*) AS n FROM workspaces WHERE owner=?", (owner,))
        if n and n["n"] >= settings.max_workspaces_per_owner:
            raise HTTPException(429, f"You already have {settings.max_workspaces_per_owner} workspaces. Delete one to create another.")
    ws_id = new_id("ws_")
    t = now()
    db.execute(
        "INSERT INTO workspaces(id,name,description,created_at,updated_at,status,stats,kind,owner) VALUES(?,?,?,?,?,?,?,?,?)",
        (ws_id, name, description, t, t, "empty", "{}", kind, owner),
    )
    return ws_id


def _tmpdir(prefix: str) -> Path:
    base = settings.data_dir / "tmp"
    base.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix=prefix, dir=str(base)))


def _safe_name(name: str) -> str:
    base = Path(name.replace("\\", "/")).name
    base = re.sub(r"[^A-Za-z0-9._\- ()]", "_", base).strip(" .") or "file"
    return base[:150]


def _safe_rel(name: str) -> str:
    """Keep folder structure of uploaded folders (webkitRelativePath) but never allow escaping."""
    parts = [p for p in name.replace("\\", "/").split("/") if p not in ("", ".", "..")]
    return "/".join(_safe_name(p) for p in parts) or "file"


def _is_archive(name: str) -> bool:
    return name.lower().endswith(ARCHIVE_EXT)


def add_tree_source(ws_id: str, name: str, kind: str, origin: str, root: Path, source_id: str | None = None) -> str:
    """Store every supported file of `root` in the database as one source of the workspace."""
    sid = source_id or new_id("src_")
    exists = db.one("SELECT id FROM sources WHERE id=?", (sid,))
    if not exists:
        db.execute(
            "INSERT INTO sources(id,workspace_id,name,kind,origin,path,size,file_count,created_at,watch,stored) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (sid, ws_id, name, kind, origin, "", 0, 0, now(), 0, 1),
        )
    count, total = files.store_tree(ws_id, sid, root)
    if count == 0:
        if not exists:
            db.execute("DELETE FROM sources WHERE id=?", (sid,))
        raise IngestError(f"No supported files were found in {name}.")
    db.execute("UPDATE sources SET file_count=?, size=?, stored=1, path='' WHERE id=?", (count, total, sid))
    return sid


def ingest_archive_file(ws_id: str, archive: Path, display_name: str) -> str:
    out = _tmpdir("nexmind-x-")
    try:
        try:
            if display_name.lower().endswith(".zip"):
                safe_extract_zip(archive, out)
            else:
                safe_extract_tar(archive, out)
        except IngestError:
            raise
        except Exception as e:
            raise IngestError(f"Could not open {display_name}: {e}") from e
        root = collapse_single_root(out)
        label = re.sub(r"(\.tar\.gz|\.tar\.bz2|\.tgz|\.zip|\.tar)$", "", display_name, flags=re.I)
        return add_tree_source(ws_id, label, "archive", display_name, root)
    finally:
        shutil.rmtree(out, ignore_errors=True)


def check_upload_allowed(ws: dict, names: list[str]) -> None:
    kind = ws.get("kind")
    if kind == "live":
        raise HTTPException(400, LIVE_MSG)
    if kind == "code" and names and all(Path(n).suffix.lower() in {".pdf", ".docx"} for n in names):
        raise HTTPException(400, CODE_PDF_MSG)


def ingest_paths(ws: dict, items: list[tuple[str, Path]], label: str | None = None) -> list[str]:
    """items = [(original name incl. relative folder, file on disk)]. Archives become their own sources."""
    ws_id = ws["id"]
    check_upload_allowed(ws, [n for n, _ in items])
    source_ids: list[str] = []
    loose = [(n, p) for n, p in items if not _is_archive(n)]
    for n, p in items:
        if _is_archive(n):
            source_ids.append(ingest_archive_file(ws_id, p, _safe_name(n)))
    if loose:
        stage = _tmpdir("nexmind-u-")
        try:
            used: set[str] = set()
            for n, p in loose:
                rel = _safe_rel(n)
                k = 1
                base_rel = rel
                while rel in used:
                    stem, dot, ext = base_rel.rpartition(".")
                    rel = f"{stem}_{k}{dot}{ext}" if dot else f"{base_rel}_{k}"
                    k += 1
                used.add(rel)
                target = stage / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(p, target)
            name = label or (loose[0][0].replace("\\", "/").split("/")[0] if "/" in loose[0][0].replace("\\", "/") else (loose[0][0] if len(loose) == 1 else f"{len(loose)} uploaded files"))
            source_ids.append(add_tree_source(ws_id, name, "files", "upload", collapse_single_root(stage) if len(loose) > 1 else stage))
        finally:
            shutil.rmtree(stage, ignore_errors=True)
    return source_ids


def _ingest_error(e: IngestError) -> HTTPException:
    return HTTPException(400, str(e))


# ----------------------------------------------------------------------------- workspaces

@router.post("/workspaces", status_code=201)
def create_workspace(body: WorkspaceIn) -> dict:
    name = body.name.strip()
    if not name:
        raise HTTPException(422, "Workspace name cannot be empty")
    ws_id = create_workspace_row(name, body.kind, body.description.strip())
    return _ws_out(get_ws(ws_id))


@router.get("/workspaces")
def list_workspaces() -> list[dict]:
    if isolated():
        owner = current_owner()
        if not owner:
            return []
        rows = db.query("SELECT * FROM workspaces WHERE owner=? ORDER BY updated_at DESC", (owner,))
    else:
        rows = db.query("SELECT * FROM workspaces ORDER BY updated_at DESC")
    return [_ws_out(w) for w in rows]


@router.get("/workspaces/{ws_id}")
def read_workspace(ws_id: str) -> dict:
    return _ws_out(get_ws(ws_id))


@router.patch("/workspaces/{ws_id}")
def patch_workspace(ws_id: str, body: WorkspacePatch) -> dict:
    ws = get_ws(ws_id)
    if body.name is not None:
        new_name = body.name.strip()
        if not new_name:
            raise HTTPException(422, "Workspace name cannot be empty")
    else:
        new_name = ws["name"]
    db.execute("UPDATE workspaces SET name=?, description=?, updated_at=? WHERE id=?", (new_name, body.description if body.description is not None else ws["description"], now(), ws_id))
    return _ws_out(get_ws(ws_id))


@router.delete("/workspaces/{ws_id}", status_code=204)
def delete_workspace(ws_id: str) -> None:
    get_ws(ws_id)
    store.clear(ws_id)
    files.delete_workspace(ws_id)
    events.delete_workspace(ws_id)

    def tx(c):
        c.execute("DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE workspace_id=?)", (ws_id,))
        for t in ("threads", "jobs", "sources", "connect_sessions"):
            c.execute(f"DELETE FROM {t} WHERE workspace_id=?", (ws_id,))
        c.execute("DELETE FROM workspaces WHERE id=?", (ws_id,))
    db.run(tx)
    shutil.rmtree(settings.workspaces_dir / ws_id, ignore_errors=True)  # legacy local copies only


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
    files.delete_source(source_id)  # a folder connected in place on disk is never touched
    db.execute("DELETE FROM sources WHERE id=?", (source_id,))
    shutil.rmtree(settings.workspaces_dir / ws_id / "sources" / source_id, ignore_errors=True)
    return {"job_id": jobs.submit(ws_id, "rebuild")}


@router.get("/workspaces/{ws_id}/sources/{source_id}/raw")
def raw_file(ws_id: str, source_id: str, path: str):
    """Serve an original file (e.g. to show a PDF next to a node)."""
    get_ws(ws_id)
    if not db.one("SELECT 1 AS x FROM sources WHERE id=? AND workspace_id=?", (source_id, ws_id)):
        raise HTTPException(404, "Source not found")
    data = read_source_file(db, files, source_id, path)
    if data is None:
        raise HTTPException(404, "File not found")
    media = mimetypes.guess_type(path)[0] or "application/octet-stream"
    return Response(data, media_type=media, headers={"Content-Disposition": f'inline; filename="{_safe_name(path)}"'})


# ----------------------------------------------------------------------------- chunked uploads (Vercel limits one request to 4.5 MB)

def _chunk_bytes() -> int:
    return int(settings.upload_chunk_mb * 1024 * 1024)


@router.post("/uploads", status_code=201)
def upload_init(body: UploadInit) -> dict:
    require_storage()
    owner = require_key()
    if body.size > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(413, f"'{body.name}' is larger than the {settings.max_upload_mb} MB limit")
    uid = new_id("up_")
    size = min(body.chunk_size or _chunk_bytes(), _chunk_bytes())
    chunks = max(1, -(-body.size // size))
    db.execute("INSERT INTO uploads(id, owner, name, size, received, chunks, created_at) VALUES(?,?,?,?,?,?,?)",
               (uid, owner, body.name, body.size, size, chunks, now()))
    # forget abandoned uploads after a day
    old = [r["id"] for r in db.query("SELECT id FROM uploads WHERE created_at<?", (now() - 86400,))]
    for o in old:
        db.execute("DELETE FROM upload_chunks WHERE upload_id=?", (o,))
        db.execute("DELETE FROM uploads WHERE id=?", (o,))
    return {"upload_id": uid, "chunk_size": size, "chunks": chunks}


def _upload_row(uid: str) -> dict:
    up = db.one("SELECT * FROM uploads WHERE id=?", (uid,))
    if not up or not can_access(up.get("owner")):
        raise HTTPException(404, "Upload not found")
    return up


@router.put("/uploads/{uid}/chunks/{idx}")
async def upload_chunk(uid: str, idx: int, request: Request) -> dict:
    up = _upload_row(uid)
    if idx < 0 or idx >= up["chunks"]:
        raise HTTPException(400, "Chunk index out of range")
    data = await request.body()
    if len(data) > int(up["received"] or _chunk_bytes()) + 1024:
        raise HTTPException(413, "Chunk too large")
    db.execute("DELETE FROM upload_chunks WHERE upload_id=? AND idx=?", (uid, idx))
    db.execute("INSERT INTO upload_chunks(upload_id, idx, data) VALUES(?,?,?)", (uid, idx, data))
    got = db.one("SELECT COUNT(*) AS n FROM upload_chunks WHERE upload_id=?", (uid,))
    return {"upload_id": uid, "received_chunks": got["n"] if got else 0, "chunks": up["chunks"]}


def assemble_upload(uid: str, dest_dir: Path) -> tuple[str, Path]:
    up = _upload_row(uid)
    rows = db.query("SELECT idx, data FROM upload_chunks WHERE upload_id=? ORDER BY idx", (uid,))
    if len(rows) != up["chunks"] or [r["idx"] for r in rows] != list(range(up["chunks"])):
        raise HTTPException(400, f"Upload of '{up['name']}' is incomplete. Please try again.")
    target = dest_dir / new_id("f_")
    with open(target, "wb") as out:
        for r in rows:
            out.write(bytes(r["data"]))
    if target.stat().st_size != up["size"]:
        raise HTTPException(400, f"Upload of '{up['name']}' arrived damaged. Please try again.")
    return up["name"], target


def discard_uploads(uids: list[str]) -> None:
    for uid in uids:
        db.execute("DELETE FROM upload_chunks WHERE upload_id=?", (uid,))
        db.execute("DELETE FROM uploads WHERE id=?", (uid,))


@router.post("/workspaces/{ws_id}/ingest/uploads", status_code=202)
def ingest_uploads(ws_id: str, body: UploadsIngest) -> dict:
    ws = get_ws(ws_id)
    require_storage()
    stage = _tmpdir("nexmind-a-")
    try:
        items = [assemble_upload(uid, stage) for uid in body.upload_ids]
        try:
            source_ids = ingest_paths(ws, items, label=body.name)
        except IngestError as e:
            raise _ingest_error(e) from e
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    discard_uploads(body.upload_ids)
    return {"job_id": jobs.submit(ws_id, "ingest"), "source_ids": source_ids}


# ----------------------------------------------------------------------------- ingestion (classic multipart, still used by small local uploads)

@router.post("/workspaces/{ws_id}/ingest", status_code=202)
async def ingest(ws_id: str, files_in: list[UploadFile] = File(default=[], alias="files"), git_url: str | None = Form(default=None), branch: str | None = Form(default=None), git_token: str | None = Form(default=None)) -> dict:
    ws = get_ws(ws_id)
    require_storage()
    uploads = [f for f in files_in if f.filename]
    if not uploads and not git_url:
        raise HTTPException(400, "Provide at least one file or a git_url")
    if git_url and ws.get("kind") == "docs":
        raise HTTPException(400, DOCS_ONLY_MSG)
    if git_url and ws.get("kind") == "live":
        raise HTTPException(400, LIVE_MSG)
    stage = _tmpdir("nexmind-m-")
    source_ids: list[str] = []
    try:
        items: list[tuple[str, Path]] = []
        limit = settings.max_upload_mb * 1024 * 1024
        total = 0
        for up in uploads:
            target = stage / new_id("f_")
            with open(target, "wb") as out:
                while True:
                    chunk = await up.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > limit:
                        raise HTTPException(413, f"Uploads exceed the {settings.max_upload_mb} MB limit")
                    out.write(chunk)
            items.append((up.filename or "file", target))
        try:
            if items:
                source_ids += ingest_paths(ws, items)
            if git_url:
                source_ids.append(_ingest_repo(ws, git_url, branch, git_token))
        except IngestError as e:
            raise _ingest_error(e) from e
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    return {"job_id": jobs.submit(ws_id, "ingest"), "source_ids": source_ids}


def _ingest_repo(ws: dict, url: str, branch: str | None, token: str | None) -> str:
    url = validate_git_url(url)
    dl = _tmpdir("nexmind-g-")
    try:
        root = fetch_repository(url, dl / "work", branch, token)
        label = url.rstrip("/").removesuffix(".git").split("/")[-1]
        return add_tree_source(ws["id"], label, "git", url, root)
    finally:
        shutil.rmtree(dl, ignore_errors=True)


@router.post("/workspaces/{ws_id}/ingest/git", status_code=202)
def ingest_git(ws_id: str, body: GitIn) -> dict:
    ws = get_ws(ws_id)
    require_storage()
    if ws.get("kind") == "live":
        raise HTTPException(400, LIVE_MSG)
    if ws.get("kind") == "docs":
        raise HTTPException(400, DOCS_ONLY_MSG)
    if body.branch and not re.match(r"^[A-Za-z0-9_.\-/]+$", body.branch.strip()):
        raise HTTPException(400, "Invalid branch name")
    try:
        sid = _ingest_repo(ws, body.url, body.branch, body.token)
    except IngestError as e:
        raise _ingest_error(e) from e
    return {"job_id": jobs.submit(ws_id, "ingest"), "source_ids": [sid]}


def require_local(request: Request) -> None:
    host = request.client.host if request.client else ""
    if not settings.allow_local_paths:
        raise HTTPException(403, LOCAL_ONLY_MSG)
    if host not in ("127.0.0.1", "::1", "localhost", "testclient"):
        raise HTTPException(403, "Local folder access is only available from the machine running NexMind")


@router.post("/workspaces/{ws_id}/ingest/local", status_code=202)
def ingest_local(ws_id: str, body: LocalIn, request: Request) -> dict:
    """Index a folder that already exists on this machine, in place (nothing is copied or modified)."""
    ws = get_ws(ws_id)
    if ws.get("kind") == "docs":
        raise HTTPException(400, DOCS_ONLY_MSG)
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
    db.execute(
        "INSERT INTO sources(id,workspace_id,name,kind,origin,path,size,file_count,created_at,watch,stored) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        (sid, ws_id, p.name or str(p), "local", str(p), str(p), 0, 0, now(), 0, 0),
    )
    return {"job_id": jobs.submit(ws_id, "ingest"), "source_ids": [sid]}

@router.get("/fs/list", tags=["system"])
def fs_list(request: Request, path: str | None = None, files: int = 1) -> dict:
    """Folder browser for the 'Local folder' picker (loopback only)."""
    require_local(request)
    import os
    import string

    home = Path.home()
    p = Path(path).expanduser() if path else home
    try:
        p = p.resolve()
    except PermissionError as e:
        raise HTTPException(400, "Cannot open this folder (permission denied)") from e
    except OSError as e:
        raise HTTPException(400, f"Cannot open folder: {e}") from e

    if not p.exists() or not p.is_dir():
        raise HTTPException(400, f"Cannot open folder: {p} is not a directory")

    roots: list[dict[str, str]] = []
    if home.exists():
        roots.append({"name": "Home", "path": str(home)})
    desktop = home / "Desktop"
    if desktop.exists():
        roots.append({"name": "Desktop", "path": str(desktop)})
    docs = home / "Documents"
    if docs.exists():
        roots.append({"name": "Documents", "path": str(docs)})
    downloads = home / "Downloads"
    if downloads.exists():
        roots.append({"name": "Downloads", "path": str(downloads)})
    roots.append({"name": "Current folder", "path": str(Path.cwd())})
    if os.name == "nt":
        roots += [{"name": f"{d}:\\", "path": f"{d}:\\"} for d in string.ascii_uppercase if Path(f"{d}:\\").exists()]
    else:
        roots.append({"name": "/", "path": "/"})

    parent = str(p.parent) if p.parent != p else None

    # Crumbs
    crumbs: list[dict[str, str]] = []
    curr = p
    chain: list[Path] = []
    while True:
        chain.append(curr)
        if curr.parent == curr:
            break
        curr = curr.parent
    for part in reversed(chain):
        crumbs.append({"name": part.name or str(part), "path": str(part)})

    PROJECT_MARKERS = {
        ".git", "package.json", "pyproject.toml", "requirements.txt",
        "pom.xml", "build.gradle", "go.mod", "Cargo.toml", "composer.json"
    }

    def _get_markers(folder: Path) -> list[str]:
        m: list[str] = []
        try:
            for sub in folder.iterdir():
                if sub.name in PROJECT_MARKERS or sub.name.endswith(".sln"):
                    m.append(sub.name)
            if not m:
                for sub in folder.iterdir():
                    if sub.is_dir() and not sub.name.startswith("."):
                        for item in sub.iterdir():
                            if item.name in PROJECT_MARKERS:
                                m.append(item.name)
                            elif item.name == "__init__.py":
                                m.append("__init__.py")
            if not m:
                if any(folder.glob("*.py")) or any(folder.glob("*/*.py")):
                    m.append("python")
                if any(folder.glob("*.js")) or any(folder.glob("*/*.js")) or any(folder.glob("*.ts")) or any(folder.glob("*/*.ts")):
                    m.append("javascript")
        except (OSError, PermissionError):
            pass
        return sorted(list(set(m)))

    dirs: list[dict[str, Any]] = []
    file_entries: list[dict[str, Any]] = []
    try:
        for child in p.iterdir():
            if child.name.startswith(".") and child.name != ".github":
                continue
            try:
                if child.is_dir():
                    markers = _get_markers(child)
                    dirs.append({
                        "name": child.name,
                        "path": str(child),
                        "kind": "dir",
                        "is_project": bool(markers),
                        "markers": markers if markers else None,
                    })
                elif files and child.is_file():
                    sz = 0
                    try:
                        sz = child.stat().st_size
                    except OSError:
                        pass
                    file_entries.append({
                        "name": child.name,
                        "path": str(child),
                        "kind": "file",
                        "size": sz,
                    })
            except (OSError, PermissionError):
                continue
    except PermissionError as e:
        raise HTTPException(400, "Cannot open this folder (permission denied)") from e
    except OSError as e:
        raise HTTPException(400, f"Cannot open folder: {e}") from e

    dirs.sort(key=lambda d: d["name"].lower())
    file_entries.sort(key=lambda f: f["name"].lower())
    all_entries = dirs + file_entries
    truncated = len(all_entries) > 400
    return {
        "path": str(p),
        "parent": parent,
        "crumbs": crumbs,
        "roots": roots,
        "entries": all_entries[:400],
        "truncated": truncated,
    }


@router.post("/fs/pick", tags=["system"])
def fs_pick(request: Request, body: FsPickIn | None = None) -> dict:
    """Open the operating system's folder-selection dialog on this machine (loopback only)."""
    require_local(request)
    import os
    import subprocess
    import sys

    initial = (body.initial.strip() if body and body.initial else "") or str(Path.home())
    title = (body.title.strip() if body and body.title else "Select Folder")

    script = """
import sys, os
try:
    import tkinter as tk
    from tkinter import filedialog
    root = tk.Tk()
    root.withdraw()
    try:
        root.attributes('-topmost', True)
    except Exception:
        pass
    initial = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else None
    title = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None
    kwargs = {'mustexist': True}
    if initial:
        kwargs['initialdir'] = initial
    if title:
        kwargs['title'] = title
    path = filedialog.askdirectory(**kwargs)
    if path:
        print(path)
    root.destroy()
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(2)
"""

    try:
        res = subprocess.run(
            [sys.executable, "-c", script, initial, title],
            capture_output=True,
            text=True,
            timeout=300,
        )
    except subprocess.TimeoutExpired:
        return {"path": None, "cancelled": True}
    except Exception as e:
        raise HTTPException(
            501,
            "The folder window is not available on this computer. Use the folder browser instead.",
        ) from e

    if res.returncode != 0:
        raise HTTPException(
            501,
            "The folder window is not available on this computer. Use the folder browser instead.",
        )

    out = res.stdout.strip()
    if not out:
        return {"path": None, "cancelled": True}

    return {"path": os.path.normpath(out), "cancelled": False}


@router.get("/fs/check", tags=["system"])
def fs_check(request: Request, path: str | None = None) -> dict:
    require_local(request)
    from fastapi.responses import JSONResponse
    from ..ingest.files import walk_source

    if not path or not path.strip():
        return JSONResponse(status_code=400, content={"ok": False, "exists": False, "is_dir": False, "readable": False, "markers": [], "supported_files": 0, "has_code": False, "has_docs": False, "message": "Path is required", "detail": "Path is required"})

    p = Path(path.strip().strip('"')).expanduser()
    try:
        p = p.resolve()
    except OSError as e:
        return JSONResponse(status_code=400, content={"ok": False, "exists": False, "is_dir": False, "readable": False, "markers": [], "supported_files": 0, "has_code": False, "has_docs": False, "message": f"Invalid path: {e}", "detail": f"Invalid path: {e}"})

    if not p.exists() or not p.is_dir():
        return JSONResponse(status_code=400, content={"ok": False, "exists": False, "is_dir": False, "readable": False, "markers": [], "supported_files": 0, "has_code": False, "has_docs": False, "message": f"Folder not found: {p}", "detail": f"Folder not found: {p}"})

    if p == Path(p.anchor):
        return JSONResponse(status_code=400, content={"ok": False, "exists": True, "is_dir": True, "readable": True, "markers": [], "supported_files": 0, "has_code": False, "has_docs": False, "message": "Choose a project folder, not a drive root", "detail": "Choose a project folder, not a drive root"})

    PROJECT_MARKERS = {
        ".git", "package.json", "pyproject.toml", "requirements.txt",
        "pom.xml", "build.gradle", "go.mod", "Cargo.toml", "composer.json"
    }
    markers: list[str] = []
    try:
        for item in p.iterdir():
            if item.name in PROJECT_MARKERS or item.name.endswith(".sln"):
                markers.append(item.name)
        if not markers:
            for sub in p.iterdir():
                if sub.is_dir() and not sub.name.startswith("."):
                    for item in sub.iterdir():
                        if item.name in PROJECT_MARKERS:
                            markers.append(item.name)
                        elif item.name == "__init__.py":
                            markers.append("__init__.py")
        if not markers:
            # Check parent for project markers when selecting a sub-folder like 'src'
            try:
                if p.parent and p.parent != p and p.parent != Path(p.parent.anchor):
                    for item in p.parent.iterdir():
                        if item.name in PROJECT_MARKERS or item.name.endswith(".sln"):
                            markers.append(item.name)
            except (OSError, PermissionError):
                pass
        if not markers:
            if any(p.glob("*.py")) or any(p.glob("*/*.py")):
                markers.append("python")
            if any(p.glob("*.js")) or any(p.glob("*/*.js")) or any(p.glob("*.ts")) or any(p.glob("*/*.ts")) or any(p.glob("*.tsx")) or any(p.glob("*/*.tsx")):
                markers.append("javascript")
    except PermissionError as e:
        return JSONResponse(status_code=400, content={"ok": False, "exists": True, "is_dir": True, "readable": False, "markers": [], "supported_files": 0, "has_code": False, "has_docs": False, "message": "Cannot open this folder (permission denied)", "detail": "Cannot open this folder (permission denied)"})
    except OSError as e:
        return JSONResponse(status_code=400, content={"ok": False, "exists": True, "is_dir": True, "readable": False, "markers": [], "supported_files": 0, "has_code": False, "has_docs": False, "message": str(e), "detail": str(e)})

    supported_files = 0
    has_code = False
    has_docs = False
    try:
        for fe in walk_source(p):
            supported_files += 1
            if fe.category == "code":
                has_code = True
            elif fe.category == "doc":
                has_docs = True
            if supported_files >= 5000:
                break
    except Exception as e:
        return JSONResponse(status_code=400, content={"ok": False, "exists": True, "is_dir": True, "readable": False, "markers": markers, "supported_files": supported_files, "has_code": has_code, "has_docs": has_docs, "message": f"Cannot read files: {e}", "detail": f"Cannot read files: {e}"})

    project_type = ""
    if any("py" in m or "requirements" in m or "__init__" in m for m in markers):
        project_type = "Python project"
    elif any("package.json" in m or "javascript" in m for m in markers):
        project_type = "Node / TypeScript project"
    elif any("Cargo" in m for m in markers):
        project_type = "Rust project"
    elif any("go.mod" in m for m in markers):
        project_type = "Go project"
    elif any("pom.xml" in m or "gradle" in m for m in markers):
        project_type = "Java project"

    msg_parts = [f"≈ {supported_files} supported files"]
    if project_type:
        msg_parts.append(project_type)
    elif has_code:
        msg_parts.append("codebase")
    elif has_docs:
        msg_parts.append("documents")

    return {
        "ok": True,
        "exists": True,
        "is_dir": True,
        "readable": True,
        "markers": sorted(markers),
        "supported_files": supported_files,
        "has_code": has_code,
        "has_docs": has_docs,
        "message": " · ".join(msg_parts),
    }



@router.post("/workspaces/{ws_id}/rebuild", status_code=202)
def rebuild(ws_id: str) -> dict:
    get_ws(ws_id)
    return {"job_id": jobs.submit(ws_id, "rebuild")}


# ----------------------------------------------------------------------------- jobs

def _job_out(j: dict) -> dict:
    return {**{k: j[k] for k in ("id", "workspace_id", "kind", "status", "progress", "phase", "message", "error", "created_at", "updated_at")}, "result": loads(j["result"], None)}


def get_job(job_id: str) -> dict:
    j = db.one("SELECT * FROM jobs WHERE id=?", (job_id,))
    if not j:
        raise HTTPException(404, "Job not found")
    get_ws(j["workspace_id"])  # ownership
    return j


@router.get("/jobs/{job_id}")
def read_job(job_id: str) -> dict:
    return _job_out(get_job(job_id))


@router.get("/workspaces/{ws_id}/jobs")
def list_jobs(ws_id: str, limit: int = 20) -> list[dict]:
    get_ws(ws_id)
    return [_job_out(j) for j in db.query("SELECT * FROM jobs WHERE workspace_id=? ORDER BY created_at DESC LIMIT ?", (ws_id, max(1, min(limit, 100))))]
