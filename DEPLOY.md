# Deploying NexMind on Vercel

`vercel.json` deploys two services from this repository: `frontend/` (Vite web app) and `backend/` (FastAPI).
`/api/*` and `/connect.py` go to the backend, everything else to the web app.

## One-time setup
1. Vercel → Project → Settings → General: **Root Directory `./`** (repository root). Leave the build settings to `vercel.json`.
2. Vercel → Storage → your **Neon** database → **Connect Project** → this project, **all environments**.
3. Settings → Environment Variables: `OPENAI_API_KEY` (optional: `NEXMIND_LLM_MODEL`, default `gpt-4o-mini`).
4. Deployments → latest → **⋯ → Redeploy**, untick **Use existing Build Cache**.
5. Open `https://<your-domain>/api/health` → `"dialect": "postgres"` and `"setup_required": null`.

## Backend dependencies
`backend/requirements.txt` and `[project].dependencies` in `backend/pyproject.toml` must stay identical
(Vercel may read either one). A test (`backend/tests/test_dependency_lists.py`) fails if they drift or if the
code imports a package that is not listed. The Postgres driver is `pg8000` (pure Python), and OpenAI is called over
plain HTTPS, so there are no compiled drivers or SDKs to go missing.

## If something fails
`/api/health` always answers with a readable sentence (database missing, unreachable, password rejected, ...).
Function logs: Deployments → latest → Logs.
