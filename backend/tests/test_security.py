"""Security tests: path traversal, zip bombs, symlinks, token redaction, loopback restrictions."""
from __future__ import annotations

import io
import shutil
import tempfile
import zipfile
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

from nexmind.main import app
from nexmind.config import settings
from nexmind.ingest.files import IngestError, safe_extract_zip

FIXTURES = Path(__file__).resolve().parent / "fixtures"


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_path_traversal_zip_extraction():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("normal.txt", "safe")
        zf.writestr("../escape_1.txt", "evil")
        zf.writestr("../../escape_2.txt", "evil")
        zf.writestr("..\\escape_win.txt", "evil")

    dest = Path(tempfile.mkdtemp(prefix="nexmind-zip-test-"))
    try:
        temp_zip = dest / "test.zip"
        temp_zip.write_bytes(buf.getvalue())
        n = safe_extract_zip(temp_zip, dest / "extracted")

        # Escapes must be skipped; only normal.txt extracted
        assert (dest / "extracted" / "normal.txt").exists()
        assert not (dest / "escape_1.txt").exists()
        assert not (dest / "escape_2.txt").exists()
        assert not (dest / "escape_win.txt").exists()
    finally:
        shutil.rmtree(dest, ignore_errors=True)


def test_zip_bomb_expansion_limit(monkeypatch):
    monkeypatch.setattr(settings, "max_unzipped_mb", 5)
    dest = Path(tempfile.mkdtemp(prefix="nexmind-bomb-test-"))
    temp_zip = dest / "bomb.zip"
    buf = io.BytesIO()
    # Create an archive whose declared uncompressed size exceeds max_unzipped_mb (5MB)
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zero_chunk = b"\x00" * (1024 * 1024)
        for i in range(8):  # 8MB uncompressed > 5MB limit
            zf.writestr(f"large_{i}.bin", zero_chunk)

    try:
        temp_zip.write_bytes(buf.getvalue())
        with pytest.raises(IngestError) as exc_info:
            safe_extract_zip(temp_zip, dest / "extracted")
        assert "expands beyond" in str(exc_info.value).lower()
    finally:
        shutil.rmtree(dest, ignore_errors=True)


def test_symlink_ignored_during_extraction():
    dest = Path(tempfile.mkdtemp(prefix="nexmind-symlink-test-"))
    temp_zip = dest / "symlink.zip"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("regular.txt", "regular content")
        # Create a ZIP entry with symlink attribute
        symlink_info = zipfile.ZipInfo("symlink_entry")
        symlink_info.create_system = 3  # Unix
        symlink_info.external_attr = 0o120777 << 16  # S_IFLNK
        zf.writestr(symlink_info, "/etc/passwd")

    try:
        temp_zip.write_bytes(buf.getvalue())
        safe_extract_zip(temp_zip, dest / "extracted")
        assert (dest / "extracted" / "regular.txt").exists()
        # Symlink entry must NOT have been extracted
        assert not (dest / "extracted" / "symlink_entry").exists()
    finally:
        shutil.rmtree(dest, ignore_errors=True)


def test_token_redaction_in_git_clone_errors():
    from nexmind.ingest.files import git_clone
    dest = Path(tempfile.mkdtemp(prefix="nexmind-git-test-"))
    secret_token = "ghp_VERY_SECRET_KEY_12345678901234567890"

    try:
        # Clone with invalid private URL and token: error text must redact token
        with pytest.raises(IngestError) as exc_info:
            git_clone(
                url="https://github.com/nexmind-nonexistent/private-repo.git",
                dest=dest,
                token=secret_token,
            )
        err_msg = str(exc_info.value)
        assert secret_token not in err_msg
    finally:
        shutil.rmtree(dest, ignore_errors=True)


def test_loopback_endpoints_reject_remote_clients():
    remote_client = TestClient(app, client=("10.0.0.99", 12345))

    # All loopback endpoints
    for route in ("/api/connect", "/api/fs/list", "/api/fs/check?path=/"):
        r = remote_client.get(route) if "fs" in route else remote_client.post(route, json={"path": "C:\\"})
        assert r.status_code == 403, f"{route} did not reject non-local client"
        assert "only available from the machine running NexMind" in r.json()["detail"]
