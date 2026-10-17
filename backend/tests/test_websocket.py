"""Tests for WebSocket endpoints: handshake, hello, ping/pong, replay_graph, ordering, 4404 on unknown workspace, slow consumer."""
from __future__ import annotations

import time
from pathlib import Path
import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from nexmind.main import app

FIXTURES = Path(__file__).resolve().parent / "fixtures"


@pytest.fixture(scope="module")
def ws_client():
    with TestClient(app) as c:
        # Create a workspace with sample code
        r_ws = c.post("/api/workspaces", json={"name": "WS Test WS", "kind": "code"})
        assert r_ws.status_code == 201
        ws_id = r_ws.json()["id"]

        code_zip = FIXTURES / "code_project.zip"
        with open(code_zip, "rb") as f:
            r_up = c.post(f"/api/workspaces/{ws_id}/ingest", files=[("files", ("code.zip", f.read(), "application/zip"))])
        job_id = r_up.json()["job_id"]
        for _ in range(120):
            j = c.get(f"/api/jobs/{job_id}").json()
            if j["status"] in ("done", "failed"):
                break
            time.sleep(0.2)

        yield c, ws_id


def test_websocket_unknown_workspace_closes_4404(ws_client):
    client, _ = ws_client
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with client.websocket_connect("/ws/workspaces/ws_nonexistent_workspace_999") as sock:
            sock.receive_json()
    assert exc_info.value.code == 4404


def test_websocket_hello_and_ping_pong(ws_client):
    client, ws_id = ws_client
    with client.websocket_connect(f"/ws/workspaces/{ws_id}") as sock:
        # 1. First event must be hello
        hello = sock.receive_json()
        assert hello["type"] == "hello"
        assert hello["workspace_id"] == ws_id
        assert "status" in hello

        # 2. Ping / Pong
        sock.send_json({"type": "ping"})
        pong = sock.receive_json()
        assert pong["type"] == "pong"


def test_websocket_replay_graph_and_edge_ordering(ws_client):
    client, ws_id = ws_client
    with client.websocket_connect(f"/ws/workspaces/{ws_id}") as sock:
        hello = sock.receive_json()
        assert hello["type"] == "hello"

        # Request replay_graph
        sock.send_json({"type": "replay_graph"})

        start_ev = sock.receive_json()
        assert start_ev["type"] == "graph_stream_start"
        assert start_ev.get("replay") is True
        assert start_ev["nodes"] > 0

        received_node_ids = set()
        ready_ev = None

        while True:
            msg = sock.receive_json()
            mtype = msg["type"]
            if mtype == "graph_batch":
                # Collect nodes
                batch_nodes = msg.get("nodes", [])
                for n in batch_nodes:
                    received_node_ids.add(n["id"])

                # Invariant: Edges in this batch must only reference nodes already sent
                batch_edges = msg.get("edges", [])
                for e in batch_edges:
                    src = e.get("source") or e.get("src")
                    dst = e.get("target") or e.get("dst")
                    assert src in received_node_ids, f"Edge src {src} sent before node was sent"
                    assert dst in received_node_ids, f"Edge dst {dst} sent before node was sent"
            elif mtype == "graph_ready":
                ready_ev = msg
                break
            else:
                continue

        assert ready_ev is not None
        assert ready_ev["type"] == "graph_ready"
        assert ready_ev.get("replay") is True


def test_websocket_job_lifecycle_events(ws_client):
    client, ws_id = ws_client
    with client.websocket_connect(f"/ws/workspaces/{ws_id}") as sock:
        hello = sock.receive_json()
        assert hello["type"] == "hello"

        # Trigger rebuild
        r_reb = client.post(f"/api/workspaces/{ws_id}/rebuild")
        assert r_reb.status_code == 202

        # Receive events until job_done
        types_seen = set()
        deadline = time.time() + 30.0
        while time.time() < deadline:
            ev = sock.receive_json()
            types_seen.add(ev["type"])
            if ev["type"] in ("job_done", "job_failed"):
                break

        assert "job_queued" in types_seen or "job_started" in types_seen
        assert "job_done" in types_seen
