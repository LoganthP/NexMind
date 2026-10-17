# NexMind

Turn repositories and documents into a living 3D knowledge graph, then chat with it.

```
nexmind/
  backend/    Python server (FastAPI). Runs on your computer. Includes a built copy of the web app.
  frontend/   The web app (React + Vite + three.js). Deployable to Vercel.
```

## 1. Run everything on your computer (no hosting needed)

**Windows PowerShell** (one command per line; PowerShell 5 cannot run `&&`):
```powershell
cd nexmind\backend
powershell -ExecutionPolicy Bypass -File .\start.ps1
```
**macOS / Linux**
```bash
cd nexmind/backend
./start.sh
```
The first run creates a virtual environment and installs everything (a few minutes). Then open **http://127.0.0.1:8000**.
Needs Python 3.10+ (and `git` only for importing GitHub/GitLab links).

Already installed it? Use the short form from the backend folder:
```powershell
pip install -e .
nexmind serve          # start
nexmind doctor         # check Python, packages, git, port
```

## 2. Develop the web app (hot reload)
```powershell
cd nexmind\frontend
npm install
npm run dev
```
Open http://localhost:5173. Keep the backend running in another terminal. The page finds it by itself.

## 3. Deploy the web app to Vercel
The site is static, so there is nothing to configure beyond the folder.
1. Push the project to GitHub.
2. Vercel → **Add New → Project** → import the repo.
3. **Root Directory: `frontend`** (important). Framework Preset: Vite (auto-detected).
   Build Command `npm run build`, Output Directory `dist` (both already in `frontend/vercel.json`).
4. Deploy. No environment variables are required. Node 20 or 22 both work.

`vercel.json` rewrites every path to `index.html`, so refreshing `/app/w/...` never 404s.

### How the hosted site reaches your server
The hosted page cannot run Python, so it connects to the server on **your** computer, exactly like the
"Start your local server" screen: it shows the command for your OS, then polls `http://127.0.0.1:8000/api/health`
and continues the moment the server answers. Your code and documents never leave your machine.
- Use Chrome, Edge or Firefox. Chrome may ask to allow access to devices on your local network: choose **Allow**.
- Safari blocks https pages from calling local servers. Use another browser or open http://127.0.0.1:8000.
- Optional hardening: set `NEXMIND_CORS_ORIGINS=https://your-site.vercel.app` in `backend/.env`.
- Server on another port: `nexmind serve --port 8001`, then enter its address on the connect screen.

## 4. What you can do
- **Analyze** a GitHub / GitLab / Azure DevOps repo (private ones with a token), a **folder on your computer**, or uploaded PDFs, Word, Markdown, code and zip files.
- **Watch the graph grow** live while it builds; hover for a summary, click for code/text, relations, flows and explanations.
- **Impact** (what depends on this), **Trace** (how two things connect), **Flows** (play a call path), **Insights** (circular imports, hubs, dead code).
- **Chat** per workspace in separate threads. Answers cite sources and light up the nodes they came from.
- Add an LLM (Anthropic / OpenAI / Ollama) in `backend/.env`; without one you get offline extractive answers.

## 5. Checks
```powershell
cd nexmind\backend ; pip install -e ".[dev]" ; python -m pytest tests -q      # 19 backend tests
cd nexmind\frontend ; npm run typecheck ; npm run build ; npm test            # types, build, UI tests
```
`npm test` also runs a full UI-against-live-server test when you start the backend and set
`NEXMIND_TEST_SAMPLE` (path of a folder to analyze) and `NEXMIND_TEST_API`.

## 6. If you see a blank page
1. Open the browser console (F12). A crash now shows a readable card instead of a blank screen; copy its message.
2. Check http://127.0.0.1:8000/api/health returns `"app":"nexmind"`.
3. Replace an old `frontend` folder completely (delete it first) so stale files do not mix with this version.
4. Run `npm install` again after replacing it, and use `npm run typecheck` to catch TypeScript errors early.
