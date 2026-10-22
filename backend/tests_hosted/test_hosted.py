"""End-to-end flows exactly as they run on Vercel."""
import io
import json
import os
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from nexmind.config import settings
from nexmind.main import app
from nexmind.state import db

ROOT = Path(__file__).resolve().parent.parent
SAMPLE = ROOT / "samples" / "sample_project"
KEY_A = "a" * 8 + secrets.token_hex(8)
KEY_B = "b" * 8 + secrets.token_hex(8)


def H(key):
    return {"X-NexMind-Key": key}


def sample_zip() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for p in SAMPLE.rglob("*"):
            if p.is_file():
                z.write(p, "shop/" + p.relative_to(SAMPLE).as_posix())
        z.writestr("../evil.txt", "nope")
        z.writestr("shop/assets/blob.bin", os.urandom(300_000))  # makes the upload span several chunks
    return buf.getvalue()


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def chunked_upload(client, key, name, data, chunk=None):
    body = {"name": name, "size": len(data)}
    if chunk:
        body["chunk_size"] = chunk
    init = client.post("/api/uploads", json=body, headers=H(key))
    assert init.status_code == 201, init.text
    j = init.json()
    size = j["chunk_size"]
    assert j["chunk_size"] <= 4 * 1024 * 1024  # stays under Vercel's 4.5 MB request limit
    for i in range(j["chunks"]):
        r = client.put(f"/api/uploads/{j['upload_id']}/chunks/{i}", content=data[i * size:(i + 1) * size], headers=H(key))
        assert r.status_code == 200, r.text
    return j["upload_id"]


def run_job(client, key, job_id):
    r = client.post(f"/api/jobs/{job_id}/run", headers=H(key))
    assert r.status_code == 200, r.text
    evs = [json.loads(line) for line in r.text.splitlines() if line.strip()]
    return evs


def test_settings_are_serverless():
    assert settings.hosted and not settings.background_jobs and not settings.allow_local_paths


def test_health_reports_hosted(client):
    h = client.get("/api/health").json()
    assert h["hosted"] is True and h["capabilities"]["local_paths"] is False
    assert h["capabilities"]["chunked_upload"] and h["upload"]["chunk_bytes"] < 4_500_000
    assert h["python_executable"] is None and h["install_dir"] is None  # no machine details leak
    if db.persistent:
        assert h["storage"]["dialect"] == "postgres" and h["setup_required"] is None


def test_key_required_and_isolation(client):
    assert client.get("/api/workspaces").json() == []  # no key: nothing visible
    r = client.post("/api/workspaces", json={"name": "no key"})
    assert r.status_code == 401
    a = client.post("/api/workspaces", json={"name": "A private"}, headers=H(KEY_A)).json()
    assert client.get(f"/api/workspaces/{a['id']}", headers=H(KEY_B)).status_code == 404
    assert all(w["id"] != a["id"] for w in client.get("/api/workspaces", headers=H(KEY_B)).json())
    assert any(w["id"] == a["id"] for w in client.get("/api/workspaces", headers=H(KEY_A)).json())
    assert client.get(f"/api/workspaces/{a['id']}/graph", headers=H(KEY_B)).status_code == 404


def test_full_project_flow_chunked_upload_run_and_query(client):
    ws = client.post("/api/workspaces", json={"name": "Shop", "kind": "code"}, headers=H(KEY_A)).json()
    data = sample_zip()
    uid = chunked_upload(client, KEY_A, "shop.zip", data, chunk=65536)  # force several chunks
    r = client.post(f"/api/workspaces/{ws['id']}/ingest/uploads", json={"upload_ids": [uid]}, headers=H(KEY_A))
    assert r.status_code == 202, r.text
    job_id = r.json()["job_id"]
    # nothing runs in the background on a serverless host: the job waits for a runner
    feed = client.get(f"/api/workspaces/{ws['id']}/events", headers=H(KEY_A)).json()
    assert feed["pending_job"]["id"] == job_id and feed["events"][-1]["type"] == "job_queued"
    evs = run_job(client, KEY_A, job_id)
    types = [e["type"] for e in evs]
    assert types[0] == "job_started" and types[-1] == "job_done" and "progress" in types
    # a second runner is refused politely
    assert client.post(f"/api/jobs/{job_id}/run", headers=H(KEY_A)).status_code == 409
    # observers can follow the same events by polling
    feed2 = client.get(f"/api/workspaces/{ws['id']}/events", params={"after": feed["seq"]}, headers=H(KEY_A)).json()
    assert [e["type"] for e in feed2["events"]][-1] == "job_done" and feed2["pending_job"] is None
    g = client.get(f"/api/workspaces/{ws['id']}/graph", headers=H(KEY_A)).json()
    assert len(g["nodes"]) > 20 and g["links"]
    assert not any("evil" in (n.get("path") or "") for n in g["nodes"])
    hit = client.get(f"/api/workspaces/{ws['id']}/search", params={"q": "validate_token"}, headers=H(KEY_A)).json()
    node = next(n for n in hit["nodes"] if n["label"] == "validate_token")
    d = client.get(f"/api/workspaces/{ws['id']}/nodes/{node['id']}", headers=H(KEY_A)).json()
    assert d["code"]["text"].startswith("def validate_token")  # source read back from the database
    imp = client.get(f"/api/workspaces/{ws['id']}/impact", params={"node": node["id"]}, headers=H(KEY_A)).json()
    assert imp["total"] >= 1
    # chat over SSE
    t = client.post(f"/api/workspaces/{ws['id']}/threads", json={}, headers=H(KEY_A)).json()
    with client.stream("POST", f"/api/workspaces/{ws['id']}/threads/{t['id']}/messages", json={"content": "How does login work?"}, headers=H(KEY_A)) as resp:
        body = "".join(resp.iter_text())
    assert "event: retrieval" in body and "event: done" in body
    # export + raw file with ?k= (plain links cannot send headers)
    assert client.get(f"/api/workspaces/{ws['id']}/export", params={"format": "json", "k": KEY_A}).status_code == 200
    src = client.get(f"/api/workspaces/{ws['id']}/sources", headers=H(KEY_A)).json()[0]
    raw = client.get(f"/api/workspaces/{ws['id']}/sources/{src['id']}/raw", params={"path": "docs/README.md", "k": KEY_A})
    assert raw.status_code == 200 and b"Shop" in raw.content
    # delete removes stored files too
    assert client.delete(f"/api/workspaces/{ws['id']}", headers=H(KEY_A)).status_code == 204
    assert db.one("SELECT 1 AS x FROM files WHERE workspace_id=?", (ws["id"],)) is None


def test_documents_and_kind_rules(client):
    docs = client.post("/api/workspaces", json={"name": "Study", "kind": "docs"}, headers=H(KEY_A)).json()
    md = b"# Notes\n\nGraph databases store nodes and edges. Neo4j uses Cypher.\n"
    uid = chunked_upload(client, KEY_A, "notes.md", md)
    r = client.post(f"/api/workspaces/{docs['id']}/ingest/uploads", json={"upload_ids": [uid]}, headers=H(KEY_A))
    assert r.status_code == 202
    run_job(client, KEY_A, r.json()["job_id"])
    g = client.get(f"/api/workspaces/{docs['id']}/graph", headers=H(KEY_A)).json()
    assert any(n["type"] == "Document" for n in g["nodes"])
    assert client.post(f"/api/workspaces/{docs['id']}/ingest/git", json={"url": "https://github.com/a/b"}, headers=H(KEY_A)).status_code == 400
    code = client.post("/api/workspaces", json={"name": "P", "kind": "code"}, headers=H(KEY_A)).json()
    uid2 = chunked_upload(client, KEY_A, "paper.pdf", b"%PDF-1.4 fake")
    r2 = client.post(f"/api/workspaces/{code['id']}/ingest/uploads", json={"upload_ids": [uid2]}, headers=H(KEY_A))
    assert r2.status_code == 400 and "Documents workspace" in r2.json()["detail"]


def test_local_only_endpoints_are_refused(client):
    ws = client.post("/api/workspaces", json={"name": "L", "kind": "code"}, headers=H(KEY_A)).json()
    r = client.post(f"/api/workspaces/{ws['id']}/ingest/local", json={"path": str(SAMPLE)}, headers=H(KEY_A))
    assert r.status_code == 403 and "Upload a project folder" in r.json()["detail"]
    assert client.get("/api/fs/list", headers=H(KEY_A)).status_code == 403
    assert client.post("/api/connect", json={"path": str(SAMPLE)}, headers=H(KEY_A)).status_code == 403


def test_incomplete_or_foreign_upload_rejected(client):
    ws = client.post("/api/workspaces", json={"name": "U", "kind": "code"}, headers=H(KEY_A)).json()
    init = client.post("/api/uploads", json={"name": "x.zip", "size": 10_000_000}, headers=H(KEY_A)).json()
    client.put(f"/api/uploads/{init['upload_id']}/chunks/0", content=b"x" * 100, headers=H(KEY_A))
    r = client.post(f"/api/workspaces/{ws['id']}/ingest/uploads", json={"upload_ids": [init["upload_id"]]}, headers=H(KEY_A))
    assert r.status_code == 400 and "incomplete" in r.json()["detail"]
    assert client.put(f"/api/uploads/{init['upload_id']}/chunks/1", content=b"x", headers=H(KEY_B)).status_code == 404
    too_big = client.post("/api/uploads", json={"name": "huge.zip", "size": 10 ** 10}, headers=H(KEY_A))
    assert too_big.status_code == 413


def test_stale_running_job_can_be_taken_over(client):
    ws = client.post("/api/workspaces", json={"name": "Stale", "kind": "code"}, headers=H(KEY_A)).json()
    uid = chunked_upload(client, KEY_A, "shop.zip", sample_zip())
    job_id = client.post(f"/api/workspaces/{ws['id']}/ingest/uploads", json={"upload_ids": [uid]}, headers=H(KEY_A)).json()["job_id"]
    # simulate an instance that died mid-build long ago
    db.execute("UPDATE jobs SET status='running', heartbeat=? WHERE id=?", (time.time() - 3600, job_id))
    evs = run_job(client, KEY_A, job_id)
    assert evs[-1]["type"] == "job_done"


def test_repo_archive_urls():
    from nexmind.ingest.remote import archive_request

    gh = archive_request("https://github.com/psf/requests", None, "tok123456789")
    assert gh.full_url == "https://api.github.com/repos/psf/requests/zipball" and gh.headers["Authorization"] == "Bearer tok123456789"
    assert archive_request("https://github.com/a/b.git", None, None).full_url == "https://codeload.github.com/a/b/zip/HEAD"
    assert archive_request("https://github.com/a/b", "dev", None).full_url == "https://codeload.github.com/a/b/zip/dev"
    gl = archive_request("https://gitlab.com/group/sub/proj", "main", "glpat-x")
    assert "projects/group%2Fsub%2Fproj/repository/archive.zip?sha=main" in gl.full_url and gl.headers["Private-token"] == "glpat-x"
    az = archive_request("https://dev.azure.com/org/proj/_git/repo", None, None)
    assert "/org/proj/_apis/git/repositories/repo/items?" in az.full_url
    assert archive_request("https://bitbucket.org/o/r", None, None).full_url == "https://bitbucket.org/o/r/get/HEAD.zip"


@pytest.mark.skipif(os.environ.get("NEXMIND_NETWORK_TESTS") != "1", reason="set NEXMIND_NETWORK_TESTS=1 to download from GitHub")
def test_real_github_download(client):
    ws = client.post("/api/workspaces", json={"name": "gh", "kind": "code"}, headers=H(KEY_A)).json()
    r = client.post(f"/api/workspaces/{ws['id']}/ingest/git", json={"url": "https://github.com/pallets/itsdangerous"}, headers=H(KEY_A))
    assert r.status_code == 202, r.text
    evs = run_job(client, KEY_A, r.json()["job_id"])
    assert evs[-1]["type"] == "job_done" and evs[-1]["stats"]["files"] > 5
    bad = client.post(f"/api/workspaces/{ws['id']}/ingest/git", json={"url": "https://github.com/LoganthP/this-repo-does-not-exist-123", "token": "ghp_SECRETVALUE123"}, headers=H(KEY_A))
    assert bad.status_code == 400 and "SECRETVALUE" not in bad.text


def test_connect_script_live_mode_against_real_server(tmp_path):
    """The exact Vercel flow: download /connect.py with the browser key, pipe it into Python from another folder."""
    import socket

    import uvicorn

    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    th = threading.Thread(target=server.run, daemon=True)
    th.start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.05)
    try:
        import urllib.request

        script = urllib.request.urlopen(f"http://127.0.0.1:{port}/connect.py?k={KEY_A}").read()
        assert all(b < 128 for b in script) and KEY_A.encode() in script and f"127.0.0.1:{port}".encode() in script
        proj = tmp_path / "myproj"
        (proj / "node_modules" / "x").mkdir(parents=True)
        (proj / "node_modules" / "x" / "big.js").write_text("function junk(){}")
        (proj / "app.py").write_text("def main():\n    return helper()\n\ndef helper():\n    return 1\n")
        (proj / "README.md").write_text("# My project\nUses `helper`.\n")
        cwd = tempfile.mkdtemp()
        out = subprocess.run([sys.executable, "-", str(proj), "--no-watch"], input=script, cwd=cwd, capture_output=True, timeout=120)
        text = out.stdout.decode() + out.stderr.decode()
        assert out.returncode == 0, text
        assert "Connected myproj to NexMind" in text and "Graph ready" in text and "Traceback" not in text
        with TestClient(app) as c:
            sessions = c.get("/api/connect/sessions", headers=H(KEY_A)).json()["sessions"]
            assert sessions and sessions[-1]["name"] == "myproj"
            wsid = sessions[-1]["workspace_id"]
            assert c.get(f"/api/workspaces/{wsid}", headers=H(KEY_A)).json()["kind"] == "live"
            labels = {n["label"] for n in c.get(f"/api/workspaces/{wsid}/graph", headers=H(KEY_A)).json()["nodes"]}
            assert "helper" in labels and "junk" not in labels
            assert c.get("/api/connect/sessions", headers=H(KEY_B)).json()["sessions"] == []
        # second run re-indexes the same workspace instead of creating another
        (proj / "extra.py").write_text("def extra_fn():\n    return 2\n")
        out2 = subprocess.run([sys.executable, "-", str(proj), "--no-watch"], input=script, cwd=cwd, capture_output=True, timeout=120)
        assert out2.returncode == 0 and "re-indexing" in out2.stdout.decode()
        with TestClient(app) as c:
            labels = {n["label"] for n in c.get(f"/api/workspaces/{wsid}/graph", headers=H(KEY_A)).json()["nodes"]}
            assert "extra_fn" in labels
        # server down: one clear sentence, no traceback
        bad = subprocess.run([sys.executable, "-", str(proj), "--no-watch", "--server", "http://127.0.0.1:9"], input=script, capture_output=True, timeout=60)
        assert bad.returncode == 1 and b"Cannot reach NexMind" in bad.stdout and b"Traceback" not in bad.stderr
    finally:
        server.should_exit = True
        th.join(timeout=10)
