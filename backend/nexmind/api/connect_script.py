"""Serve connect.py as a plain-text download with dynamic BASE_URL injection.

GET /connect.py  →  a self-contained stdlib-only Python script that
  1. POSTs the current folder to /api/connect on the local NexMind server
  2. Prints the workspace URL
  3. Keeps live-sync running (Ctrl-C to stop)

Usage examples:
  Windows PowerShell:  irm http://127.0.0.1:8000/connect.py | python - .
  macOS / Linux:       curl -fsSL http://127.0.0.1:8000/connect.py | python3 - .
"""
from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse

router = APIRouter(tags=["connect"])

# The script template.  @@BASE_URL@@ is replaced at request time so the
# downloaded script already knows which server to talk to — even if the user
# runs NexMind on a non-default port.
_SCRIPT_TEMPLATE = r'''#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""nexmind-connect  --  stdlib-only live connect helper.

Usage
-----
  python connect.py [PATH] [--no-watch] [--name NAME] [--server URL]

  PATH    folder to connect (default: current directory)

Pipe-install shortcut (no clone needed):
  Windows PowerShell:
      irm @@BASE_URL@@/connect.py | python - .
  macOS / Linux:
      curl -fsSL @@BASE_URL@@/connect.py | python3 - .
"""
from __future__ import annotations

import json
import os
import signal
import sys
import time
import urllib.error
import urllib.request

DEFAULT_SERVER = "@@BASE_URL@@"


def _post(server: str, path: str, watch: bool, name: str | None) -> dict:
    url = server.rstrip("/") + "/api/connect"
    payload: dict = {"path": path, "watch": watch}
    if name:
        payload["name"] = name
    req = urllib.request.Request(
        url,
        method="POST",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=12) as resp:
        return json.loads(resp.read().decode())


def _parse_args(argv: list[str]) -> tuple[str, bool, str | None, str]:
    path = "."
    watch = True
    name = None
    server = DEFAULT_SERVER
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--no-watch":
            watch = False
        elif a == "--name" and i + 1 < len(argv):
            i += 1
            name = argv[i]
        elif a == "--server" and i + 1 < len(argv):
            i += 1
            server = argv[i]
        elif not a.startswith("-"):
            path = a
        i += 1
    return os.path.abspath(path), watch, name, server.rstrip("/")


def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]

    path, watch, name, server = _parse_args(argv)

    if not os.path.isdir(path):
        print(f"Error: '{path}' is not a directory.", file=sys.stderr)
        return 1

    print(f"Connecting {path} to {server} ...")
    try:
        data = _post(server, path, watch, name)
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read().decode()).get("detail", str(e))
        except Exception:
            detail = str(e)
        print(f"Error: {detail}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(
            f"Could not reach the NexMind server at {server}.\n"
            f"  Make sure it is running:  python -m nexmind serve\n"
            f"  Error: {exc}",
            file=sys.stderr,
        )
        return 1

    ws_url = data.get("url") or f"{server}/app/w/{data.get('workspace_id')}"
    reused = data.get("reused", False)
    print(f"\n  {'Re-indexed' if reused else 'Connected'}:  {data.get('name', path)}")
    print(f"  Open:  {ws_url}\n")

    if not watch:
        return 0

    print("  Live-sync is ON.  Press Ctrl-C to stop.\n")

    # Keep the process alive so the watcher (on the server side) keeps running.
    # A graceful SIGINT is enough; the server cleans up on its own.
    stop = False

    def _handle_sig(*_: object) -> None:
        nonlocal stop
        stop = True

    signal.signal(signal.SIGINT, _handle_sig)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _handle_sig)

    try:
        while not stop:
            time.sleep(1)
    except KeyboardInterrupt:
        pass

    print("\n  Stopped.  Your workspace stays in NexMind; run the command again to re-sync.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
'''


@router.get("/connect.py", include_in_schema=False)
def serve_connect_script(request: Request) -> PlainTextResponse:
    """Return a self-contained stdlib-only connect helper pre-configured with the server's own URL."""
    base = str(request.base_url).rstrip("/")
    script = _SCRIPT_TEMPLATE.replace("@@BASE_URL@@", base)
    return PlainTextResponse(
        script,
        media_type="text/plain; charset=utf-8",
        headers={
            "Content-Disposition": 'inline; filename="connect.py"',
            "Cache-Control": "no-store",
        },
    )
