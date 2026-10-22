"""Vercel entry point: the whole NexMind API (FastAPI) runs as one Python function.

vercel.json sends /api/* and /connect.py here; everything else is the static web app.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from nexmind.main import app  # noqa: E402,F401
