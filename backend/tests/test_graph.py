"""Tests for Graph routes, queries, payload invariants, node details, analytics, exports, and fs."""
from __future__ import annotations

import io
import math
import networkx as nx
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

from nexmind.main import app

FIXTURES = Path(__file__).resolve().parent / "fixtures"


@pytest.fixture(scope="module")
def populated_client():
    with TestClient(app) as c:
        # Create workspace with both code and docs
        r_ws = c.post("/api/workspaces", json={"name": "Graph Test Workspace", "kind": "code"})
        assert r_ws.status_code == 201
        ws_id = r_ws.json()["id"]

        code_zip = FIXTURES / "code_project.zip"
        docs_zip = FIXTURES / "docs_archive.zip"
        with open(code_zip, "rb") as f1, open(docs_zip, "rb") as f2:
            r_up = c.post(
                f"/api/workspaces/{ws_id}/ingest",
                files=[
                    ("files", ("code.zip", f1.read(), "application/zip")),
                    ("files", ("docs.zip", f2.read(), "application/zip")),
                ],
            )
        assert r_up.status_code == 202
        job_id = r_up.json()["job_id"]
        # Poll until done
        for _ in range(120):
            import time
            j = c.get(f"/api/jobs/{job_id}").json()
            if j["status"] in ("done", "failed"):
                assert j["status"] == "done", j.get("error")
                break
            time.sleep(0.2)
        else:
            raise TimeoutError("Graph build timed out")

        yield c, ws_id


def test_graph_payload_invariants_and_filters(populated_client):
    client, ws_id = populated_client

    # 1. Full graph query
    r = client.get(f"/api/workspaces/{ws_id}/graph")
    assert r.status_code == 200
    g = r.json()
    assert "nodes" in g
    assert "links" in g
    assert "clusters" in g

    nodes = g["nodes"]
    links = g["links"]
    node_ids = {n["id"] for n in nodes}

    # Invariant A: Unique node IDs
    assert len(node_ids) == len(nodes), "Duplicate node IDs detected in graph payload"

    # Invariant B: Link endpoints exist in nodes
    for lk in links:
        src = lk.get("source") or lk.get("src")
        dst = lk.get("target") or lk.get("dst")
        assert src in node_ids, f"Link source {src} does not exist in nodes"
        assert dst in node_ids, f"Link target {dst} does not exist in nodes"

    # Invariant C: Finite 3D coordinates (no NaN, no Inf)
    for n in nodes:
        for coord in ("x", "y", "z"):
            val = n[coord]
            assert isinstance(val, (int, float)) and math.isfinite(val), f"Node {n['id']} has non-finite {coord}: {val}"

    # Invariant D: Centrality/score present
    for n in nodes:
        assert "score" in n
        assert "cluster" in n

    # 2. Filtering by type
    r_filtered = client.get(f"/api/workspaces/{ws_id}/graph?types=Function,Class")
    assert r_filtered.status_code == 200
    fg = r_filtered.json()
    for n in fg["nodes"]:
        assert n["type"] in ("Function", "Class")

    # 3. Filtering by max_nodes (min valid is 50)
    r_capped = client.get(f"/api/workspaces/{ws_id}/graph?max_nodes=50")
    assert r_capped.status_code == 200
    assert len(r_capped.json()["nodes"]) <= 50

    # 4. Truncation flag
    assert "truncated" in g


def test_node_details_and_explain(populated_client):
    client, ws_id = populated_client
    g = client.get(f"/api/workspaces/{ws_id}/graph").json()
    assert len(g["nodes"]) > 0

    # Test nodes of different types
    tested_types = set()
    for n in g["nodes"]:
        nid = n["id"]
        ntype = n["type"]
        if ntype in tested_types and len(tested_types) >= 4:
            continue
        tested_types.add(ntype)

        # Brief / standard node detail
        r_node = client.get(f"/api/workspaces/{ws_id}/nodes/{nid}")
        assert r_node.status_code == 200
        detail = r_node.json()
        assert detail["id"] == nid
        assert "label" in detail
        assert "type" in detail
        assert "relations" in detail
        assert "metrics" in detail

        # Neighbors
        r_nb = client.get(f"/api/workspaces/{ws_id}/nodes/{nid}/neighbors")
        assert r_nb.status_code == 200
        nb_data = r_nb.json()
        assert "nodes" in nb_data
        assert "links" in nb_data

        # Node explain (offline mode fallback)
        r_exp = client.get(f"/api/workspaces/{ws_id}/nodes/{nid}/explain")
        assert r_exp.status_code == 200
        exp_data = r_exp.json()
        assert "explanation" in exp_data
        assert len(exp_data["explanation"]) > 0

    # 404 on nonexistent node
    r_bad_node = client.get(f"/api/workspaces/{ws_id}/nodes/node_nonexistent_xyz")
    assert r_bad_node.status_code == 404


def test_edge_details(populated_client):
    client, ws_id = populated_client
    g = client.get(f"/api/workspaces/{ws_id}/graph").json()
    assert len(g["links"]) > 0

    # Check first few edges
    for lk in g["links"][:5]:
        eid = lk["id"]
        r_edge = client.get(f"/api/workspaces/{ws_id}/edges/{eid}")
        assert r_edge.status_code == 200
        ed = r_edge.json()
        assert ed["id"] == eid
        assert "type" in ed
        assert "evidence" in ed
        assert "source" in ed
        assert "target" in ed

    # 404 on bad edge
    r_bad_edge = client.get(f"/api/workspaces/{ws_id}/edges/edge_nonexistent")
    assert r_bad_edge.status_code == 404


def test_search_impact_trace_analytics(populated_client):
    client, ws_id = populated_client

    # 1. Search
    r_search = client.get(f"/api/workspaces/{ws_id}/search?q=order")
    assert r_search.status_code == 200
    res = r_search.json()
    assert "nodes" in res
    assert "passages" in res
    assert len(res["nodes"]) > 0

    # Empty search: min_length=1 triggers 422 validation error
    r_empty_search = client.get(f"/api/workspaces/{ws_id}/search?q=")
    assert r_empty_search.status_code == 422

    # 2. Impact analysis
    g = client.get(f"/api/workspaces/{ws_id}/graph").json()
    first_node = g["nodes"][0]["id"]
    r_impact_up = client.get(f"/api/workspaces/{ws_id}/impact?node={first_node}&direction=upstream&depth=2")
    assert r_impact_up.status_code == 200
    impact_data = r_impact_up.json()
    assert "levels" in impact_data
    assert "risk" in impact_data

    r_impact_down = client.get(f"/api/workspaces/{ws_id}/impact?node={first_node}&direction=downstream&depth=2")
    assert r_impact_down.status_code == 200

    # 3. Trace (path finding)
    if len(g["nodes"]) >= 2:
        src_id = g["nodes"][0]["id"]
        dst_id = g["nodes"][1]["id"]
        r_trace = client.get(f"/api/workspaces/{ws_id}/trace?source={src_id}&target={dst_id}")
        assert r_trace.status_code == 200
        t_data = r_trace.json()
        assert "found" in t_data

    # 4. Processes, Clusters, Insights, Stats
    for endpoint in ("processes", "clusters", "insights", "stats"):
        r_ep = client.get(f"/api/workspaces/{ws_id}/{endpoint}")
        assert r_ep.status_code == 200, f"{endpoint} returned {r_ep.status_code}"


def test_sources_tree_and_raw_file_security(populated_client):
    client, ws_id = populated_client
    sources = client.get(f"/api/workspaces/{ws_id}/sources").json()
    assert len(sources) > 0
    sid = sources[0]["id"]

    # Tree
    r_tree = client.get(f"/api/workspaces/{ws_id}/sources/{sid}/tree")
    assert r_tree.status_code == 200
    assert "label" in r_tree.json()

    # Raw file serving with path traversal blocked
    r_raw_traversal = client.get(f"/api/workspaces/{ws_id}/sources/{sid}/raw?path=../../../../etc/passwd")
    assert r_raw_traversal.status_code in (400, 404)

    r_raw_win_traversal = client.get(f"/api/workspaces/{ws_id}/sources/{sid}/raw?path=..\\..\\windows\\system32\\calc.exe")
    assert r_raw_win_traversal.status_code in (400, 404)


def test_graph_export_json_graphml_cypher(populated_client):
    client, ws_id = populated_client

    # 1. JSON Export
    r_json = client.get(f"/api/workspaces/{ws_id}/export?format=json")
    assert r_json.status_code == 200
    assert "attachment" in r_json.headers.get("content-disposition", "")
    assert "nodes" in r_json.json()
    assert "edges" in r_json.json()

    # 2. GraphML Export: Load with networkx.read_graphml
    r_gml = client.get(f"/api/workspaces/{ws_id}/export?format=graphml")
    assert r_gml.status_code == 200
    assert "attachment" in r_gml.headers.get("content-disposition", "")
    buf = io.BytesIO(r_gml.content)
    parsed_nx = nx.read_graphml(buf)
    assert parsed_nx.number_of_nodes() > 0

    # 3. Cypher Export: Validate statements syntax
    r_cypher = client.get(f"/api/workspaces/{ws_id}/export?format=cypher")
    assert r_cypher.status_code == 200
    assert "attachment" in r_cypher.headers.get("content-disposition", "")
    lines = r_cypher.text.splitlines()
    assert len(lines) > 2
    assert lines[0].startswith("//")
    for line in lines:
        if line.startswith("//"):
            continue
        assert line.strip().endswith(";"), f"Cypher line missing semicolon: {line}"


def test_relayout_endpoint(populated_client):
    client, ws_id = populated_client
    r_relayout = client.post(f"/api/workspaces/{ws_id}/relayout")
    assert r_relayout.status_code == 200
    assert "nodes" in r_relayout.json()
    assert r_relayout.json()["nodes"] > 0


def test_fs_list_and_check(populated_client):
    client, _ = populated_client

    # fs/list on fixtures directory
    r_list = client.get(f"/api/fs/list?path={FIXTURES}&files=1")
    assert r_list.status_code == 200
    data = r_list.json()
    assert "entries" in data
    assert "crumbs" in data
    assert "roots" in data

    # Verify directories precede files
    entries = data["entries"]
    seen_file = False
    for e in entries:
        if e["kind"] == "file":
            seen_file = True
        elif e["kind"] == "dir":
            assert not seen_file, "Directories must come before files"

    # fs/check on valid folder
    r_check = client.get(f"/api/fs/check?path={FIXTURES / 'sample_code'}")
    assert r_check.status_code == 200
    check_data = r_check.json()
    assert check_data["ok"] is True
    assert check_data["has_code"] is True

    # fs/check on missing folder
    r_missing = client.get("/api/fs/check?path=C:\\nonexistent_dir_999999")
    assert r_missing.status_code in (400, 200)
    if r_missing.status_code == 200:
        assert r_missing.json()["ok"] is False
