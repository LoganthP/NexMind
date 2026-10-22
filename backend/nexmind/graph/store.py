"""Persistence + in-memory query structure for a workspace's knowledge graph."""
from __future__ import annotations

import gzip
import json
import re
import threading
import time
from collections import defaultdict
from typing import Any

import networkx as nx

from ..db import DB, dumps, loads, new_id, now


class WorkspaceGraph:
    def __init__(
        self,
        ws_id: str,
        nodes: dict[str, dict],
        edges: dict[str, dict],
        chunks: list[dict] | None,
        clusters: list[dict],
        insights: list[dict],
        db: DB | None = None,
    ):
        self.ws_id = ws_id
        self.nodes = nodes
        self.edges = edges
        self._chunks = chunks
        self._db = db
        self.clusters = clusters
        self.insights = insights
        self.out_adj: dict[str, list[dict]] = defaultdict(list)
        self.in_adj: dict[str, list[dict]] = defaultdict(list)
        for e in edges.values():
            self.out_adj[e["src"]].append(e)
            self.in_adj[e["dst"]].append(e)
        self._U: nx.Graph | None = None
        self._index = None
        self._lock = threading.Lock()
        self._label_index: dict[str, list[str]] | None = None
        self._cached_viz_nodes: list[dict] | None = None
        self._cached_viz_edges: list[dict] | None = None

    @property
    def chunks(self) -> list[dict]:
        if self._chunks is None:
            if self._db is not None:
                self._chunks = [
                    {"id": r["id"], "source_id": r["source_id"], "node_id": r["node_id"], "kind": r["kind"], "text": r["text"], "meta": loads(r["meta"], {})}
                    for r in self._db.query("SELECT * FROM chunks WHERE workspace_id=?", (self.ws_id,))
                ]
            else:
                self._chunks = []
        return self._chunks

    @chunks.setter
    def chunks(self, val: list[dict]) -> None:
        self._chunks = val

    # ------------------------------------------------------------------ helpers
    def undirected(self) -> nx.Graph:
        if self._U is None:
            U = nx.Graph()
            U.add_nodes_from(n for n, v in self.nodes.items() if v["type"] != "Process")
            for e in self.edges.values():
                if e["type"] == "HAS_STEP" or e["src"] not in U or e["dst"] not in U or e["src"] == e["dst"]:
                    continue
                w = 0.05 if (e["type"] == "CONTAINS" and self.nodes[e["src"]]["type"] == "Source") else min(max(e["weight"], 0.1), 3.0)
                if U.has_edge(e["src"], e["dst"]):
                    U[e["src"]][e["dst"]]["weight"] += w
                else:
                    U.add_edge(e["src"], e["dst"], weight=w)
            self._U = U
        return self._U

    def index(self):
        from ..rag.index import HybridIndex

        with self._lock:
            if self._index is None:
                self._index = HybridIndex(self.chunks)
            return self._index

    def neighbors(self, node_id: str, direction: str = "both") -> list[tuple[str, dict, str]]:
        """List of (neighbor_id, edge, 'out'|'in')."""
        res: list[tuple[str, dict, str]] = []
        if direction in ("both", "out"):
            res += [(e["dst"], e, "out") for e in self.out_adj.get(node_id, ()) if e["type"] != "HAS_STEP"]
        if direction in ("both", "in"):
            res += [(e["src"], e, "in") for e in self.in_adj.get(node_id, ()) if e["type"] != "HAS_STEP"]
        return res

    def find_nodes(self, query: str, limit: int = 8, types: set[str] | None = None) -> list[dict]:
        """Fuzzy node lookup by id, exact label, path or token overlap — used by search, chat and tracing."""
        q = query.strip()
        if not q:
            return []
        if q in self.nodes:
            return [self.nodes[q]]
        ql = q.lower()
        qtokens = set(re.findall(r"[a-z0-9]+", ql))
        scored: list[tuple[float, dict]] = []
        for n in self.nodes.values():
            if n["type"] == "Process" or (types and n["type"] not in types):
                continue
            label = n["label"].lower()
            path = (n["props"].get("path") or n["props"].get("file") or "").lower()
            s = 0.0
            if label == ql:
                s = 10
            elif ql and ql in label:
                s = 6 + len(ql) / max(len(label), 1)
            elif ql and path and ql in path:
                s = 4
            else:
                ltokens = set(re.findall(r"[a-z0-9]+", label))
                if qtokens and ltokens:
                    ov = len(qtokens & ltokens) / len(qtokens | ltokens)
                    s = ov * 3
            if s > 0:
                s += n.get("score", 0) * 0.8
                scored.append((s, n))
        scored.sort(key=lambda t: -t[0])
        return [n for _, n in scored[:limit]]


def _pack(obj) -> bytes:
    return gzip.compress(json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8"), compresslevel=6)


def _unpack(data) -> Any:
    if data is None:
        return None
    return json.loads(gzip.decompress(bytes(data)).decode("utf-8"))


class GraphStore:
    """Each workspace graph is stored as two compressed JSON blobs (core + chunks).

    One row read per load works well on a remote Postgres (Vercel/Neon) and on local SQLite alike.
    Every serverless instance keeps a cache and revalidates it with a tiny version query.
    """

    CHECK_TTL = 2.0  # seconds between version re-checks per workspace and instance

    def __init__(self, db: DB):
        self.db = db
        self._cache: dict[str, tuple[str, WorkspaceGraph]] = {}
        self._checked: dict[str, float] = {}
        self._lock = threading.Lock()

    def invalidate(self, ws_id: str) -> None:
        with self._lock:
            self._cache.pop(ws_id, None)
            self._checked.pop(ws_id, None)

    def _write(self, ws_id: str, core: dict, chunks: list[dict]) -> str:
        version = new_id("v")
        t = now()
        core_blob, chunk_blob = _pack(core), _pack(chunks)

        def tx(c):
            c.execute("DELETE FROM graphs WHERE workspace_id IN (?, ?)", (ws_id, ws_id + "#chunks"))
            c.execute("INSERT INTO graphs(workspace_id, version, data, updated_at) VALUES(?,?,?,?)", (ws_id, version, core_blob, t))
            c.execute("INSERT INTO graphs(workspace_id, version, data, updated_at) VALUES(?,?,?,?)", (ws_id + "#chunks", version, chunk_blob, t))
        self.db.run(tx)
        self.invalidate(ws_id)
        return version

    def save(self, ws_id: str, nodes: dict[str, dict], edges: dict[str, dict], chunks: list[dict], clusters: list[dict], insights: list[dict]) -> None:
        self._write(ws_id, {"nodes": nodes, "edges": edges, "clusters": clusters, "insights": insights}, chunks)

    def update_positions(self, ws_id: str, nodes: dict[str, dict]) -> None:
        """Rewrite the core blob only (used by relayout); chunks are kept."""
        wg = self.get(ws_id)
        core = {"nodes": nodes, "edges": wg.edges, "clusters": wg.clusters, "insights": wg.insights}
        self._write(ws_id, core, wg.chunks)

    def clear(self, ws_id: str) -> None:
        self.db.execute("DELETE FROM graphs WHERE workspace_id IN (?, ?)", (ws_id, ws_id + "#chunks"))
        self.invalidate(ws_id)

    def has_graph(self, ws_id: str) -> bool:
        return bool(self.db.one("SELECT 1 AS x FROM graphs WHERE workspace_id=?", (ws_id,))) or self._legacy_has(ws_id)

    def get(self, ws_id: str) -> WorkspaceGraph:
        t = time.time()
        with self._lock:
            cached = self._cache.get(ws_id)
            fresh = cached is not None and t - self._checked.get(ws_id, 0) < self.CHECK_TTL
        if fresh:
            return cached[1]  # type: ignore[index]
        row = self.db.one("SELECT version FROM graphs WHERE workspace_id=?", (ws_id,))
        if row is None and self._legacy_has(ws_id):
            self._migrate_legacy(ws_id)
            row = self.db.one("SELECT version FROM graphs WHERE workspace_id=?", (ws_id,))
        version = row["version"] if row else ""
        if cached is not None and cached[0] == version:
            with self._lock:
                self._checked[ws_id] = t
            return cached[1]
        wg = self._load(ws_id, version)
        with self._lock:
            self._cache[ws_id] = (version, wg)
            self._checked[ws_id] = t
        return wg

    def _load(self, ws_id: str, version: str) -> WorkspaceGraph:
        if not version:
            return WorkspaceGraph(ws_id, {}, {}, [], [], [])
        r = self.db.one("SELECT data FROM graphs WHERE workspace_id=?", (ws_id,))
        core = _unpack(r["data"]) if r else {}
        db = self.db

        class _Lazy(WorkspaceGraph):
            @property
            def chunks(self) -> list[dict]:  # type: ignore[override]
                if self._chunks is None:
                    rr = db.one("SELECT data FROM graphs WHERE workspace_id=?", (ws_id + "#chunks",))
                    self._chunks = _unpack(rr["data"]) if rr else []
                return self._chunks

            @chunks.setter
            def chunks(self, val: list[dict]) -> None:
                self._chunks = val

        return _Lazy(ws_id, core.get("nodes", {}), core.get("edges", {}), None, core.get("clusters", []), core.get("insights", []))

    # ------------------------------------------------------------------ legacy (row-per-node) databases
    def _legacy_has(self, ws_id: str) -> bool:
        if self.db.dialect != "sqlite" or not self.db.table_exists("nodes"):
            return False
        return bool(self.db.one("SELECT 1 AS x FROM nodes WHERE workspace_id=? LIMIT 1", (ws_id,)))

    def _migrate_legacy(self, ws_id: str) -> None:
        nodes = {
            r["id"]: {"id": r["id"], "type": r["type"], "label": r["label"], "props": loads(r["props"], {}), "x": r["x"], "y": r["y"], "z": r["z"], "cluster": r["cluster"], "score": r["score"]}
            for r in self.db.query("SELECT * FROM nodes WHERE workspace_id=?", (ws_id,))
        }
        edges = {
            r["id"]: {"id": r["id"], "src": r["src"], "dst": r["dst"], "type": r["type"], "weight": r["weight"], "props": loads(r["props"], {})}
            for r in self.db.query("SELECT * FROM edges WHERE workspace_id=?", (ws_id,))
        }
        chunks = [
            {"id": r["id"], "source_id": r["source_id"], "node_id": r["node_id"], "kind": r["kind"], "text": r["text"], "meta": loads(r["meta"], {})}
            for r in self.db.query("SELECT * FROM chunks WHERE workspace_id=?", (ws_id,))
        ] if self.db.table_exists("chunks") else []
        clusters = self.db.query("SELECT id,label,size,color,summary FROM clusters WHERE workspace_id=? ORDER BY id", (ws_id,)) if self.db.table_exists("clusters") else []
        ins = self.db.one("SELECT data FROM insights WHERE workspace_id=?", (ws_id,)) if self.db.table_exists("insights") else None
        self.save(ws_id, nodes, edges, chunks, clusters, loads(ins["data"], []) if ins else [])
