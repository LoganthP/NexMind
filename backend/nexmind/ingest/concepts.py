"""Knowledge extraction from documents.

Works fully offline (TF-IDF concepts, capitalised-phrase entities, co-occurrence, doc similarity) and optionally
upgrades to typed relationships when an LLM provider is configured (NEXMIND_LLM_EXTRACT=true).

The distinctive part: document sections are linked to *code symbols and files* they mention, so one graph holds
both your repo and the knowledge around it.
"""
from __future__ import annotations

import json
import logging
import re
from collections import Counter, defaultdict
from typing import Any, Callable

import numpy as np
from sklearn.feature_extraction.text import CountVectorizer, TfidfVectorizer

from ..config import settings
from ..graph.analysis import sid

log = logging.getLogger("nexmind.concepts")

_ENT_STOP = {
    "The", "This", "That", "These", "Those", "In", "On", "For", "And", "But", "With", "When", "Where", "What", "Which",
    "It", "We", "You", "They", "There", "A", "An", "If", "As", "At", "By", "From", "To", "Of", "Our", "Your", "Note",
    "See", "Figure", "Table", "Page", "Section", "Chapter", "However", "Also", "Then", "Each", "Some", "All", "Any",
    "Introduction", "Conclusion", "Overview", "Example", "Examples", "Usage", "Install", "Installation", "License",
}
_ENT_RE = re.compile(r"\b([A-Z][a-zA-Z]+(?:[ \-][A-Z][a-zA-Z]+){1,3})\b")
_ACRONYM_RE = re.compile(r"\b([A-Z]{2,6})\b")
_PROPER_RE = re.compile(r"\b[A-Z][A-Za-z0-9]{2,}\b")
_SENT_START = {"", ".", "!", "?", ":", "#", "\n", "-", "*", "•", ">", "|", "(", "\""}
_ACR_STOP = {"THE", "AND", "FOR", "NOT", "PDF", "TODO", "NOTE", "API", "URL", "HTTP", "HTTPS", "JSON", "HTML", "CSS", "USD", "ID"}


_GENERIC = {
    "data", "demo", "team", "production", "system", "user", "users", "example", "examples", "note", "new", "time", "way", "work",
    "works", "based", "use", "used", "using", "also", "make", "made", "need", "needs", "must", "should", "will", "can", "may",
    "one", "two", "first", "second", "see", "many", "such", "well", "good", "different", "following", "include", "includes",
}


def _is_noise_term(t: str) -> bool:
    if t in _GENERIC or all(w in _GENERIC for w in t.split()):
        return True
    if re.fullmatch(r"[\d\W_]+", t):
        return True
    toks = t.split()
    return all(len(x) < 3 for x in toks) or t in {"et al", "fig", "http", "https", "www", "com"}


def _distinctive(name: str) -> bool:
    return "_" in name or bool(re.search(r"[a-z][A-Z]", name)) or (name.isupper() and len(name) >= 4)


def extract_concepts(
    sections: list[dict],
    code_index: dict[str, Any],
    B: Any,
    emit: Callable[..., None],
    llm: Any = None,
) -> dict:
    """sections: [{node_id, doc_id, text, title, doc_path}] ; mutates builder B with nodes/edges."""
    stats = {"concepts": 0, "entities": 0, "code_links": 0, "similar_docs": 0, "triples": 0}
    if not sections:
        return stats
    n = len(sections)
    modules: dict[str, str] = code_index.get("modules", {})

    label_to_id: dict[str, str] = {}
    sec_concepts: dict[int, list[str]] = defaultdict(list)

    # ---------------------------------------------------------------- entities (proper nouns, capitalised phrases, acronyms)
    ent_total: Counter = Counter()
    ent_sections: dict[str, Counter] = defaultdict(Counter)

    def prev_char(txt: str, pos: int) -> str:
        j = pos - 1
        while j >= 0 and txt[j] in " \t":
            j -= 1
        return txt[j] if j >= 0 else ""

    for i, sec in enumerate(sections):
        txt = sec["text"][:20000]
        for m in _ENT_RE.finditer(txt):
            phrase = m.group(1)
            if phrase.split()[0].split("-")[0] in _ENT_STOP or phrase in _ENT_STOP:
                continue
            ent_total[phrase] += 1
            ent_sections[phrase][i] += 1
        for m in _PROPER_RE.finditer(txt):
            w = m.group(0)
            if w in _ENT_STOP or prev_char(txt, m.start()) in _SENT_START:
                continue
            ent_total[w] += 1
            ent_sections[w][i] += 1
        for m in _ACRONYM_RE.finditer(txt):
            a = m.group(1)
            if a in _ACR_STOP:
                continue
            ent_total[a] += 1
            ent_sections[a][i] += 1
    for phrase, cnt in ent_total.most_common(250):
        if cnt < 2:
            break
        low = phrase.lower()
        if low in label_to_id or low in modules:
            continue
        eid = sid("ent", low)
        label_to_id[low] = eid
        B.add_node(eid, "Entity", phrase, mentions=cnt)
        stats["entities"] += 1
        for i, c in ent_sections[phrase].items():
            B.add_edge(sections[i]["node_id"], eid, "MENTIONS", min(c, 5) / 5.0, mode="sum")
            sec_concepts[i].append(eid)

    # ---------------------------------------------------------------- concepts (global keyphrases shared across sections)
    texts = [s["text"][:20000] for s in sections]
    try:
        cv = CountVectorizer(
            ngram_range=(1, 2), stop_words="english", lowercase=True, max_features=60000,
            token_pattern=r"(?u)\b[A-Za-z][A-Za-z0-9\-]{2,}\b",
        )
        C = cv.fit_transform(texts).tocsc()
        terms = cv.get_feature_names_out()
        term_index = {str(t): k for k, t in enumerate(terms)}
        tf_total = np.asarray(C.sum(axis=0)).ravel()
        df = np.asarray((C > 0).sum(axis=0)).ravel()
        idf = np.log((1 + n) / (1 + df)) + 1.0
        cand: list[tuple[float, int]] = []
        for j, term in enumerate(terms):
            t = str(term)
            if tf_total[j] < 2 and not (n == 1 and tf_total[j] >= 1 and " " in t):
                continue
            if n >= 8 and df[j] / n > 0.6:
                continue
            if _is_noise_term(t) or (" " not in t and len(t) < 4):
                continue
            if t in label_to_id:
                continue
            score = float(tf_total[j]) * float(idf[j]) * (1.6 if " " in t else 1.0)
            cand.append((score, j))
        cand.sort(reverse=True)
        chosen_idx: list[int] = []
        chosen_terms: list[str] = []
        limit = min(150, max(20, n * 8))
        for score, j in cand:
            t = str(terms[j])
            if " " not in t and any(t in c.split() and tf_total[j] <= tf_total[term_index[c]] * 1.35 for c in chosen_terms if " " in c):
                continue  # unigram already covered by a stronger bigram
            if " " in t:  # drop weaker unigrams that were taken earlier but are parts of this bigram
                parts = t.split()
                for k, (ct, cj) in enumerate(list(zip(chosen_terms, chosen_idx))):
                    if ct in parts and tf_total[cj] <= tf_total[j] * 1.35:
                        chosen_terms.pop(k)
                        chosen_idx.pop(k)
                        break
            chosen_terms.append(t)
            chosen_idx.append(j)
            if len(chosen_terms) >= limit:
                break
        K = settings.concepts_per_section + 2
        per_sec: dict[int, list[tuple[float, str]]] = defaultdict(list)
        for t, j in zip(chosen_terms, chosen_idx):
            col = C[:, j]
            for i, c in zip(col.indices, col.data):
                per_sec[int(i)].append((float(c) * float(idf[j]), t))
        for i, lst in per_sec.items():
            lst.sort(reverse=True)
            for sc, t in lst[:K]:
                w = round(min(1.0, sc / 6.0), 3)
                if t in modules:  # a doc mentioning "numpy" links straight to the numpy dependency node
                    B.add_edge(sections[i]["node_id"], modules[t], "MENTIONS", w, mode="max")
                    continue
                cid = label_to_id.get(t)
                if cid is None:
                    cid = sid("con", t)
                    label_to_id[t] = cid
                    B.add_node(cid, "Concept", t)
                    stats["concepts"] += 1
                B.add_edge(sections[i]["node_id"], cid, "MENTIONS", w, mode="sum")
                sec_concepts[i].append(cid)
    except ValueError:  # empty vocabulary
        pass

    # ---------------------------------------------------------------- co-occurrence -> RELATED_TO
    pair: Counter = Counter()
    for i, ids in sec_concepts.items():
        uniq = list(dict.fromkeys(ids))[:8]
        for a in range(len(uniq)):
            for b in range(a + 1, len(uniq)):
                pair[tuple(sorted((uniq[a], uniq[b])))] += 1
    min_w = 1 if len(pair) <= 800 else 2
    for (a, b), w in pair.items():
        if w >= min_w:
            B.add_edge(a, b, "RELATED_TO", float(w), mode="sum")

    # ---------------------------------------------------------------- doc -> code references
    symbols: dict[str, list[str]] = code_index.get("symbols", {})
    files_by_path: dict[str, str] = code_index.get("files_by_path", {})
    files_by_base: dict[str, list[str]] = code_index.get("files_by_base", {})
    if symbols or files_by_path:
        for s in sections:
            txt = s["text"][:30000]
            backticked = set()
            for span in re.findall(r"`([^`\n]{2,100})`", txt):
                backticked.update(re.findall(r"[A-Za-z_][A-Za-z0-9_]{2,}", span))
            bare = set(re.findall(r"\b[A-Za-z_][A-Za-z0-9_]{3,}\b", txt))
            for name in backticked | bare:
                ids = symbols.get(name)
                if not ids or len(ids) > 3:
                    continue
                if name not in backticked and not _distinctive(name):
                    continue
                w = (0.9 if name in backticked else 0.6) / len(ids)
                for sid_ in ids:
                    B.add_edge(s["node_id"], sid_, "REFERENCES", round(max(w, 0.25), 3), mode="max")
                    stats["code_links"] += 1
            for tok in set(re.findall(r"[\w./\\-]+\.[A-Za-z]{1,5}\b", txt)):
                tok = tok.replace("\\", "/").lstrip("./")
                fid = files_by_path.get(tok)
                if fid is None:
                    cands = files_by_base.get(tok.rsplit("/", 1)[-1], [])
                    fid = cands[0] if len(cands) == 1 else None
                if fid:
                    B.add_edge(s["node_id"], fid, "REFERENCES", 0.9, mode="max")
                    stats["code_links"] += 1

    # ---------------------------------------------------------------- document similarity
    doc_text: dict[str, list[str]] = defaultdict(list)
    for s in sections:
        doc_text[s["doc_id"]].append(s["text"][:8000])
    if len(doc_text) >= 2:
        try:
            ids = list(doc_text)
            dv = TfidfVectorizer(stop_words="english", sublinear_tf=True, max_df=0.8 if len(ids) >= 5 else 1.0, token_pattern=r"(?u)\b[A-Za-z][A-Za-z0-9\-]{2,}\b")
            D = dv.fit_transform([" ".join(doc_text[d])[:100000] for d in ids])
            sim = (D @ D.T).toarray()
            np.fill_diagonal(sim, 0)
            done: set[tuple[str, str]] = set()
            for a in range(len(ids)):
                for b in np.argsort(-sim[a])[:3]:
                    if sim[a][b] >= 0.18:
                        key = tuple(sorted((ids[a], ids[int(b)])))
                        if key not in done:
                            done.add(key)
                            B.add_edge(key[0], key[1], "SIMILAR_TO", round(float(sim[a][b]), 3), mode="max")
                            stats["similar_docs"] += 1
        except ValueError:
            pass

    # ---------------------------------------------------------------- optional LLM triples
    if llm is not None and llm.available and settings.llm_extract_triples:
        stats["triples"] = _llm_triples(llm, sections, B, label_to_id, emit)
    return stats


def _llm_triples(llm: Any, sections: list[dict], B: Any, label_to_id: dict[str, str], emit: Callable[..., None], limit: int = 30) -> int:
    system = (
        "You extract factual knowledge-graph triples from text. Reply with ONLY a JSON array. "
        'Each item: {"subject": str, "subject_type": str, "relation": str, "object": str, "object_type": str}. '
        "Use short canonical names, 3-8 items, only facts stated in the text."
    )
    count = 0
    ranked = sorted(sections, key=lambda s: -len(s["text"]))[:limit]
    consecutive_errors = 0
    for k, s in enumerate(ranked):
        try:
            raw = llm.complete(system, s["text"][:2500])
            a, b = raw.find("["), raw.rfind("]")
            items = json.loads(raw[a : b + 1]) if a != -1 and b != -1 else []
            consecutive_errors = 0
        except Exception as e:
            consecutive_errors += 1
            err_name = type(e).__name__
            err_msg = str(e)
            emit("log", level="warn", message=f"LLM extraction error on section {k+1}: {err_name}")
            is_fatal = any(term in err_name.lower() or term in err_msg.lower() for term in ("ratelimit", "429", "quota", "auth", "unauthorized", "invalid_api_key", "timeout"))
            if is_fatal or consecutive_errors >= 2:
                emit("log", level="warn", message=f"Aborting LLM triple extraction ({err_name}). Continuing with offline extraction.")
                break
            continue
        for it in items:
            try:
                su, ob, rel = str(it["subject"]).strip(), str(it["object"]).strip(), str(it["relation"]).strip()[:60]
            except Exception:
                continue
            if not su or not ob or not rel:
                continue
            ids = []
            for name, typ in ((su, it.get("subject_type")), (ob, it.get("object_type"))):
                low = name.lower()
                nid = label_to_id.get(low)
                if nid is None:
                    nid = sid("ent", low)
                    label_to_id[low] = nid
                    B.add_node(nid, "Entity", name, etype=str(typ or "")[:30])
                ids.append(nid)
                B.add_edge(s["node_id"], nid, "MENTIONS", 0.6, mode="max")
            B.add_edge(ids[0], ids[1], "RELATION", 1.0, mode="max", label=rel, evidence=s["node_id"])
            count += 1
    return count
