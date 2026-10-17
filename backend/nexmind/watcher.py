"""Background watcher for live connect workspaces."""
from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path

from .events import hub
from .ingest.files import walk_source
from .state import db, jobs

log = logging.getLogger("nexmind.watcher")


class Watcher:
    def __init__(self):
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_sig: dict[str, tuple[int, float, int]] = {}
        self._pending: dict[str, tuple[tuple[int, float, int], float]] = {}

    def start(self):
        if self._thread is None:
            self._stop.clear()
            self._wake.clear()
            self._thread = threading.Thread(target=self._run, name="nexmind-watcher", daemon=True)
            self._thread.start()
            log.info("Live watcher started")

    def stop(self):
        self._stop.set()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout=2.0)
            self._thread = None
            log.info("Live watcher stopped")

    def wake(self):
        self._wake.set()

    def register_source(self, sid: str, path: Path):
        try:
            self._last_sig[sid] = self._compute_sig(path)
            self._pending.pop(sid, None)
        except Exception:
            pass
        self._wake.set()

    def unregister_source(self, sid: str):
        self._last_sig.pop(sid, None)
        self._pending.pop(sid, None)
        self._wake.set()

    def _compute_sig(self, path: Path) -> tuple[int, float, int]:
        file_count = 0
        max_mtime = 0.0
        total_size = 0
        for fe in walk_source(path):
            file_count += 1
            total_size += fe.size
            try:
                mt = fe.abs.stat().st_mtime
                if mt > max_mtime:
                    max_mtime = mt
            except OSError:
                pass
        return (file_count, max_mtime, total_size)

    def _run(self):
        while not self._stop.is_set():
            interval = float(os.environ.get("NEXMIND_WATCH_INTERVAL", "2.0"))
            settle = float(os.environ.get("NEXMIND_WATCH_SETTLE", "3.0" if interval >= 1.0 else str(max(0.3, interval * 1.5))))
            try:
                sources = db.query("SELECT id, workspace_id, path FROM sources WHERE watch=1")
                active_sids = {s["id"] for s in sources}
                for sid in list(self._last_sig.keys()):
                    if sid not in active_sids:
                        self._last_sig.pop(sid, None)
                        self._pending.pop(sid, None)

                for s in sources:
                    sid = s["id"]
                    ws_id = s["workspace_id"]
                    p = Path(s["path"])
                    if not p.exists() or not p.is_dir():
                        log.info("Watched path %s no longer exists, stopping watch", p)
                        db.execute("UPDATE sources SET watch=0 WHERE id=?", (sid,))
                        self._last_sig.pop(sid, None)
                        self._pending.pop(sid, None)
                        continue

                    try:
                        sig = self._compute_sig(p)
                    except Exception as e:
                        log.debug("Error computing signature for %s: %s", p, e)
                        continue

                    if sid not in self._last_sig:
                        self._last_sig[sid] = sig
                        self._pending.pop(sid, None)
                        continue

                    last = self._last_sig[sid]
                    if sig == last:
                        self._pending.pop(sid, None)
                        continue

                    if sid not in self._pending or self._pending[sid][0] != sig:
                        self._pending[sid] = (sig, time.time())
                    else:
                        sig_candidate, first_seen = self._pending[sid]
                        elapsed = time.time() - first_seen
                        if elapsed >= settle:
                            row = db.one("SELECT COUNT(*) AS n FROM jobs WHERE workspace_id=? AND status IN ('queued', 'running')", (ws_id,))
                            if not (row and row["n"] > 0):
                                log.info("Source %s in workspace %s changed and stabilized. Triggering rebuild.", sid, ws_id)
                                jobs.submit(ws_id, "rebuild")
                                hub.publish(ws_id, {"type": "source_changed", "source_id": sid})
                                self._last_sig[sid] = sig
                                self._pending.pop(sid, None)

            except Exception as e:
                log.error("Error in watcher loop: %s", e)

            # Wait for interval or until woken up (or stopped)
            self._wake.wait(timeout=interval)
            self._wake.clear()


watcher = Watcher()
