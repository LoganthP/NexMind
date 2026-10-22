"""Vercel may install from requirements.txt OR pyproject.toml: they must never drift apart again."""
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_requirements_and_pyproject_match():
    req = sorted(l.strip() for l in (ROOT / "requirements.txt").read_text().splitlines() if l.strip() and not l.startswith("#"))
    proj = sorted(tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]["dependencies"])
    assert req == proj


def test_every_imported_third_party_module_is_declared():
    import ast
    import sys

    declared = {"fastapi", "starlette", "pydantic", "uvicorn", "multipart", "python_multipart", "dotenv", "networkx", "numpy",
                "scipy", "sklearn", "pypdf", "docx", "pg8000"}
    stdlib = set(sys.stdlib_module_names)
    missing = set()
    for py in (ROOT / "nexmind").rglob("*.py"):
        for node in ast.walk(ast.parse(py.read_text(encoding="utf-8"))):
            names = []
            if isinstance(node, ast.Import):
                names = [a.name.split(".")[0] for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                names = [node.module.split(".")[0]]
            for n in names:
                if n not in stdlib and n not in declared and n != "nexmind":
                    missing.add(f"{n} ({py.name})")
    # optional, guarded imports that are allowed to be absent
    missing -= {m for m in missing if m.split(" ")[0] in {"sentence_transformers", "pgserver", "watchdog", "tkinter"}}
    assert not missing, f"imported but not declared in requirements.txt: {sorted(missing)}"
