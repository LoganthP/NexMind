"""Graph endpoints: the data the 3D UI renders and the details shown on hover / click."""
from __future__ import annotations

import hashlib
import io
import logging
from collections import Counter, defaultdict, deque
from pathlib import Path

import networkx as nx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse, Response

from ..graph import analysis as A
from ..graph.store import WorkspaceGraph
from ..ingest.pipeline import _viz_edge, _viz_node
from ..rag.index import deprioritize_tests, focus_snippet
from ..state import db, store
from .workspaces import get_ws

log = logging.getLogger("nexmind.graph_routes")

router = APIRouter(prefix="/api/workspaces/{ws_id}", tags=["graph"])

NODE_COLORS = {
    "Source": "#f8fafc", "Folder": "#94a3b8", "File": "#38bdf8", "Document": "#fb923c", "Section": "#fdba74",
    "Class": "#a78bfa", "Function": "#34d399", "Method": "#6ee7b7", "Module": "#f472b6", "Concept": "#facc15",
    "Entity": "#f87171", "Process": "#22d3ee",
}
EDGE_COLORS = {
    "CONTAINS": "#475569", "DEFINES": "#64748b", "IMPORTS": "#60a5fa", "CALLS": "#34d399", "INHERITS": "#c084fc",
    "REFERENCES": "#fbbf24", "MENTIONS": "#fcd34d", "RELATED_TO": "#fb7185", "SIMILAR_TO": "#f97316",
    "RELATION": "#f43f5e", "HAS_STEP": "#22d3ee",
}
TYPE_PRIORITY = {"Source": 2.0, "Document": 0.9, "File": 0.8, "Folder": 0.6, "Class": 0.5, "Module": 0.4, "Concept": 0.3, "Entity": 0.3, "Process": 0.2}


def generate_offline_explanation(wg: WorkspaceGraph, n: dict, d: dict) -> str:
    typ = n.get("type", "Node")
    label = n.get("label", "")
    p = n.get("props", {})
    metrics = d.get("metrics", {})
    rel = d.get("relations", {})

    parts = []
    if typ in ("Function", "Method"):
        parent_cls = p.get("parent")
        owner_str = f" belonging to class `{parent_cls}`" if parent_cls else ""
        entry_str = "an application entry point" if p.get("is_entry") else ("a test component" if p.get("is_test") else f"a {typ.lower()}{owner_str}")
        sig = p.get("signature") or f"{label}()"
        parts.append(f"`{label}` is {entry_str} defined in `{p.get('file', '')}`.")
        if p.get("doc"):
            parts.append(f"**Description:** {p['doc'].strip()}")
        parts.append(f"**Signature:** `{sig}`")

        callers = [r["node"]["label"] for r in rel.get("CALLS", {}).get("in", [])[:5]]
        callees = [r["node"]["label"] for r in rel.get("CALLS", {}).get("out", [])[:5]]
        if callers:
            parts.append(f"**Called by:** {', '.join(f'`{c}`' for c in callers)}")
        if callees:
            parts.append(f"**Calls:** {', '.join(f'`{c}`' for c in callees)}")

        procs = d.get("processes", [])
        if procs:
            proc_names = [f"“{pr['label']}”" for pr in procs[:3]]
            parts.append(f"**Execution Flows:** Participates in {', '.join(proc_names)}.")

    elif typ == "Class":
        bases = p.get("bases") or []
        base_str = f" extending {', '.join(f'`{b}`' for b in bases)}" if bases else ""
        methods = [r["node"]["label"] for r in rel.get("DEFINES", {}).get("out", []) if r["node"]["type"] == "Method"][:6]
        parts.append(f"`{label}` is a class in `{p.get('file', '')}`{base_str}.")
        if p.get("doc"):
            parts.append(f"**Description:** {p['doc'].strip()}")
        if methods:
            parts.append(f"**Defined Methods:** {', '.join(f'`{m}`' for m in methods)}")
        instantiators = [r["node"]["label"] for r in rel.get("CALLS", {}).get("in", [])[:5]]
        if instantiators:
            parts.append(f"**Instantiated by:** {', '.join(f'`{i}`' for i in instantiators)}")

    elif typ == "File":
        loc = p.get("loc", 0)
        lang = p.get("language", "")
        defined = [r["node"]["label"] for r in rel.get("DEFINES", {}).get("out", []) if r["node"]["type"] in ("Function", "Method", "Class")][:8]
        imported = [r["node"]["label"] for r in rel.get("IMPORTS", {}).get("out", [])][:6]
        parts.append(f"`{label}` is a {lang} source file with {loc} lines of code at `{p.get('path', '')}`.")
        if defined:
            parts.append(f"**Symbols Defined:** {', '.join(f'`{s}`' for s in defined)}")
        if imported:
            parts.append(f"**Imports:** {', '.join(f'`{im}`' for im in imported)}")

    elif typ in ("Document", "Section"):
        parts.append(f"`{label}` is a {typ.lower()} from `{p.get('path', '')}`.")
        if p.get("preview"):
            parts.append(f"**Summary:** {p['preview'].strip()}")
        refs = [r["node"]["label"] for r in rel.get("REFERENCES", {}).get("out", [])[:5]]
        mentions = [r["node"]["label"] for r in rel.get("MENTIONS", {}).get("out", [])[:6]]
        if refs:
            parts.append(f"**Connected Code:** {', '.join(f'`{r}`' for r in refs)}")
        if mentions:
            parts.append(f"**Mentioned Concepts:** {', '.join(f'“{m}”' for m in mentions)}")

    elif typ in ("Concept", "Entity"):
        parts.append(f"“{label}” is an extracted domain {typ.lower()} across the knowledge base.")
        mentions_in = [r["node"]["label"] for r in rel.get("MENTIONS", {}).get("in", [])[:4]]
        related = [r["node"]["label"] for r in rel.get("RELATED_TO", {}).get("out", [])[:5]]
        if mentions_in:
            parts.append(f"**Referenced in:** {', '.join(f'`{m}`' for m in mentions_in)}")
        if related:
            parts.append(f"**Related Entities:** {', '.join(f'“{r}”' for r in related)}")

    elif typ == "Process":
        steps = p.get("steps", [])
        parts.append(f"“{label}” is an execution trace with {len(steps)} steps spanning {len(p.get('clusters', []))} functional cluster(s).")
        step_labels = [s.get("label", "") for s in (d.get("steps") or [])[:6]]
        if step_labels:
            parts.append(f"**Flow Path:** {' → '.join(f'`{s}`' for s in step_labels)}")

    else:
        parts.append(f"`{label}` ({typ}): {d.get('summary', '')}")

    deg = metrics.get("degree", 0)
    pr = metrics.get("pagerank", 0)
    if deg > 0 or pr > 0:
        parts.append(f"**Graph Connectivity:** Degree {deg}, PageRank {pr:.3f}.")

    return "\n\n".join(parts)


def wg_of(ws_id: str) -> WorkspaceGraph:
    get_ws(ws_id)
    return store.get(ws_id)


def brief(n: dict) -> dict:
    p = n["props"]
    return {"id": n["id"], "label": n["label"], "type": n["type"], "path": p.get("path") or p.get("file"), "cluster": n.get("cluster", 0), "score": n.get("score", 0)}


def node_or_404(wg: WorkspaceGraph, node_id: str) -> dict:
    n = wg.nodes.get(node_id)
    if not n:
        raise HTTPException(404, "Node not found")
    return n


def summarize(wg: WorkspaceGraph, n: dict) -> str:
    p, t = n["props"], n["type"]
    deg = Counter(e["type"] for e in wg.out_adj.get(n["id"], ())) + Counter("in:" + e["type"] for e in wg.in_adj.get(n["id"], ()))
    if t in ("Function", "Method", "Class"):
        base = p.get("doc") or p.get("signature") or n["label"]
        callers, callees = deg.get("in:CALLS", 0), deg.get("CALLS", 0)
        extra = f" · called by {callers}, calls {callees}" if (callers or callees) else ""
        return f"{base}{extra}"[:500]
    if t == "File":
        return (p.get("doc") or f"{p.get('language', '')} file · {p.get('loc', 0)} lines · defines {deg.get('DEFINES', 0)} symbols · imported by {deg.get('in:IMPORTS', 0)} files").strip()
    if t == "Document":
        bits = [str(p.get("doc_type", "document"))]
        if p.get("pages"):
            bits.append(f"{p['pages']} pages")
        bits.append(f"{p.get('sections', 0)} sections")
        return " · ".join(bits)
    if t == "Section":
        return p.get("preview", "")
    if t in ("Concept", "Entity"):
        secs = [e for e in wg.in_adj.get(n["id"], ()) if e["type"] == "MENTIONS"]
        docs = {wg.nodes[e["src"]]["props"].get("document") for e in secs if e["src"] in wg.nodes}
        rel = deg.get("RELATED_TO", 0) + deg.get("in:RELATED_TO", 0)
        return f"Mentioned in {len(secs)} section(s) across {len(docs)} document(s); linked to {rel} related ideas."
    if t == "Module":
        return f"External dependency imported by {deg.get('in:IMPORTS', 0)} file(s)."
    if t == "Process":
        return f"Execution flow of {p.get('step_count', 0)} steps, depth {p.get('max_depth', 0)}, spanning {len(p.get('clusters', []))} cluster(s)."
    if t == "Folder":
        return f"Folder containing {deg.get('CONTAINS', 0)} item(s)."
    if t == "Source":
        return f"{p.get('kind', 'source')} source · {deg.get('CONTAINS', 0)} top-level item(s)."
    return n["label"]


def read_code(source_id: str | None, rel: str | None, start: int | None, end: int | None, max_lines: int = 400) -> dict | None:
    if not source_id or not rel:
        return None
    src = db.one("SELECT path FROM sources WHERE id=?", (source_id,))
    if not src:
        return None
    root = Path(src["path"]).resolve()
    target = (root / rel).resolve()
    if root not in target.parents or not target.is_file():
        return None
    try:
        lines = target.read_text(encoding="utf-8", errors="ignore").splitlines()
    except OSError:
        return None
    s = max(1, start or 1)
    e = min(len(lines), end or (s + max_lines - 1), s + max_lines - 1)
    return {"path": rel, "start": s, "end": e, "total_lines": len(lines), "text": "\n".join(lines[s - 1 : e]), "truncated": (end or e) > e}


def relations(wg: WorkspaceGraph, nid: str, cap: int = 40) -> dict:
    out: dict[str, dict[str, list]] = defaultdict(lambda: {"out": [], "in": []})
    for nb, e, d in wg.neighbors(nid):
        out[e["type"]]["out" if d == "out" else "in"].append(
            {"edge_id": e["id"], "weight": round(e["weight"], 3), "label": e["props"].get("label"), "node": brief(wg.nodes[nb])}
        )
    for v in out.values():
        for k in ("out", "in"):
            v[k].sort(key=lambda r: -r["node"]["score"])
            v[k] = v[k][:cap]
    return dict(out)


def breadcrumb(wg: WorkspaceGraph, nid: str) -> list[dict]:
    chain = []
    cur = nid
    for _ in range(12):
        parents = [e for e in wg.in_adj.get(cur, ()) if e["type"] in ("CONTAINS", "DEFINES")]
        if not parents:
            break
        cur = parents[0]["src"]
        chain.append(brief(wg.nodes[cur]))
    return list(reversed(chain))


def check_etag(request: Request, ws: dict) -> tuple[str, bool]:
    updated_at = str(ws.get("updated_at", ""))
    query_str = str(request.url.query)
    raw = f"{ws.get('id', '')}:{updated_at}:{query_str}"
    tag = f'"{hashlib.sha1(raw.encode("utf-8")).hexdigest()}"'
    inm = request.headers.get("if-none-match")
    if inm:
        client_tags = [t.strip().lstrip("W/") for t in inm.split(",")]
        clean_tag = tag.strip().lstrip("W/")
        if clean_tag in client_tags or "*" in client_tags:
            return tag, True
    return tag, False


# ============================================================================ graph

@router.post("/relayout")
def relayout(ws_id: str):
    """Recompute 3D layout using the stored graph and updated cluster/anti-collision algorithms."""
    from ..events import hub

    wg = wg_of(ws_id)
    assign = {nid: n.get("cluster", 0) for nid, n in wg.nodes.items()}
    U = A.build_undirected(wg.nodes, wg.edges)
    pos = A.layout_3d(U, assign, nodes=wg.nodes)
    updates = [(x, y, z, ws_id, nid) for nid, (x, y, z) in pos.items()]
    with db.tx() as c:
        c.executemany("UPDATE nodes SET x=?, y=?, z=? WHERE workspace_id=? AND id=?", updates)
        for pn in wg.nodes.values():
            if pn["type"] == "Process":
                steps = [pos[s["node_id"]] for s in pn["props"].get("steps", []) if s["node_id"] in pos]
                if steps:
                    px = round(sum(s[0] for s in steps) / len(steps), 2)
                    py = round(sum(s[1] for s in steps) / len(steps), 2)
                    pz = round(sum(s[2] for s in steps) / len(steps), 2)
                    c.execute("UPDATE nodes SET x=?, y=?, z=? WHERE workspace_id=? AND id=?", (px, py, pz, ws_id, pn["id"]))
    store.invalidate(ws_id)
    hub.publish(ws_id, {"type": "relayout_done"})
    return {"nodes": len(wg.nodes)}


@router.get("/graph")
def get_graph(
    ws_id: str,
    request: Request,
    response: Response,
    types: str | None = Query(None, description="comma-separated node types to include"),
    edge_types: str | None = Query(None, description="comma-separated edge types to include"),
    cluster: int | None = None,
    max_nodes: int = Query(3000, ge=50, le=20000),
    min_score: float = Query(0.0, ge=0, le=1),
    focus: str | None = Query(None, description="node id: return its ego network"),
    depth: int = Query(2, ge=1, le=5),
    include_processes: bool = True,
):
    ws = get_ws(ws_id)
    tag, match = check_etag(request, ws)
    if match:
        return Response(status_code=304, headers={"ETag": tag, "Cache-Control": "no-cache"})
    response.headers["ETag"] = tag
    response.headers["Cache-Control"] = "no-cache"

    wg = store.get(ws_id)
    ids = set(wg.nodes)
    if focus:
        node_or_404(wg, focus)
        ids = {focus}
        frontier = deque([(focus, 0)])
        while frontier:
            cur, d = frontier.popleft()
            if d >= depth:
                continue
            for nb, e, _ in wg.neighbors(cur):
                if nb not in ids and wg.nodes[nb]["type"] != "Source":
                    ids.add(nb)
                    frontier.append((nb, d + 1))
    if types:
        tset = {t.strip() for t in types.split(",")}
        ids = {i for i in ids if wg.nodes[i]["type"] in tset}
    if not include_processes:
        ids = {i for i in ids if wg.nodes[i]["type"] != "Process"}
    if cluster is not None:
        ids = {i for i in ids if wg.nodes[i].get("cluster") == cluster}
    if min_score > 0:
        ids = {i for i in ids if wg.nodes[i].get("score", 0) >= min_score or wg.nodes[i]["type"] == "Source"}
    truncated = False
    if len(ids) > max_nodes:
        truncated = True
        ranked = sorted(ids, key=lambda i: -(wg.nodes[i].get("score", 0) + TYPE_PRIORITY.get(wg.nodes[i]["type"], 0)))
        ids = set(ranked[:max_nodes])

    if not types and not edge_types and cluster is None and min_score == 0 and not focus and include_processes and not truncated:
        if wg._cached_viz_nodes is None or wg._cached_viz_edges is None:
            wg._cached_viz_nodes = [_viz_node(wg.nodes[i]) for i in ids]
            wg._cached_viz_edges = [_viz_edge(e) for e in wg.edges.values()]
        nodes = wg._cached_viz_nodes
        links = wg._cached_viz_edges
    else:
        eset = {t.strip() for t in edge_types.split(",")} if edge_types else None
        links = [_viz_edge(e) for e in wg.edges.values() if e["src"] in ids and e["dst"] in ids and (eset is None or e["type"] in eset)]
        nodes = [_viz_node(wg.nodes[i]) for i in ids]

    return {
        "nodes": nodes, "links": links, "clusters": wg.clusters, "truncated": truncated,
        "total_nodes": len(wg.nodes), "total_edges": len(wg.edges), "status": ws["status"],
        "legend": {"node_colors": NODE_COLORS, "edge_colors": EDGE_COLORS},
    }


@router.get("/stats")
def stats(ws_id: str):
    ws = get_ws(ws_id)
    from ..db import loads

    s = loads(ws["stats"], {})
    return {"status": ws["status"], **s}


# ============================================================================ detail

@router.get("/nodes/{node_id}")
def node_detail(ws_id: str, node_id: str, brief_only: bool = Query(False, alias="brief")):
    wg = wg_of(ws_id)
    n = node_or_404(wg, node_id)
    p = n["props"]
    cl = next((c for c in wg.clusters if c["id"] == n.get("cluster")), None)
    d_out = sum(1 for e in wg.out_adj.get(node_id, ()) if e["type"] != "HAS_STEP")
    d_in = sum(1 for e in wg.in_adj.get(node_id, ()) if e["type"] != "HAS_STEP")
    base = {
        "id": n["id"], "type": n["type"], "label": n["label"], "cluster": cl, "score": n.get("score", 0),
        "summary": summarize(wg, n), "path": p.get("path") or p.get("file"), "language": p.get("language"),
        "degree": {"in": d_in, "out": d_out}, "color": NODE_COLORS.get(n["type"]),
        "position": {"x": n["x"], "y": n["y"], "z": n["z"]},
    }
    if brief_only is True:
        return base
    code = None
    if n["type"] in ("Function", "Method", "Class"):
        code = read_code(p.get("source_id"), p.get("file"), p.get("start"), p.get("end"))
    elif n["type"] == "File":
        code = read_code(p.get("source_id"), p.get("path"), 1, 300)
    procs = [
        {"id": pn["id"], "label": pn["label"], "step_count": pn["props"].get("step_count")}
        for pn in wg.nodes.values()
        if pn["type"] == "Process" and any(s["node_id"] == node_id for s in pn["props"].get("steps", []))
    ][:10]
    chunks = [c for c in wg.chunks if c["node_id"] == node_id][:3]
    return {
        **base,
        "props": {k: v for k, v in p.items() if k not in ("steps", "text")},
        "text": p.get("text"),  # full section text for Section nodes
        "code": code,
        "breadcrumb": breadcrumb(wg, node_id),
        "relations": relations(wg, node_id),
        "metrics": {"pagerank": n.get("score", 0), "betweenness": p.get("betweenness", 0), "degree": d_in + d_out},
        "processes": procs,
        "steps": [{**s, "label": wg.nodes[s["node_id"]]["label"], "type": wg.nodes[s["node_id"]]["type"]} for s in p.get("steps", [])] if n["type"] == "Process" else None,
        "passages": [{"id": c["id"], "text": c["text"][:700], "meta": c["meta"]} for c in chunks],
        "source_id": p.get("source_id"),
    }


@router.get("/nodes/{node_id}/neighbors")
def neighbors(ws_id: str, node_id: str, depth: int = Query(1, ge=1, le=3), limit: int = Query(120, ge=1, le=500)):
    wg = wg_of(ws_id)
    node_or_404(wg, node_id)
    seen = {node_id: 0}
    edges: dict[str, dict] = {}
    frontier = deque([node_id])
    while frontier and len(seen) < limit:
        cur = frontier.popleft()
        if seen[cur] >= depth:
            continue
        for nb, e, _ in sorted(wg.neighbors(cur), key=lambda t: -wg.nodes[t[0]].get("score", 0)):
            if wg.nodes[nb]["type"] == "Source":
                continue
            edges[e["id"]] = e
            if nb not in seen and len(seen) < limit:
                seen[nb] = seen[cur] + 1
                frontier.append(nb)
    return {"nodes": [{**_viz_node(wg.nodes[i]), "hop": h} for i, h in seen.items()], "links": [_viz_edge(e) for e in edges.values() if e["src"] in seen and e["dst"] in seen]}


@router.get("/edges/{edge_id}")
def edge_detail(ws_id: str, edge_id: str):
    wg = wg_of(ws_id)
    e = wg.edges.get(edge_id)
    if not e:
        raise HTTPException(404, "Edge not found")
    s, d = wg.nodes[e["src"]], wg.nodes[e["dst"]]
    verbs = {
        "CALLS": "calls", "IMPORTS": "imports", "INHERITS": "inherits from", "DEFINES": "defines", "CONTAINS": "contains",
        "REFERENCES": "references", "MENTIONS": "mentions", "RELATED_TO": "is related to", "SIMILAR_TO": "is similar to",
        "RELATION": e["props"].get("label") or "relates to", "HAS_STEP": "includes step",
    }
    explanation = f"{s['label']} {verbs.get(e['type'], e['type'].lower())} {d['label']}"
    if e["type"] == "CALLS":
        explanation += f" (confidence {round(e['weight'], 2)})"
    evidence: list[dict] = []
    if e["type"] == "CALLS":
        sp = s["props"]
        code = read_code(sp.get("source_id"), sp.get("file"), sp.get("start"), sp.get("end"), 400)
        if code:
            for i, line in enumerate(code["text"].splitlines()):
                if f"{d['label']}(" in line or f"{d['label']} (" in line:
                    evidence.append({"kind": "code", "path": code["path"], "line": code["start"] + i, "text": line.strip()[:240]})
                    if len(evidence) >= 3:
                        break
    elif e["type"] == "IMPORTS":
        sp = s["props"]
        code = read_code(sp.get("source_id"), sp.get("path"), 1, 200)
        if code:
            stem = Path(d["props"].get("path") or d["label"]).stem
            for i, line in enumerate(code["text"].splitlines()):
                if stem in line and ("import" in line or "require" in line or "include" in line or "use " in line or "from " in line):
                    evidence.append({"kind": "code", "path": code["path"], "line": i + 1, "text": line.strip()[:240]})
                    break
    elif e["type"] in ("MENTIONS", "REFERENCES"):
        evidence.append({"kind": "text", "path": s["props"].get("path"), "text": (s["props"].get("preview") or "")[:300]})
    elif e["type"] == "RELATED_TO":
        a = {x["src"] for x in wg.in_adj.get(e["src"], ()) if x["type"] == "MENTIONS"}
        b = {x["src"] for x in wg.in_adj.get(e["dst"], ()) if x["type"] == "MENTIONS"}
        for sec in list(a & b)[:3]:
            evidence.append({"kind": "text", "path": wg.nodes[sec]["props"].get("path"), "title": wg.nodes[sec]["label"], "text": (wg.nodes[sec]["props"].get("preview") or "")[:300]})
    elif e["type"] == "RELATION":
        ev = wg.nodes.get(e["props"].get("evidence", ""))
        if ev:
            evidence.append({"kind": "text", "path": ev["props"].get("path"), "title": ev["label"], "text": (ev["props"].get("preview") or "")[:300]})
    return {
        "id": e["id"], "type": e["type"], "weight": round(e["weight"], 3), "label": e["props"].get("label"), "explanation": explanation,
        "source": brief(s), "target": brief(d), "evidence": evidence, "props": e["props"], "color": EDGE_COLORS.get(e["type"]),
    }


def generate_offline_explanation(wg: WorkspaceGraph, n: dict, d: dict) -> str:
    """Generate an informative, architectural offline explanation when LLM is unavailable or fails."""
    p, t, label = n["props"], n["type"], n["label"]
    lines = []

    path = d.get("path") or p.get("path") or p.get("file")
    loc_str = f" in `{path}`" if path else ""
    cluster = d.get("cluster")
    cluster_name = cluster.get("name") if isinstance(cluster, dict) else None

    if t in ("Function", "Method"):
        sig = p.get("signature") or label
        lines.append(f"`{sig}` is a {t.lower()}{loc_str}.")
    elif t == "Class":
        lines.append(f"`{label}` is a class definition{loc_str}.")
    elif t == "File":
        lang = p.get("language") or "source"
        lines.append(f"`{label}` is a {lang} file{loc_str} ({p.get('loc', 0)} lines of code).")
    elif t == "Document":
        lines.append(f"`{label}` is a {p.get('doc_type', 'document')}{loc_str} with {p.get('sections', 0)} sections.")
    elif t == "Section":
        lines.append(f"Section `{label}`{loc_str}.")
    elif t in ("Concept", "Entity"):
        lines.append(f"`{label}` is a key {t.lower()} extracted from project documentation.")
    elif t == "Process":
        lines.append(f"`{label}` is an execution flow spanning {p.get('step_count', 0)} steps.")
    else:
        lines.append(f"`{label}` is a {t} node{loc_str}.")

    if cluster_name:
        lines.append(f"It belongs to the **{cluster_name}** cluster.")

    doc = p.get("doc") or p.get("preview")
    if doc:
        clean_doc = doc.strip().split("\n\n")[0].strip()
        if clean_doc:
            lines.append(f"\n> {clean_doc}")

    deg = d.get("degree") or {}
    d_in, d_out = deg.get("in", 0), deg.get("out", 0)
    score = n.get("score", 0)
    betweenness = p.get("betweenness", 0)
    metric_bits = []
    if d_in or d_out:
        metric_bits.append(f"{d_in} incoming and {d_out} outgoing graph connections")
    if score > 0.01:
        metric_bits.append(f"PageRank centrality {round(score, 3)}")
    if betweenness > 0.01:
        metric_bits.append(f"betweenness centrality {round(betweenness, 3)}")
    if metric_bits:
        lines.append("\n**Structural Role:** " + "; ".join(metric_bits) + ".")

    rel_map = d.get("relations") or {}
    rel_bullets = []
    for rel_type, sides in rel_map.items():
        if rel_type in ("CONTAINS",):
            continue
        out_nodes = [item["node"]["label"] for item in sides.get("out", []) if isinstance(item, dict) and "node" in item][:4]
        in_nodes = [item["node"]["label"] for item in sides.get("in", []) if isinstance(item, dict) and "node" in item][:4]
        if rel_type == "CALLS":
            if out_nodes:
                rel_bullets.append(f"- Calls: {', '.join(f'`{x}`' for x in out_nodes)}")
            if in_nodes:
                rel_bullets.append(f"- Called by: {', '.join(f'`{x}`' for x in in_nodes)}")
        elif rel_type == "IMPORTS":
            if out_nodes:
                rel_bullets.append(f"- Imports: {', '.join(f'`{x}`' for x in out_nodes)}")
            if in_nodes:
                rel_bullets.append(f"- Imported by: {', '.join(f'`{x}`' for x in in_nodes)}")
        elif rel_type == "DEFINES" and out_nodes:
            rel_bullets.append(f"- Defines: {', '.join(f'`{x}`' for x in out_nodes)}")
        elif rel_type == "REFERENCES":
            if out_nodes:
                rel_bullets.append(f"- References: {', '.join(f'`{x}`' for x in out_nodes)}")
            if in_nodes:
                rel_bullets.append(f"- Referenced by: {', '.join(f'`{x}`' for x in in_nodes)}")
        elif rel_type in ("RELATED_TO", "MENTIONS"):
            items = out_nodes or in_nodes
            if items:
                rel_bullets.append(f"- Related entities/topics: {', '.join(f'`{x}`' for x in items)}")

    if rel_bullets:
        lines.append("\n**Key Relationships:**\n" + "\n".join(rel_bullets[:6]))

    procs = d.get("processes") or []
    if procs:
        flow_names = ", ".join(f"`{pr['label']}`" for pr in procs[:3])
        lines.append(f"\n**Execution Flows:** Participates in {flow_names}.")

    return "\n".join(lines).strip()


@router.get("/nodes/{node_id}/explain")
async def explain_node(ws_id: str, node_id: str):
    """Natural-language explanation of a node using its code/text plus graph context (LLM if configured)."""
    import asyncio

    from ..rag.llm import get_llm

    wg = wg_of(ws_id)
    n = node_or_404(wg, node_id)
    d = node_detail(ws_id, node_id, brief_only=False)
    summary = d.get("summary") or "No description available."
    offline_exp = generate_offline_explanation(wg, n, d)
    llm = get_llm()
    if not llm.available:
        return {"explanation": offline_exp, "provider": "offline"}
    rel_lines = []
    for et, sides in (d.get("relations") or {}).items():
        if et in ("CONTAINS",):
            continue
        if not isinstance(sides, dict):
            continue
        for side, items in sides.items():
            if not isinstance(items, list):
                continue
            for it in items[:4]:
                if isinstance(it, dict) and "node" in it:
                    lbl = it["node"].get("label", "")
                    typ = it["node"].get("type", "")
                    rel_lines.append(f"{et} {'→' if side == 'out' else '←'} {lbl} ({typ})")
    body = (d.get("code") or {}).get("text") or d.get("text") or summary
    body = str(body)
    prompt = f"Explain this {n.get('type', 'Node')} `{n.get('label', '')}` in 4-6 sentences for a developer new to the project.\n\nCONTENT:\n{body[:3500]}\n\nGRAPH RELATIONS:\n" + "\n".join(rel_lines[:20])
    try:
        text = await asyncio.to_thread(llm.complete, "You explain code and documents clearly and concisely.", prompt)
        return {"explanation": text.strip(), "provider": llm.provider}
    except Exception as e:  # noqa: BLE001
        return {"explanation": offline_exp, "provider": "offline", "error": f"{type(e).__name__}: {e}"}


# ============================================================================ discovery

@router.get("/search")
def search(ws_id: str, q: str = Query(..., min_length=1), k: int = Query(8, ge=1, le=30)):
    wg = wg_of(ws_id)
    nodes = wg.find_nodes(q, limit=min(k, 12))
    passages = []
    for h in deprioritize_tests(wg.index().search(q, k=k * 2), q)[:k]:
        ch = h["chunk"]
        node = wg.nodes.get(ch["node_id"])
        if node:
            passages.append({"score": h["score"], "kind": ch["kind"], "node": brief(node), "snippet": focus_snippet(ch["text"], q, 360), "meta": ch["meta"]})
    ids = [n["id"] for n in nodes] + [p["node"]["id"] for p in passages]
    return {"query": q, "nodes": [brief(n) for n in nodes], "passages": passages, "highlight": {"nodes": list(dict.fromkeys(ids))}}


@router.get("/impact")
def impact(ws_id: str, node: str, direction: str = Query("upstream", pattern="^(upstream|downstream)$"), depth: int = Query(4, ge=1, le=8)):
    wg = wg_of(ws_id)
    node_or_404(wg, node)
    return A.impact(wg, node, "up" if direction == "upstream" else "down", depth)


@router.get("/trace")
def trace(ws_id: str, source: str, target: str):
    wg = wg_of(ws_id)
    node_or_404(wg, source)
    node_or_404(wg, target)
    return A.trace(wg, source, target)


@router.get("/processes")
def processes(ws_id: str, request: Request, response: Response):
    ws = get_ws(ws_id)
    tag, match = check_etag(request, ws)
    if match:
        return Response(status_code=304, headers={"ETag": tag, "Cache-Control": "no-cache"})
    response.headers["ETag"] = tag
    response.headers["Cache-Control"] = "no-cache"

    wg = store.get(ws_id)
    out = []
    for n in wg.nodes.values():
        if n["type"] == "Process":
            steps = n["props"]["steps"]
            out.append({
                "id": n["id"], "label": n["label"], "entry": brief(wg.nodes[n["props"]["entry"]]), "step_count": n["props"]["step_count"],
                "max_depth": n["props"]["max_depth"], "clusters": n["props"]["clusters"],
                "steps": [{**s, "label": wg.nodes[s["node_id"]]["label"], "type": wg.nodes[s["node_id"]]["type"], "path": wg.nodes[s["node_id"]]["props"].get("file")} for s in steps],
                "highlight": {"nodes": [s["node_id"] for s in steps], "edges": [s["via"] for s in steps if s["via"]]},
            })
    out.sort(key=lambda p: -p["step_count"])
    return out


@router.get("/clusters")
def clusters(ws_id: str, request: Request, response: Response):
    ws = get_ws(ws_id)
    tag, match = check_etag(request, ws)
    if match:
        return Response(status_code=304, headers={"ETag": tag, "Cache-Control": "no-cache"})
    response.headers["ETag"] = tag
    response.headers["Cache-Control"] = "no-cache"

    wg = store.get(ws_id)
    counts: dict[int, Counter] = defaultdict(Counter)
    for n in wg.nodes.values():
        counts[n.get("cluster", 0)][n["type"]] += 1
    out = []
    for c in wg.clusters:
        members = sorted((n for n in wg.nodes.values() if n.get("cluster") == c["id"] and n["type"] != "Process"), key=lambda n: -n.get("score", 0))
        cx = [sum(n[a] for n in members) / max(len(members), 1) for a in ("x", "y", "z")]
        out.append({**c, "types": dict(counts[c["id"]]), "top_nodes": [brief(n) for n in members[:6]], "center": {"x": round(cx[0], 2), "y": round(cx[1], 2), "z": round(cx[2], 2)}})
    return out


@router.get("/insights")
def insights(ws_id: str, request: Request, response: Response):
    ws = get_ws(ws_id)
    tag, match = check_etag(request, ws)
    if match:
        return Response(status_code=304, headers={"ETag": tag, "Cache-Control": "no-cache"})
    response.headers["ETag"] = tag
    response.headers["Cache-Control"] = "no-cache"

    return store.get(ws_id).insights


@router.get("/sources/{source_id}/tree")
def tree(ws_id: str, source_id: str):
    """File tree (Source → Folder → File/Document) for a sidebar explorer."""
    wg = wg_of(ws_id)
    root = next((n for n in wg.nodes.values() if n["type"] == "Source" and n["props"].get("source_id") == source_id), None)
    if not root:
        raise HTTPException(404, "Source not found")

    def build(nid: str, depth: int) -> dict:
        n = wg.nodes[nid]
        kids = [e["dst"] for e in wg.out_adj.get(nid, ()) if e["type"] == "CONTAINS" and wg.nodes[e["dst"]]["type"] in ("Folder", "File", "Document")]
        kids.sort(key=lambda k: (wg.nodes[k]["type"] != "Folder", wg.nodes[k]["label"].lower()))
        return {**brief(n), "children": [build(k, depth + 1) for k in kids] if depth < 12 else []}

    return build(root["id"], 0)


# ============================================================================ export

@router.get("/export")
def export(ws_id: str, format: str = Query("json", pattern="^(json|graphml|cypher)$")):
    wg = wg_of(ws_id)
    if format == "json":
        import json

        body = json.dumps({"nodes": list(wg.nodes.values()), "edges": list(wg.edges.values()), "clusters": wg.clusters}, ensure_ascii=False)
        return Response(body, media_type="application/json", headers={"Content-Disposition": f'attachment; filename="nexmind-{ws_id}.json"'})
    if format == "graphml":
        G = nx.DiGraph()
        for n in wg.nodes.values():
            G.add_node(n["id"], label=n["label"], type=n["type"], cluster=int(n.get("cluster", 0)), score=float(n.get("score", 0)))
        for e in wg.edges.values():
            G.add_edge(e["src"], e["dst"], key=e["id"], type=e["type"], weight=float(e["weight"]))
        buf = io.BytesIO()
        nx.write_graphml(G, buf)
        return Response(buf.getvalue(), media_type="application/xml", headers={"Content-Disposition": f'attachment; filename="nexmind-{ws_id}.graphml"'})
    # cypher: import into Neo4j / Memgraph / Kuzu-compatible tools
    def esc(v: object) -> str:
        return "'" + str(v).replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ") + "'"

    lines = ["// NexMind export — run in Neo4j Browser / cypher-shell", "CREATE CONSTRAINT IF NOT EXISTS FOR (n:Node) REQUIRE n.id IS UNIQUE;"]
    for n in wg.nodes.values():
        lines.append(f"MERGE (n:Node:{n['type']} {{id:{esc(n['id'])}}}) SET n.label={esc(n['label'])}, n.cluster={int(n.get('cluster', 0))}, n.score={float(n.get('score', 0))}, n.path={esc(n['props'].get('path') or n['props'].get('file') or '')};")
    for e in wg.edges.values():
        lines.append(f"MATCH (a:Node {{id:{esc(e['src'])}}}), (b:Node {{id:{esc(e['dst'])}}}) MERGE (a)-[r:{e['type']} {{id:{esc(e['id'])}}}]->(b) SET r.weight={float(e['weight'])};")
    return PlainTextResponse("\n".join(lines), headers={"Content-Disposition": f'attachment; filename="nexmind-{ws_id}.cypher"'})
