"""LLM access over plain HTTPS (standard library only, nothing extra to install).

Providers: openai | anthropic | ollama | offline | mock.
`offline` means no model at all: NexMind still works (retrieval, graph, extractive answers) with zero API keys.
Configure with OPENAI_API_KEY (and optionally NEXMIND_LLM_MODEL, OPENAI_BASE_URL).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import urllib.error
import urllib.request
from typing import AsyncIterator, Iterator

from ..config import settings

log = logging.getLogger("nexmind.llm")

DEFAULT_MODELS = {"anthropic": "claude-sonnet-5-5", "openai": "gpt-4o-mini", "ollama": "llama3.1"}
TIMEOUT = 120


class LLMError(Exception):
    pass


def _post(url: str, headers: dict, body: dict, stream: bool):
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), method="POST",
                                 headers={"Content-Type": "application/json", **headers})
    try:
        return urllib.request.urlopen(req, timeout=TIMEOUT)
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = json.loads(e.read().decode("utf-8", "ignore")).get("error", {})
            detail = detail.get("message", "") if isinstance(detail, dict) else str(detail)
        except Exception:
            pass
        raise LLMError(f"HTTP {e.code}: {detail or e.reason}") from None
    except urllib.error.URLError as e:
        raise LLMError(f"Cannot reach the model provider: {e.reason}") from None


class LLM:
    def __init__(self, provider: str | None = None, model: str | None = None):
        self.provider = (provider or settings.llm_provider or "offline").lower()
        self.model = model or settings.llm_model or DEFAULT_MODELS.get(self.provider, "")
        self.last_error: str | None = None
        self.mock_complete_reply = "[]"  # test hook

    @property
    def available(self) -> bool:
        if self.provider in ("offline", "none", ""):
            return False
        if self.provider == "openai" and not os.environ.get("OPENAI_API_KEY", "").strip():
            return False
        if self.provider == "anthropic" and not os.environ.get("ANTHROPIC_API_KEY", "").strip():
            return False
        return True

    def info(self) -> dict:
        return {"provider": self.provider, "model": self.model if self.available else None, "available": self.available, "last_error": self.last_error}

    # ------------------------------------------------------------------ providers (sync generators of text pieces)
    def _openai(self, system: str, messages: list[dict], stream: bool) -> Iterator[str]:
        base = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
        body = {"model": self.model, "temperature": 0.2, "stream": stream,
                "messages": [{"role": "system", "content": system}] + [{"role": m["role"], "content": m["content"]} for m in messages]}
        r = _post(f"{base}/chat/completions", {"Authorization": f"Bearer {os.environ['OPENAI_API_KEY'].strip()}"}, body, stream)
        with r:
            if not stream:
                data = json.loads(r.read().decode("utf-8"))
                yield data["choices"][0]["message"].get("content") or ""
                return
            for raw in r:
                line = raw.decode("utf-8", "ignore").strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    delta = json.loads(payload)["choices"][0].get("delta", {}).get("content")
                except (ValueError, KeyError, IndexError):
                    continue
                if delta:
                    yield delta

    def _anthropic(self, system: str, messages: list[dict], stream: bool) -> Iterator[str]:
        body = {"model": self.model, "max_tokens": 1800, "temperature": 0.2, "system": system, "stream": stream,
                "messages": [{"role": "assistant" if m["role"] == "assistant" else "user", "content": m["content"]} for m in messages]}
        r = _post("https://api.anthropic.com/v1/messages", {"x-api-key": os.environ["ANTHROPIC_API_KEY"].strip(), "anthropic-version": "2023-06-01"}, body, stream)
        with r:
            if not stream:
                data = json.loads(r.read().decode("utf-8"))
                yield "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
                return
            for raw in r:
                line = raw.decode("utf-8", "ignore").strip()
                if not line.startswith("data:"):
                    continue
                try:
                    ev = json.loads(line[5:].strip())
                except ValueError:
                    continue
                if ev.get("type") == "content_block_delta":
                    t = ev.get("delta", {}).get("text")
                    if t:
                        yield t

    def _ollama(self, system: str, messages: list[dict], stream: bool) -> Iterator[str]:
        body = {"model": self.model, "stream": stream, "messages": [{"role": "system", "content": system}] + messages}
        r = _post(f"{settings.ollama_base_url.rstrip('/')}/api/chat", {}, body, stream)
        with r:
            if not stream:
                yield json.loads(r.read().decode("utf-8")).get("message", {}).get("content", "")
                return
            for raw in r:
                try:
                    t = json.loads(raw.decode("utf-8")).get("message", {}).get("content")
                except ValueError:
                    continue
                if t:
                    yield t

    def _gen(self, system: str, messages: list[dict], stream: bool) -> Iterator[str]:
        fn = {"openai": self._openai, "anthropic": self._anthropic, "ollama": self._ollama}.get(self.provider)
        if fn is None:
            raise LLMError(f"Unknown LLM provider '{self.provider}'")
        return fn(system, messages, stream)

    # ------------------------------------------------------------------ public API (unchanged)
    async def astream(self, system: str, messages: list[dict]) -> AsyncIterator[str]:
        if self.provider == "mock":
            reply = "(mock model) " + messages[-1]["content"][-300:]
            for w in reply.split(" "):
                yield w + " "
                await asyncio.sleep(0)
            return
        loop = asyncio.get_running_loop()
        q: asyncio.Queue = asyncio.Queue()
        done = object()

        def worker() -> None:
            try:
                for piece in self._gen(system, messages, True):
                    loop.call_soon_threadsafe(q.put_nowait, piece)
                self.last_error = None
            except Exception as e:  # noqa: BLE001
                self.last_error = f"{type(e).__name__}: {e}"
                loop.call_soon_threadsafe(q.put_nowait, e)
            finally:
                loop.call_soon_threadsafe(q.put_nowait, done)

        threading.Thread(target=worker, daemon=True).start()
        while True:
            item = await q.get()
            if item is done:
                break
            if isinstance(item, Exception):
                raise item
            yield item

    def complete(self, system: str, prompt: str) -> str:
        """Blocking call for worker threads (entity extraction, summaries)."""
        if self.provider == "mock":
            return self.mock_complete_reply
        try:
            text = "".join(self._gen(system, [{"role": "user", "content": prompt}], False))
            self.last_error = None
            return text
        except Exception as e:
            self.last_error = f"{type(e).__name__}: {e}"
            raise


_llm: LLM | None = None


def get_llm() -> LLM:
    global _llm
    if _llm is None:
        _llm = LLM()
    return _llm


def set_llm(llm: LLM) -> None:  # used by tests and the runtime /api/llm endpoint
    global _llm
    _llm = llm
