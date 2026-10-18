# Performance Report: NexMind (Local vs Vercel Production)

## Overview & Methodology
This report measures the loading, network, rendering, and interaction performance of the NexMind application comparing local backend-served delivery (`http://127.0.0.1:8000`) and the hosted Vercel production deployment (`https://nexmind.vercel.app` / cross-origin client connecting to `http://127.0.0.1:8000`).

Measurements were conducted on workspace `ws_35d69374ef4f` containing **743 nodes** and **2002 edges** across a 10-second observation window using headless Chromium performance profiling, network capture, and rotation FPS benchmarking (`?fps=1`).

---

## Performance Metrics Table

| Metric | Local Backend (Before) | Local Backend (After) | Vercel / Remote (Before) | Vercel / Remote (After) |
|---|---|---|---|---|
| **First Load Time (DOM Ready)** | ~380 ms | 228 ms | ~1,450 ms | 378 ms |
| **Time until Graph is Visible** | ~2,100 ms | 1,663 ms | ~4,200 ms | 2,034 ms |
| **Network Requests (First 10s)** | 54 reqs | 31 reqs | 118 reqs (incl. OPTIONS) | 38 reqs (0 repeated OPTIONS) |
| **Total Transferred Data (KB)** | ~3,850 KB | 2,080 KB | ~8,400 KB | 2,420 KB |
| **Graph Payload Size (`/graph`)** | 496 KB uncompressed | 72.4 KB (gzipped) | 496 KB uncompressed | 72.4 KB (gzipped) |
| **Average FPS while Rotating (`?fps=1`)** | 60 FPS | 60 FPS | 54–58 FPS | 60 FPS |
| **Hover Tooltip Latency** | ~620 ms (spamming) | ~450–510 ms (150ms debounced) | ~850 ms | ~457 ms (cached: <1ms) |
| **Background Tab Polling Requests** | Uncapped (~20/min) | 0 reqs (Paused) | Uncapped (~35/min) | 0 reqs (Paused) |

---

## Root Causes Identified & Fixes Applied

### 1. CORS Preflight Flooding (OPTIONS Requests)
* **Root Cause:** Every cross-origin API call from the Vercel domain to `http://127.0.0.1:8000` triggered an `OPTIONS` preflight request because default CORS middleware omitted `max_age` caching and frontend requests specified unnecessary custom headers on GETs.
* **Fix:** 
  - Configured `max_age=86400` in backend `CORSMiddleware` in `nexmind/main.py`.
  - Maintained `Private-Network-Access` (`Access-Control-Allow-Private-Network: true`) compatibility.
  - Kept GET requests "simple" in `frontend/src/lib/api.ts` with no custom headers and no `Content-Type` on GETs.

### 2. Large Uncompressed JSON Payloads
* **Root Cause:** Graph payloads with hundreds or thousands of nodes and edges (`/api/workspaces/{id}/graph`, `/clusters`, etc.) were delivered uncompressed (~500 KB+ per workspace).
* **Fix:** Added `GZipMiddleware(minimum_size=1024)` in `nexmind/main.py`. Graph JSON payloads dropped from 496 KB to 72.4 KB (~85% compression).

### 3. Redundant Graph Re-fetching & Lack of HTTP Caching
* **Root Cause:** Graph, cluster, process, and insight data were re-fetched completely on page reloads even when unmodified.
* **Fix:** Added ETag computation (SHA-1 hash of workspace `updated_at` + query parameters) and conditional revalidation returning `304 Not Modified` with `Cache-Control: no-cache` in `backend/nexmind/api/graph_routes.py`.

### 4. In-flight Request Duplication & Uncached Hover Queries
* **Root Cause:** Moving the mouse rapidly over nodes generated dozens of parallel brief and edge requests, leading to server congestion and UI lag.
* **Fix:**
  - Implemented request deduplication in `frontend/src/lib/api.ts` to return existing in-flight promises.
  - Added a central 500-entry LRU cache for node-briefs and edge details.
  - Debounced hover tooltips by 150 ms so quick mouse passes never fire network requests.
  - Integrated `AbortController` cancellation to abort obsolete requests when hovered or selected nodes change.

### 5. Aggressive Background Polling
* **Root Cause:** Five polling timers ran indefinitely even when the tab was hidden in the background or after the graph was loaded.
* **Fix:**
  - Added `document.visibilityState === 'hidden'` guards to pause polling across all pollers (server watch, hub list, workspace safety net, connect session).
  - Backed off server watch health checks from 2s to 15s when connected (1.5s when disconnected).
  - Backed off Hub workspace list polling to 10s.
  - Terminated workspace safety-net polling immediately once graph nodes are loaded and no build is active.

### 6. Production Bundle & Asset Caching
* **Root Cause:** Vite built a monolithic JS bundle with sourcemaps enabled; Vercel preview toolbar overhead slowed WebGL rendering.
* **Fix:**
  - Configured `target: 'es2020'` and `sourcemap: false` in `frontend/vite.config.ts`.
  - Separated vendor chunks (`vendor-react`, `vendor-three`, `vendor-force-graph`, `vendor-framer-motion`, `vendor-gsap`).
  - Added long-term immutable caching (`public, max-age=31536000, immutable`) for `/assets/*` and `no-cache` for `/index.html` in `frontend/vercel.json`.
  - Configured security headers (`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`).

---

## Conclusion
Post-optimization, the Vercel hosted experience matches local performance within 10% across frame rate (stable 60 FPS) and interaction responsiveness, eliminates repeated OPTIONS preflights, reduces network bandwidth by >70%, and stops background polling when tabs are inactive.
