"""NexMind: AI repository & document intelligence backend (FastAPI).

Runs the same code locally (`python -m nexmind serve`) and on Vercel (api/index.py imports `app`).
"""
from __future__ import annotations

import logging
import os
import re
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

import asyncio
from . import __version__
from .api import chat_routes, connect, connect_script, events as events_api, graph_routes, workspaces, ws
from .config import settings
from .db import find_database_url
from .events import hub
from .ingest.files import IngestError
from .owner import OwnerMiddleware
from .rag.llm import LLM, get_llm, set_llm
from .state import db, get_db_status
from .watcher import watcher

logging.basicConfig(level=os.environ.get("NEXMIND_LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
log = logging.getLogger("nexmind")

# Cold-start log line: version, platform, which database variable is used (name only), Python version
_init_url, _init_env_var = find_database_url()
log.info("NexMind %s (platform=%s, db_env=%s, python=%s)", __version__, sys.platform, _init_env_var or "none", sys.version.split()[0])


@asynccontextmanager
async def lifespan(app: FastAPI):
    hub.bind_loop(asyncio.get_running_loop())
    if settings.allow_local_paths and not settings.hosted:
        watcher.start()
    _, _, env_var, _ = get_db_status()
    log.info("NexMind %s ready (%s, storage=%s, db_env=%s, hosted=%s, LLM=%s)", __version__,
             "vercel" if settings.on_vercel else "local", db.dialect, env_var or "none", settings.hosted, get_llm().info().get("provider"))
    yield
    watcher.stop()


app = FastAPI(
    title="NexMind API",
    version=__version__,
    description="AI Repository & Document Intelligence: a live 3D knowledge graph from code and documents, with GraphRAG chat.",
    lifespan=lifespan,
)


def is_origin_allowed(origin: str | None) -> bool:
    if not origin:
        return True
    if "*" in settings.cors_origins or origin in settings.cors_origins:
        return True
    regex = settings.cors_origin_regex or r"^https://([a-z0-9-]+\.)*vercel\.app$|^http://(localhost|127\.0\.0\.1)(:\d+)?$"
    return bool(re.match(regex, origin))


_cors = dict(allow_origins=settings.cors_origins, allow_credentials=False, allow_methods=["*"], allow_headers=["*"], max_age=86400,
             allow_origin_regex=settings.cors_origin_regex or r"^https://([a-z0-9-]+\.)*vercel\.app$|^http://(localhost|127\.0\.0\.1)(:\d+)?$")
try:
    app.add_middleware(CORSMiddleware, allow_private_network=True, **_cors)
except TypeError:  # older Starlette
    app.add_middleware(CORSMiddleware, **_cors)
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(OwnerMiddleware)


def require_db():
    ok, error_sentence, _, _ = get_db_status()
    if not ok:
        raise HTTPException(status_code=503, detail=error_sentence)


db_dep = [Depends(require_db)]


@app.exception_handler(IngestError)
async def ingest_error_handler(_: Request, exc: IngestError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(_: Request, exc: StarletteHTTPException):
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


@app.exception_handler(Exception)
async def unexpected_error(_: Request, exc: Exception):
    log.exception("Unhandled error: %s", exc)
    return JSONResponse(status_code=500, content={"detail": "The server hit a problem. Try again; details are in the server log."})


# Routers requiring working database
app.include_router(workspaces.router, dependencies=db_dep)
app.include_router(graph_routes.router, dependencies=db_dep)
app.include_router(chat_routes.router, dependencies=db_dep)
app.include_router(events_api.router, dependencies=db_dep)
app.include_router(connect.router, dependencies=db_dep)
app.include_router(connect_script.router)
app.include_router(ws.router, dependencies=db_dep)


@app.get("/api/ping", tags=["system"])
def ping(request: Request) -> JSONResponse:
    origin = request.headers.get("origin")
    data = {"app": "nexmind", "ok": True, "version": __version__, "origin_allowed": is_origin_allowed(origin), "origin": origin}
    return JSONResponse(content=data, headers={"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Private-Network": "true"})


@app.get("/api/health", tags=["system"])
def health() -> dict:
    ok, error_sentence, env_var, configured = get_db_status()
    setup_req = error_sentence if not ok else None

    ws_count = 0
    if ok:
        try:
            ws_count = _workspace_count()
        except Exception:
            ws_count = 0

    return {
        "app": "nexmind", "status": "ok", "version": __version__,
        "hosted": settings.hosted, "platform_host": "vercel" if settings.on_vercel else "local",
        "storage": {"dialect": db.dialect, "persistent": db.persistent or not settings.hosted},
        "database": {
            "configured": configured,
            "ok": ok,
            "error": error_sentence,
            "env_var": env_var,
        },
        "setup_required": setup_req,
        "capabilities": {"local_paths": settings.allow_local_paths, "git_token": True, "websocket": False, "events": True,
                         "sse_chat": True, "chunked_upload": True, "background_jobs": settings.background_jobs},
        "upload": {"chunk_bytes": int(settings.upload_chunk_mb * 1024 * 1024), "max_mb": settings.max_upload_mb},
        "platform": sys.platform, "python": sys.version.split()[0],
        "python_executable": None if settings.hosted else sys.executable,
        "install_dir": None if settings.hosted else str(Path(__file__).resolve().parent.parent),
        "web_url": settings.web_url,
        "llm": get_llm().info(), "embeddings": settings.embeddings,
        "limits": {"max_upload_mb": settings.max_upload_mb, "max_files": settings.max_files, "git_hosts": settings.git_hosts},
        "workspaces": ws_count,
    }


def _workspace_count() -> int:
    from .owner import current_owner

    if settings.hosted:
        owner = current_owner()
        r = db.one("SELECT COUNT(*) AS n FROM workspaces WHERE owner=?", (owner,)) if owner else None
    else:
        r = db.one("SELECT COUNT(*) AS n FROM workspaces")
    return int(r["n"]) if r else 0


class LLMIn(BaseModel):
    provider: str
    model: str | None = None


@app.get("/api/llm", tags=["system"], dependencies=db_dep)
def llm_info() -> dict:
    return {**get_llm().info(), "available_providers": ["offline", "anthropic", "openai", "ollama"]}


@app.put("/api/llm", tags=["system"], dependencies=db_dep)
def llm_switch(body: LLMIn):
    if settings.hosted:
        return JSONResponse(status_code=403, content={"detail": "The hosted app uses the model configured by its owner."})
    if body.provider not in ("offline", "anthropic", "openai", "ollama", "mock"):
        return JSONResponse(status_code=400, content={"detail": "provider must be offline | anthropic | openai | ollama"})
    set_llm(LLM(body.provider, body.model))
    return get_llm().info()


# Unknown /api/* route handler: returns JSON 404 (never SPA HTML)
@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"], include_in_schema=False)
def api_not_found(path: str):
    return JSONResponse(status_code=404, content={"detail": "Not found"})


# Local installs: serve the built web app from ./frontend_dist so http://127.0.0.1:8000 is the whole product.
_fe = Path(os.environ.get("NEXMIND_FRONTEND_DIR", Path(__file__).resolve().parent.parent / "frontend_dist")).resolve()
if not settings.on_vercel and (_fe / "index.html").exists():
    from fastapi.responses import FileResponse

    if (_fe / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=str(_fe / "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        if full_path.startswith(("api/", "docs", "openapi.json", "redoc")):
            return JSONResponse(status_code=404, content={"detail": "Not found"})
        candidate = (_fe / full_path).resolve()
        if full_path and _fe in candidate.parents and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(_fe / "index.html")
