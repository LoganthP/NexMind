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
| `VITE_BACKEND_REPO_URL` | Link to Python backend source repository | `https://github.com/LoganthP/NexMind` |
| `VITE_BACKEND_ZIP_URL` | Direct archive download of backend bundle | Optional packaged download URL |
| `VITE_PIP_PACKAGE` | Custom package name if distributed via PyPI | `nexmind` |

*Note: Never commit secret tokens or credentials to environment configuration.*

---

## 3. Pre-Deployment Safety Verification

Before deploying new changes to production, run the local verification workflow. All checks must pass with zero errors:

```bash
cd frontend
npm run typecheck
npm test
npm run build
```

The build automatically triggers `postbuild` (`npm run check:forbidden`), which runs `scripts/check-forbidden.mjs` to ensure forbidden screens or legacy server wizard text never return.

---

## 4. Deployment Verification Checklist

Follow these steps for every deployment to production:

1. **Commit and Push to Production Branch:**
   - Commit and push your changes to your repository's production branch (`main` or `master`).
   - In **Vercel → Deployments**, confirm that the latest deployment is **"Ready"** and built from the latest commit (the build log displays the commit hash `VERCEL_GIT_COMMIT_SHA`).
   - If the deployment was triggered as a preview deployment, click **Promote to Production**.

2. **Verify the Build Stamp on the Production Domain:**
   - Open the **PRODUCTION domain** (e.g. `https://nexmind.vercel.app`, NOT an old per-deployment URL like `nexmind-xxxx.vercel.app`) in a **private/incognito window**.
   - Navigate to `/app`.
   - The Hub footer must display the tiny muted text matching the deployed commit hash: `build <commit-hash-7-chars>`.
   - In the browser console, `window.__NEXMIND_BUILD__` will match this same commit hash.
   - If it displays an older hash, the previous build is still being served: in Vercel, go to the deployment and click **Redeploy with "Redeploy without cache"**.

3. **Verify Cache Control & Service Workers:**
   - In `vercel.json`, `index.html` is configured with `Cache-Control: no-cache` so browsers always fetch the newest release.
   - Confirm that no service worker is registered (NexMind does not register service workers). In DevTools → Application → Service Workers, verify there are no active service workers.

4. **Verify Offline Experience on Production Domain:**
   - When opened without a local server running, `/app` immediately displays the three workspace modes (Projects, Documents, Live connect) along with the quiet line:
     `Your saved workspaces appear here once the local server is running.`
   - The header displays `Server not connected` with a `Connect` button opening inline server connection guidance.
   - Direct workspace URLs (`/app/w/:id`) display a small inline card titled `"Can't reach your NexMind server"` with "Try again now", "Open NexMind on this computer", and "Back to modes".
   - No full-page server wizard or blocking gate ever replaces the application.

---

## 5. Rollback Procedure

If an issue occurs in production:
1. Navigate to **Deployments** in your Vercel Dashboard.
2. Locate the most recent known healthy deployment.
3. Click the three dots (`...`) icon on that deployment.
4. Click **Promote to Production** (or **Rollback to this deployment**).
5. Vercel instantly routes production traffic back to the selected deployment without rebuilding.
