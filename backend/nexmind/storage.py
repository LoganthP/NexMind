"""Source-file store.

Uploaded / downloaded project files are kept in the database (compressed), so the app needs no writable
disk: this is what makes it work on Vercel. During a build they are written to a temporary folder.
Local folders connected in place (local mode only) are read straight from disk instead.
"""
from __future__ import annotations

import gzip
import shutil
from pathlib import Path

from .db import DB
from .ingest.files import walk_source


class FileStore:
    BATCH = 150

    def __init__(self, db: DB):
        self.db = db

    def store_tree(self, ws_id: str, source_id: str, root: Path) -> tuple[int, int]:
        """Save every supported file under root. Returns (file count, total original bytes)."""
        self.delete_source(source_id)
        rows: list[tuple] = []
        count = total = 0

        def flush() -> None:
            if rows:
                self.db.executemany("INSERT INTO files(source_id, path, workspace_id, size, data) VALUES(?,?,?,?,?)", rows)
                rows.clear()

        for fe in walk_source(root):
            try:
                raw = fe.abs.read_bytes()
            except OSError:
                continue
            rows.append((source_id, fe.rel, ws_id, len(raw), gzip.compress(raw, compresslevel=5)))
            count += 1
            total += len(raw)
            if len(rows) >= self.BATCH:
                flush()
        flush()
        return count, total

    def materialize(self, source_id: str, dest: Path) -> int:
        dest.mkdir(parents=True, exist_ok=True)
        n = 0
        for r in self.db.query("SELECT path, data FROM files WHERE source_id=?", (source_id,)):
            target = (dest / r["path"]).resolve()
            if dest.resolve() not in target.parents:
                continue  # never write outside the build folder
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(gzip.decompress(bytes(r["data"])))
            n += 1
        return n

    def read(self, source_id: str, rel: str) -> bytes | None:
        r = self.db.one("SELECT data FROM files WHERE source_id=? AND path=?", (source_id, rel))
        return gzip.decompress(bytes(r["data"])) if r else None

    def paths(self, source_id: str) -> list[str]:
        return [r["path"] for r in self.db.query("SELECT path FROM files WHERE source_id=? ORDER BY path", (source_id,))]

    def delete_source(self, source_id: str) -> None:
        self.db.execute("DELETE FROM files WHERE source_id=?", (source_id,))

    def delete_workspace(self, ws_id: str) -> None:
        self.db.execute("DELETE FROM files WHERE workspace_id=?", (ws_id,))


def read_source_file(db: DB, files: FileStore, source_id: str | None, rel: str | None) -> bytes | None:
    """Read one file of a source, whether stored in the database or connected in place on disk."""
    if not source_id or not rel:
        return None
    src = db.one("SELECT path, stored FROM sources WHERE id=?", (source_id,))
    if not src:
        return None
    if src.get("stored"):
        return files.read(source_id, rel)
    root = Path(src["path"] or "").resolve()
    target = (root / rel).resolve()
    if not src["path"] or root not in target.parents or not target.is_file():
        return None
    try:
        return target.read_bytes()
    except OSError:
        return None


def remove_tree(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)
