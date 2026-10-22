# Deploying NexMind to Vercel

One Vercel project serves both the web app (static, `frontend/dist`) and the API (Python function, `api/index.py`).

1. **Settings → General**: Root Directory `./`, Framework Preset **Other**, build/output fields empty (set by `vercel.json`).
2. **Storage → Create Database → Neon (Postgres)**, connect to this project for Production, Preview and Development. This sets `DATABASE_URL`.
3. **Settings → Environment Variables**: `OPENAI_API_KEY` (optional `NEXMIND_LLM_MODEL`).
4. Push to `main` (or **Redeploy**).
5. Check `https://<your-site>/api/health`: `"hosted": true`, `"storage": {"dialect": "postgres"}`, `"setup_required": null`.

Optional variables: `NEXMIND_MAX_UPLOAD_MB` (120), `NEXMIND_MAX_WORKSPACES` (30), `NEXMIND_CORS_ORIGINS`.

Remove the previously committed `node_modules` folders from Git once (they slow every deploy):

```powershell
git rm -r --cached node_modules
git rm -r --cached frontend/node_modules
git commit -m "Stop tracking node_modules"
```

Rollback: Vercel → Deployments → choose a previous deployment → **Promote to Production**.
