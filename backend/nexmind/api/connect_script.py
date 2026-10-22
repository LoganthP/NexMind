"""GET /connect.py: the connect command as one self-contained, stdlib-only Python file.

The server writes its own public address and the caller's browser key into the script, so this works:
    Windows PowerShell:  irm "https://YOUR-SITE/connect.py?k=KEY" | python - .
    macOS / Linux:       curl -fsS "https://YOUR-SITE/connect.py?k=KEY" | python3 - .
"""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse

from ..owner import current_owner

router = APIRouter(tags=["connect"])
_CLIENT = Path(__file__).resolve().parent.parent / "connect_client.py"


def public_base(request: Request) -> str:
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto.split(',')[0].strip()}://{host.split(',')[0].strip()}"


@router.get("/connect.py", include_in_schema=False)
@router.get("/api/connect.py", include_in_schema=False)
def serve_connect_script(request: Request) -> PlainTextResponse:
    text = _CLIENT.read_text(encoding="utf-8")
    text = text.replace('DEFAULT_SERVER = "http://127.0.0.1:8000"', f"DEFAULT_SERVER = {json.dumps(public_base(request))}", 1)
    text = text.replace('DEFAULT_KEY = ""', f"DEFAULT_KEY = {json.dumps(current_owner() or '')}", 1)
    return PlainTextResponse(text, media_type="text/plain; charset=utf-8",
                             headers={"Content-Disposition": 'inline; filename="connect.py"', "Cache-Control": "no-store"})
