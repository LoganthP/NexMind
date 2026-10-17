"""Central configuration. Everything can be overridden with environment variables or a .env file."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

try:  # python-dotenv is optional at runtime
    from dotenv import load_dotenv

    load_dotenv()
except Exception:  # pragma: no cover
    pass


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


def _bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() in {"1", "true", "yes", "on"}


def _detect_provider() -> str:
    p = os.environ.get("NEXMIND_LLM_PROVIDER", "").strip().lower()
    if p:
        return p
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "anthropic"
    if os.environ.get("OPENAI_API_KEY"):
        return "openai"
    return "offline"


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(os.environ.get("NEXMIND_DATA_DIR", "./data")).resolve())
    host: str = os.environ.get("NEXMIND_HOST", "127.0.0.1")
    port: int = _int("NEXMIND_PORT", 8000)
    cors_origins: list[str] = field(
        default_factory=lambda: [o.strip() for o in os.environ.get("NEXMIND_CORS_ORIGINS", "*").split(",") if o.strip()]
    )

    # --- ingestion limits (protect your machine from zip bombs / huge uploads) ---
    max_upload_mb: int = _int("NEXMIND_MAX_UPLOAD_MB", 300)
    max_unzipped_mb: int = _int("NEXMIND_MAX_UNZIPPED_MB", 1500)
    max_files: int = _int("NEXMIND_MAX_FILES", 25000)
    max_file_kb: int = _int("NEXMIND_MAX_FILE_KB", 1024)  # per-file parse limit
    git_hosts: list[str] = field(
        default_factory=lambda: [
            h.strip() for h in os.environ.get("NEXMIND_GIT_HOSTS", "github.com,gitlab.com,bitbucket.org,codeberg.org,dev.azure.com").split(",") if h.strip()
        ]
    )
    allow_local_paths: bool = _bool("NEXMIND_ALLOW_LOCAL_PATHS", True)  # index folders on this machine in place
    web_url: str = os.environ.get("NEXMIND_WEB_URL", "http://localhost:5173")  # where your frontend lives (printed by `nexmind serve`)
    git_timeout_s: int = _int("NEXMIND_GIT_TIMEOUT", 180)

    # --- graph / analysis ---
    max_processes: int = _int("NEXMIND_MAX_PROCESSES", 30)
    process_depth: int = _int("NEXMIND_PROCESS_DEPTH", 8)
    process_branching: int = _int("NEXMIND_PROCESS_BRANCHING", 4)
    stream_batch_size: int = _int("NEXMIND_STREAM_BATCH", 250)
    stream_delay_s: float = _float("NEXMIND_STREAM_DELAY", 0.015)  # pacing for the "graph grows live" effect
    max_sections_per_doc: int = _int("NEXMIND_MAX_SECTIONS_PER_DOC", 80)
    concepts_per_section: int = _int("NEXMIND_CONCEPTS_PER_SECTION", 6)

    # --- RAG / LLM ---
    llm_provider: str = field(default_factory=_detect_provider)  # offline | anthropic | openai | ollama | mock
    llm_model: str = os.environ.get("NEXMIND_LLM_MODEL", "")
    ollama_base_url: str = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
    embeddings: str = os.environ.get("NEXMIND_EMBEDDINGS", "tfidf")  # tfidf | sentence-transformers
    embedding_model: str = os.environ.get("NEXMIND_EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
    llm_extract_triples: bool = _bool("NEXMIND_LLM_EXTRACT", False)  # LLM entity/relation extraction (needs a provider)
    chunk_size: int = _int("NEXMIND_CHUNK_SIZE", 1000)
    chunk_overlap: int = _int("NEXMIND_CHUNK_OVERLAP", 150)

    @property
    def db_path(self) -> Path:
        return self.data_dir / "nexmind.db"

    @property
    def workspaces_dir(self) -> Path:
        return self.data_dir / "workspaces"

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.workspaces_dir.mkdir(parents=True, exist_ok=True)


settings = Settings()
