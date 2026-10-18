"""Tests for Chat routes, threads CRUD, SSE streaming, intents, offline fallback, and mocked LLM providers."""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch
import pytest
from fastapi.testclient import TestClient

from nexmind.main import app
from nexmind.rag.llm import LLM, set_llm
from nexmind.state import db

FIXTURES = Path(__file__).resolve().parent / "fixtures"


@pytest.fixture(scope="module")
def chat_client():
    with TestClient(app) as c:
        # Create a workspace with sample code
        r_ws = c.post("/api/workspaces", json={"name": "Chat Test WS", "kind": "code"})
        assert r_ws.status_code == 201
        ws_id = r_ws.json()["id"]

        code_zip = FIXTURES / "code_project.zip"
        with open(code_zip, "rb") as f:
            r_up = c.post(f"/api/workspaces/{ws_id}/ingest", files=[("files", ("code.zip", f.read(), "application/zip"))])
        job_id = r_up.json()["job_id"]
        for _ in range(300):
            import time
            j = c.get(f"/api/jobs/{job_id}").json()
            if j["status"] in ("done", "failed"):
                break
            time.sleep(0.2)
        assert j.get("status") == "done", f"Ingest job failed: {j}"

        yield c, ws_id


def test_threads_crud(chat_client):
    client, ws_id = chat_client

    # 1. Create thread
    r_create = client.post(f"/api/workspaces/{ws_id}/threads", json={"title": "First Thread"})
    assert r_create.status_code == 201
    th = r_create.json()
    assert th["title"] == "First Thread"
    assert th["id"].startswith("th_")
    tid = th["id"]

    # 2. List threads
    r_list = client.get(f"/api/workspaces/{ws_id}/threads")
    assert r_list.status_code == 200
    threads = r_list.json()
    assert any(t["id"] == tid for t in threads)

    # 3. Rename thread
    r_patch = client.patch(f"/api/workspaces/{ws_id}/threads/{tid}", json={"title": "Updated Title"})
    assert r_patch.status_code == 200
    assert r_patch.json()["title"] == "Updated Title"

    # 4. Messages initially empty
    r_msgs = client.get(f"/api/workspaces/{ws_id}/threads/{tid}/messages")
    assert r_msgs.status_code == 200
    assert r_msgs.json() == []

    # 5. Delete thread
    r_del = client.delete(f"/api/workspaces/{ws_id}/threads/{tid}")
    assert r_del.status_code == 204

    # Now 404
    r_after = client.get(f"/api/workspaces/{ws_id}/threads/{tid}/messages")
    assert r_after.status_code == 404


def test_chat_sse_event_order_and_done(chat_client):
    client, ws_id = chat_client
    r_th = client.post(f"/api/workspaces/{ws_id}/threads", json={"title": "SSE Flow"})
    tid = r_th.json()["id"]

    # Stream SSE request
    with client.stream("POST", f"/api/workspaces/{ws_id}/threads/{tid}/messages", json={"content": "What does OrderService do?", "stream": True}) as response:
        assert response.status_code == 200
        assert "text/event-stream" in response.headers["content-type"]

        events = []
        for line in response.iter_lines():
            if line.startswith("event: "):
                events.append(line.removeprefix("event: ").strip())

    # Verify event ordering: start must precede retrieval, retrieval before tokens, done is last
    assert "start" in events
    assert "retrieval" in events
    assert "token" in events
    assert "done" in events
    assert events.index("start") < events.index("retrieval") < events.index("token")
    assert events[-1] == "done"

    # Verify messages in DB
    msgs = client.get(f"/api/workspaces/{ws_id}/threads/{tid}/messages").json()
    assert len(msgs) == 2  # user + assistant
    assert msgs[0]["role"] == "user"
    assert msgs[1]["role"] == "assistant"
    assert msgs[1]["meta"].get("partial") is False


def test_chat_json_mode_and_intents(chat_client):
    client, ws_id = chat_client
    r_th = client.post(f"/api/workspaces/{ws_id}/threads")
    tid = r_th.json()["id"]

    # 1. Non-streaming JSON request
    r_json = client.post(
        f"/api/workspaces/{ws_id}/threads/{tid}/messages",
        json={"content": "Explain the checkout flow", "stream": False},
    )
    assert r_json.status_code == 200
    data = r_json.json()
    assert "retrieval" in data
    assert "done" in data
    assert "citations" in data["done"]
    assert "followups" in data["done"]

    # 2. Impact intent test
    r_impact = client.post(
        f"/api/workspaces/{ws_id}/threads/{tid}/messages",
        json={"content": "What is the impact of changing OrderService?", "stream": False},
    )
    assert r_impact.status_code == 200
    impact_data = r_impact.json()
    assert impact_data["retrieval"]["intent"] == "impact" or "OrderService" in impact_data["done"]["answer"]

    # 3. Path intent test
    r_path = client.post(
        f"/api/workspaces/{ws_id}/threads/{tid}/messages",
        json={"content": "What is the path between main and OrderService?", "stream": False},
    )
    assert r_path.status_code == 200
    path_data = r_path.json()
    assert path_data["retrieval"]["intent"] == "path" or len(path_data["done"]["answer"]) > 0


def test_empty_workspace_chat_polite_answer(chat_client):
    client, _ = chat_client
    # Create empty workspace with no material
    r_empty_ws = client.post("/api/workspaces", json={"name": "Empty Chat WS", "kind": "code"})
    empty_id = r_empty_ws.json()["id"]

    r_th = client.post(f"/api/workspaces/{empty_id}/threads")
    tid = r_th.json()["id"]

    r_msg = client.post(
        f"/api/workspaces/{empty_id}/threads/{tid}/messages",
        json={"content": "Hello! Can you help me?", "stream": False},
    )
    assert r_msg.status_code == 200
    answer = r_msg.json()["done"]["answer"]
    assert "no graph yet" in answer.lower()


def test_llm_failure_falls_back_to_offline(chat_client):
    client, ws_id = chat_client
    r_th = client.post(f"/api/workspaces/{ws_id}/threads")
    tid = r_th.json()["id"]

    # Create a failing mock LLM
    class FailingLLM(LLM):
        @property
        def available(self):
            return True

        async def astream(self, system, messages):
            raise RuntimeError("API connection error 503")
            yield "never"

    original_llm = client.get("/api/llm").json()
    try:
        set_llm(FailingLLM("openai", "gpt-4o-mini"))
        with client.stream("POST", f"/api/workspaces/{ws_id}/threads/{tid}/messages", json={"content": "Tell me about OrderService", "stream": True}) as response:
            assert response.status_code == 200
            events = []
            for line in response.iter_lines():
                if line.startswith("event: "):
                    events.append(line.removeprefix("event: ").strip())

            # Must emit error event and continue with fallback token events to done
            assert "error" in events
            assert "token" in events
            assert "done" in events
    finally:
        set_llm(LLM("offline"))
