"""Per-browser privacy for the hosted app.

Every browser generates a random key (stored in localStorage) and sends it as the `X-NexMind-Key` header
(or `?k=` for plain links such as downloads). On a hosted deployment each key only sees its own
workspaces. A local single-user install is not isolated (everything on your machine is yours).
"""
from __future__ import annotations

import contextvars
import re
from urllib.parse import parse_qs

from .config import settings

KEY_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
_current: contextvars.ContextVar[str | None] = contextvars.ContextVar("nexmind_owner", default=None)


def current_owner() -> str | None:
    return _current.get()


def isolated() -> bool:
    return settings.hosted


def can_access(owner_of_row: str | None) -> bool:
    if not isolated():
        return True
    me = current_owner()
    return bool(me) and owner_of_row == me


class OwnerMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        key = None
        for k, v in scope.get("headers", []):
            if k == b"x-nexmind-key":
                key = v.decode("latin-1").strip()
                break
        if not key and scope.get("query_string"):
            vals = parse_qs(scope["query_string"].decode("latin-1")).get("k")
            key = vals[0] if vals else None
        if key and not KEY_RE.match(key):
            key = None
        token = _current.set(key)
        try:
            await self.app(scope, receive, send)
        finally:
            _current.reset(token)
