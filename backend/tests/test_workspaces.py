"""Tests for Workspace lifecycle, CRUD, kind rules, validation, and safe deletion."""
from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

from nexmind.main import app
from nexmind.state import db, store
from nexmind.api.workspaces import ws_dir


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_workspace_crud_and_validation(client):
    # 1. Create with kind code, docs, live
    for kind in ("code", "docs", "live"):
        r = client.post("/api/workspaces", json={"name": f"Test {kind.title()} WS", "kind": kind})
        assert r.status_code == 201
        ws = r.json()
        assert ws["kind"] == kind
        assert ws["name"] == f"Test {kind.title()} WS"
        assert ws["id"].startswith("ws_")
        assert ws["status"] == "empty"

    # 2. Validation: Empty or whitespace name rejected with 422
    r_empty = client.post("/api/workspaces", json={"name": ""})
    assert r_empty.status_code == 422

    r_spaces = client.post("/api/workspaces", json={"name": "    "})
    assert r_spaces.status_code == 422
    assert "cannot be empty" in str(r_spaces.json()).lower()

    # Over-long name (>80 chars) rejected with 422
    r_long = client.post("/api/workspaces", json={"name": "A" * 81})
    assert r_long.status_code == 422

    # Invalid kind rejected with 422
    r_bad_kind = client.post("/api/workspaces", json={"name": "Bad Kind", "kind": "unsupported_kind"})
    assert r_bad_kind.status_code == 422

    # 3. List workspaces
    r_list = client.get("/api/workspaces")
    assert r_list.status_code == 200
    workspaces = r_list.json()
    assert len(workspaces) >= 3

    # 4. Get workspace
    target = workspaces[0]
    r_get = client.get(f"/api/workspaces/{target['id']}")
    assert r_get.status_code == 200
    assert r_get.json()["id"] == target["id"]

    # 404 for unknown workspace
    r_not_found = client.get("/api/workspaces/ws_nonexistent999")
    assert r_not_found.status_code == 404

    # 5. Rename with PATCH
    r_patch = client.patch(f"/api/workspaces/{target['id']}", json={"name": "Renamed Workspace"})
    assert r_patch.status_code == 200
    assert r_patch.json()["name"] == "Renamed Workspace"

    # Rename validation: empty or whitespace rejected
    r_patch_empty = client.patch(f"/api/workspaces/{target['id']}", json={"name": ""})
    assert r_patch_empty.status_code == 422

    r_patch_spaces = client.patch(f"/api/workspaces/{target['id']}", json={"name": "   "})
    assert r_patch_spaces.status_code == 422

    # Rename validation: over-long name rejected
    r_patch_long = client.patch(f"/api/workspaces/{target['id']}", json={"name": "X" * 81})
    assert r_patch_long.status_code == 422


def test_kind_rules_enforcement(client):
    # Create one workspace of each kind
    r_code = client.post("/api/workspaces", json={"name": "Code WS", "kind": "code"})
    code_id = r_code.json()["id"]

    r_docs = client.post("/api/workspaces", json={"name": "Docs WS", "kind": "docs"})
    docs_id = r_docs.json()["id"]

    r_live = client.post("/api/workspaces", json={"name": "Live WS", "kind": "live"})
    live_id = r_live.json()["id"]

    # Rule 1: git into docs -> 400
    r_git_docs = client.post(f"/api/workspaces/{docs_id}/ingest/git", json={"url": "https://github.com/org/repo"})
    assert r_git_docs.status_code == 400
    assert "Document workspaces take PDFs" in r_git_docs.json()["detail"]

    # Rule 2: local into docs -> 400
    r_local_docs = client.post(f"/api/workspaces/{docs_id}/ingest/local", json={"path": "C:\\fake\\path"})
    assert r_local_docs.status_code == 400
    assert "Document workspaces take PDFs" in r_local_docs.json()["detail"]

    # Rule 3: git into live -> 400
    r_git_live = client.post(f"/api/workspaces/{live_id}/ingest/git", json={"url": "https://github.com/org/repo"})
    assert r_git_live.status_code == 400
    assert "Live workspaces are connected from a folder" in r_git_live.json()["detail"]

    # Rule 4: zip/upload into live -> 400
    r_up_live = client.post(
        f"/api/workspaces/{live_id}/ingest",
        files=[("files", ("test.zip", b"PK...", "application/zip"))]
    )
    assert r_up_live.status_code == 400
    assert "Live workspaces are connected from a folder" in r_up_live.json()["detail"]

    # Rule 5: PDF-only upload into code -> 400
    r_pdf_code = client.post(
        f"/api/workspaces/{code_id}/ingest",
        files=[("files", ("manual.pdf", b"%PDF-1.4...", "application/pdf"))]
    )
    assert r_pdf_code.status_code == 400
    assert "Project workspaces take repositories or project archives" in r_pdf_code.json()["detail"]


def test_delete_workspace_cleanup_and_safety(client):
    # Create a live workspace connected to a local temp folder
    temp_local = Path(tempfile.mkdtemp(prefix="nexmind-local-preserve-"))
    (temp_local / "source_file.py").write_text("print('must not be deleted')", encoding="utf-8")

    try:
        r_conn = client.post("/api/connect", json={"path": str(temp_local), "name": "Preserve Test", "watch": False})
        assert r_conn.status_code == 200
        ws_id = r_conn.json()["workspace_id"]

        # Add a thread to verify thread cleanup
        r_th = client.post(f"/api/workspaces/{ws_id}/threads", json={"title": "Test Thread"})
        assert r_th.status_code == 201

        # Delete workspace
        r_del = client.delete(f"/api/workspaces/{ws_id}")
        assert r_del.status_code == 204

        # Verify DB records are gone
        assert db.one("SELECT * FROM workspaces WHERE id=?", (ws_id,)) is None
        assert db.one("SELECT * FROM sources WHERE workspace_id=?", (ws_id,)) is None
        assert db.one("SELECT * FROM threads WHERE workspace_id=?", (ws_id,)) is None
        assert db.one("SELECT * FROM jobs WHERE workspace_id=?", (ws_id,)) is None

        # Verify workspace storage on disk is deleted
        assert not ws_dir(ws_id).exists()

        # CRITICAL SAFETY: The user's actual local folder was NEVER deleted
        assert temp_local.exists()
        assert (temp_local / "source_file.py").exists()
        assert (temp_local / "source_file.py").read_text(encoding="utf-8") == "print('must not be deleted')"
    finally:
        shutil.rmtree(temp_local, ignore_errors=True)
