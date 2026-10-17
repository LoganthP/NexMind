"""Hybrid retrieval over chunks: TF-IDF cosine + BM25 (+ optional sentence-transformer embeddings), fused with
Reciprocal Rank Fusion. Identifier-aware: `parseConfig` and `parse_config` both match "parse config"."""
from __future__ import annotations

import logging
import re
import threading

import numpy as np
from sklearn.feature_extraction.text import CountVectorizer, TfidfVectorizer

from ..config import settings

log = logging.getLogger("nexmind.index")
_TOKEN = r"(?u)\b[a-z0-9][a-z0-9]+\b"


def expand_identifiers(text: str) -> str:
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text)
    text = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", text)
    return text.replace("_", " ").lower()


_dense_lock = threading.Lock()
_dense_model = None
_dense_failed = False


def _get_dense():
    global _dense_model, _dense_failed
    if _dense_failed:
        return None
    with _dense_lock:
        if _dense_model is None:
            try:
                from sentence_transformers import SentenceTransformer

                _dense_model = SentenceTransformer(settings.embedding_model)
            except Exception as e:  # missing package / offline model download
                log.warning("Dense embeddings disabled (%s). Falling back to TF-IDF + BM25.", e)
                _dense_failed = True
                return None
    return _dense_model


class HybridIndex:
    def __init__(self, chunks: list[dict]):
        self.chunks = chunks
        self.empty = len(chunks) == 0
        self.dense = None
        if self.empty:
            return
        texts = [expand_identifiers(c["text"]) for c in chunks]
        self.tfidf = TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True, token_pattern=_TOKEN, max_features=250_000, dtype=np.float32)
        self.X = self.tfidf.fit_transform(texts)
        self.cv = CountVectorizer(token_pattern=_TOKEN, dtype=np.float32)
        self.C = self.cv.fit_transform(texts).tocsc()
        self.dl = np.asarray(self.C.sum(axis=1)).ravel()
        self.avgdl = float(self.dl.mean()) or 1.0
        df = np.asarray((self.C > 0).sum(axis=0)).ravel()
        n = len(chunks)
        self.idf = np.log(1 + (n - df + 0.5) / (df + 0.5))
        if settings.embeddings == "sentence-transformers":
            model = _get_dense()
            if model is not None:
                try:
                    self.dense = model.encode([c["text"][:1500] for c in chunks], normalize_embeddings=True, batch_size=32, show_progress_bar=False)
                except Exception as e:  # pragma: no cover
                    log.warning("Dense encode failed: %s", e)

    # ------------------------------------------------------------------
    def _bm25(self, q: str, k1: float = 1.4, b: float = 0.75) -> np.ndarray:
        scores = np.zeros(len(self.chunks), dtype=np.float32)
        qv = self.cv.transform([expand_identifiers(q)])
        for idx in qv.indices:
            col = self.C[:, idx]
            rows = col.indices
            data = col.data
            if len(data) == 0:
                continue
            denom = data + k1 * (1 - b + b * self.dl[rows] / self.avgdl)
            scores[rows] += self.idf[idx] * (data * (k1 + 1)) / denom
        return scores

    def search(self, query: str, k: int = 8, kinds: set[str] | None = None) -> list[dict]:
        if self.empty or not query.strip():
            return []
        qx = self.tfidf.transform([expand_identifiers(query)])
        s_tfidf = (self.X @ qx.T).toarray().ravel()
        s_bm25 = self._bm25(query)
        lists = [s_tfidf, s_bm25]
        s_dense = None
        if self.dense is not None:
            model = _get_dense()
            if model is not None:
                qd = model.encode([query], normalize_embeddings=True, show_progress_bar=False)[0]
                s_dense = self.dense @ qd
                lists.append(s_dense)
        mask = np.ones(len(self.chunks), dtype=bool)
        if kinds:
            mask = np.array([c["kind"] in kinds for c in self.chunks])
        fused = np.zeros(len(self.chunks), dtype=np.float64)
        for s in lists:
            s = np.where(mask, s, -1.0)
            order = np.argsort(-s)[:60]
            for rank, i in enumerate(order):
                if s[i] > 0:
                    fused[i] += 1.0 / (60 + rank)
        fused[~mask] = 0
        top = np.argsort(-fused)[:k]
        m_tfidf = float(s_tfidf.max()) or 1.0
        m_bm25 = float(s_bm25.max()) or 1.0
        out = []
        for i in top:
            if fused[i] <= 0:
                continue
            # RRF decides the ORDER; the reported score is an interpretable 0..1 relevance blend
            rel = 0.55 * float(s_tfidf[i]) / m_tfidf + 0.45 * float(s_bm25[i]) / m_bm25
            if s_dense is not None:
                rel = 0.6 * rel + 0.4 * max(float(s_dense[i]), 0.0)
            out.append({
                "chunk": self.chunks[int(i)], "score": round(rel, 4), "tfidf": round(float(s_tfidf[i]), 4),
                "bm25": round(float(s_bm25[i]), 4), "dense": round(float(s_dense[i]), 4) if s_dense is not None else None,
            })
        return out


_STOP = set("a an the of to in on for and or is are was were be by with as at it this that from how what why who which do does can i you we".split())


def best_sentences(text: str, query: str, n: int = 2) -> list[str]:
    """Pick the n sentences with the best query-term overlap (used by the offline answer composer)."""
    q = {w for w in re.findall(r"[a-z0-9]+", expand_identifiers(query)) if w not in _STOP and len(w) > 2}
    sents = [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", text) if len(s.strip()) > 25]
    if not sents:
        return [text[:240].strip()] if text.strip() else []
    scored = []
    for i, s in enumerate(sents):
        toks = set(re.findall(r"[a-z0-9]+", expand_identifiers(s)))
        scored.append((len(q & toks) / (1 + 0.02 * len(s)), -i, s))
    scored.sort(reverse=True)
    picked = sorted(scored[:n], key=lambda t: -t[1])
    return [p[2][:320] for p in picked]


def focus_snippet(text: str, query: str, width: int = 320) -> str:
    """A readable window of `text` centred on where the query terms cluster (instead of just the first characters)."""
    flat = re.sub(r"\s+", " ", text).strip()
    if len(flat) <= width:
        return flat
    low = flat.lower()
    terms = sorted({t for t in re.findall(r"[a-z0-9]+", expand_identifiers(query)) if t not in _STOP and len(t) > 2})
    positions = []
    for t in terms:
        i = low.find(t)
        while i != -1 and len(positions) < 80:
            positions.append(i)
            i = low.find(t, i + len(t))
    if not positions:
        return flat[:width].rstrip() + "…"
    best_start, best_hits = 0, -1
    for pos in positions:
        start = max(0, pos - 60)
        window = low[start : start + width]
        hits = sum(1 for t in terms if t in window)
        if hits > best_hits:
            best_start, best_hits = start, hits
    chunk = flat[best_start : best_start + width].strip()
    return ("…" if best_start > 0 else "") + chunk + ("…" if best_start + width < len(flat) else "")


_TEST_PATH = re.compile(r"(^|/)(tests?|__tests__|spec|specs|mocks?|fixtures?)(/|_|\.)|(^|/)test_|_test\.|\.(spec|test)\.", re.I)
_WANTS_TESTS = re.compile(r"\b(tests?|testing|spec|pytest|unittest|mock|fixture)\b", re.I)


def deprioritize_tests(hits: list[dict], query: str, factor: float = 0.55) -> list[dict]:
    """Questions about behaviour should hit implementation before tests, unless the user is asking about tests."""
    if _WANTS_TESTS.search(query):
        return hits
    for h in hits:
        path = (h["chunk"].get("meta") or {}).get("path") or ""
        if path and _TEST_PATH.search(path):
            h["score"] = round(h["score"] * factor, 4)
    return sorted(hits, key=lambda h: -h["score"])
