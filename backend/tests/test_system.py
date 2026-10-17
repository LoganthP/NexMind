"""Tests for System endpoints: /api/health, /api/llm, /connect.py, CORS, PNA, SPA fallback, loopback."""
from __future__ import annotations

import os
import sys
import pytest
from fastapi.testclient import TestClient

from nexmind.main import app
from nexmind.config import settings


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_health_endpoint_fields(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    data = r.json()
    assert data["app"] == "nexmind"
    assert data["status"] == "ok"
    assert "version" in data
    assert "capabilities" in data
    caps = data["capabilities"]
    assert "local_paths" in caps
    assert "git_token" in caps
    assert "websocket" in caps
    assert "sse_chat" in caps
    assert data["platform"] == sys.platform
    assert "python" in data
    assert "python_executable" in data
    assert os.path.exists(data["python_executable"])
    assert "install_dir" in data
    assert "llm" in data
    assert "embeddings" in data
    assert "limits" in data
    assert "workspaces" in data

    # Security: No secret tokens or API keys exposed in health
    dump = str(data).lower()
    assert "api_key" not in dump
    assert "secret" not in dump
    assert "token" not in dump or dump.count("token") <= 2  # caps['git_token'] is boolean


def test_llm_get_and_put(client):
    r = client.get("/api/llm")
    assert r.status_code == 200
    data = r.json()
    assert "provider" in data
    assert "available_providers" in data
    assert set(data["available_providers"]) == {"offline", "anthropic", "openai", "ollama"}

    # Switch to offline
    r_put = client.put("/api/llm", json={"provider": "offline"})
    assert r_put.status_code == 200
    assert r_put.json()["provider"] == "offline"

    # Switch to mock
    r_put2 = client.put("/api/llm", json={"provider": "mock", "model": "test-model"})
    assert r_put2.status_code == 200
    assert r_put2.json()["provider"] == "mock"

    # Invalid provider rejected with 400
    r_bad = client.put("/api/llm", json={"provider": "invalid_provider_xyz"})
    assert r_bad.status_code == 400
    assert "provider must be offline" in r_bad.json()["detail"]

    # Restore to offline
    client.put("/api/llm", json={"provider": "offline"})


def test_connect_script_endpoint(client):
    r = client.get("/connect.py")
    assert r.status_code == 200
    assert "text/plain" in r.headers.get("content-type", "")
    script = r.text

    # ASCII-only
    assert script.isascii(), "connect.py must be ASCII-only"

    # Python syntax is valid
    compile(script, "<connect.py>", "exec")

    # Injected base URL
    assert "http://testserver" in script
    assert "def main(" in script

    # Self-contained: No 3rd-party dependencies
    for dep in ("requests", "httpx", "aiohttp", "flask", "fastapi", "pydantic"):
        assert f"import {dep}" not in script


def test_cors_and_private_network_preflight(client):
    # Standard CORS preflight
    r = client.options(
        "/api/health",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert r.status_code == 200
    assert r.headers.get("access-control-allow-origin") in ("*", "http://localhost:5173")

    # Chrome Private Network Access preflight
    r_pna = client.options(
        "/api/health",
        headers={
            "Origin": "https://nexmind.vercel.app",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Private-Network": "true",
        },
    )
    assert r_pna.status_code == 200
    assert r_pna.headers.get("access-control-allow-private-network") == "true"


def test_spa_fallback(client):
    # Root path
    r_root = client.get("/")
    assert r_root.status_code == 200
    assert "html" in r_root.headers.get("content-type", "")

    # Client-side app paths
    r_app = client.get("/app")
    assert r_app.status_code == 200
    assert "html" in r_app.headers.get("content-type", "")

    r_ws = client.get("/app/w/ws_xyz123")
    assert r_ws.status_code == 200
    assert "html" in r_ws.headers.get("content-type", "")

    # Non-existent API route must return JSON 404, NOT html
    r_api_404 = client.get("/api/nope")
    assert r_api_404.status_code == 404
    assert "application/json" in r_api_404.headers.get("content-type", "")
    assert r_api_404.json()["detail"] == "Not found"


def test_loopback_restriction():
    # When request comes from a non-local client IP, loopback-only endpoints must return 403
    remote_client = TestClient(app, client=("192.168.1.100", 54321))

    r_connect = remote_client.post("/api/connect", json={"path": "C:\\fake"})
    assert r_connect.status_code == 403
    assert "only available from the machine running NexMind" in r_connect.json()["detail"]

    r_fs = remote_client.get("/api/fs/list")
    assert r_fs.status_code == 403

    r_check = remote_client.get("/api/fs/check?path=/")
    assert r_check.status_code == 403
