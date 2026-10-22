"""Tests for ingestion pipeline: file uploads, archives, path traversal, git clone, local connect, watcher, concurrency, recovery."""
from __future__ import annotations

import os
import shutil
import tempfile
import time
from pathlib import Path
from unittest.mock import MagicMock, patch
import pytest
from fastapi.testclient import TestClient

from nexmind.main import app
from nexmind.state import db, jobs
from nexmind.ingest.files import IngestError

FIXTURES = Path(__file__).resolve().parent / "fixtures"


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def wait_job(client, job_id: str, timeout: float = 60.0) -> dict:
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = client.get(f"/api/jobs/{job_id}").json()
        if j["status"] in ("done", "failed"):
            return j
        time.sleep(0.15)
    raise AssertionError(f"Job {job_id} timed out after {timeout}s")


def test_upload_archives_and_loose_files(client):
    # Create workspace for code
    r = client.post("/api/workspaces", json={"name": "Ingest Matrix WS", "kind": "code"})
    assert r.status_code == 201
    ws_id = r.json()["id"]

    # 1. Upload zip of code
    code_zip = FIXTURES / "code_project.zip"
    with open(code_zip, "rb") as f:
        r_up = client.post(f"/api/workspaces/{ws_id}/ingest", files=[("files", ("code_project.zip", f.read(), "application/zip"))])
    assert r_up.status_code == 202
    job_info = wait_job(client, r_up.json()["job_id"])
    assert job_info["status"] == "done"

    # Verify sources and graph exist
    r_sources = client.get(f"/api/workspaces/{ws_id}/sources")
    assert r_sources.status_code == 200
    assert len(r_sources.json()) >= 1

    r_graph = client.get(f"/api/workspaces/{ws_id}/graph")
    assert r_graph.status_code == 200
    assert len(r_graph.json()["nodes"]) > 0

    # 2. Upload tar.gz archive
    tar_gz = FIXTURES / "archive.tar.gz"
    with open(tar_gz, "rb") as f:
        r_tar = client.post(f"/api/workspaces/{ws_id}/ingest", files=[("files", ("archive.tar.gz", f.read(), "application/gzip"))])
    assert r_tar.status_code == 202
    job_tar = wait_job(client, r_tar.json()["job_id"])
    assert job_tar["status"] == "done"


def test_path_traversal_archive_protection(client):
    r = client.post("/api/workspaces", json={"name": "Traversal Test WS", "kind": "code"})
    ws_id = r.json()["id"]

    traversal_zip = FIXTURES / "traversal.zip"
    with open(traversal_zip, "rb") as f:
        r_up = client.post(f"/api/workspaces/{ws_id}/ingest", files=[("files", ("traversal.zip", f.read(), "application/zip"))])
    assert r_up.status_code == 202
    job = wait_job(client, r_up.json()["job_id"])
    assert job["status"] == "done"

    # The traversal entry must never be stored, and nothing may escape the data folder
    stored = [r["path"] for r in db.query("SELECT path FROM files WHERE workspace_id=?", (ws_id,))]
    assert stored and all(".." not in p and not p.startswith("/") for p in stored)
    assert not any("evil_escape" in p for p in stored)
    from nexmind.config import settings
    assert not (settings.data_dir.parent / "evil_escape.txt").exists()


def test_corrupt_pdf_does_not_kill_ingest(client):
    r = client.post("/api/workspaces", json={"name": "Corrupt Ingest WS", "kind": "docs"})
    ws_id = r.json()["id"]

    corrupt_pdf = FIXTURES / "corrupt.pdf"
    valid_pdf = FIXTURES / "text_doc.pdf"
    with open(corrupt_pdf, "rb") as f1, open(valid_pdf, "rb") as f2:
        r_up = client.post(
            f"/api/workspaces/{ws_id}/ingest",
            files=[
                ("files", ("corrupt.pdf", f1.read(), "application/pdf")),
                ("files", ("valid.pdf", f2.read(), "application/pdf")),
            ],
        )
    assert r_up.status_code == 202
    job = wait_job(client, r_up.json()["job_id"])
    # The job must complete (not crash with unhandled 500)
    assert job["status"] == "done"


def test_git_ingest_mocked(client, monkeypatch):
    r = client.post("/api/workspaces", json={"name": "Git Ingest WS", "kind": "code"})
    ws_id = r.json()["id"]

    # 1. Invalid git URL rejected
    r_bad_url = client.post(f"/api/workspaces/{ws_id}/ingest/git", json={"url": "http://insecure.com/repo"})
    assert r_bad_url.status_code == 400

    r_bad_host = client.post(f"/api/workspaces/{ws_id}/ingest/git", json={"url": "https://malicious-host.org/repo"})
    assert r_bad_host.status_code == 400
    assert "not allowed" in r_bad_host.json()["detail"].lower()

    # 2. Mock git_clone for public repo
    def fake_fetch(url: str, dest: Path, branch: str | None = None, token: str | None = None):
        out = dest / "repo"
        out.mkdir(parents=True, exist_ok=True)
        (out / "sample.py").write_text("def cloned_func(): return True\n", encoding="utf-8")
        return out

    monkeypatch.setattr("nexmind.api.workspaces.fetch_repository", fake_fetch)

    # Ingest public repo
    r_git = client.post(f"/api/workspaces/{ws_id}/ingest/git", json={"url": "https://github.com/org/public-repo"})
    assert r_git.status_code == 202
    job = wait_job(client, r_git.json()["job_id"])
    assert job["status"] == "done"

    # 3. Private repo with token: Verify token is NEVER stored or echoed
    secret_token = "ghp_SECRET_TOKEN_DO_NOT_LEAK_1234567890"
    r_priv = client.post(
        f"/api/workspaces/{ws_id}/ingest/git",
        json={"url": "https://github.com/org/private-repo", "token": secret_token},
    )
    assert r_priv.status_code == 202
    assert secret_token not in str(r_priv.json())
    job2 = wait_job(client, r_priv.json()["job_id"])
    assert job2["status"] == "done"

    # Verify DB contains no trace of the secret token
    sources = db.query("SELECT * FROM sources WHERE workspace_id=?", (ws_id,))
    for s in sources:
        assert secret_token not in str(s)
    jobs_rows = db.query("SELECT * FROM jobs WHERE workspace_id=?", (ws_id,))
    for j in jobs_rows:
        assert secret_token not in str(j)

    # 4. Timeout and auth failure friendly messages
    def fake_fetch_auth_error(url, dest, branch=None, token=None):
        raise IngestError("Repository or branch not found, or it is private. For a private repository, paste an access token with read access.")

    monkeypatch.setattr("nexmind.api.workspaces.fetch_repository", fake_fetch_auth_error)
    r_auth_err = client.post(f"/api/workspaces/{ws_id}/ingest/git", json={"url": "https://github.com/org/private-error"})
    assert r_auth_err.status_code == 400
    assert "private" in r_auth_err.json()["detail"].lower()


def test_job_queue_concurrency(client):
    r = client.post("/api/workspaces", json={"name": "Concurrency WS", "kind": "code"})
    ws_id = r.json()["id"]

    code_zip = FIXTURES / "code_project.zip"
    with open(code_zip, "rb") as f:
        data = f.read()

    # Submit two ingests back-to-back
    r1 = client.post(f"/api/workspaces/{ws_id}/ingest", files=[("files", ("code1.zip", data, "application/zip"))])
    r2 = client.post(f"/api/workspaces/{ws_id}/ingest", files=[("files", ("code2.zip", data, "application/zip"))])
    assert r1.status_code == 202
    assert r2.status_code == 202

    j1 = wait_job(client, r1.json()["job_id"])
    j2 = wait_job(client, r2.json()["job_id"])
    assert j1["status"] == "done"
    assert j2["status"] == "done"

    # Workspace status must be 'ready'
    ws = client.get(f"/api/workspaces/{ws_id}").json()
    assert ws["status"] == "ready"


def test_delete_source_triggers_rebuild(client):
    r = client.post("/api/workspaces", json={"name": "Source Delete WS", "kind": "code"})
    ws_id = r.json()["id"]

    code_zip = FIXTURES / "code_project.zip"
    with open(code_zip, "rb") as f:
        r_up = client.post(f"/api/workspaces/{ws_id}/ingest", files=[("files", ("code_project.zip", f.read(), "application/zip"))])
    wait_job(client, r_up.json()["job_id"])

    sources = client.get(f"/api/workspaces/{ws_id}/sources").json()
    assert len(sources) >= 1
    sid = sources[0]["id"]

    # Delete source
    r_del = client.delete(f"/api/workspaces/{ws_id}/sources/{sid}")
    assert r_del.status_code == 200
    assert "job_id" in r_del.json()
    job_rebuild = wait_job(client, r_del.json()["job_id"])
    assert job_rebuild["status"] == "done"


def test_restart_recovery_marks_interrupted_jobs_failed():
    # Insert a dummy job with status 'running' and workspace with 'building'
    test_ws = "ws_recovery_test"
    test_job = "job_recovery_test"
    db.execute("INSERT OR REPLACE INTO workspaces(id,name,description,created_at,updated_at,status,stats,kind) VALUES(?,?,'',0,0,'building','{}','code')", (test_ws, test_ws))
    db.execute("INSERT OR REPLACE INTO jobs(id,workspace_id,kind,status,progress,phase,message,created_at,updated_at) VALUES(?,?,?,'running',50,'scan','Scanning...',0,0)", (test_job, test_ws, "ingest"))

    # Instantiate JobManager again to simulate restart recovery
    from nexmind.jobs import JobManager
    from nexmind.state import events, files, store
    _ = JobManager(db, store, files, events)

    job_row = db.one("SELECT * FROM jobs WHERE id=?", (test_job,))
    assert job_row["status"] == "failed"
    assert "server restart" in job_row["error"].lower()
