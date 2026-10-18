"""NexMind — AI Repository & Document Intelligence backend (FastAPI)."""
from __future__ import annotations

import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import __version__
from .api import chat_routes, graph_routes, workspaces, ws, connect, connect_script
from .config import settings
from .events import hub
from .ingest.files import IngestError
from .rag.llm import LLM, get_llm, set_llm
from .state import db
from .watcher import watcher

logging.basicConfig(level=os.environ.get("NEXMIND_LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    hub.bind_loop(asyncio.get_running_loop())
    llm = get_llm()
    watcher.start()
    logging.getLogger("nexmind").info("NexMind %s ready — data dir: %s — LLM: %s", __version__, settings.data_dir, llm.info())
    yield
    watcher.stop()


app = FastAPI(
    title="NexMind API",
    version=__version__,
    description="AI Repository & Document Intelligence — builds a live 3D knowledge graph from code and documents, with GraphRAG chat.",
    lifespan=lifespan,
)
import inspect

from fastapi.middleware.gzip import GZipMiddleware
from starlette.middleware.cors import CORSMiddleware as _CORS

_cors_kwargs = dict(allow_origins=settings.cors_origins, allow_credentials=False, allow_methods=["*"], allow_headers=["*"], max_age=86400)
_native_pna = "allow_private_network" in inspect.signature(_CORS.__init__).parameters
if _native_pna:  # newer Starlette answers Chrome's private-network preflight itself
    _cors_kwargs["allow_private_network"] = True
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(CORSMiddleware, **_cors_kwargs)


class PrivateNetworkAccess:
    """Chrome/Edge require this header when a public website (your Vercel frontend) talks to http://127.0.0.1.
    It answers the browser's preflight so the hosted UI can connect to the server running on your machine."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        wants = any(k == b"access-control-request-private-network" and v.lower() == b"true" for k, v in scope["headers"])

        async def send_wrapper(message):
            if wants and message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.append((b"access-control-allow-private-network", b"true"))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_wrapper)


if not _native_pna:  # older Starlette: add the header ourselves
    app.add_middleware(PrivateNetworkAccess)


@app.exception_handler(IngestError)
async def ingest_error_handler(_: Request, exc: IngestError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.exception_handler(Exception)
async def generic_exception_handler(_: Request, exc: Exception):
    from fastapi import HTTPException
    from starlette.exceptions import HTTPException as StarletteHTTPException

    if isinstance(exc, (HTTPException, StarletteHTTPException)):
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail}, headers=getattr(exc, "headers", None))
    logging.getLogger("nexmind").exception("Unhandled error: %s", exc)
    return JSONResponse(status_code=500, content={"detail": f"Internal server error: {exc}"})


app.include_router(workspaces.router)
app.include_router(graph_routes.router)
app.include_router(chat_routes.router)
app.include_router(ws.router)
app.include_router(connect.router)
app.include_router(connect_script.router)


@app.get("/api/health", tags=["system"])
def health() -> dict:
    return {
        "app": "nexmind", "status": "ok", "version": __version__,
        "capabilities": {"local_paths": settings.allow_local_paths, "git_token": True, "websocket": True, "sse_chat": True},
        "platform": sys.platform, "python": sys.version.split()[0], "python_executable": sys.executable,
        "install_dir": str(Path(__file__).resolve().parent), "llm": get_llm().info(), "embeddings": settings.embeddings,
        "limits": {"max_upload_mb": settings.max_upload_mb, "max_files": settings.max_files, "git_hosts": settings.git_hosts},
        "workspaces": (db.one("SELECT COUNT(*) AS n FROM workspaces") or {}).get("n", 0),
    }


class LLMIn(BaseModel):
    provider: str
    model: str | None = None


@app.get("/api/llm", tags=["system"])
def llm_info() -> dict:
    return {**get_llm().info(), "available_providers": ["offline", "anthropic", "openai", "ollama"]}


@app.put("/api/llm", tags=["system"])
def llm_switch(body: LLMIn) -> dict:
    """Switch provider/model at runtime (API keys still come from environment variables)."""
    if body.provider not in ("offline", "anthropic", "openai", "ollama", "mock"):
        return JSONResponse(status_code=400, content={"detail": "provider must be offline | anthropic | openai | ollama"})  # type: ignore[return-value]
    set_llm(LLM(body.provider, body.model))
    return get_llm().info()


# Optional: serve the built web app from ./frontend_dist (or NEXMIND_FRONTEND_DIR) so http://127.0.0.1:8000 is the whole product.
# Unknown non-API paths fall back to index.html so client-side routes like /app/w/<id> survive a page refresh.
_fe = Path(os.environ.get("NEXMIND_FRONTEND_DIR", Path(__file__).resolve().parent.parent / "frontend_dist")).resolve()
if (_fe / "index.html").exists():
    from fastapi.responses import FileResponse, JSONResponse as _J

    if (_fe / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=str(_fe / "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        if full_path.startswith(("api/", "ws/", "docs", "openapi.json", "redoc")):
            return _J(status_code=404, content={"detail": "Not found"})
        candidate = (_fe / full_path).resolve()
        if full_path and _fe in candidate.parents and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(_fe / "index.html")
