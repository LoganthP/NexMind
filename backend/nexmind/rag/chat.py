"""GraphRAG chat.

Pipeline per question:
  1. hybrid retrieval over chunks (TF-IDF + BM25 [+ dense]) -> seed nodes
  2. intent detection (impact / path questions are answered from the graph itself, GitNexus-style)
  3. personalised-PageRank expansion over the knowledge graph -> neighbouring nodes
  4. emit a `retrieval` event = the "neural activation" the UI animates (seeds first, then ripples outward)
  5. stream the answer (LLM via LangChain, or an extractive composer when offline) with [n] citations
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, AsyncIterator

import networkx as nx

from ..graph import analysis as A
from ..graph.store import WorkspaceGraph
from .index import best_sentences, deprioritize_tests, focus_snippet
from .llm import LLM

log = logging.getLogger("nexmind.chat")

SYSTEM_PROMPT = (
    "You are NexMind, an assistant that answers questions about the user's code repositories and documents using a "
    "knowledge graph. Use ONLY the numbered SOURCES and GRAPH FACTS provided. Cite sources inline like [1] or [2][3]. "
    "If the sources do not contain the answer, say so plainly instead of guessing. Name relevant code symbols, files and "
    "documents explicitly and put identifiers in `backticks`. Be concise and well structured (short paragraphs or bullets)."
)

_IMPACT = re.compile(r"\b(impact|blast radius|break(s)?|depend(s|ent|encies)? on|who (calls|uses)|what (calls|uses|depends)|if i (change|modify|remove|delete|rename)|affect(s|ed)?)\b", re.I)
_PATH = re.compile(r"\b(path|route|connect(ed|s|ion)?|relationship|related to|link(ed)?)\b.*\b(between|from|to|and|with)\b", re.I)
_STOP = set("what which who how does do is are the a an and or of to in on for with between from path connect connected connection relate related relationship change changes remove delete rename impact depends depend uses calls call if i my this that it explain show me tell about".split())


def _candidate_tokens(question: str) -> list[str]:
    toks: list[str] = []
    toks += re.findall(r"`([^`\n]{2,80})`", question)
    toks += re.findall(r"\b[A-Za-z]+(?:_[A-Za-z0-9]+)+\b|\b[a-z]+(?:[A-Z][a-z0-9]+)+\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b", question)
    toks += [w for w in re.findall(r"[A-Za-z][A-Za-z0-9_.\-/]{2,}", question) if w.lower() not in _STOP]
    seen, out = set(), []
    for t in toks:
        t = t.strip("`.,?!:;()")
        if t and t.lower() not in seen:
            seen.add(t.lower())
            out.append(t)
    return out


def _resolve_targets(wg: WorkspaceGraph, question: str, want: int) -> list[dict]:
    found: list[dict] = []
    ids: set[str] = set()
    for tok in _candidate_tokens(question):
        hits = [n for n in wg.find_nodes(tok, limit=3) if n["label"].lower() == tok.lower() or (n["props"].get("path") or "").lower().endswith(tok.lower())]
        if not hits:
            continue
        n = max(hits, key=lambda x: x.get("score", 0))
        if n["id"] not in ids and n["type"] not in ("Source", "Folder", "Process"):
            ids.add(n["id"])
            found.append(n)
        if len(found) >= want:
            break
    return found


_ANAPHORA = re.compile(r"\b(it|its|that|this|those|these|them|they|he|she|there|former|latter|same)\b|^(and|also|but|so|why|how about|what about|more|explain|elaborate|continue)\b", re.I)


def _is_followup(q: str) -> bool:
    words = q.split()
    return len(words) <= 3 or (len(words) <= 8 and bool(_ANAPHORA.search(q.strip())))


def _brief(n: dict) -> dict:
    p = n["props"]
    return {"id": n["id"], "label": n["label"], "type": n["type"], "path": p.get("path") or p.get("file"), "cluster": n.get("cluster", 0)}


def _expand(wg: WorkspaceGraph, seeds: dict[str, float], limit: int = 10) -> list[tuple[str, float, int]]:
    """Personalised PageRank around seeds. Returns [(node_id, score, hop)]."""
    if not seeds:
        return []
    U = wg.undirected()
    region = set(s for s in seeds if s in U)
    frontier = set(region)
    for _ in range(2):
        nxt = set()
        for n in frontier:
            nbrs = sorted(U[n].items(), key=lambda kv: -kv[1].get("weight", 1))[:30]
            nxt.update(m for m, _ in nbrs)
        region |= nxt
        frontier = nxt
        if len(region) > 1500:
            break
    sub = U.subgraph(region)
    if sub.number_of_edges() == 0:
        return []
    pers = {s: w for s, w in seeds.items() if s in sub}
    try:
        pr = nx.pagerank(sub, alpha=0.8, personalization=pers, weight="weight", max_iter=60)
    except Exception:
        return []
    hops = nx.multi_source_dijkstra_path_length(sub, set(pers), weight=None)
    out = []
    for n, v in sorted(pr.items(), key=lambda kv: -kv[1]):
        if n in seeds or wg.nodes[n]["type"] in ("Source", "Folder", "Process"):
            continue
        out.append((n, v, int(hops.get(n, 2))))
        if len(out) >= limit:
            break
    return out


def _edges_among(wg: WorkspaceGraph, ids: set[str], cap: int = 90) -> list[str]:
    out = []
    for n in ids:
        for e in wg.out_adj.get(n, ()):
            if e["dst"] in ids and e["type"] not in ("HAS_STEP",):
                out.append(e["id"])
                if len(out) >= cap:
                    return out
    return out


def _cite_snippet(ch: dict, query: str) -> str:
    t = ch["text"]
    t = t.split("\n", 1)[1] if "\n" in t and len(t.split("\n", 1)[1]) > 40 else t
    return focus_snippet(t, query, 300)


def _followups(wg: WorkspaceGraph, seeds: list[str], neighbors: list[tuple[str, float, int]]) -> list[str]:
    out: list[str] = []
    for nid in seeds[:2]:
        n = wg.nodes[nid]
        if n["type"] in ("Function", "Method", "Class", "File"):
            out.append(f"What would break if I change `{n['label']}`?")
        elif n["type"] in ("Concept", "Entity", "Section", "Document"):
            out.append(f"How is “{n['label']}” connected to the rest of my knowledge base?")
    if len(seeds) >= 2 or neighbors:
        a = wg.nodes[seeds[0]]["label"] if seeds else None
        b = wg.nodes[neighbors[0][0]]["label"] if neighbors else (wg.nodes[seeds[1]]["label"] if len(seeds) > 1 else None)
        if a and b and a != b:
            out.append(f"What is the path between `{a}` and `{b}`?")
    procs = [n for n in wg.nodes.values() if n["type"] == "Process"]
    if procs and len(out) < 3:
        out.append(f"Walk me through the “{max(procs, key=lambda p: p['props'].get('step_count', 0))['label']}”.")
    return out[:3]


# ============================================================================ main entry

async def run_chat(wg: WorkspaceGraph, question: str, history: list[dict], llm: LLM) -> AsyncIterator[tuple[str, dict]]:
    index = wg.index()
    # contextualise short follow-ups using the previous user turn
    query = question
    if history and _is_followup(question):
        prev = [m["content"] for m in history if m["role"] == "user"]
        if prev:
            query = prev[-1] + " " + question
    hits = deprioritize_tests(await asyncio.to_thread(index.search, query, 16), question)[:8]

    activations: dict[str, dict] = {}
    citations: list[dict] = []
    graph_facts: list[str] = []
    structured: dict[str, Any] | None = None
    seeds: dict[str, float] = {}

    def activate(nid: str, hop: int, score: float, role: str) -> None:
        if nid in activations and activations[nid]["hop"] <= hop:
            return
        activations[nid] = {"node_id": nid, "hop": hop, "score": round(score, 3), "role": role, "delay_ms": 120 * hop + (30 if role != "hit" else 0)}

    # ---- passages -> citations + seeds
    per_node: dict[str, int] = {}
    for h in hits:
        ch = h["chunk"]
        if per_node.get(ch["node_id"], 0) >= 2 or len(citations) >= 6:
            continue
        per_node[ch["node_id"]] = per_node.get(ch["node_id"], 0) + 1
        node = wg.nodes.get(ch["node_id"])
        if not node:
            continue
        n = len(citations) + 1
        meta = ch.get("meta", {})
        citations.append({
            "n": n, "node_id": node["id"], "label": node["label"], "type": node["type"], "path": meta.get("path"),
            "page": meta.get("page"), "start": meta.get("start"), "end": meta.get("end"), "score": h["score"],
            "snippet": _cite_snippet(ch, question), "_text": ch["text"],
        })
        seeds[node["id"]] = max(seeds.get(node["id"], 0), h["score"])
        activate(node["id"], 0, h["score"], "hit")

    # ---- intents answered by the graph itself
    impact_res = path_res = None
    if _IMPACT.search(question):
        tgt = _resolve_targets(wg, question, 1)
        if tgt:
            impact_res = await asyncio.to_thread(A.impact, wg, tgt[0]["id"], "up", 4)
    elif _PATH.search(question):
        tgt = _resolve_targets(wg, question, 2)
        if len(tgt) == 2:
            path_res = await asyncio.to_thread(A.trace, wg, tgt[0]["id"], tgt[1]["id"])
    if impact_res:
        structured = {"kind": "impact", "result": impact_res}
        activate(impact_res["target"]["id"], 0, 1.0, "hit")
        seeds[impact_res["target"]["id"]] = 1.0
        for lvl in impact_res["levels"]:
            for item in lvl["nodes"][:25]:
                activate(item["id"], lvl["depth"], item["confidence"], "impact")
        graph_facts.append(
            f"IMPACT of changing `{impact_res['target']['label']}`: {impact_res['total']} dependents, risk {impact_res['risk']['level']}, "
            f"files: {', '.join(impact_res['files_affected'][:8]) or 'n/a'}."
        )
        for lvl in impact_res["levels"][:3]:
            graph_facts.append(f"depth {lvl['depth']}: " + ", ".join(f"`{x['label']}` ({x['confidence']})" for x in lvl["nodes"][:8]))
    elif path_res and path_res.get("found"):
        structured = {"kind": "path", "result": path_res}
        for i, nd in enumerate(path_res["nodes"]):
            activate(nd["id"], i, 1.0, "path")
            seeds[nd["id"]] = 1.0
        hops = " → ".join(f"`{nd['label']}`" for nd in path_res["nodes"])
        graph_facts.append(f"PATH ({path_res['mode']}, {path_res['length']} hops): {hops}")
    elif path_res is not None:
        graph_facts.append("No connection was found between the two entities in the graph.")

    # ---- graph expansion
    neighbors = await asyncio.to_thread(_expand, wg, seeds, 10)
    for nid, v, hop in neighbors:
        activate(nid, max(hop, 1), v, "neighbor")
    for nid, v, hop in neighbors[:6]:
        n = wg.nodes[nid]
        rel = [e for e in wg.out_adj.get(nid, ()) if e["dst"] in seeds and e["type"] != "HAS_STEP"] + [e for e in wg.in_adj.get(nid, ()) if e["src"] in seeds and e["type"] != "HAS_STEP"]
        if rel:
            e = rel[0]
            graph_facts.append(f"`{wg.nodes[e['src']]['label']}` {e['type']} `{wg.nodes[e['dst']]['label']}`")
    for nid in list(seeds)[:4]:
        n = wg.nodes[nid]
        for nb, e, direction in wg.neighbors(nid)[:6]:
            if e["type"] in ("CONTAINS", "MENTIONS", "RELATED_TO"):
                continue
            s, d = (n["label"], wg.nodes[nb]["label"]) if direction == "out" else (wg.nodes[nb]["label"], n["label"])
            fact = f"`{s}` {e['type']} `{d}`"
            if fact not in graph_facts:
                graph_facts.append(fact)
    graph_facts = graph_facts[:14]

    act_list = sorted(activations.values(), key=lambda a: (a["hop"], -a["score"]))[:60]
    act_ids = {a["node_id"] for a in act_list}
    yield "retrieval", {
        "activations": [{**a, **_brief(wg.nodes[a["node_id"]])} for a in act_list],
        "edges": _edges_among(wg, act_ids),
        "citations": [{k: v for k, v in c.items() if not k.startswith("_")} for c in citations],
        "intent": structured["kind"] if structured else "qa",
        "structured": structured["result"] if structured else None,
    }

    # ---- answer
    ctx = []
    for c in citations:
        where = c["path"] or ""
        if c.get("start"):
            where += f":{c['start']}-{c['end']}"
        if c.get("page"):
            where += f" (page {c['page']})"
        ctx.append(f"[{c['n']}] {c['type']} `{c['label']}` — {where}\n{c['_text'][:1400]}")
    user_block = f"Question: {question}\n\nSOURCES:\n" + ("\n\n".join(ctx) if ctx else "(no passages matched)") + "\n\nGRAPH FACTS:\n" + ("\n".join(f"- {f}" for f in graph_facts) if graph_facts else "(none)")
    msgs = [{"role": m["role"], "content": m["content"]} for m in history[-6:]] + [{"role": "user", "content": user_block}]

    answer = ""
    used_llm = False
    if llm.available:
        try:
            async for tok in llm.astream(SYSTEM_PROMPT, msgs):
                answer += tok
                used_llm = True
                yield "token", {"text": tok}
        except Exception as e:
            log.warning("LLM failed, falling back to extractive answer: %s", e)
            yield "error", {"message": f"LLM unavailable ({type(e).__name__}); showing an extractive answer instead.", "fallback": True}
            answer = ""
            used_llm = False
    if not used_llm:
        text = compose_offline(wg, question, citations, neighbors, structured)
        answer = ""
        for piece in re.findall(r"\S+\s*|\n", text):
            answer += piece
            yield "token", {"text": piece}
            await asyncio.sleep(0.008)

    yield "done", {
        "answer": answer, "citations": [{k: v for k, v in c.items() if not k.startswith("_")} for c in citations],
        "followups": _followups(wg, list(seeds), neighbors), "provider": llm.provider if used_llm else "offline",
        "activated_nodes": [a["node_id"] for a in act_list],
    }


def compose_offline(wg: WorkspaceGraph, question: str, citations: list[dict], neighbors: list[tuple[str, float, int]], structured: dict | None) -> str:
    lines: list[str] = []
    if structured and structured["kind"] == "impact":
        r = structured["result"]
        lines.append(f"**Impact of changing `{r['target']['label']}`** — risk **{r['risk']['level']}**")
        lines.append(f"{r['total']} dependent symbols/files within {r['max_depth']} hops, across {len(r['clusters_affected'])} cluster(s).")
        for lvl in r["levels"][:3]:
            names = ", ".join(f"`{x['label']}`" for x in lvl["nodes"][:6])
            lines.append(f"- depth {lvl['depth']}: {names}" + (" …" if len(lvl["nodes"]) > 6 else ""))
        if r["processes_affected"]:
            lines.append("Execution flows touched: " + ", ".join(p["label"] for p in r["processes_affected"][:4]))
        lines.append("")
    elif structured and structured["kind"] == "path":
        r = structured["result"]
        lines.append(f"**Connection path** ({r['length']} hops, {r['mode']}):")
        lines.append(" → ".join(f"`{n['label']}`" for n in r["nodes"]))
        lines.append("")
    if not citations:
        if not structured:
            lines.append("I couldn't find anything in this workspace that matches your question. Try rephrasing, or upload more material.")
        return "\n".join(lines).strip()
    top = citations[0]
    lines.append(f"**{top['label']}** ({top['type'].lower()}{', ' + top['path'] if top['path'] else ''}) [1]")
    for s in best_sentences(top["_text"], question, 2):
        lines.append(f"> {s}")
    if len(citations) > 1:
        lines.append("")
        lines.append("**Also relevant**")
        for c in citations[1:4]:
            sent = best_sentences(c["_text"], question, 1)
            lines.append(f"- **{c['label']}** [{c['n']}]: {sent[0] if sent else c['snippet'][:160]}")
    if neighbors:
        names = ", ".join(f"`{wg.nodes[n]['label']}`" for n, _, _ in neighbors[:6])
        lines.append("")
        lines.append(f"**Connected in the graph:** {names}")
    lines.append("")
    lines.append("_Answered offline from retrieved passages. Set an LLM provider for fluent, synthesized answers._")
    return "\n".join(lines).strip()
