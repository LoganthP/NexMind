"""Graph analytics: communities ("brain lobes"), centrality, 3D layout, execution flows, impact, tracing, insights."""
from __future__ import annotations

import colorsys
import hashlib
import math
import re
from collections import Counter, defaultdict, deque
from typing import Any

import networkx as nx
import numpy as np
from scipy.spatial import cKDTree

DEP_EDGES = {"CALLS", "IMPORTS", "INHERITS", "REFERENCES"}
SYMBOL_TYPES = {"Function", "Method", "Class"}

EDGE_CLUSTER_WEIGHT = {
    "DEFINES": 1.6, "CALLS": 1.0, "INHERITS": 1.0, "IMPORTS": 0.9, "REFERENCES": 0.7, "MENTIONS": 0.6,
    "RELATED_TO": 0.8, "SIMILAR_TO": 1.0, "CONTAINS": 0.5, "RELATION": 1.0, "HAS_STEP": 0.0,
}


def sid(prefix: str, key: str) -> str:
    return f"{prefix}_{hashlib.sha1(key.encode('utf-8', 'ignore')).hexdigest()[:12]}"


def edge_id(src: str, dst: str, etype: str) -> str:
    return hashlib.sha1(f"{src}|{etype}|{dst}".encode()).hexdigest()[:14]


# ============================================================================ clustering / scoring

def build_undirected(nodes: dict[str, dict], edges: dict[str, dict]) -> nx.Graph:
    U = nx.Graph()
    for nid, n in nodes.items():
        if n["type"] != "Process":
            U.add_node(nid)
    for e in edges.values():
        if e["type"] == "HAS_STEP" or e["src"] == e["dst"]:
            continue
        if e["src"] not in U or e["dst"] not in U:
            continue
        base = EDGE_CLUSTER_WEIGHT.get(e["type"], 0.5)
        if e["type"] == "CONTAINS" and nodes[e["src"]]["type"] == "Source":
            base = 0.02
        w = base * min(max(float(e.get("weight", 1.0)), 0.1), 3.0)
        if w <= 0:
            continue
        if U.has_edge(e["src"], e["dst"]):
            U[e["src"]][e["dst"]]["weight"] += w
        else:
            U.add_edge(e["src"], e["dst"], weight=w)
    return U


def detect_clusters(U: nx.Graph) -> dict[str, int]:
    if U.number_of_nodes() == 0:
        return {}
    if U.number_of_edges() == 0:
        return {n: 0 for n in U.nodes}
    comms = nx.community.louvain_communities(U, weight="weight", seed=42, resolution=1.0)
    comms = sorted(comms, key=len, reverse=True)
    assign: dict[str, int] = {}
    small: list[set] = []
    cid = 1
    for c in comms:
        if len(c) >= 3:
            for n in c:
                assign[n] = cid
            cid += 1
        else:
            small.append(c)
    for c in small:
        votes: Counter = Counter()
        for n in c:
            for m, d in U[n].items():
                if m in assign:
                    votes[assign[m]] += d.get("weight", 1.0)
        target = votes.most_common(1)[0][0] if votes else 0
        for n in c:
            assign[n] = target
    return assign


def cluster_color(i: int) -> str:
    if i == 0:
        return "#6b7280"
    h = ((i * 137.508) % 360) / 360.0
    r, g, b = colorsys.hls_to_rgb(h, 0.60, 0.72)
    return "#{:02x}{:02x}{:02x}".format(int(r * 255), int(g * 255), int(b * 255))


def label_clusters(nodes: dict[str, dict], assign: dict[str, int]) -> list[dict]:
    members: dict[int, list[dict]] = defaultdict(list)
    for nid, c in assign.items():
        members[c].append(nodes[nid])
    out = []
    for cid, ms in sorted(members.items()):
        types = Counter(m["type"] for m in ms)
        dirs: Counter = Counter()
        for m in ms:
            if m["type"] in ("File", "Document"):
                p = m["props"].get("path", "")
                d = p.rsplit("/", 1)[0] if "/" in p else ""
                if d:
                    dirs[d.split("/")[-1]] += 1
        top = sorted(ms, key=lambda m: -m.get("score", 0))
        concepts = [m["label"] for m in top if m["type"] in ("Concept", "Entity")][:2]
        syms = [m["label"] for m in top if m["type"] in SYMBOL_TYPES][:2]
        files = [m["label"] for m in top if m["type"] in ("File", "Document")][:1]
        code_like = types["File"] + types["Function"] + types["Method"] + types["Class"]
        doc_like = types["Document"] + types["Section"] + types["Concept"] + types["Entity"]
        def _clean_cluster_label(parts: list[str]) -> str:
            res: list[str] = []
            seen_words: set[str] = set()
            for p in parts:
                p_clean = p.strip()
                if not p_clean:
                    continue
                words = re.findall(r"[A-Za-z0-9]+", p_clean.lower())
                sig_words = [w for w in words if len(w) > 2]
                if sig_words and all(w in seen_words for w in sig_words):
                    continue
                for w in sig_words:
                    seen_words.add(w)
                res.append(p_clean)
            return " · ".join(res) if res else (parts[0] if parts else "Module")

        if cid == 0:
            label = "Loose ends"
        elif doc_like > code_like and concepts:
            label = _clean_cluster_label(concepts)
        elif dirs:
            dir_name = dirs.most_common(1)[0][0]
            label = _clean_cluster_label([dir_name] + ([syms[0]] if syms else []))
        elif syms:
            label = _clean_cluster_label(syms)
        elif concepts:
            label = _clean_cluster_label(concepts)
        else:
            label = (files or [top[0]["label"]])[0]
        desc = ", ".join(f"{v} {k.lower()}{'s' if v != 1 else ''}" for k, v in types.most_common(4))
        out.append({
            "id": cid, "label": label[:48], "size": len(ms), "color": cluster_color(cid),
            "summary": f"{len(ms)} nodes — {desc}",
        })
    return out


def compute_scores(U: nx.Graph) -> tuple[dict[str, float], dict[str, float]]:
    if U.number_of_nodes() == 0:
        return {}, {}
    try:
        pr = nx.pagerank(U, weight="weight", max_iter=100)
    except Exception:
        deg = dict(U.degree(weight="weight"))
        total = sum(deg.values()) or 1
        pr = {k: v / total for k, v in deg.items()}
    mx = max(pr.values()) or 1.0
    score = {k: v / mx for k, v in pr.items()}
    n = U.number_of_nodes()
    bt: dict[str, float] = {k: 0.0 for k in U.nodes}
    if n <= 6000 and U.number_of_edges() > 0:
        try:
            bt = nx.betweenness_centrality(U, k=min(25, n), seed=3)
        except Exception:
            pass
    return score, bt


# ============================================================================ 3D layout

def layout_3d(
    U: nx.Graph,
    assign: dict[str, int],
    max_refine: int = 1500,
    seed: int = 7,
    nodes: dict[str, dict] | None = None,
) -> dict[str, tuple[float, float, float]]:
    ids = list(U.nodes)
    n = len(ids)
    if n == 0:
        return {}
    rng = np.random.default_rng(seed)
    cids = sorted({c for c in assign.values() if c != 0})
    k = max(len(cids), 1)
    # Increase distance between cluster centers by 20%
    R = (70.0 * (k ** (1 / 3)) + 40.0) * 1.2
    centers: dict[int, np.ndarray] = {}
    cluster_dirs: dict[int, np.ndarray] = {}
    golden = math.pi * (3 - math.sqrt(5))
    for i, c in enumerate(cids):  # Fibonacci sphere: evenly spread brain lobes
        y = 1 - (2 * (i + 0.5) / k)
        r = math.sqrt(max(0.0, 1 - y * y))
        th = golden * i
        udir = np.array([math.cos(th) * r, y, math.sin(th) * r])
        norm = float(np.linalg.norm(udir)) or 1.0
        udir /= norm
        cluster_dirs[c] = udir
        centers[c] = udir * R

    sizes = Counter(assign.values())

    # Map cluster 0 "loose" nodes to the cluster of their strongest-linked neighbour in U
    loose_target_cluster: dict[str, int] = {}
    for nid in ids:
        if assign.get(nid, 0) == 0:
            best_c = 0
            best_w = -1.0
            for nb, d in U[nid].items():
                nb_c = assign.get(nb, 0)
                if nb_c != 0:
                    w = d.get("weight", 1.0)
                    if w > best_w:
                        best_w = w
                        best_c = nb_c
            if best_c == 0 and cids:
                best_c = cids[0]
            loose_target_cluster[nid] = best_c

    # Check for document-heavy concentric mode
    is_docs_heavy = False
    if nodes:
        doc_count = sum(1 for nid in ids if nodes.get(nid, {}).get("type") in ("Document", "Section", "Concept", "Entity"))
        code_count = sum(1 for nid in ids if nodes.get(nid, {}).get("type") in ("Function", "Method", "Class"))
        if doc_count > code_count and doc_count > 0:
            is_docs_heavy = True

    pos = np.zeros((n, 3))
    if is_docs_heavy and nodes:
        # Concentric layering for document-heavy graphs:
        # radius by type: Source 0, Document 70, Concept 130, Section 190, Entity 250 (world units)
        shell_radii = {
            "Source": 0.0,
            "Document": 70.0,
            "Concept": 130.0,
            "Section": 190.0,
            "Entity": 250.0,
            "Folder": 30.0,
        }
        for i, nid in enumerate(ids):
            ntype = nodes.get(nid, {}).get("type", "Document")
            r_shell = shell_radii.get(ntype, 160.0)
            c = assign.get(nid, 0)
            if c == 0:
                c = loose_target_cluster.get(nid, cids[0] if cids else 1)
            udir = cluster_dirs.get(c, np.array([0.0, 1.0, 0.0]))
            c_size = sizes.get(c, 1)
            jitter = rng.normal(size=3) * (0.05 + 0.02 * (c_size ** (1 / 3)))
            dvec = udir + jitter
            dnorm = float(np.linalg.norm(dvec)) or 1.0
            pos[i] = (dvec / dnorm) * r_shell
    else:
        # Organic layout: seeded positions around cluster centers
        for i, nid in enumerate(ids):
            c = assign.get(nid, 0)
            if c == 0:
                target_c = loose_target_cluster.get(nid, cids[0] if cids else 0)
                if target_c in centers:
                    sigma = 6.0 * (sizes[target_c] ** (1 / 3)) + 4.0
                    pos[i] = centers[target_c] + rng.normal(size=3) * sigma
                else:
                    pos[i] = rng.normal(size=3) * 15.0
            else:
                sigma = 5.0 * (sizes[c] ** (1 / 3)) + 4.0
                pos[i] = centers[c] + rng.normal(size=3) * sigma

        scale = max(float(np.abs(pos).max()), 1.0)
        if n <= max_refine and U.number_of_edges() > 0:
            try:
                init = {nid: pos[i] / scale for i, nid in enumerate(ids)}
                # 15 iterations: fast convergence since positions are already cluster-seeded
                refined = nx.spring_layout(U, dim=3, pos=init, weight="weight", iterations=15, seed=seed, scale=None, center=None)
                for i, nid in enumerate(ids):
                    pos[i] = np.asarray(refined[nid]) * scale
            except Exception:
                pass
        else:
            index = {nid: i for i, nid in enumerate(ids)}
            for _ in range(2):
                new = pos.copy()
                for nid in ids:
                    nb = [index[m] for m in U[nid]]
                    if nb:
                        new[index[nid]] = 0.75 * pos[index[nid]] + 0.25 * pos[nb].mean(axis=0)
                pos = new

        # Cluster fusion: move every node 40% of the way toward its cluster centroid
        cluster_members: dict[int, list[int]] = defaultdict(list)
        for i, nid in enumerate(ids):
            c = assign.get(nid, 0)
            if c != 0:
                cluster_members[c].append(i)
            else:
                target_c = loose_target_cluster.get(nid, 0)
                if target_c != 0:
                    cluster_members[target_c].append(i)

        cluster_centroids: dict[int, np.ndarray] = {}
        for c, idxs in cluster_members.items():
            if idxs:
                cluster_centroids[c] = pos[idxs].mean(axis=0)

        for i, nid in enumerate(ids):
            c = assign.get(nid, 0)
            target_c = c if c != 0 else loose_target_cluster.get(nid, 0)
            if target_c in cluster_centroids:
                cen = cluster_centroids[target_c]
                pos[i] = pos[i] + 0.40 * (cen - pos[i])

    # Anti-collision separation pass:
    # node radius r(n) = 2 + 6 * sqrt(score) (world units)
    scores = np.zeros(n)
    if nodes:
        for i, nid in enumerate(ids):
            scores[i] = max(float(nodes.get(nid, {}).get("score", 0.0)), 0.0)
    radii = 2.0 + 6.0 * np.sqrt(scores)
    max_r = float(radii.max()) if n > 0 else 2.0

    # Cluster bounding spheres (centroid and radius) for clamping
    cluster_member_indices: dict[int, list[int]] = defaultdict(list)
    for i, nid in enumerate(ids):
        c = assign.get(nid, 0)
        target_c = c if c != 0 else loose_target_cluster.get(nid, 0)
        cluster_member_indices[target_c].append(i)

    cluster_b_spheres: dict[int, tuple[np.ndarray, float]] = {}
    for c, idxs in cluster_member_indices.items():
        if idxs:
            c_cen = pos[idxs].mean(axis=0)
            c_r = max(float(np.linalg.norm(pos[idxs] - c_cen, axis=1).max()), 10.0)
            cluster_b_spheres[c] = (c_cen, c_r)

    # 8 collision iterations using scipy.spatial.cKDTree.query_pairs(2 * max_r * 1.2)
    for _ in range(8):
        tree = cKDTree(pos)
        pairs = tree.query_pairs(2.0 * max_r * 1.2)
        if not pairs:
            break
        for i1, i2 in pairs:
            min_dist = (radii[i1] + radii[i2]) * 1.25
            delta = pos[i1] - pos[i2]
            dist = float(np.linalg.norm(delta))
            if dist < min_dist:
                overlap = min_dist - dist
                if dist < 1e-5:
                    v = rng.normal(size=3)
                    v /= (float(np.linalg.norm(v)) or 1.0)
                else:
                    v = delta / dist
                shift = v * (overlap * 0.5)
                pos[i1] += shift
                pos[i2] -= shift

        # Keep nodes inside their cluster's bounding sphere (clamp to 1.35 x cluster radius)
        for c, idxs in cluster_member_indices.items():
            if c in cluster_b_spheres:
                c_cen, c_r = cluster_b_spheres[c]
                max_allowed_r = c_r * 1.35
                for idx in idxs:
                    v = pos[idx] - c_cen
                    dist = float(np.linalg.norm(v))
                    if dist > max_allowed_r and dist > 1e-5:
                        pos[idx] = c_cen + (v / dist) * max_allowed_r

    pos -= pos.mean(axis=0)
    radius = float(np.linalg.norm(pos, axis=1).max()) or 1.0
    pos *= min(1.0, 420.0 / radius) if radius > 420 else 1.0
    return {nid: (round(float(pos[i][0]), 2), round(float(pos[i][1]), 2), round(float(pos[i][2]), 2)) for i, nid in enumerate(ids)}


# ============================================================================ processes (execution flows)

def detect_processes(nodes: dict[str, dict], edges: dict[str, dict], limit: int, max_depth: int, branching: int) -> tuple[list[dict], list[dict]]:
    calls_out: dict[str, list[tuple[str, float]]] = defaultdict(list)
    calls_in: Counter = Counter()
    for e in edges.values():
        if e["type"] == "CALLS" and e["weight"] >= 0.45 and e["src"] != e["dst"]:
            calls_out[e["src"]].append((e["dst"], e["weight"]))
            calls_in[e["dst"]] += 1
    for k in calls_out:
        calls_out[k].sort(key=lambda t: -t[1])

    def is_candidate(n: dict) -> bool:
        if n["type"] not in ("Function", "Method") or n["props"].get("is_test"):
            return False
        if not calls_out.get(n["id"]):
            return False
        return bool(n["props"].get("is_entry")) or calls_in[n["id"]] == 0

    cands = [n for n in nodes.values() if is_candidate(n)]
    traces: list[tuple[dict, list[dict]]] = []
    for ent in cands:
        steps = [{"node_id": ent["id"], "depth": 0, "via": None}]
        seen = {ent["id"]}
        q = deque([(ent["id"], 0)])
        while q and len(steps) < 40:
            cur, d = q.popleft()
            if d >= max_depth:
                continue
            for dst, w in calls_out.get(cur, [])[:branching]:
                if dst in seen:
                    continue
                seen.add(dst)
                steps.append({"node_id": dst, "depth": d + 1, "via": edge_id(cur, dst, "CALLS")})
                q.append((dst, d + 1))
        if len(steps) >= 3:
            traces.append((ent, steps))
    traces.sort(key=lambda t: (-int(bool(t[0]["props"].get("is_entry"))), -len(t[1])))
    chosen: list[tuple[dict, list[dict]]] = []
    for ent, steps in traces:
        s = {x["node_id"] for x in steps}
        if any(len(s & {y["node_id"] for y in st}) / max(len(s | {y["node_id"] for y in st}), 1) > 0.8 for _, st in chosen):
            continue
        chosen.append((ent, steps))
        if len(chosen) >= limit:
            break
    pnodes: list[dict] = []
    pedges: list[dict] = []
    for ent, steps in chosen:
        pid = sid("proc", ent["id"])
        clusters = sorted({nodes[s["node_id"]].get("cluster", 0) for s in steps})
        pnodes.append({
            "id": pid, "type": "Process", "label": f"{ent['label']} flow",
            "props": {
                "entry": ent["id"], "steps": steps, "step_count": len(steps),
                "max_depth": max(s["depth"] for s in steps), "clusters": clusters,
                "path": ent["props"].get("file"),
            },
            "cluster": ent.get("cluster", 0), "score": min(1.0, 0.25 + len(steps) / 60), "x": 0.0, "y": 0.0, "z": 0.0,
        })
        for i, s in enumerate(steps):
            pedges.append({
                "id": edge_id(pid, s["node_id"], "HAS_STEP"), "src": pid, "dst": s["node_id"], "type": "HAS_STEP",
                "weight": 1.0, "props": {"order": i, "depth": s["depth"]},
            })
    return pnodes, pedges


# ============================================================================ queries on a loaded graph

def _dep_neighbors(wg: Any, node_id: str, direction: str):
    """Yield (neighbor_id, edge) following dependency edges. direction='up' = who depends on me."""
    if direction == "up":
        for e in wg.in_adj.get(node_id, ()):
            if e["type"] in DEP_EDGES:
                yield e["src"], e
    else:
        for e in wg.out_adj.get(node_id, ()):
            if e["type"] in DEP_EDGES:
                yield e["dst"], e


def _expand_roots(wg: Any, node_id: str) -> list[str]:
    n = wg.nodes[node_id]
    roots = [node_id]
    if n["type"] in ("File", "Class"):
        for e in wg.out_adj.get(node_id, ()):
            if e["type"] == "DEFINES":
                roots.append(e["dst"])
                if wg.nodes[e["dst"]]["type"] == "Class":
                    for e2 in wg.out_adj.get(e["dst"], ()):
                        if e2["type"] == "DEFINES":
                            roots.append(e2["dst"])
    return roots


def impact(wg: Any, node_id: str, direction: str = "up", max_depth: int = 4) -> dict:
    roots = _expand_roots(wg, node_id)
    root_set = set(roots)
    seen: dict[str, dict] = {}
    frontier = deque()
    for r in roots:
        frontier.append((r, 0, 1.0))
    while frontier:
        cur, d, conf = frontier.popleft()
        if d >= max_depth:
            continue
        for nb, e in _dep_neighbors(wg, cur, direction):
            if nb in root_set:
                continue
            w = min(float(e["weight"]), 1.0) if e["type"] == "CALLS" else (0.9 if e["type"] in ("IMPORTS", "INHERITS") else 0.7)
            c = conf * w
            if nb in seen:
                if d + 1 <= seen[nb]["depth"] and c > seen[nb]["confidence"]:
                    seen[nb]["confidence"] = round(c, 3)
                continue
            seen[nb] = {"id": nb, "depth": d + 1, "confidence": round(c, 3), "via": {"edge_id": e["id"], "type": e["type"], "from": cur}}
            frontier.append((nb, d + 1, c))
    levels: dict[int, list[dict]] = defaultdict(list)
    files: set[str] = set()
    clusters: set[int] = set()
    for nb, info in seen.items():
        n = wg.nodes[nb]
        files.add(n["props"].get("file") or n["props"].get("path") or "")
        clusters.add(n.get("cluster", 0))
        levels[info["depth"]].append({**info, "label": n["label"], "type": n["type"], "path": n["props"].get("file") or n["props"].get("path"), "cluster": n.get("cluster", 0)})
    for lst in levels.values():
        lst.sort(key=lambda x: -x["confidence"])
    total = len(seen)
    procs = []
    all_ids = set(seen) | root_set
    for pn in wg.nodes.values():
        if pn["type"] == "Process" and any(s["node_id"] in all_ids for s in pn["props"].get("steps", [])):
            procs.append({"id": pn["id"], "label": pn["label"]})
    score = total + 4 * max(len(clusters) - 1, 0) + 3 * len(procs)
    level = "LOW" if score < 4 else "MEDIUM" if score < 12 else "HIGH" if score < 30 else "CRITICAL"
    files.discard("")
    return {
        "target": {"id": node_id, "label": wg.nodes[node_id]["label"], "type": wg.nodes[node_id]["type"]},
        "direction": "upstream" if direction == "up" else "downstream", "max_depth": max_depth,
        "total": total, "levels": [{"depth": d, "nodes": levels[d]} for d in sorted(levels)],
        "files_affected": sorted(files), "clusters_affected": sorted(clusters), "processes_affected": procs,
        "risk": {"level": level, "score": score,
                 "reasons": [f"{total} dependent symbols/files within {max_depth} hops", f"spans {len(clusters)} cluster(s)", f"touches {len(procs)} execution flow(s)"]},
        "highlight": {"nodes": sorted(all_ids), "edges": sorted({i["via"]["edge_id"] for i in seen.values()})},
    }


def trace(wg: Any, a: str, b: str) -> dict:
    def bfs(neighbors) -> list[tuple[str, dict | None]] | None:
        prev: dict[str, tuple[str, dict] | None] = {a: None}
        q = deque([a])
        while q:
            cur = q.popleft()
            if cur == b:
                break
            for nb, e in neighbors(cur):
                if nb not in prev:
                    prev[nb] = (cur, e)
                    q.append(nb)
        if b not in prev:
            return None
        path: list[tuple[str, dict | None]] = []
        cur = b
        while cur is not None:
            p = prev[cur]
            path.append((cur, p[1] if p else None))
            cur = p[0] if p else None  # type: ignore[assignment]
        return list(reversed(path))

    def directed(cur):
        yield from _dep_neighbors(wg, cur, "down")

    def undirected(cur):
        for e in wg.out_adj.get(cur, ()):
            if e["type"] not in ("HAS_STEP",):
                yield e["dst"], e
        for e in wg.in_adj.get(cur, ()):
            if e["type"] not in ("HAS_STEP",):
                yield e["src"], e

    path = bfs(directed)
    mode = "directed-dependency"
    if path is None:
        path = bfs(undirected)
        mode = "undirected"
    if path is None:
        return {"found": False, "mode": None, "nodes": [], "edges": [], "length": 0}
    return {
        "found": True, "mode": mode, "length": len(path) - 1,
        "nodes": [{"id": i, "label": wg.nodes[i]["label"], "type": wg.nodes[i]["type"]} for i, _ in path],
        "edges": [{"id": e["id"], "type": e["type"], "src": e["src"], "dst": e["dst"]} for _, e in path if e],
        "highlight": {"nodes": [i for i, _ in path], "edges": [e["id"] for _, e in path if e]},
    }


# ============================================================================ insights

def compute_insights(nodes: dict[str, dict], edges: dict[str, dict], clusters: list[dict]) -> list[dict]:
    out: list[dict] = []
    calls_in: Counter = Counter()
    refs_in: Counter = Counter()
    imports_in: Counter = Counter()
    total_calls = 0
    defined_by_file: Counter = Counter()
    for e in edges.values():
        if e["type"] == "CALLS":
            calls_in[e["dst"]] += 1
            total_calls += 1
        elif e["type"] == "REFERENCES":
            refs_in[e["dst"]] += 1
        elif e["type"] == "IMPORTS":
            imports_in[e["dst"]] += 1
        elif e["type"] == "DEFINES":
            defined_by_file[e["src"]] += 1

    def add(kind: str, severity: str, title: str, detail: str, ids: list[str]) -> None:
        out.append({"id": f"ins_{len(out)+1}", "kind": kind, "severity": severity, "title": title, "detail": detail, "node_ids": ids[:25]})

    # circular imports
    G = nx.DiGraph()
    for e in edges.values():
        if e["type"] == "IMPORTS" and e["src"] in nodes and e["dst"] in nodes and nodes[e["src"]]["type"] == "File" and nodes[e["dst"]]["type"] == "File":
            G.add_edge(e["src"], e["dst"])
    cyc = [c for c in nx.strongly_connected_components(G) if len(c) > 1]
    for c in sorted(cyc, key=len, reverse=True)[:5]:
        labels = ", ".join(sorted(nodes[i]["label"] for i in c)[:6])
        add("circular_dependency", "high", f"Circular imports across {len(c)} files", f"These files import each other in a loop: {labels}", list(c))

    # hubs
    hubs = sorted(((calls_in[i] + imports_in[i], i) for i in nodes if nodes[i]["type"] in ("File", "Function", "Method", "Class")), reverse=True)[:3]
    for cnt, i in hubs:
        if cnt >= 5:
            add("hub", "medium", f"{nodes[i]['label']} is a dependency hub", f"{cnt} things depend directly on this {nodes[i]['type'].lower()} — changes ripple widely.", [i])

    # god files
    for fid, cnt in defined_by_file.most_common(3):
        n = nodes[fid]
        if n["type"] == "File" and (cnt >= 25 or n["props"].get("loc", 0) > 800):
            add("god_file", "medium", f"{n['label']} does a lot", f"Defines {cnt} symbols over {n['props'].get('loc', '?')} lines — a candidate for splitting.", [fid])

    # dead code
    if total_calls > 0:
        dead = []
        for i, n in nodes.items():
            if n["type"] not in ("Function", "Method"):
                continue
            p = n["props"]
            if p.get("is_entry") or p.get("is_test") or n["label"].startswith("__") or n["label"].startswith("test"):
                continue
            if calls_in[i] == 0 and refs_in[i] == 0:
                dead.append(i)
        if dead:
            add("dead_code", "low", f"{len(dead)} symbols are never called", "No inbound calls were found (dynamic dispatch can hide real usage): " + ", ".join(nodes[i]["label"] for i in dead[:8]), dead)

    # undocumented hotspots
    hot = [n for n in sorted(nodes.values(), key=lambda n: -n.get("score", 0)) if n["type"] in SYMBOL_TYPES and not n["props"].get("doc")][:5]
    if hot:
        add("undocumented_hotspot", "low", "Important symbols without docs", ", ".join(h["label"] for h in hot), [h["id"] for h in hot])

    # cluster coupling
    pair: Counter = Counter()
    for e in edges.values():
        if e["type"] in ("CALLS", "IMPORTS"):
            a, b = nodes[e["src"]].get("cluster", 0), nodes[e["dst"]].get("cluster", 0)
            if a != b and a and b:
                pair[tuple(sorted((a, b)))] += 1
    names = {c["id"]: c["label"] for c in clusters}
    for (a, b), cnt in pair.most_common(2):
        if cnt >= 6:
            add("coupling", "medium", f"“{names.get(a)}” ↔ “{names.get(b)}” are tightly coupled", f"{cnt} cross-cluster dependency edges.", [])

    # knowledge insights
    concepts = sorted((n for n in nodes.values() if n["type"] in ("Concept", "Entity")), key=lambda n: -n.get("score", 0))[:6]
    if concepts:
        add("central_concepts", "info", "Core ideas in your documents", ", ".join(c["label"] for c in concepts), [c["id"] for c in concepts])
    # documents whose sections share no concept/entity/code target with any other document (and have no similar doc)
    doc_of_section = {i: n["props"].get("document") for i, n in nodes.items() if n["type"] == "Section"}
    targets_by_doc: dict[str, set[str]] = defaultdict(set)
    docs_by_target: dict[str, set[str]] = defaultdict(set)
    similar: set[str] = set()
    for e in edges.values():
        if e["type"] in ("MENTIONS", "REFERENCES") and e["src"] in doc_of_section:
            d = doc_of_section[e["src"]]
            if d:
                targets_by_doc[d].add(e["dst"])
                docs_by_target[e["dst"]].add(d)
        elif e["type"] == "SIMILAR_TO":
            similar.update((e["src"], e["dst"]))
    iso = []
    for i, n in nodes.items():
        if n["type"] != "Document" or i in similar:
            continue
        if not any(len(docs_by_target[t]) > 1 or nodes[t]["type"] in ("File", "Function", "Method", "Class") for t in targets_by_doc.get(i, ())):
            iso.append(i)
    if iso:
        add("isolated_documents", "low", f"{len(iso)} document(s) don't connect to anything else", ", ".join(nodes[i]["label"] for i in iso[:5]), iso)
    return out
