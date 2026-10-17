"""File handling: safe extraction (zip-slip / zip-bomb protection), directory walking, classification."""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import tarfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator
from urllib.parse import urlparse

from ..config import settings

IGNORED_DIRS = {
    ".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv", "env", ".env", "dist", "build",
    ".idea", ".vscode", ".next", ".nuxt", "target", "vendor", ".gradle", ".tox", ".mypy_cache", ".pytest_cache",
    "coverage", ".cache", "bower_components", "site-packages", ".dart_tool", "Pods", "__MACOSX",
}
IGNORED_FILES = {"package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock", "Cargo.lock", ".DS_Store", "composer.lock"}

CODE_LANGS = {
    ".py": "python", ".pyw": "python",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".ts": "typescript", ".tsx": "typescript",
    ".java": "java", ".kt": "kotlin", ".kts": "kotlin",
    ".go": "go", ".rs": "rust",
    ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp",
    ".cs": "csharp", ".php": "php", ".rb": "ruby", ".swift": "swift",
}
DOC_TYPES = {
    ".pdf": "pdf", ".docx": "docx", ".md": "markdown", ".markdown": "markdown", ".txt": "text", ".rst": "text",
    ".html": "html", ".htm": "html", ".csv": "csv", ".json": "json", ".ipynb": "notebook", ".log": "text",
    ".yaml": "text", ".yml": "text", ".toml": "text", ".ini": "text", ".cfg": "text",
}
ARCHIVE_EXT = (".zip", ".tar", ".tar.gz", ".tgz", ".tar.bz2")


class IngestError(Exception):
    pass


@dataclass
class FileEntry:
    rel: str  # path relative to the source root, posix style
    abs: Path
    size: int
    category: str  # code | doc
    language: str  # python / pdf / markdown ...


def classify(path: Path) -> tuple[str, str] | None:
    name = path.name
    if name in IGNORED_FILES or name.endswith(".min.js") or name.endswith(".map"):
        return None
    ext = path.suffix.lower()
    if ext in CODE_LANGS:
        return "code", CODE_LANGS[ext]
    if ext in DOC_TYPES:
        return "doc", DOC_TYPES[ext]
    if name.lower() in {"readme", "license", "changelog", "dockerfile", "makefile"}:
        return "doc", "text"
    return None


def walk_source(root: Path) -> Iterator[FileEntry]:
    count = 0
    max_bytes = settings.max_file_kb * 1024 * 20  # PDFs / DOCX are binary and naturally larger
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in IGNORED_DIRS and not d.startswith(".") or d in {".github"})
        for fn in sorted(filenames):
            p = Path(dirpath) / fn
            if p.is_symlink():
                continue
            cls = classify(p)
            if cls is None:
                continue
            try:
                size = p.stat().st_size
            except OSError:
                continue
            cat, lang = cls
            limit = max_bytes if lang == "pdf" or lang == "docx" else settings.max_file_kb * 1024
            if size == 0 or size > limit:
                continue
            count += 1
            if count > settings.max_files:
                return
            yield FileEntry(rel=p.relative_to(root).as_posix(), abs=p, size=size, category=cat, language=lang)


# ----------------------------------------------------------------------------- archives

def _is_within(base: Path, target: Path) -> bool:
    try:
        target.resolve().relative_to(base.resolve())
        return True
    except ValueError:
        return False


def safe_extract_zip(zpath: Path, dest: Path) -> int:
    dest.mkdir(parents=True, exist_ok=True)
    total = 0
    n = 0
    limit = settings.max_unzipped_mb * 1024 * 1024
    with zipfile.ZipFile(zpath) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            name = info.filename.replace("\\", "/")
            if name.startswith("/") or ".." in Path(name).parts:
                continue  # zip-slip attempt: skip silently
            if (info.external_attr >> 16) & 0o170000 == 0o120000:
                continue  # symlink
            parts = Path(name).parts
            if any(p in IGNORED_DIRS for p in parts[:-1]):
                continue
            total += info.file_size
            n += 1
            if total > limit:
                raise IngestError(f"Archive expands beyond the {settings.max_unzipped_mb} MB limit")
            if n > settings.max_files * 2:
                raise IngestError("Archive contains too many files")
            target = dest / name
            if not _is_within(dest, target):
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out, length=1024 * 256)
    return n


def safe_extract_tar(tpath: Path, dest: Path) -> int:
    dest.mkdir(parents=True, exist_ok=True)
    total = 0
    n = 0
    limit = settings.max_unzipped_mb * 1024 * 1024
    with tarfile.open(tpath) as tf:
        for m in tf:
            if not m.isfile():
                continue
            name = m.name.replace("\\", "/")
            if name.startswith("/") or ".." in Path(name).parts:
                continue
            if any(p in IGNORED_DIRS for p in Path(name).parts[:-1]):
                continue
            total += m.size
            n += 1
            if total > limit or n > settings.max_files * 2:
                raise IngestError("Archive too large")
            target = dest / name
            if not _is_within(dest, target):
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            f = tf.extractfile(m)
            if f is None:
                continue
            with f, open(target, "wb") as out:
                shutil.copyfileobj(f, out, length=1024 * 256)
    return n


def collapse_single_root(dest: Path) -> Path:
    """GitHub zips contain one top-level folder; descend into it so paths look natural."""
    entries = [p for p in dest.iterdir()]
    if len(entries) == 1 and entries[0].is_dir():
        return entries[0]
    return dest


# ----------------------------------------------------------------------------- git

_GIT_URL = re.compile(r"^https://[A-Za-z0-9.\-]+/[A-Za-z0-9_.\-/]+?(?:\.git)?/?$")


def validate_git_url(url: str) -> str:
    url = url.strip()
    if not _GIT_URL.match(url):
        raise IngestError("Only plain https:// git URLs are accepted (e.g. https://github.com/owner/repo)")
    host = (urlparse(url).hostname or "").lower()
    if host not in settings.git_hosts:
        raise IngestError(f"Host '{host}' is not allowed. Allowed: {', '.join(settings.git_hosts)} (NEXMIND_GIT_HOSTS)")
    return url


_AUTH_USER = {"github.com": "x-access-token", "gitlab.com": "oauth2", "bitbucket.org": "x-token-auth", "codeberg.org": "oauth2", "dev.azure.com": "pat"}


def git_clone(url: str, dest: Path, branch: str | None = None, token: str | None = None) -> None:
    """Shallow-clone a repo. An optional access token (for private repos) is used for this one command only:
    it is never stored, never logged, and removed from any error text."""
    url = validate_git_url(url)
    if branch and not re.match(r"^[A-Za-z0-9_.\-/]+$", branch):
        raise IngestError("Invalid branch name")
    target = url
    if token:
        token = token.strip()
        if not re.match(r"^[A-Za-z0-9_\-.~+/=]{8,300}$", token):
            raise IngestError("That access token contains unexpected characters")
        host = (urlparse(url).hostname or "").lower()
        target = url.replace("https://", f"https://{_AUTH_USER.get(host, 'x-access-token')}:{token}@", 1)
    cmd = ["git", "clone", "--depth", "1", "--single-branch", "--no-tags"]
    if branch:
        cmd += ["--branch", branch]
    cmd += ["--", target, str(dest)]
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "echo", "GCM_INTERACTIVE": "never"}
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=settings.git_timeout_s, env=env)
    except FileNotFoundError as e:
        raise IngestError("git is not installed on this machine") from e
    except subprocess.TimeoutExpired as e:
        raise IngestError("git clone timed out") from e
    if r.returncode != 0:
        err = (r.stderr or "").strip()
        if token:
            err = err.replace(token, "***")
        last = (err.splitlines() or ["unknown error"])[-1]
        if re.search(r"not found|authentication|could not read|403|401|invalid credentials", err, re.I):
            raise IngestError("Repository not found or private. For a private repo, paste an access token with read access.")
        raise IngestError("git clone failed: " + last)
    shutil.rmtree(dest / ".git", ignore_errors=True)
