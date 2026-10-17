"""Background watcher for live connect workspaces."""
from __future__ import annotations

import logging
import threading
import time
from pathlib import Path

from .state import db, jobs

log = logging.getLogger("nexmind.watcher")

class Watcher:
    def __init__(self):
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_mtime: dict[str, float] = {}

    def start(self):
        if self._thread is None:
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, name="nexmind-watcher", daemon=True)
            self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2.0)
            self._thread = None

    def _get_max_mtime(self, folder: Path) -> float:
        max_mtime = 0.0
        try:
            for p in folder.rglob("*"):
                if p.is_file():
                    try:
                        mtime = p.stat().st_mtime
                        if mtime > max_mtime:
                            max_mtime = mtime
                    except OSError:
                        pass
        except OSError:
            pass
        return max_mtime

    def _run(self):
        log.info("Live watcher started")
        while not self._stop.is_set():
            try:
                # Find all sources that are being watched
                sources = db.query("SELECT id, workspace_id, path FROM sources WHERE watch=1")
                for s in sources:
                    sid = s["id"]
                    path = Path(s["path"])
                    if not path.exists() or not path.is_dir():
                        continue
                    
                    current_mtime = self._get_max_mtime(path)
                    
                    last = self._last_mtime.get(sid, 0.0)
                    if last == 0.0:
                        # First time seeing this source, just record mtime
                        self._last_mtime[sid] = current_mtime
                    elif current_mtime > last:
                        self._last_mtime[sid] = current_mtime
                        log.info("Change detected in %s, rebuilding workspace %s", path, s["workspace_id"])
                        # Trigger rebuild. If a job is already queued/running, jobs.submit will create a new one,
                        # but it's better if we just rebuild.
                        jobs.submit(s["workspace_id"], "rebuild")
                        
            except Exception as e:
                log.error("Error in watcher loop: %s", e)
            
            # Sleep for a bit before checking again
            self._stop.wait(3.0)

watcher = Watcher()
