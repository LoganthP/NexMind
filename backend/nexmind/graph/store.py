"""Persistence + in-memory query structure for a workspace's knowledge graph."""
from __future__ import annotations

import re
import threading
from collections import defaultdict
from typing import Any

import networkx as nx

from ..db import DB, dumps, loads


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


class GraphStore:
    def __init__(self, db: DB):
        self.db = db
        self._cache: dict[str, WorkspaceGraph] = {}
        self._lock = threading.Lock()

    def invalidate(self, ws_id: str) -> None:
        with self._lock:
            self._cache.pop(ws_id, None)

    def save(self, ws_id: str, nodes: dict[str, dict], edges: dict[str, dict], chunks: list[dict], clusters: list[dict], insights: list[dict]) -> None:
        with self.db.tx() as c:
            for t in ("nodes", "edges", "chunks", "clusters"):
                c.execute(f"DELETE FROM {t} WHERE workspace_id=?", (ws_id,))
            c.executemany(
                "INSERT INTO nodes(workspace_id,id,type,label,props,x,y,z,cluster,score) VALUES(?,?,?,?,?,?,?,?,?,?)",
                [(ws_id, n["id"], n["type"], n["label"], dumps(n["props"]), n.get("x", 0), n.get("y", 0), n.get("z", 0), n.get("cluster", 0), n.get("score", 0)) for n in nodes.values()],
            )
            c.executemany(
                "INSERT INTO edges(workspace_id,id,src,dst,type,weight,props) VALUES(?,?,?,?,?,?,?)",
                [(ws_id, e["id"], e["src"], e["dst"], e["type"], e["weight"], dumps(e["props"])) for e in edges.values()],
            )
            c.executemany(
                "INSERT INTO chunks(workspace_id,id,source_id,node_id,kind,text,meta) VALUES(?,?,?,?,?,?,?)",
                [(ws_id, ch["id"], ch.get("source_id"), ch["node_id"], ch["kind"], ch["text"], dumps(ch.get("meta", {}))) for ch in chunks],
            )
            c.executemany(
                "INSERT INTO clusters(workspace_id,id,label,size,color,summary) VALUES(?,?,?,?,?,?)",
                [(ws_id, k["id"], k["label"], k["size"], k["color"], k["summary"]) for k in clusters],
            )
            c.execute("INSERT OR REPLACE INTO insights(workspace_id,data) VALUES(?,?)", (ws_id, dumps(insights)))
        self.invalidate(ws_id)

    def clear(self, ws_id: str) -> None:
        with self.db.tx() as c:
            for t in ("nodes", "edges", "chunks", "clusters", "insights"):
                c.execute(f"DELETE FROM {t} WHERE workspace_id=?", (ws_id,))
        self.invalidate(ws_id)

    def get(self, ws_id: str) -> WorkspaceGraph:
        with self._lock:
            wg = self._cache.get(ws_id)
        if wg is not None:
            return wg
        nodes = {
            r["id"]: {"id": r["id"], "type": r["type"], "label": r["label"], "props": loads(r["props"], {}), "x": r["x"], "y": r["y"], "z": r["z"], "cluster": r["cluster"], "score": r["score"]}
            for r in self.db.query("SELECT * FROM nodes WHERE workspace_id=?", (ws_id,))
        }
        edges = {
            r["id"]: {"id": r["id"], "src": r["src"], "dst": r["dst"], "type": r["type"], "weight": r["weight"], "props": loads(r["props"], {})}
            for r in self.db.query("SELECT * FROM edges WHERE workspace_id=?", (ws_id,))
        }
        clusters = self.db.query("SELECT id,label,size,color,summary FROM clusters WHERE workspace_id=? ORDER BY id", (ws_id,))
        ins = self.db.one("SELECT data FROM insights WHERE workspace_id=?", (ws_id,))
        wg = WorkspaceGraph(ws_id, nodes, edges, None, clusters, loads(ins["data"], []) if ins else [], db=self.db)
        with self._lock:
            self._cache[ws_id] = wg
        return wg
