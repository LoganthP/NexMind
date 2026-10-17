# NexMind — AI Repository & Document Intelligence (backend)

Upload repos (zip / git URL), PDFs, DOCX, Markdown and more into an isolated **workspace**. NexMind builds a live
**knowledge graph** (code symbols + document concepts, cross-linked), lays it out in 3D "brain lobes", and lets you chat
with it using **GraphRAG** — answers come with citations and a "neural activation" map of the nodes that fired.

Stack: Python · FastAPI · LangChain (text splitting + LLM providers) · NetworkX graph store (SQLite-persisted) ·
TF-IDF + BM25 hybrid retrieval (optional embeddings) · WebSockets + SSE.

## 1. Quick start

Requires Python 3.10+ (3.12 tested) and git (only for git-URL ingestion).

```powershell
# Windows PowerShell (note: PowerShell 5 does not understand "&&", so run commands one per line)
cd nexmind\backend
powershell -ExecutionPolicy Bypass -File .\start.ps1
```
```bash
# macOS / Linux
cd nexmind/backend && ./start.sh
```
Prefer a real command? `pip install -e .` once, then `nexmind serve` (and `nexmind doctor` to check your setup).
This creates `.venv`, installs `requirements.txt`, copies `.env.example` to `.env` and serves
**http://127.0.0.1:8000** (interactive docs: `/docs`). No API key needed.

Manual equivalent:
```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python run.py
```

## 2. Try it in 60 seconds
```bash
curl -X POST localhost:8000/api/workspaces -H 'content-type: application/json' -d '{"name":"demo"}'      # -> id
zip -r sample.zip samples/sample_project
curl -F files=@sample.zip localhost:8000/api/workspaces/<id>/ingest                                     # -> job_id
curl localhost:8000/api/workspaces/<id>/graph | head -c 600
curl -X POST localhost:8000/api/workspaces/<id>/ingest/git -H 'content-type: application/json' \
     -d '{"url":"https://github.com/psf/requests"}'
```
Watch live progress with any WebSocket client on `ws://127.0.0.1:8000/ws/workspaces/<id>`.

## 3. Enable an LLM (optional)
Without one, chat returns extractive answers from retrieved passages. For fluent answers:
```bash
pip install -r requirements-llm.txt
```
then in `.env`:
```
NEXMIND_LLM_PROVIDER=anthropic     # or openai / ollama
ANTHROPIC_API_KEY=...              # OPENAI_API_KEY=... ; Ollama needs no key
```
Model defaults: `claude-sonnet-5-5`, `gpt-4o-mini`, `llama3.1` (override with `NEXMIND_LLM_MODEL`).
`NEXMIND_LLM_EXTRACT=true` also uses the LLM to extract typed entity relationships while building the graph.
Optional dense embeddings: `NEXMIND_EMBEDDINGS=sentence-transformers` (downloads a ~90 MB model).

## 4. Frontend
The web app lives in `../frontend`. A built copy sits in `frontend_dist/`, so `python -m nexmind serve` serves the whole product at http://127.0.0.1:8000.
`docs/API.md` is the contract between the two.

## 5. Tests
```bash
pip install -r requirements-dev.txt && python -m pytest tests -q
```

## 6. Layout
```
nexmind/ingest   file safety, code parsers (ast + regex), document parsers, concept extraction, graph pipeline
nexmind/graph    clustering, centrality, 3D layout, flows, impact, trace, insights, persistence
nexmind/rag      hybrid index, LLM providers (LangChain), GraphRAG chat
nexmind/api      REST + SSE + WebSocket routes
```
Data lives in `./data` (SQLite + uploaded sources). Delete the folder to reset.

## 7. Known limits
- Python is parsed exactly (`ast`); other languages use heuristic regex parsing, so call links there carry lower confidence.
- Graphs over ~1,500 nodes skip the force-layout refinement (faster, slightly less polished); the UI should cap visible nodes (`max_nodes`).
- LLM providers, dense embeddings and Windows were not tested by the author; the offline path is.
- Bind to localhost only. There is no authentication; do not expose it publicly as-is.
