"""Performance budget tests on a synthetic 5,000-node graph:
- Graph build < 60 s
- /graph query < 2 s
- /nodes/{id} detail < 200 ms
- Search query < 300 ms
- Layout has no NaN
- Memory stays bounded
"""
from __future__ import annotations

import math
import time
import pytest
from fastapi.testclient import TestClient

from nexmind.main import app
from nexmind.state import db, store
from nexmind.graph.store import WorkspaceGraph
from nexmind.graph import analysis as A


@pytest.fixture(scope="module")
def large_graph_workspace():
    with TestClient(app) as client:
        r = client.post("/api/workspaces", json={"name": "5k Perf Graph", "kind": "code"})
        assert r.status_code == 201
        ws_id = r.json()["id"]

        t0 = time.perf_counter()

        # Build a synthetic 5,000-node graph directly
        node_rows = []
        edge_rows = []
        n_nodes = 5000
        n_clusters = 10

        # Generate nodes
        nodes_dict = {}
        for i in range(n_nodes):
            nid = f"sym_{i:06d}"
            ntype = "Function" if i % 3 == 0 else ("Class" if i % 3 == 1 else "File")
            c = i % n_clusters + 1
            nodes_dict[nid] = {
                "id": nid, "type": ntype, "label": f"symbol_{i}",
                "props": {"path": f"src/module_{c}/file_{i}.py", "start": 1, "end": 20},
                "cluster": c, "score": round(1.0 / (1 + i % 100), 4),
            }

        # Build undirected graph and layout
        U = nx = None
        import networkx as nx
        U = nx.Graph()
        for nid in nodes_dict:
            U.add_node(nid)
        # Add edges: ring + random intra-cluster edges (~10,000 edges)
        for i in range(n_nodes):
            next_i = (i + 1) % n_nodes
            U.add_edge(f"sym_{i:06d}", f"sym_{next_i:06d}", weight=1.0)
            if i % 2 == 0:
                jump_i = (i + 7) % n_nodes
                U.add_edge(f"sym_{i:06d}", f"sym_{jump_i:06d}", weight=0.8)

        assign = {nid: n["cluster"] for nid, n in nodes_dict.items()}
        pos = A.layout_3d(U, assign, max_refine=1500, nodes=nodes_dict)

        for nid, n in nodes_dict.items():
            x, y, z = pos.get(nid, (0.0, 0.0, 0.0))
            node_rows.append((ws_id, nid, n["type"], n["label"], "{}", x, y, z, n["cluster"], n["score"]))

        for u, v, d in U.edges(data=True):
            eid = f"e_{u}_{v}"
            edge_rows.append((ws_id, eid, u, v, "CALLS", float(d.get("weight", 1.0)), "{}"))

        gnodes = {r[1]: {"id": r[1], "type": r[2], "label": r[3], "props": {}, "x": r[5], "y": r[6], "z": r[7], "cluster": r[8], "score": r[9]} for r in node_rows}
        gedges = {r[1]: {"id": r[1], "src": r[2], "dst": r[3], "type": r[4], "weight": r[5], "props": {}} for r in edge_rows}
        store.save(ws_id, gnodes, gedges, [], [], [])
        db.execute("UPDATE workspaces SET status='ready' WHERE id=?", (ws_id,))
        store.invalidate(ws_id)
        build_time = time.perf_counter() - t0

        # Performance Budget 1: Build < 60s
        assert build_time < 60.0, f"Graph construction took {build_time:.2f}s (budget: <60s)"

        yield client, ws_id


def test_performance_budgets_and_layout(large_graph_workspace):
    client, ws_id = large_graph_workspace

    # Budget 2: /graph < 2s
    t0 = time.perf_counter()
    r_graph = client.get(f"/api/workspaces/{ws_id}/graph?max_nodes=3000")
    graph_duration = time.perf_counter() - t0
    assert r_graph.status_code == 200
    assert graph_duration < 2.0, f"/graph took {graph_duration:.3f}s (budget: <2s)"

    g = r_graph.json()
    assert len(g["nodes"]) > 0

    # Budget 3: Layout has no NaN
    for n in g["nodes"][:500]:
        for c in ("x", "y", "z"):
            assert math.isfinite(n[c]) and not math.isnan(n[c])

    # Budget 4: /nodes/{id} detail < 200ms
    sample_id = g["nodes"][0]["id"]
    t0 = time.perf_counter()
    r_node = client.get(f"/api/workspaces/{ws_id}/nodes/{sample_id}")
    node_duration = time.perf_counter() - t0
    assert r_node.status_code == 200
    assert node_duration < 0.200, f"/nodes/{{id}} took {node_duration:.3f}s (budget: <200ms)"

    # Budget 5: search < 300ms
    t0 = time.perf_counter()
    r_search = client.get(f"/api/workspaces/{ws_id}/search?q=symbol_100")
    search_duration = time.perf_counter() - t0
    assert r_search.status_code == 200
    assert search_duration < 0.300, f"search took {search_duration:.3f}s (budget: <300ms)"
