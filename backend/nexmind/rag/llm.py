"""LLM access through LangChain chat models. Providers: anthropic | openai | ollama | offline | mock.

`offline` means no model at all: NexMind still works (retrieval, graph, extractive answers) with zero API keys.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, AsyncIterator

from ..config import settings

log = logging.getLogger("nexmind.llm")

DEFAULT_MODELS = {"anthropic": "claude-sonnet-5-5", "openai": "gpt-4o-mini", "ollama": "llama3.1"}


def _text(chunk: Any) -> str:
    c = getattr(chunk, "content", chunk)
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        parts = []
        for b in c:
            if isinstance(b, str):
                parts.append(b)
            elif isinstance(b, dict) and b.get("type", "text") == "text":
                parts.append(b.get("text", ""))
        return "".join(parts)
    return ""


class LLM:
    def __init__(self, provider: str | None = None, model: str | None = None):
        self.provider = (provider or settings.llm_provider or "offline").lower()
        self.model = model or settings.llm_model or DEFAULT_MODELS.get(self.provider, "")
        self._chat: Any = None
        self.last_error: str | None = None
        self._disabled_reason: str | None = None
        self.mock_complete_reply = "[]"  # test hook

    @property
    def available(self) -> bool:
        if self._disabled_reason:
            return False
        if self.provider in ("offline", "none", ""):
            return False
        if self.provider == "openai" and not os.environ.get("OPENAI_API_KEY", "").strip():
            return False
        if self.provider == "anthropic" and not os.environ.get("ANTHROPIC_API_KEY", "").strip():
            return False
        return True

    def info(self) -> dict:
        return {"provider": self.provider, "model": self.model if self.available else None, "available": self.available, "last_error": self.last_error or self._disabled_reason}

    def _mark_error(self, e: Exception) -> None:
        self.last_error = f"{type(e).__name__}: {e}"
        err_str = f"{type(e).__name__} {e}".lower()
        if any(w in err_str for w in ("ratelimit", "429", "credit_balance_exhausted", "quota", "insufficient_quota", "unauthorized", "401", "invalid_api_key")):
            self._disabled_reason = self.last_error

    # ------------------------------------------------------------------ construction
    def _build(self) -> Any:
        if self._chat is not None:
            return self._chat
        p = self.provider
        try:
            if p == "anthropic":
                from langchain_anthropic import ChatAnthropic

                self._chat = ChatAnthropic(model=self.model, temperature=0.2, max_tokens=1800, timeout=10.0, max_retries=1)
            elif p == "openai":
                from langchain_openai import ChatOpenAI

                self._chat = ChatOpenAI(model=self.model, temperature=0.2, max_tokens=1800, timeout=10.0, max_retries=1)
            elif p == "ollama":
                from langchain_ollama import ChatOllama

                self._chat = ChatOllama(model=self.model, base_url=settings.ollama_base_url, temperature=0.2, timeout=10.0)
            else:
                raise RuntimeError(f"Unknown LLM provider '{p}'")
        except ImportError as e:
            raise RuntimeError(
                f"Provider '{p}' needs an extra package: pip install -r requirements-llm.txt  ({e})"
            ) from e
        return self._chat

    @staticmethod
    def _messages(system: str, messages: list[dict]) -> list:
        from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

        out: list = [SystemMessage(content=system)]
        for m in messages:
            out.append(AIMessage(content=m["content"]) if m["role"] == "assistant" else HumanMessage(content=m["content"]))
        return out

    # ------------------------------------------------------------------ generation
    async def astream(self, system: str, messages: list[dict]) -> AsyncIterator[str]:
        if self.provider == "mock":
            reply = "(mock model) " + messages[-1]["content"][-300:]
            for w in reply.split(" "):
                yield w + " "
                await asyncio.sleep(0)
            return
        chat = self._build()
        try:
            async for chunk in chat.astream(self._messages(system, messages)):
                t = _text(chunk)
                if t:
                    yield t
            self.last_error = None
        except Exception as e:
            self._mark_error(e)
            raise

    def complete(self, system: str, prompt: str) -> str:
        """Blocking call for worker threads (entity extraction, summaries)."""
        if self.provider == "mock":
            return self.mock_complete_reply
        chat = self._build()
        try:
            res = chat.invoke(self._messages(system, [{"role": "user", "content": prompt}]))
            self.last_error = None
            return _text(res)
        except Exception as e:
            self._mark_error(e)
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
