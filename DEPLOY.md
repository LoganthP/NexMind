# Deployment Guide: NexMind on Vercel

This guide outlines the deployment configuration, environment variables, safety verification steps, and operational procedures for running NexMind's frontend on Vercel.

---

## 1. Vercel Project Settings

Configure these settings in the Vercel dashboard (**Project Settings**):

| Setting | Value |
|---|---|
| **Framework Preset** | `Vite` |
| **Root Directory** | `frontend` |
| **Install Command** | `npm ci` |
| **Build Command** | `npm run build` |
| **Output Directory** | `dist` |
| **Node.js Version** | `22.x` |

> **IMPORTANT: Vercel Toolbar**  
> Disable the Vercel Toolbar for both Preview and Production deployments (**Project Settings → General → Vercel Toolbar** → Toggle Off).  
> Branch preview URLs inject DOM overlays, mutation observers, and deployment protection scripts that can degrade WebGL 3D rendering and Three.js frame rates. Always use the canonical Production domain (e.g., `https://nexmind.vercel.app`).

> **Analytics & Speed Insights**  
> Do **not** enable Vercel Analytics or Speed Insights scripts unless explicitly requested, as injected tracking scripts interfere with Three.js rendering loops and canvas event handlers.

---

## 2. Environment Variables

Configure these under **Project Settings → Environment Variables** if overriding defaults:

| Variable | Description | Default / Example |
|---|---|---|
| `VITE_API_URL` | Base URL of the NexMind FastAPI backend | `http://127.0.0.1:8000` (defaults to local backend) |
| `VITE_BACKEND_REPO_URL` | Link to Python backend source repository | Optional fallback link in Connect Gate |
| `VITE_BACKEND_ZIP_URL` | Direct archive download of backend bundle | Optional packaged download URL |
| `VITE_PIP_PACKAGE` | Custom package name if distributed via PyPI | `nexmind` |

*Note: Never commit secret tokens or credentials to environment configuration.*

---

## 3. Pre-Deployment Safety Verification

Before deploying new changes to production, run the local verification workflow. All checks must pass with zero errors:

```bash
cd frontend
npm run verify
```

The `verify` script (`scripts/verify.mjs`) executes:
1. `npm run typecheck` — TypeScript verification with no emit errors.
2. `npm test` — Unit and component test suites via Vitest.
3. `npm run build` — Production Vite build checking imports and case sensitivity.

To test the production build locally with deep link navigation:
```bash
cd frontend
npx vite preview
```
Visit `http://localhost:4173/app` and `http://localhost:4173/app/w/<id>` to verify routing, backend detection, and legend colors.

---

## 4. Deployment & Redeploy Steps

### Method A: Git Push (Automatic CI/CD)
1. Commit your changes:
   ```bash
   git add .
   git commit -m "feat/fix: descriptive summary"
   ```
2. Push to the production branch:
   ```bash
   git push origin main
   ```
3. Vercel automatically detects the push, runs `npm ci`, and builds `frontend`.

### Method B: Manual CLI Deployment
If deploying directly from the command line:
1. Navigate to the frontend directory:
   ```bash
   cd frontend
   ```
2. Run production deployment:
   ```bash
   npx vercel --prod
   ```

---

## 5. Checking Build Logs & Health

1. Go to your Vercel Project Dashboard: `https://vercel.com/<team>/<project>`.
2. Click on the **Deployments** tab.
3. Select the latest deployment to view:
   - **Building**: Logs of `npm ci` and `vite build`. Confirm chunks (`vendor-react`, `vendor-three`, `vendor-force-graph`, etc.) were emitted without warnings.
   - **Checks**: Verify header rules and rewrites from `vercel.json` applied cleanly.
4. Open the production URL in Chrome DevTools to verify:
   - No duplicate `OPTIONS` preflight requests for API calls.
   - Initial load completes in < 400 ms.
   - WebSocket connection (`ws://127.0.0.1:8000/ws/...`) connects and streams data.

---

## 6. Rollback Procedure

If an issue occurs in production:
1. Navigate to **Deployments** in your Vercel Dashboard.
2. Locate the most recent known healthy deployment.
3. Click the three dots (`...`) icon on that deployment.
4. Click **Promote to Production** (or **Rollback to this deployment**).
5. Vercel instantly routes production traffic back to the selected deployment without rebuilding.
