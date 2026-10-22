"""`nexmind` command line:  nexmind serve | nexmind doctor | nexmind version"""
from __future__ import annotations

import argparse
import importlib
import shutil
import socket
import sys

from . import __version__


def _port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) != 0


def cmd_serve(args: argparse.Namespace) -> int:
    from .config import settings

    host, port = args.host or settings.host, args.port or settings.port
    if not _port_free("127.0.0.1" if host in ("0.0.0.0", "localhost") else host, port):
        print(f"\n  Port {port} is already in use. If NexMind is already running, just open the web app.\n"
              f"  Otherwise pick another port:  nexmind serve --port {port + 1}\n")
        return 1
    url = f"http://127.0.0.1:{port}"
    print(f"\n  NexMind {__version__}")
    print(f"  Server      {url}   (API docs: {url}/docs)")
    print(f"  Web app     {settings.web_url}   (it detects this server automatically)")
    print("  Stop        Ctrl+C\n")
    if args.open:
        import threading
        import webbrowser

        threading.Timer(1.5, lambda: webbrowser.open(settings.web_url)).start()
    import uvicorn

    uvicorn.run("nexmind.main:app", host=host, port=port, log_level="info", reload=getattr(args, "reload", False))
    return 0


def cmd_doctor(_: argparse.Namespace) -> int:
    from .config import settings

    ok = True

    def line(good: bool, label: str, detail: str = "") -> None:
        nonlocal ok
        ok = ok and good
        print(f"  {'OK ' if good else 'FIX'}  {label}{(' — ' + detail) if detail else ''}")

    print(f"\n  NexMind doctor ({__version__})\n")
    line(sys.version_info >= (3, 10), "Python 3.10+", sys.version.split()[0])
    for mod in ("fastapi", "uvicorn", "networkx", "numpy", "scipy", "sklearn", "pypdf", "docx", "langchain_text_splitters", "multipart"):
        try:
            importlib.import_module(mod)
            line(True, f"package {mod}")
        except Exception as e:  # noqa: BLE001
            line(False, f"package {mod}", f"missing -> pip install -r requirements.txt ({type(e).__name__})")
    line(shutil.which("git") is not None, "git (needed only for GitHub/GitLab URL import)", shutil.which("git") or "not found")
    try:
        settings.ensure_dirs()
        test = settings.data_dir / ".write-test"
        test.write_text("x")
        test.unlink()
        line(True, "data folder writable", str(settings.data_dir))
    except Exception as e:  # noqa: BLE001
        line(False, "data folder writable", str(e))
    line(_port_free("127.0.0.1", settings.port), f"port {settings.port} free", "if not, NexMind may already be running")
    from .rag.llm import get_llm

    print(f"  --   LLM provider: {get_llm().info()['provider']} (offline mode needs no key)")
    print("\n  " + ("Everything looks good. Run: nexmind serve\n" if ok else "Fix the items marked FIX, then run: nexmind serve\n"))
    return 0 if ok else 1


def cmd_connect(args: argparse.Namespace) -> int:
    from .connect_client import main as connect_main

    argv = [args.path or "."]
    if getattr(args, "name", None):
        argv += ["--name", args.name]
    if getattr(args, "no_watch", False):
        argv.append("--no-watch")
    if getattr(args, "server", None):
        server = args.server if args.server.startswith(("http://", "https://")) else f"http://{args.server}"
        argv += ["--server", server]
    if getattr(args, "key", None):
        argv += ["--key", args.key]
    return connect_main(argv)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="nexmind", description="NexMind — repository & document intelligence")
    sub = parser.add_subparsers(dest="cmd")
    s = sub.add_parser("serve", help="start the local server (the web app connects to it automatically)")
    s.add_argument("--host", default=None)
    s.add_argument("--port", type=int, default=None)
    s.add_argument("--reload", action="store_true", help="auto-reload on code change")
    s.add_argument("--open", action="store_true", help="open the web app in your browser")
    sub.add_parser("doctor", help="check that your machine is ready")
    sub.add_parser("version")
    c = sub.add_parser("connect", help="connect the current folder to a running NexMind server (Live Connect)")
    c.add_argument("path", nargs="?", default=".", help="folder to connect (default: current directory)")
    c.add_argument("--key", default=None, help="browser key shown in the web app (hosted NexMind)")
    c.add_argument("--name", default=None, help="workspace name")
    c.add_argument("--no-watch", action="store_true", help="disable auto-sync on file change")
    c.add_argument("--server", default=None, help="NexMind server URL")
    c.add_argument("--port", type=int, default=None, help="NexMind server port")
    c.add_argument("--open", action="store_true", help="open workspace in browser")
    
    args = parser.parse_args(argv)
    if args.cmd == "doctor":
        return cmd_doctor(args)
    if args.cmd == "version":
        print(__version__)
        return 0
    if args.cmd == "connect":
        return cmd_connect(args)
    if args.cmd in (None, "serve"):
        if args.cmd is None:
            args = parser.parse_args(["serve"])
        return cmd_serve(args)
    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
