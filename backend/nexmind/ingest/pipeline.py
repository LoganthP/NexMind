"""Graph-building pipeline.

scan -> parse (code AST / documents) -> nodes & edges -> resolve imports/calls -> doc<->code links
     -> clusters -> scores -> 3D layout -> execution flows -> insights -> persist -> stream to the UI
"""
from __future__ import annotations

import logging
import posixpath
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Callable

from ..config import settings
from ..db import DB, dumps, loads, now
from ..graph import analysis as A
from ..graph.analysis import edge_id, sid
from ..graph.store import GraphStore
from ..rag.llm import get_llm
from .code_parser import FileParse, ImportRef, Symbol, parse_code
from .concepts import extract_concepts
from .doc_parser import DocParse, parse_document
from .files import FileEntry, walk_source

log = logging.getLogger("nexmind.pipeline")

Emit = Callable[..., None]

PY_STDLIB = set(getattr(sys, "stdlib_module_names", set()))
COMMON_ATTR = {
    "get", "set", "add", "append", "update", "items", "keys", "values", "join", "split", "strip", "format", "read", "write",
    "open", "close", "run", "start", "stop", "send", "pop", "push", "remove", "clear", "copy", "map", "filter", "reduce",
    "then", "catch", "log", "info", "debug", "error", "warn", "print", "len", "str", "int", "list", "dict", "next", "emit",
    "init", "main", "count", "find", "load", "save", "dump", "dumps", "loads", "encode", "decode", "reset", "put", "post",
    "delete", "insert", "extend", "sort", "index", "select", "execute", "commit", "cursor", "fetch", "call", "apply",
}
_EXT_TRY = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".php", ".rb", ".h", ".hpp", ".c", ".cc", ".cpp"]


class GraphBuilder:
    def __init__(self) -> None:
        self.nodes: dict[str, dict] = {}
        self.edges: dict[str, dict] = {}
        self.chunks: list[dict] = []

    def add_node(self, nid: str, ntype: str, label: str, **props: Any) -> str:
        n = self.nodes.get(nid)
        if n is None:
            self.nodes[nid] = {"id": nid, "type": ntype, "label": label, "props": dict(props), "x": 0.0, "y": 0.0, "z": 0.0, "cluster": 0, "score": 0.0}
        else:
            n["props"].update({k: v for k, v in props.items() if v not in (None, "")})
        return nid

    def add_edge(self, src: str, dst: str, etype: str, weight: float = 1.0, mode: str = "max", **props: Any) -> None:
        if src == dst or src not in self.nodes or dst not in self.nodes:
            return
        eid = edge_id(src, dst, etype)
        e = self.edges.get(eid)
        if e is None:
            self.edges[eid] = {"id": eid, "src": src, "dst": dst, "type": etype, "weight": float(weight), "props": dict(props)}
        else:
            e["weight"] = e["weight"] + weight if mode == "sum" else max(e["weight"], weight)
            e["props"].update(props)

    def add_chunk(self, node_id: str, kind: str, text: str, source_id: str, **meta: Any) -> None:
        self.chunks.append({"id": f"ch_{len(self.chunks):06d}", "node_id": node_id, "kind": kind, "text": text, "source_id": source_id, "meta": meta})


# ============================================================================ text splitting

def _splitter(language: str | None = None):
    try:
        from langchain_text_splitters import Language, RecursiveCharacterTextSplitter

        if language:
            lang_map = {"python": Language.PYTHON, "javascript": Language.JS, "typescript": Language.TS, "java": Language.JAVA,
                        "go": Language.GO, "rust": Language.RUST, "cpp": Language.CPP, "c": Language.C, "csharp": Language.CSHARP,
                        "php": Language.PHP, "ruby": Language.RUBY, "kotlin": Language.KOTLIN, "swift": Language.SWIFT}
            if language in lang_map:
                return RecursiveCharacterTextSplitter.from_language(lang_map[language], chunk_size=settings.chunk_size, chunk_overlap=settings.chunk_overlap)
        return RecursiveCharacterTextSplitter(chunk_size=settings.chunk_size, chunk_overlap=settings.chunk_overlap)
    except Exception:  # langchain missing -> trivial fallback splitter
        class _Fallback:
            def split_text(self, t: str) -> list[str]:
                size, step = settings.chunk_size, settings.chunk_size - settings.chunk_overlap
                return [t[i : i + size] for i in range(0, max(len(t), 1), step)]

        return _Fallback()


# ============================================================================ import resolution

class PathIndex:
    def __init__(self, rels: list[str]):
        self.rels = set(rels)
        self.suffix: dict[str, list[str]] = defaultdict(list)  # "a/b/c" (no ext) suffixes -> rels
        self.dirs: dict[str, list[str]] = defaultdict(list)  # directory suffix -> rels
        for r in rels:
            noext = r.rsplit(".", 1)[0] if "." in posixpath.basename(r) else r
            parts = noext.split("/")
            for i in range(len(parts)):
                self.suffix["/".join(parts[i:])].append(r)
            dparts = r.split("/")[:-1]
            for i in range(len(dparts)):
                self.dirs["/".join(dparts[i:])].append(r)

    def lookup(self, key: str) -> list[str]:
        return self.suffix.get(key.strip("/"), [])


def _pick_nearest(cands: list[str], from_rel: str) -> str | None:
    if not cands:
        return None
    base = from_rel.split("/")
    best = max(cands, key=lambda c: sum(1 for a, b in zip(base, c.split("/")) if a == b))
    return best


def resolve_import(lang: str, from_rel: str, imp: ImportRef, idx: PathIndex) -> tuple[list[str], str | None]:
    """-> (internal target file rels, external module name or None)."""
    mod = imp.module
    here = posixpath.dirname(from_rel)
    if lang == "python":
        if imp.level > 0:
            base = here
            for _ in range(imp.level - 1):
                base = posixpath.dirname(base)
            key_mod = mod.replace(".", "/")
            prefix = posixpath.normpath(posixpath.join(base, key_mod)) if key_mod else base
            for cand in (prefix + ".py", prefix + "/__init__.py"):
                if cand in idx.rels:
                    return [cand], None
            targets = [posixpath.join(prefix, n) + ".py" for n in imp.names if posixpath.join(prefix, n) + ".py" in idx.rels]
            return targets, None
        key = mod.replace(".", "/")
        found = idx.lookup(key) + idx.lookup(key + "/__init__")
        if found:
            return [_pick_nearest(found, from_rel)], None  # type: ignore[list-item]
        subs = []
        for n in imp.names:
            c = idx.lookup(f"{key}/{n}")
            if c:
                subs.append(_pick_nearest(c, from_rel))
        if subs:
            return [s for s in subs if s], None
        top = mod.split(".")[0]
        if not top or top in PY_STDLIB or top == "__future__":
            return [], None
        return [], top

    if lang in ("javascript", "typescript", "php", "ruby", "c", "cpp"):
        if mod.startswith(".") or lang in ("c", "cpp", "php", "ruby"):
            cand_base = posixpath.normpath(posixpath.join(here, mod))
            for ext in _EXT_TRY:
                for c in (cand_base + ext, cand_base + "/index" + ext):
                    if c in idx.rels:
                        return [c], None
            # includes like "util/helpers.h" or aliased paths
            noext = cand_base.rsplit(".", 1)[0]
            found = idx.lookup(noext)
            if found:
                return [_pick_nearest(found, from_rel)], None  # type: ignore[list-item]
            if lang in ("c", "cpp"):
                found = idx.lookup(posixpath.splitext(mod)[0])
                if found:
                    return [_pick_nearest(found, from_rel)], None  # type: ignore[list-item]
                return [], None
            if lang in ("php", "ruby"):
                return [], None
            return [], None
        # bare specifier / alias
        stripped = mod.lstrip("@~").lstrip("/")
        for key in (stripped, stripped.split("/", 1)[-1] if "/" in stripped else ""):
            if key:
                found = idx.lookup(key) + idx.lookup(key + "/index")
                if found:
                    return [_pick_nearest(found, from_rel)], None  # type: ignore[list-item]
        pkg = "/".join(mod.split("/")[:2]) if mod.startswith("@") else mod.split("/")[0]
        if pkg.startswith("node:") or pkg in {"fs", "path", "os", "http", "https", "crypto", "util", "events", "stream", "url", "child_process"}:
            return [], None
        return [], pkg

    if lang in ("java", "kotlin", "csharp"):
        key = mod.replace(".", "/")
        found = idx.lookup(key)
        if found:
            return [_pick_nearest(found, from_rel)], None  # type: ignore[list-item]
        if mod.startswith(("java.", "javax.", "kotlin.", "System", "Microsoft", "android.")):
            return [], None
        return [], ".".join(mod.split(".")[:3])

    if lang == "go":
        parts = mod.split("/")
        for i in range(len(parts)):
            files = idx.dirs.get("/".join(parts[i:]))
            if files:
                return sorted(files)[:6], None
        return ([], "/".join(parts[:3])) if "." in parts[0] else ([], None)

    if lang == "rust":
        segs = [s for s in mod.split("::") if s not in ("crate", "self", "super", "")]
        if not segs:
            return [], None
        for k in range(len(segs), 0, -1):
            key = "/".join(segs[:k])
            found = idx.lookup(key) + idx.lookup(key + "/mod")
            if found:
                return [_pick_nearest(found, from_rel)], None  # type: ignore[list-item]
        first = mod.split("::")[0]
        return ([], None) if first in ("std", "core", "alloc", "crate", "self", "super") else ([], first)

    found = idx.lookup(mod.replace(".", "/"))
    return ([_pick_nearest(found, from_rel)], None) if found else ([], None)  # type: ignore[list-item]


# ============================================================================ the pipeline

def build_workspace_graph(ws_id: str, db: DB, store: GraphStore, emit: Emit) -> dict:
    t0 = time.time()
    llm = get_llm()
    ws = db.one("SELECT * FROM workspaces WHERE id=?", (ws_id,))
    ws_kind = ws.get("kind") if ws else "code"
    if not ws_kind and ws:
        stats = loads(ws.get("stats"), {})
        ws_kind = "docs" if stats.get("documents", 0) > 0 and stats.get("files", 0) == 0 else "code"
    ws_kind = ws_kind or "code"

    sources = db.query("SELECT * FROM sources WHERE workspace_id=? ORDER BY created_at", (ws_id,))
    B = GraphBuilder()

    # ------------------------------------------------------------------ 1. scan
    emit("progress", phase="scan", percent=3, message="Scanning files…")
    entries: list[tuple[dict, FileEntry]] = []
    for src in sources:
        root = Path(src["path"])
        if not root.exists():
            continue
        for fe in walk_source(root):
            if ws_kind == "docs" and fe.category == "code":
                continue
            entries.append((src, fe))
    if not entries:
        store.clear(ws_id)
        emit("log", level="warn", message="No supported files found.")
        return {"nodes": 0, "edges": 0, "files": 0}
    emit("log", level="info", message=f"Found {len(entries)} analysable files in {len(sources)} source(s)")

    # ------------------------------------------------------------------ 2. parse + structural nodes
    code_parse: dict[tuple[str, str], tuple[FileParse, str]] = {}  # (source_id, rel) -> (parse, file_node_id)
    doc_sections: list[dict] = []
    folder_nodes: dict[tuple[str, str], str] = {}
    lang_loc: Counter = Counter()
    n_pages = 0
    n_docs = 0
    source_node: dict[str, str] = {}
    for src in sources:
        sn = sid("src", src["id"])
        B.add_node(sn, "Source", src["name"], kind=src["kind"], origin=src["origin"], source_id=src["id"])
        source_node[src["id"]] = sn

    def ensure_folder(source_id: str, rel_dir: str) -> str:
        if not rel_dir or rel_dir == ".":
            return source_node[source_id]
        key = (source_id, rel_dir)
        if key in folder_nodes:
            return folder_nodes[key]
        parent = ensure_folder(source_id, posixpath.dirname(rel_dir))
        fid = sid("dir", f"{source_id}:{rel_dir}")
        B.add_node(fid, "Folder", posixpath.basename(rel_dir), path=rel_dir, source_id=source_id)
        B.add_edge(parent, fid, "CONTAINS")
        folder_nodes[key] = fid
        return fid

    total = len(entries)
    splitter = _splitter()
    for i, (src, fe) in enumerate(entries):
        if i % 20 == 0:
            emit("progress", phase="parse", percent=5 + int(35 * i / total), message=f"Parsing {fe.rel}", counts={"files": i, "total": total})
        sid_src = src["id"]
        parent = ensure_folder(sid_src, posixpath.dirname(fe.rel))
        is_test = any(t in fe.rel.lower() for t in ("test", "spec", "__tests__", "mock"))
        if fe.category == "code":
            try:
                text = fe.abs.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            fp = parse_code(fe.rel, text, fe.language)
            fnode = sid("file", f"{sid_src}:{fe.rel}")
            B.add_node(fnode, "File", posixpath.basename(fe.rel), path=fe.rel, language=fe.language, loc=fp.loc, source_id=sid_src,
                       doc=fp.doc[:300], is_test=is_test, parse_error=fp.parse_error or None, size=fe.size)
            B.add_edge(parent, fnode, "CONTAINS")
            code_parse[(sid_src, fe.rel)] = (fp, fnode)
            lang_loc[fe.language] += fp.loc
        else:
            dp = parse_document(fe.rel, fe.abs, fe.language)
            dnode = sid("doc", f"{sid_src}:{fe.rel}")
            n_docs += 1
            n_pages += dp.pages or 0
            B.add_node(dnode, "Document", dp.title or posixpath.basename(fe.rel), path=fe.rel, doc_type=fe.language, pages=dp.pages,
                       sections=len(dp.sections), chars=sum(len(s.text) for s in dp.sections), source_id=sid_src,
                       filename=posixpath.basename(fe.rel), error=dp.error or None, size=fe.size)
            B.add_edge(parent, dnode, "CONTAINS")
            for k, sec in enumerate(dp.sections):
                snode = sid("sec", f"{sid_src}:{fe.rel}:{k}")
                B.add_node(snode, "Section", sec.title or f"Section {k+1}", path=fe.rel, page=sec.page, level=sec.level, index=k,
                           preview=sec.text[:260], text=sec.text[:6000], chars=len(sec.text), source_id=sid_src, document=dnode)
                B.add_edge(dnode, snode, "CONTAINS")
                for piece in splitter.split_text(sec.text):
                    if piece.strip():
                        B.add_chunk(snode, "doc", f"{dp.title} — {sec.title}\n{piece}", sid_src, path=fe.rel, title=sec.title, page=sec.page, document=dnode)
                doc_sections.append({"node_id": snode, "doc_id": dnode, "text": sec.text, "title": sec.title, "doc_path": fe.rel})

    # ------------------------------------------------------------------ 3. symbols
    emit("progress", phase="symbols", percent=42, message="Extracting classes, functions and methods…")
    sym_nodes: dict[tuple[str, str, str, int], str] = {}  # (source, rel, qualname, start) -> node id
    by_name: dict[str, list[str]] = defaultdict(list)
    sym_info: dict[str, dict] = {}
    file_syms: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))  # file node -> name -> ids
    class_members: dict[tuple[str, str], str] = {}  # (file_node, class name) -> class node id
    used_ids: set[str] = set()
    code_splitters: dict[str, Any] = {}

    for (sid_src, rel), (fp, fnode) in code_parse.items():
        is_test = B.nodes[fnode]["props"].get("is_test")
        for s in fp.symbols:
            qual = f"{s.parent}.{s.name}" if s.parent else s.name
            nid = sid("sym", f"{sid_src}:{rel}:{qual}:{s.kind}")
            if nid in used_ids:
                nid = sid("sym", f"{sid_src}:{rel}:{qual}:{s.kind}:{s.start}")
            used_ids.add(nid)
            ntype = {"class": "Class", "function": "Function", "method": "Method"}[s.kind]
            B.add_node(nid, ntype, s.name, file=rel, file_node=fnode, source_id=sid_src, start=s.start, end=s.end, signature=s.signature[:300],
                       doc=s.doc[:600], parent=s.parent, language=fp.language, is_entry=s.is_entry, is_test=bool(is_test),
                       decorators=s.decorators[:5], loc=max(s.end - s.start + 1, 1), qualname=qual)
            sym_nodes[(sid_src, rel, qual, s.start)] = nid
            sym_info[nid] = {"sym": s, "file": rel, "fnode": fnode, "src": sid_src, "lang": fp.language}
            if len(s.name) >= 2:
                by_name[s.name].append(nid)
            file_syms[fnode][s.name].append(nid)
            if s.kind == "class":
                class_members[(fnode, s.name)] = nid
        # DEFINES edges (file -> top-level symbols, class -> methods)
        for s in fp.symbols:
            qual = f"{s.parent}.{s.name}" if s.parent else s.name
            nid = sym_nodes[(sid_src, rel, qual, s.start)]
            owner = class_members.get((fnode, s.parent)) if s.parent else None
            B.add_edge(owner or fnode, nid, "DEFINES")
        # code chunks (one per symbol; file header chunk for context)
        header = f"File: {rel}\n{fp.doc}\n" + "\n".join(f"import {im.module}" for im in fp.imports[:25])
        B.add_chunk(fnode, "code", header[:1800], sid_src, path=rel, title=rel, language=fp.language)
        if not fp.symbols:
            sp = code_splitters.setdefault(fp.language, _splitter(fp.language))
            for piece in sp.split_text(fp.text[:40000])[:20]:
                B.add_chunk(fnode, "code", f"File: {rel}\n{piece}", sid_src, path=rel, title=rel, language=fp.language)
        for s in fp.symbols:
            qual = f"{s.parent}.{s.name}" if s.parent else s.name
            nid = sym_nodes[(sid_src, rel, qual, s.start)]
            body = f"{rel} :: {qual}\n{s.signature}\n{s.doc}\n{s.body}"
            if len(body) > 2600:
                sp = code_splitters.setdefault(fp.language, _splitter(fp.language))
                for piece in sp.split_text(body)[:6]:
                    B.add_chunk(nid, "code", piece, sid_src, path=rel, title=qual, language=fp.language, start=s.start, end=s.end)
            else:
                B.add_chunk(nid, "code", body, sid_src, path=rel, title=qual, language=fp.language, start=s.start, end=s.end)

    # ------------------------------------------------------------------ 4. imports
    emit("progress", phase="links", percent=52, message="Resolving imports…")
    per_source_rels: dict[str, list[str]] = defaultdict(list)
    for (sid_src, rel) in code_parse:
        per_source_rels[sid_src].append(rel)
    path_index = {s: PathIndex(rels) for s, rels in per_source_rels.items()}
    rel_to_file_node = {(s, r): v[1] for (s, r), v in code_parse.items()}
    imported_files: dict[str, set[str]] = defaultdict(set)  # file node -> imported file nodes
    alias_to_file: dict[str, dict[str, str]] = defaultdict(dict)  # file node -> {alias: file node}
    name_to_file: dict[str, dict[str, str]] = defaultdict(dict)  # file node -> {imported symbol name: file node}
    module_nodes: dict[str, str] = {}
    for (sid_src, rel), (fp, fnode) in code_parse.items():
        idx = path_index[sid_src]
        for imp in fp.imports:
            try:
                targets, ext = resolve_import(fp.language, rel, imp, idx)
            except Exception:
                continue
            for t in targets:
                tnode = rel_to_file_node.get((sid_src, t))
                if not tnode or tnode == fnode:
                    continue
                B.add_edge(fnode, tnode, "IMPORTS", 1.0)
                imported_files[fnode].add(tnode)
                if fp.language == "python":
                    if imp.names:
                        for nm in imp.names:
                            name_to_file[fnode][nm] = tnode
                            sub = rel_to_file_node.get((sid_src, posixpath.splitext(t)[0] + "/" + nm + ".py"))
                            if sub:
                                alias_to_file[fnode][nm] = sub
                    else:
                        alias_to_file[fnode][imp.alias or imp.module.split(".")[0]] = tnode
                        alias_to_file[fnode][imp.module.split(".")[-1]] = tnode
            if ext:
                mid = module_nodes.get(ext)
                if mid is None:
                    mid = sid("mod", ext.lower())
                    B.add_node(mid, "Module", ext, external=True)
                    module_nodes[ext] = mid
                B.add_edge(fnode, mid, "IMPORTS", 1.0)

    # ------------------------------------------------------------------ 5. calls + inheritance
    emit("progress", phase="links", percent=60, message="Linking calls and inheritance…")
    node_file = {nid: info["fnode"] for nid, info in sym_info.items()}
    class_by_file_name: dict[tuple[str, str], str] = class_members
    n_calls = 0

    def bases_chain(cnode: str, depth: int = 0) -> list[str]:
        if depth > 5:
            return []
        out = []
        for e in B_out.get(cnode, ()):
            if e["type"] == "INHERITS":
                out.append(e["dst"])
                out += bases_chain(e["dst"], depth + 1)
        return out

    # INHERITS first (so method resolution through bases works)
    for nid, info in sym_info.items():
        s: Symbol = info["sym"]
        if s.kind != "class":
            continue
        fnode = info["fnode"]
        for base in s.bases:
            bname = base.replace("<", ".").split("[")[0].split("(")[0].split(".")[-1].strip()
            if not bname or bname in {"object", "Exception", "ABC", "Enum", "BaseModel", "dict", "list"}:
                continue
            target = class_by_file_name.get((fnode, bname))
            if not target:
                for f in imported_files[fnode]:
                    target = class_by_file_name.get((f, bname))
                    if target:
                        break
            if not target:
                cands = [c for c in by_name.get(bname, []) if B.nodes[c]["type"] == "Class"]
                target = cands[0] if len(cands) == 1 else None
            if target and target != nid:
                B.add_edge(nid, target, "INHERITS", 1.0)
    B_out: dict[str, list[dict]] = defaultdict(list)
    for e in B.edges.values():
        if e["type"] == "INHERITS":
            B_out[e["src"]].append(e)

    for nid, info in sym_info.items():
        s = info["sym"]
        if s.kind == "class" or not s.calls:
            continue
        fnode = info["fnode"]
        imp_files = imported_files[fnode]
        parent_cls = class_members.get((fnode, s.parent)) if s.parent else None
        seen_pairs: set[tuple[str, str]] = set()
        for cname, recv in s.calls:
            cands = by_name.get(cname)
            if not cands:
                continue
            pick: list[tuple[str, float]] = []
            base = recv.split(".")[0] if recv and not recv.endswith("()") and recv != "?" else None
            if recv in ("self", "cls", "this", "super", "@", "parent") and parent_cls:
                same = [c for c in cands if sym_info[c]["sym"].parent == s.parent and sym_info[c]["fnode"] == fnode]
                if same and recv != "super":
                    pick = [(c, 0.95) for c in same]
                else:
                    chain = set(bases_chain(parent_cls))
                    inh = [c for c in cands if sym_info[c]["sym"].parent and class_members.get((sym_info[c]["fnode"], sym_info[c]["sym"].parent)) in chain]
                    pick = [(c, 0.85) for c in inh] or [(c, 0.9) for c in same]
            elif recv and recv.endswith("()"):  # local variable built from a constructor: Order().total()
                tname = recv[:-2]
                typed = [c for c in cands if sym_info[c]["sym"].parent == tname]
                near = [c for c in typed if node_file[c] == fnode or node_file[c] in imp_files]
                pick = [(c, 0.85) for c in (near or typed)][:2]
            if not pick and base and base in alias_to_file[fnode]:
                tf = alias_to_file[fnode][base]
                pick = [(c, 0.9) for c in cands if node_file[c] == tf]
            if not pick and recv is None and cname in name_to_file[fnode]:
                tf = name_to_file[fnode][cname]
                pick = [(c, 0.95) for c in cands if node_file[c] == tf]
            if not pick and recv is None:
                same = [c for c in cands if node_file[c] == fnode and sym_info[c]["sym"].kind != "method"]
                if same:
                    pick = [(c, 0.9) for c in same][:1]
            if not pick and recv is None:
                imp = [c for c in cands if node_file[c] in imp_files and sym_info[c]["sym"].kind != "method"]
                if imp:
                    pick = [(c, 0.85 if len(imp) == 1 else 0.6) for c in imp][:2]
            if not pick and recv is not None:
                imp = [c for c in cands if node_file[c] in imp_files]
                if len(imp) == 1 and cname not in COMMON_ATTR:
                    pick = [(imp[0], 0.6)]
                same = [c for c in cands if node_file[c] == fnode and sym_info[c]["sym"].kind == "method"]
                if not pick and len(same) == 1 and cname not in COMMON_ATTR:
                    pick = [(same[0], 0.5)]
            if not pick and len(cands) == 1 and len(cname) >= 4 and (recv is None or cname not in COMMON_ATTR):
                pick = [(cands[0], 0.5 if recv is None else 0.35)]
            for c, w in pick:
                if c == nid or (nid, c) in seen_pairs:
                    continue
                seen_pairs.add((nid, c))
                B.add_edge(nid, c, "CALLS", w, mode="max", via="instantiate" if B.nodes[c]["type"] == "Class" else "call")
                n_calls += 1
    emit("log", level="info", message=f"Resolved {n_calls} call relationships")

    # ------------------------------------------------------------------ 6. documents: concepts + doc<->code links
    emit("progress", phase="knowledge", percent=70, message="Extracting concepts and linking documents to code…")
    code_index = {
        "symbols": {name: ids for name, ids in by_name.items() if len(name) >= 4},
        "modules": {m.lower(): mid for m, mid in module_nodes.items()},
        "files_by_path": {rel: v[1] for (_, rel), v in code_parse.items()},
        "files_by_base": defaultdict(list),
    }
    for (_, rel), v in code_parse.items():
        code_index["files_by_base"][posixpath.basename(rel)].append(v[1])
    kstats = extract_concepts(doc_sections, code_index, B, emit, llm)

    # ------------------------------------------------------------------ 7. analytics
    emit("progress", phase="analyze", percent=80, message="Detecting communities and computing centrality…")
    U = A.build_undirected(B.nodes, B.edges)
    assign = A.detect_clusters(U)
    for nid, c in assign.items():
        B.nodes[nid]["cluster"] = c
    score, betw = A.compute_scores(U)
    for nid, v in score.items():
        B.nodes[nid]["score"] = round(v, 4)
        B.nodes[nid]["props"]["degree"] = U.degree(nid)
        B.nodes[nid]["props"]["betweenness"] = round(betw.get(nid, 0.0), 4)

    emit("progress", phase="layout", percent=86, message="Growing the 3D brain layout…")
    pos = A.layout_3d(U, assign, nodes=B.nodes)
    for nid, (x, y, z) in pos.items():
        B.nodes[nid].update(x=x, y=y, z=z)

    emit("progress", phase="flows", percent=91, message="Tracing execution flows…")
    pnodes, pedges = A.detect_processes(B.nodes, B.edges, settings.max_processes, settings.process_depth, settings.process_branching)
    for pn in pnodes:
        steps = [B.nodes[s["node_id"]] for s in pn["props"]["steps"]]
        pn["x"] = round(sum(s["x"] for s in steps) / len(steps), 2)
        pn["y"] = round(sum(s["y"] for s in steps) / len(steps), 2)
        pn["z"] = round(sum(s["z"] for s in steps) / len(steps), 2)
        B.nodes[pn["id"]] = pn
    for pe in pedges:
        B.edges[pe["id"]] = pe

    clusters = A.label_clusters(B.nodes, assign)
    insights = A.compute_insights(B.nodes, B.edges, clusters)

    # ------------------------------------------------------------------ 8. persist
    emit("progress", phase="save", percent=95, message="Saving graph…")
    store.save(ws_id, B.nodes, B.edges, B.chunks, clusters, insights)

    type_counts = Counter(n["type"] for n in B.nodes.values())
    edge_counts = Counter(e["type"] for e in B.edges.values())
    stats = {
        "nodes": len(B.nodes), "edges": len(B.edges), "chunks": len(B.chunks), "clusters": len([c for c in clusters if c["id"] != 0]),
        "node_types": dict(type_counts), "edge_types": dict(edge_counts), "languages": dict(lang_loc.most_common()),
        "files": len(code_parse), "documents": n_docs, "pages": n_pages, "processes": len(pnodes), "insights": len(insights),
        "knowledge": kstats, "build_seconds": round(time.time() - t0, 2),
    }
    db.execute("UPDATE workspaces SET stats=?, status='ready', updated_at=? WHERE id=?", (dumps(stats), now(), ws_id))
    return stats


def stream_graph(ws_id: str, store: GraphStore, emit: Emit) -> None:
    """Replay the finished graph to WebSocket clients in paced batches so the UI can animate it 'growing'."""
    wg = store.get(ws_id)
    nodes = sorted(wg.nodes.values(), key=lambda n: (n["type"] == "Process", -n.get("score", 0)))
    edges = list(wg.edges.values())
    bs = max(10, settings.stream_batch_size)
    emit("graph_stream_start", nodes=len(nodes), edges=len(edges), clusters=wg.clusters)

    # Pre-index nodes by batch to achieve O(E) grouping
    node_batch_idx: dict[str, int] = {n["id"]: i // bs for i, n in enumerate(nodes)}
    edge_batches: dict[int, list[dict]] = defaultdict(list)
    for e in edges:
        b_src = node_batch_idx.get(e["src"])
        b_dst = node_batch_idx.get(e["dst"])
        if b_src is not None and b_dst is not None:
            edge_batches[max(b_src, b_dst)].append(e)

    num_batches = (len(nodes) + bs - 1) // bs
    delay = min(settings.stream_delay_s, 0.015)

    for b in range(num_batches):
        batch_nodes = nodes[b * bs : (b + 1) * bs]
        batch_edges = edge_batches.get(b, [])
        emit("graph_batch", nodes=[_viz_node(n) for n in batch_nodes], edges=[_viz_edge(e) for e in batch_edges])
        if delay > 0 and b < num_batches - 1:
            time.sleep(delay)

    emit("graph_ready", stats={"nodes": len(nodes), "edges": len(edges)})


def _viz_node(n: dict) -> dict:
    p = n.get("props", {})
    return {
        "id": n["id"], "type": n["type"], "label": n["label"], "x": n["x"], "y": n["y"], "z": n["z"], "cluster": n["cluster"],
        "score": n["score"], "degree": p.get("degree", 0), "betweenness": p.get("betweenness", 0.0),
        "path": p.get("path") or p.get("file"), "language": p.get("language"),
    }


def _viz_edge(e: dict) -> dict:
    return {"id": e["id"], "source": e["src"], "target": e["dst"], "type": e["type"], "weight": round(e["weight"], 3), "label": e["props"].get("label")}
