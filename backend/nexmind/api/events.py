"""Live progress without WebSockets (Vercel has none): an event feed to poll, and a job runner that streams."""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, StreamingResponse

from ..jobs import JobBusy
from ..state import db, events, jobs
from .workspaces import get_job, get_ws

router = APIRouter(prefix="/api", tags=["events"])


@router.get("/workspaces/{ws_id}/events")
def workspace_events(ws_id: str, after: int = Query(0, ge=0), limit: int = Query(300, ge=1, le=1000)) -> dict:
    """Events after `after` (use the returned `seq` next time) plus the workspace status and any job waiting to run."""
    ws = get_ws(ws_id)
    evs = events.since(ws_id, after, limit)
    pending = jobs.pending_for(ws_id)
    running = db.one("SELECT id, progress, phase, message FROM jobs WHERE workspace_id=? AND status='running' ORDER BY created_at DESC LIMIT 1", (ws_id,))
    return {
        "events": evs,
        "seq": evs[-1]["seq"] if evs else max(after, events.latest_seq(ws_id) if after == 0 else after),
        "status": ws["status"],
        "pending_job": {"id": pending["id"], "status": pending["status"]} if pending else None,
        "running_job": running,
    }


@router.post("/jobs/{job_id}/run")
def run_job(job_id: str):
    """Run a queued job inside this request and stream its events as NDJSON (one JSON object per line).

    409 means it is already running elsewhere or finished; follow it with the events feed instead."""
    job = get_job(job_id)
    try:
        stream = jobs.run(job_id)
        first = next(stream)  # claim happens here; raises JobBusy before any byte is sent
    except JobBusy as e:
        return JSONResponse(status_code=409, content={"detail": f"Job is {e.args[0] if e.args else 'busy'}", "status": str(e.args[0]) if e.args else "busy"})
    except KeyError:
        raise HTTPException(404, "Job not found")
    except StopIteration:
        return JSONResponse(status_code=200, content={"status": "done", "job_id": job["id"]})

    def body():
        yield json.dumps(first, default=str) + "\n"
        for ev in stream:
            yield json.dumps(ev, default=str) + "\n"

    return StreamingResponse(body(), media_type="application/x-ndjson", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
