"""Tests for Quality Invariants on sample data:
- No Document labelled anonymous/untitled
- No empty labels
- No duplicate node ids
- No NaN positions
- No overlapping nodes (minimum distance)
- Cluster labels have no repeated words
- Anonymous PDF metadata handled cleanly
"""
from __future__ import annotations

import math
import re
from pathlib import Path
import numpy as np
import pytest
from fastapi.testclient import TestClient

from nexmind.main import app

FIXTURES = Path(__file__).resolve().parent / "fixtures"


@pytest.fixture(scope="module")
def sample_workspace():
    with TestClient(app) as client:
        r_ws = client.post("/api/workspaces", json={"name": "Quality Invariants WS", "kind": "code"})
        assert r_ws.status_code == 201
        ws_id = r_ws.json()["id"]

        code_zip = FIXTURES / "code_project.zip"
        docs_zip = FIXTURES / "docs_archive.zip"
        with open(code_zip, "rb") as f1, open(docs_zip, "rb") as f2:
            r_up = client.post(
                f"/api/workspaces/{ws_id}/ingest",
                files=[
                    ("files", ("code.zip", f1.read(), "application/zip")),
                    ("files", ("docs.zip", f2.read(), "application/zip")),
                ],
            )
        assert r_up.status_code == 202
        job_id = r_up.json()["job_id"]

        # Wait for completion
        for _ in range(120):
            import time
            j = client.get(f"/api/jobs/{job_id}").json()
            if j["status"] in ("done", "failed"):
                assert j["status"] == "done", j.get("error")
                break
            time.sleep(0.2)
        else:
            raise TimeoutError("Job timed out")

        yield client, ws_id


def test_quality_invariants_nodes_and_documents(sample_workspace):
    client, ws_id = sample_workspace
    g = client.get(f"/api/workspaces/{ws_id}/graph").json()
    nodes = g["nodes"]
    assert len(nodes) > 0

    seen_ids = set()
    for n in nodes:
        nid = n["id"]
        # Invariant 1: No duplicate node IDs
        assert nid not in seen_ids, f"Duplicate node ID: {nid}"
        seen_ids.add(nid)

        label = n["label"]
        # Invariant 2: No empty labels
        assert label is not None and len(label.strip()) > 0, f"Node {nid} has empty label"

        # Invariant 3: No Document labelled anonymous/untitled
        if n["type"] == "Document":
            low = label.lower().strip()
            assert low not in ("untitled", "anonymous", "document", "unknown"), f"Invalid document label: {label}"

        # Invariant 4: No NaN or infinite positions
        for c in ("x", "y", "z"):
            val = n[c]
            assert isinstance(val, (int, float))
            assert math.isfinite(val), f"Node {nid} coordinate {c} is not finite: {val}"
            assert not math.isnan(val), f"Node {nid} coordinate {c} is NaN"


def test_cluster_labels_no_repeated_words(sample_workspace):
    client, ws_id = sample_workspace
    clusters = client.get(f"/api/workspaces/{ws_id}/clusters").json()
    assert len(clusters) > 0

    for cl in clusters:
        label = cl["label"]
        assert label and len(label.strip()) > 0

        # Split into parts by delimiter if present
        parts = [p.strip() for p in label.split(" · ")]
        words_per_part = [re.findall(r"[A-Za-z0-9]+", p.lower()) for p in parts]

        # Check that no word of significant length is repeated across parts
        seen_words = set()
        for words in words_per_part:
            for w in words:
                if len(w) > 3:  # ignore short articles/prepositions
                    assert w not in seen_words, f"Cluster label '{label}' repeats word '{w}'"
                    seen_words.add(w)


def test_no_overlapping_nodes_min_distance(sample_workspace):
    client, ws_id = sample_workspace
    g = client.get(f"/api/workspaces/{ws_id}/graph").json()
    nodes = g["nodes"]

    # Extract 3D coordinates
    coords = np.array([[n["x"], n["y"], n["z"]] for n in nodes])
    n = len(coords)

    # Check pairwise distance between all distinct nodes
    # No two nodes should occupy the exact same point in 3D space
    from scipy.spatial.distance import pdist
    if n > 1:
        distances = pdist(coords)
        min_dist = float(distances.min())
        # Even with tight layouts, nodes must have non-zero separation
        assert min_dist > 0.001, f"Found overlapping nodes with distance {min_dist}"
