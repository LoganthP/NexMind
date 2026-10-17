"""Per-workspace chat threads (separate histories) with streaming GraphRAG answers over Server-Sent Events."""
from __future__ import annotations

import json
from typing import AsyncIterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..db import dumps, loads, new_id, now
from ..rag.chat import run_chat
from ..rag.llm import get_llm
from ..state import db, store
from .workspaces import get_ws

router = APIRouter(prefix="/api/workspaces/{ws_id}", tags=["chat"])


class ThreadIn(BaseModel):
    title: str = Field(default="New chat", max_length=120)


class MessageIn(BaseModel):
    content: str = Field(min_length=1, max_length=8000)
    stream: bool = True


def _thread(ws_id: str, tid: str) -> dict:
    t = db.one("SELECT * FROM threads WHERE id=? AND workspace_id=?", (tid, ws_id))
    if not t:
        raise HTTPException(404, "Thread not found")
    return t


def _thread_out(t: dict) -> dict:
    last = db.one("SELECT content FROM messages WHERE thread_id=? ORDER BY created_at DESC LIMIT 1", (t["id"],))
    n = db.one("SELECT COUNT(*) AS n FROM messages WHERE thread_id=?", (t["id"],))
    return {**t, "message_count": n["n"] if n else 0, "last_message": (last["content"][:120] if last else None)}


def _msg_out(m: dict) -> dict:
    return {"id": m["id"], "thread_id": m["thread_id"], "role": m["role"], "content": m["content"], "meta": loads(m["meta"], {}), "created_at": m["created_at"]}


@router.get("/threads")
def list_threads(ws_id: str) -> list[dict]:
    get_ws(ws_id)
    return [_thread_out(t) for t in db.query("SELECT * FROM threads WHERE workspace_id=? ORDER BY updated_at DESC", (ws_id,))]


@router.post("/threads", status_code=201)
def create_thread(ws_id: str, body: ThreadIn | None = None) -> dict:
    get_ws(ws_id)
    tid = new_id("th_")
    t = now()
    db.execute("INSERT INTO threads(id,workspace_id,title,created_at,updated_at) VALUES(?,?,?,?,?)", (tid, ws_id, (body.title if body else "New chat"), t, t))
    return _thread_out(_thread(ws_id, tid))


@router.patch("/threads/{tid}")
def rename_thread(ws_id: str, tid: str, body: ThreadIn) -> dict:
    _thread(ws_id, tid)
    db.execute("UPDATE threads SET title=?, updated_at=? WHERE id=?", (body.title, now(), tid))
    return _thread_out(_thread(ws_id, tid))


@router.delete("/threads/{tid}", status_code=204)
def delete_thread(ws_id: str, tid: str) -> None:
    _thread(ws_id, tid)
    db.execute("DELETE FROM messages WHERE thread_id=?", (tid,))
    db.execute("DELETE FROM threads WHERE id=?", (tid,))


@router.get("/threads/{tid}/messages")
def list_messages(ws_id: str, tid: str) -> list[dict]:
    _thread(ws_id, tid)
    return [_msg_out(m) for m in db.query("SELECT * FROM messages WHERE thread_id=? ORDER BY created_at, rowid", (tid,))]


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/threads/{tid}/messages")
async def post_message(ws_id: str, tid: str, body: MessageIn):
    """Ask a question. Default response is an SSE stream with events:
    `start` → `retrieval` (graph activation map + citations) → many `token` → `done` (answer, citations, follow-ups)."""
    th = _thread(ws_id, tid)
    ws = get_ws(ws_id)
    history = [{"role": m["role"], "content": m["content"]} for m in db.query("SELECT role, content FROM messages WHERE thread_id=? ORDER BY created_at, rowid", (tid,))]
    user_id = new_id("msg_")
    t = now()
    db.execute("INSERT INTO messages(id,thread_id,role,content,meta,created_at) VALUES(?,?,?,?,?,?)", (user_id, tid, "user", body.content, "{}", t))
    if th["title"] in ("New chat", "") and not history:
        db.execute("UPDATE threads SET title=?, updated_at=? WHERE id=?", (body.content.strip()[:60], t, tid))
    else:
        db.execute("UPDATE threads SET updated_at=? WHERE id=?", (t, tid))
    wg = store.get(ws_id)
    llm = get_llm()
    assistant_id = new_id("msg_")

    async def events() -> AsyncIterator[tuple[str, dict]]:
        yield "start", {"user_message_id": user_id, "assistant_message_id": assistant_id, "thread_id": tid, "provider": llm.info()}
        if not wg.nodes:
            msg = "This workspace has no graph yet — upload a PDF, zip or repository first."
            yield "retrieval", {"activations": [], "edges": [], "citations": [], "intent": "qa", "structured": None}
            yield "token", {"text": msg}
            yield "done", {"answer": msg, "citations": [], "followups": [], "provider": "offline", "activated_nodes": []}
            return
        async for ev in run_chat(wg, body.content, history, llm):
            yield ev

    async def persist_wrapper() -> AsyncIterator[str]:
        answer, meta, finished = "", {}, False
        try:
            async for ev, data in events():
                if ev == "token":
                    answer += data["text"]
                elif ev == "retrieval":
                    meta["activations"] = data["activations"]
                    meta["edges"] = data["edges"]
                    meta["intent"] = data.get("intent")
                    meta["structured"] = data.get("structured")
                elif ev == "done":
                    answer = data["answer"] or answer
                    meta.update(citations=data["citations"], followups=data["followups"], provider=data["provider"])
                    finished = True
                yield _sse(ev, data)
        finally:
            if answer:
                meta["partial"] = not finished
                db.execute("INSERT INTO messages(id,thread_id,role,content,meta,created_at) VALUES(?,?,?,?,?,?)", (assistant_id, tid, "assistant", answer, dumps(meta), now()))
                db.execute("UPDATE threads SET updated_at=? WHERE id=?", (now(), tid))

    if body.stream:
        return StreamingResponse(persist_wrapper(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    # non-streaming JSON (handy for curl/tests)
    result: dict = {}
    async for chunk in persist_wrapper():
        ev = chunk.split("\n", 1)[0].removeprefix("event: ")
        data = json.loads(chunk.split("data: ", 1)[1])
        if ev == "retrieval":
            result["retrieval"] = data
        elif ev == "done":
            result["done"] = data
    return {"message_id": assistant_id, **result}
