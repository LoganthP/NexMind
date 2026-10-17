"""Source-code parsing.

* Python is parsed with the real `ast` module (exact symbols, calls, decorators, docstrings).
* JS/TS, Java, Go, Rust, C/C++, C#, PHP, Ruby, Kotlin, Swift use a resilient regex extractor with brace matching.
  It is heuristic by design (no native tree-sitter toolchain needed) and reports lower confidence on ambiguous calls.
"""
from __future__ import annotations

import ast
import re
from dataclasses import dataclass, field


@dataclass
class Symbol:
    name: str
    kind: str  # class | function | method
    start: int
    end: int
    signature: str = ""
    doc: str = ""
    parent: str | None = None
    bases: list[str] = field(default_factory=list)
    decorators: list[str] = field(default_factory=list)
    calls: list[tuple[str, str | None]] = field(default_factory=list)  # (callee name, receiver or None)
    is_entry: bool = False
    body: str = ""


@dataclass
class ImportRef:
    module: str
    names: list[str] = field(default_factory=list)
    level: int = 0
    line: int = 0
    alias: str | None = None


@dataclass
class FileParse:
    path: str
    language: str
    loc: int
    text: str
    doc: str = ""
    imports: list[ImportRef] = field(default_factory=list)
    symbols: list[Symbol] = field(default_factory=list)
    parse_error: str = ""


ENTRY_DECORATOR = re.compile(
    r"(?:app|router|bp|blueprint|api|server)\.(?:get|post|put|delete|patch|route|websocket|on_event)|"
    r"\.command\(|shared_task|\.task\b|click\.|typer\.|@cli|pytest\.fixture",
    re.I,
)
ENTRY_NAMES = {"main", "handler", "lambda_handler", "run", "cli", "app", "start"}


def looks_like_entry(name: str) -> bool:
    return name in ENTRY_NAMES or name.endswith("_handler") or name.startswith(("handle_", "on_", "cmd_", "command_"))


def _loc(text: str) -> int:
    return sum(1 for ln in text.splitlines() if ln.strip())


# ============================================================================ Python

def _dotted(node: ast.AST) -> str | None:
    parts: list[str] = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    return None


def _py_calls(node: ast.AST) -> list[tuple[str, str | None]]:
    """(callee, receiver). Receiver is None for bare calls, 'self', a dotted prefix ('utils.helpers'),
    'Type()' when a local was assigned from a constructor, or '?' when unknown (call result, subscript...)."""
    var_types: dict[str, str] = {}
    for n in ast.walk(node):
        if isinstance(n, ast.Assign) and isinstance(n.value, ast.Call) and isinstance(n.value.func, ast.Name) and n.value.func.id[:1].isupper():
            for t in n.targets:
                if isinstance(t, ast.Name):
                    var_types[t.id] = n.value.func.id
        elif isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name) and isinstance(n.annotation, ast.Name) and n.annotation.id[:1].isupper():
            var_types[n.target.id] = n.annotation.id
        elif isinstance(n, ast.arg) and isinstance(n.annotation, ast.Name) and n.annotation.id[:1].isupper():
            var_types.setdefault(n.arg, n.annotation.id)
    out: list[tuple[str, str | None]] = []
    for n in ast.walk(node):
        if not isinstance(n, ast.Call):
            continue
        f = n.func
        if isinstance(f, ast.Name):
            out.append((f.id, None))
        elif isinstance(f, ast.Attribute):
            base = f.value
            if isinstance(base, ast.Call) and isinstance(base.func, ast.Name) and base.func.id == "super":
                out.append((f.attr, "super"))
                continue
            d = _dotted(base)
            if d is None:
                out.append((f.attr, "?"))
            elif d in var_types:
                out.append((f.attr, var_types[d] + "()"))
            else:
                out.append((f.attr, d))
    return out


def _py_sig(node: ast.AST) -> str:
    try:
        if isinstance(node, ast.ClassDef):
            bases = ", ".join(ast.unparse(b) for b in node.bases)
            return f"class {node.name}({bases})" if bases else f"class {node.name}"
        prefix = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
        ret = f" -> {ast.unparse(node.returns)}" if node.returns else ""  # type: ignore[attr-defined]
        return f"{prefix} {node.name}({ast.unparse(node.args)}){ret}"  # type: ignore[attr-defined]
    except Exception:
        return getattr(node, "name", "")


def parse_python(path: str, text: str) -> FileParse:
    fp = FileParse(path=path, language="python", loc=_loc(text), text=text)
    tree = ast.parse(text)
    lines = text.splitlines()
    fp.doc = (ast.get_docstring(tree) or "").strip()

    def body_of(node: ast.AST) -> str:
        s, e = node.lineno, getattr(node, "end_lineno", node.lineno)  # type: ignore[attr-defined]
        return "\n".join(lines[s - 1 : e])

    def add_func(node: ast.FunctionDef | ast.AsyncFunctionDef, parent: str | None) -> None:
        decos = []
        for d in node.decorator_list:
            try:
                decos.append(ast.unparse(d))
            except Exception:
                pass
        entry = any(ENTRY_DECORATOR.search("@" + d) for d in decos) or (parent is None and looks_like_entry(node.name))
        fp.symbols.append(
            Symbol(
                name=node.name, kind="method" if parent else "function", start=node.lineno,
                end=getattr(node, "end_lineno", node.lineno), signature=_py_sig(node),
                doc=(ast.get_docstring(node) or "").strip(), parent=parent, decorators=decos,
                calls=_py_calls(node), is_entry=entry, body=body_of(node),
            )
        )

    def visit(nodes: list[ast.stmt], parent: str | None) -> None:
        for node in nodes:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                add_func(node, parent)
            elif isinstance(node, ast.ClassDef):
                bases = []
                for b in node.bases:
                    try:
                        bases.append(ast.unparse(b))
                    except Exception:
                        pass
                fp.symbols.append(
                    Symbol(
                        name=node.name, kind="class", start=node.lineno,
                        end=getattr(node, "end_lineno", node.lineno), signature=_py_sig(node),
                        doc=(ast.get_docstring(node) or "").strip(), parent=parent, bases=bases,
                        decorators=[ast.unparse(d) for d in node.decorator_list], body=body_of(node),
                    )
                )
                visit(node.body, node.name)
            elif isinstance(node, ast.If) and parent is None:
                # `if __name__ == "__main__":` -> synthetic entry symbol
                try:
                    test = ast.unparse(node.test)
                except Exception:
                    test = ""
                if "__name__" in test and "__main__" in test:
                    fp.symbols.append(
                        Symbol(
                            name="__main__", kind="function", start=node.lineno,
                            end=getattr(node, "end_lineno", node.lineno), signature="if __name__ == '__main__'",
                            doc="Script entry point", calls=_py_calls(node), is_entry=True, body=body_of(node),
                        )
                    )
                else:
                    visit(node.body, parent)
                    visit(node.orelse, parent)
            elif isinstance(node, (ast.Try, ast.With, ast.AsyncWith)) and parent is None:
                visit(node.body, parent)

    visit(tree.body, None)

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                fp.imports.append(ImportRef(module=a.name, alias=a.asname, line=node.lineno))
        elif isinstance(node, ast.ImportFrom):
            fp.imports.append(
                ImportRef(module=node.module or "", names=[a.name for a in node.names], level=node.level, line=node.lineno)
            )
    return fp


# ============================================================================ generic (regex) languages

_JS_FN = [
    r"^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:async[ \t]+)?function[ \t]*\*?[ \t]*(?P<name>[A-Za-z_$][\w$]*)[ \t]*(?:<[^>(]*>)?[ \t]*\(",
    r"^[ \t]*(?:export[ \t]+)?(?:const|let|var)[ \t]+(?P<name>[A-Za-z_$][\w$]*)[ \t]*(?::[^=\n]+)?=[ \t]*(?:async[ \t]*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)[ \t]*(?::[ \t]*[^=\n]+)?=>",
]
_JS_CLS = [
    r"^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:abstract[ \t]+)?(?:class|interface)[ \t]+(?P<name>[A-Za-z_$][\w$]*)(?:<[^>{]*>)?(?:[ \t]+extends[ \t]+(?P<base>[A-Za-z_$][\w$.]*))?"
]
_JS_METHOD = [
    r"^[ \t]+(?:(?:public|private|protected|static|async|get|set|readonly|override)[ \t]+)*(?P<name>[A-Za-z_$][\w$]*)[ \t]*(?:<[^>(]*>)?[ \t]*\([^)]*\)[ \t]*(?::[ \t]*[^{;\n]+)?\{"
]
_JS_IMP = [
    r"""import[ \t]+(?:[^'"\n;]*?[ \t]+from[ \t]+)?['"](?P<mod>[^'"\n]+)['"]""",
    r"""require\([ \t]*['"](?P<mod>[^'"\n]+)['"][ \t]*\)""",
    r"""export[ \t]+[^'"\n;]*?[ \t]+from[ \t]+['"](?P<mod>[^'"\n]+)['"]""",
]

PATTERNS: dict[str, dict[str, list[str]]] = {
    "javascript": {"fn": _JS_FN, "cls": _JS_CLS, "method": _JS_METHOD, "imp": _JS_IMP},
    "typescript": {"fn": _JS_FN, "cls": _JS_CLS, "method": _JS_METHOD, "imp": _JS_IMP},
    "java": {
        "cls": [r"^[ \t]*(?:(?:public|private|protected|abstract|final|static|sealed)[ \t]+)*(?:class|interface|enum|record)[ \t]+(?P<name>\w+)(?:<[^>{]*>)?(?:[ \t]+extends[ \t]+(?P<base>[\w.<>]+))?"],
        "fn": [],
        "method": [r"^[ \t]+(?:(?:public|private|protected|static|final|abstract|synchronized|native|default)[ \t]+)*(?:<[^>]+>[ \t]+)?[\w<>\[\],.?]+[ \t]+(?P<name>\w+)[ \t]*\([^;{)]*\)[ \t]*(?:throws[ \t]+[\w., ]+)?[ \t]*\{"],
        "imp": [r"^[ \t]*import[ \t]+(?:static[ \t]+)?(?P<mod>[\w.]+?)(?:\.\*)?[ \t]*;"],
    },
    "kotlin": {
        "cls": [r"^[ \t]*(?:(?:public|private|internal|open|abstract|data|sealed|enum|annotation)[ \t]+)*(?:class|interface|object)[ \t]+(?P<name>\w+)(?:[ \t]*\([^)]*\))?(?:[ \t]*:[ \t]*(?P<base>[\w.<>]+))?"],
        "fn": [r"^[ \t]*(?:(?:public|private|protected|internal|open|override|abstract|suspend|inline)[ \t]+)*fun[ \t]+(?:<[^>]+>[ \t]+)?(?:[\w.]+\.)?(?P<name>\w+)[ \t]*\("],
        "method": [],
        "imp": [r"^[ \t]*import[ \t]+(?P<mod>[\w.]+)"],
    },
    "go": {
        "cls": [r"^type[ \t]+(?P<name>\w+)[ \t]+(?:struct|interface)\b"],
        "fn": [r"^func[ \t]+(?:\((?P<recv>[^)]*)\)[ \t]*)?(?P<name>\w+)[ \t]*(?:\[[^\]]*\])?\("],
        "method": [],
        "imp": [],  # handled specially
    },
    "rust": {
        "cls": [r"^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?(?:struct|enum|trait)[ \t]+(?P<name>\w+)"],
        "fn": [r"^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?(?:const[ \t]+)?(?:async[ \t]+)?(?:unsafe[ \t]+)?fn[ \t]+(?P<name>\w+)"],
        "method": [],
        "imp": [r"^[ \t]*use[ \t]+(?P<mod>[\w:]+)", r"^[ \t]*mod[ \t]+(?P<mod>\w+)[ \t]*;"],
    },
    "c": {
        "cls": [r"^[ \t]*(?:typedef[ \t]+)?(?:struct|union|enum)[ \t]+(?P<name>\w+)[ \t]*\{"],
        "fn": [r"^(?!(?:[ \t]*(?:if|for|while|switch|return|else|do|typedef|using|namespace)\b))[A-Za-z_][\w \t\*&:<>,]*?[ \t\*&]+(?P<name>[A-Za-z_]\w*(?:::~?\w+)?)[ \t]*\([^;{}]*\)[ \t\n]*(?:const[ \t]*)?(?:noexcept[ \t]*)?(?:override[ \t]*)?\{"],
        "method": [],
        "imp": [r"""^[ \t]*#[ \t]*include[ \t]+["<](?P<mod>[^">]+)[">]"""],
    },
    "csharp": {
        "cls": [r"^[ \t]*(?:(?:public|internal|private|protected|static|abstract|sealed|partial)[ \t]+)*(?:class|interface|struct|enum|record)[ \t]+(?P<name>\w+)(?:<[^>{]*>)?(?:[ \t]*:[ \t]*(?P<base>[\w.<>]+))?"],
        "fn": [],
        "method": [r"^[ \t]+(?:(?:public|private|protected|internal|static|virtual|override|abstract|async|sealed|extern|unsafe|new)[ \t]+)+[\w<>\[\],.?]+[ \t]+(?P<name>\w+)[ \t]*(?:<[^>]+>)?[ \t]*\([^;{)]*\)[ \t]*(?:where[^{]+)?\{"],
        "imp": [r"^[ \t]*using[ \t]+(?:static[ \t]+)?(?P<mod>[\w.]+)[ \t]*;"],
    },
    "php": {
        "cls": [r"^[ \t]*(?:abstract[ \t]+|final[ \t]+)?(?:class|interface|trait)[ \t]+(?P<name>\w+)(?:[ \t]+extends[ \t]+(?P<base>\w+))?"],
        "fn": [r"^[ \t]*(?:(?:public|private|protected|static|abstract|final)[ \t]+)*function[ \t]+&?(?P<name>\w+)[ \t]*\("],
        "method": [],
        "imp": [r"""(?:require|include)(?:_once)?[ \t]*\(?[ \t]*['"](?P<mod>[^'"]+)['"]""", r"^use[ \t]+(?P<mod>[\w\\]+)"],
    },
    "ruby": {
        "cls": [r"^[ \t]*(?:class|module)[ \t]+(?P<name>\w+)(?:[ \t]*<[ \t]*(?P<base>[\w:]+))?"],
        "fn": [r"^[ \t]*def[ \t]+(?:self\.)?(?P<name>\w+[?!]?)"],
        "method": [],
        "imp": [r"""require(?:_relative)?[ \t]+['"](?P<mod>[^'"]+)['"]"""],
    },
    "swift": {
        "cls": [r"^[ \t]*(?:(?:public|private|internal|open|final)[ \t]+)*(?:class|struct|enum|protocol|extension)[ \t]+(?P<name>\w+)(?:[ \t]*:[ \t]*(?P<base>\w+))?"],
        "fn": [r"^[ \t]*(?:(?:public|private|internal|open|static|class|override|final|mutating)[ \t]+)*func[ \t]+(?P<name>\w+)"],
        "method": [],
        "imp": [r"^[ \t]*import[ \t]+(?P<mod>\w+)"],
    },
}
PATTERNS["cpp"] = PATTERNS["c"]
PATTERNS["cpp"] = {**PATTERNS["c"], "cls": PATTERNS["c"]["cls"] + [r"^[ \t]*(?:class)[ \t]+(?P<name>\w+)(?:[ \t]*:[ \t]*(?:public|private|protected)?[ \t]*(?P<base>[\w:]+))?"]}

BRACE_LANGS = {"javascript", "typescript", "java", "kotlin", "go", "rust", "c", "cpp", "csharp", "php", "swift"}
NOT_NAMES = {
    "if", "for", "while", "switch", "catch", "function", "return", "else", "with", "do", "try", "finally", "sizeof",
    "new", "typeof", "await", "yield", "delete", "throw", "case", "foreach", "using", "lock", "fixed", "synchronized",
    "elif", "when", "in", "is", "not", "and", "or", "super", "this", "fn", "def", "func", "fun", "echo", "print", "unset", "isset", "array", "list",
}
DECL_BLOCK = {"if", "for", "while", "switch", "catch", "function", "return", "else", "do", "try", "finally", "sizeof", "typeof",
              "await", "yield", "throw", "case", "foreach", "using", "lock", "fixed", "synchronized", "elif", "when", "with"}
CALL_RE = re.compile(r"(?:(?P<recv>[A-Za-z_$][\w$]*)[ \t]*(?:\.|->|::)[ \t]*)?(?P<name>[A-Za-z_$][\w$]*)[ \t]*\(")
LINE_COMMENT = {"python": "#", "ruby": "#", "php": "//"}


def _strip_comments(src: str, language: str) -> str:
    src = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), src, flags=re.S)
    if language in ("ruby",):
        return re.sub(r"(?m)#.*$", "", src)
    return re.sub(r"(?m)(?<![:\"'])//.*$", "", src)


def _brace_end(text: str, from_offset: int, limit: int = 250_000) -> int | None:
    """Offset of the closing brace matching the first '{' found at/after from_offset, or None."""
    i, n = from_offset, min(len(text), from_offset + limit)
    depth = 0
    started = False
    quote = None
    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote or (quote != "`" and ch == "\n"):
                quote = None
        elif ch == "/" and nxt == "/":
            j = text.find("\n", i)
            i = j if j != -1 else n
            continue
        elif ch == "/" and nxt == "*":
            j = text.find("*/", i + 2)
            i = (j + 2) if j != -1 else n
            continue
        elif ch in "\"'`":
            quote = ch
        elif ch == "{":
            depth += 1
            started = True
        elif ch == "}":
            depth -= 1
            if started and depth == 0:
                return i
        elif ch == ";" and not started:
            return None  # declaration without a body
        i += 1
    return None


def _line_of(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def _leading_comment(lines: list[str], start: int) -> str:
    out: list[str] = []
    i = start - 2
    while i >= 0 and len(out) < 8:
        s = lines[i].strip()
        if s.startswith(("//", "///", "#", "*", "/*", "/**", "--")) or s.endswith("*/"):
            out.append(re.sub(r"^(/\*\*?|\*/|\*|///?|#|--)\s?", "", s).strip())
            i -= 1
        elif s.startswith("@") and not out:  # annotation between doc and def
            i -= 1
        else:
            break
    return " ".join(reversed([o for o in out if o]))[:400]


def _go_imports(text: str) -> list[ImportRef]:
    out: list[ImportRef] = []
    for m in re.finditer(r"^import[ \t]*\(([^)]*)\)", text, re.M):
        base = _line_of(text, m.start())
        for k, line in enumerate(m.group(1).splitlines()):
            mm = re.search(r'"([^"]+)"', line)
            if mm:
                out.append(ImportRef(module=mm.group(1), line=base + k))
    for m in re.finditer(r'^import[ \t]+(?:\w+[ \t]+)?"([^"]+)"', text, re.M):
        out.append(ImportRef(module=m.group(1), line=_line_of(text, m.start())))
    return out


def parse_generic(path: str, text: str, language: str) -> FileParse:
    pats = PATTERNS.get(language, {"fn": [], "cls": [], "method": [], "imp": []})
    fp = FileParse(path=path, language=language, loc=_loc(text), text=text)
    lines = text.splitlines()
    fp.doc = _leading_comment(lines, 4) if lines and lines[0].lstrip().startswith(("//", "/*", "#")) else ""

    # ---- imports
    if language == "go":
        fp.imports = _go_imports(text)
    for pat in pats.get("imp", []):
        for m in re.finditer(pat, text, re.M):
            fp.imports.append(ImportRef(module=m.group("mod"), line=_line_of(text, m.start("mod"))))

    # ---- declarations
    found: list[tuple[str, re.Match, str]] = []
    for kind, key in (("class", "cls"), ("function", "fn"), ("method", "method")):
        for pat in pats.get(key, []):
            for m in re.finditer(pat, text, re.M):
                name = m.group("name")
                if name in DECL_BLOCK:
                    continue
                found.append((kind, m, name))

    # containers: classes + rust impl blocks (for method ownership)
    containers: list[tuple[int, int, str]] = []
    if language == "rust":
        for m in re.finditer(r"^[ \t]*impl(?:<[^>]*>)?[ \t]+(?:[\w:<>]+[ \t]+for[ \t]+)?(?P<name>\w+)[^{]*\{", text, re.M):
            end_off = _brace_end(text, m.end() - 1)
            if end_off:
                containers.append((_line_of(text, m.start()), _line_of(text, end_off), m.group("name")))

    seen: set[tuple[str, int]] = set()
    syms: list[Symbol] = []
    for kind, m, name in sorted(found, key=lambda t: t[1].start("name")):
        line = _line_of(text, m.start("name"))
        if (name, line) in seen:
            continue
        seen.add((name, line))
        end_line = line
        if language == "ruby":  # `end` keyword at the same indentation closes the block
            indent = len(lines[line - 1]) - len(lines[line - 1].lstrip())
            for k in range(line, len(lines)):
                if lines[k].strip() == "end" and len(lines[k]) - len(lines[k].lstrip()) == indent:
                    end_line = k + 1
                    break
        elif language in BRACE_LANGS:
            off = _brace_end(text, m.end() - 1 if m.group(0).endswith("{") else m.end())
            if off is not None:
                end_line = _line_of(text, off)
        body = "\n".join(lines[line - 1 : min(end_line, line + 400)])
        base = m.groupdict().get("base")
        sym = Symbol(
            name=name, kind=kind, start=line, end=end_line, signature=lines[line - 1].strip()[:200] if line - 1 < len(lines) else name,
            doc=_leading_comment(lines, line), bases=[base] if base else [], body=body,
        )
        recv = m.groupdict().get("recv")
        if recv:  # Go method receiver: (s *Server)
            tname = re.findall(r"[A-Za-z_]\w*", recv)
            if tname:
                sym.parent = tname[-1]
                sym.kind = "method"
        # calls
        clean = _strip_comments(body, language)
        var_types = dict(re.findall(r"\b(\w+)\s*(?::[^=;\n]+)?=\s*new\s+([A-Z]\w*)", clean))
        var_types.update({v: t for t, v in re.findall(r"\b([A-Z]\w*)(?:<[^>]*>)?\s+(\w+)\s*=\s*new\b", clean)})
        first_nl = clean.find("\n")
        if first_nl == -1:  # one-liner: drop only the declaration's own name so it doesn't "call itself"
            calls_src = clean.replace(name + "(", "(", 1).replace(name + " (", "(", 1)
        else:
            calls_src = clean[first_nl:]  # skip the signature line itself
        if kind != "class":
            for cm in CALL_RE.finditer(calls_src):
                cname = cm.group("name")
                if cname in NOT_NAMES:
                    continue
                recv = cm.group("recv")
                if recv in var_types:
                    recv = var_types[recv] + "()"
                sym.calls.append((cname, recv))
        if looks_like_entry(name) and kind != "class" and not sym.parent:
            sym.is_entry = True
        syms.append(sym)

    # assign ownership: symbols located inside a class (or impl) range
    classes = [s for s in syms if s.kind == "class"]
    ranges = [(c.start, c.end, c.name) for c in classes] + containers
    for s in syms:
        if s.kind == "class" or s.parent:
            continue
        owners = [r for r in ranges if r[0] < s.start <= r[1] and not (r[2] == s.name and r[0] == s.start)]
        if owners:
            owner = min(owners, key=lambda r: r[1] - r[0])
            s.parent = owner[2]
            s.kind = "method"
    # methods found by the method regex but outside any class are noise (calls / control flow) -> drop
    keep: list[Symbol] = []
    method_pats = bool(pats.get("method"))
    for s in syms:
        if s.kind == "method" and not s.parent and method_pats:
            continue
        keep.append(s)
    fp.symbols = keep
    return fp


def parse_code(path: str, text: str, language: str) -> FileParse:
    if language == "python":
        try:
            return parse_python(path, text)
        except SyntaxError as e:
            fp = FileParse(path=path, language="python", loc=_loc(text), text=text, parse_error=f"SyntaxError: {e.msg} (line {e.lineno})")
            return fp
        except Exception as e:  # pragma: no cover
            return FileParse(path=path, language="python", loc=_loc(text), text=text, parse_error=str(e))
    try:
        return parse_generic(path, text, language)
    except Exception as e:  # pragma: no cover
        return FileParse(path=path, language=language, loc=_loc(text), text=text, parse_error=str(e))
