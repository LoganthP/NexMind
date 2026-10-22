"""Hosted (Vercel-like) mode: Postgres storage, no background threads, per-browser isolation.

Uses an embedded Postgres (pip install pgserver) so the real SQL dialect is exercised.
Without pgserver it falls back to SQLite (NEXMIND_ALLOW_EPHEMERAL=1) so the flows still run.
"""
import os
import shutil
import tempfile

import pytest

_DATA = tempfile.mkdtemp(prefix="nexmind-hosted-")
os.environ["NEXMIND_DATA_DIR"] = _DATA
os.environ["NEXMIND_HOSTED"] = "1"
os.environ["NEXMIND_LLM_PROVIDER"] = "offline"
os.environ.pop("DATABASE_URL", None)

PG = None
try:
    import pgserver  # type: ignore

    PG = pgserver.get_server(os.path.join(_DATA, "pg"), cleanup_mode="stop")
    os.environ["DATABASE_URL"] = PG.get_uri()
except Exception:  # pragma: no cover
    os.environ["NEXMIND_ALLOW_EPHEMERAL"] = "1"


@pytest.fixture(scope="session", autouse=True)
def _cleanup():
    yield
    try:
        if PG is not None:
            PG.cleanup()
    finally:
        shutil.rmtree(_DATA, ignore_errors=True)
