# NexMind web app

React 19 · Vite · Tailwind 4 · three.js (3d-force-graph) · GSAP · Framer Motion · Zustand.

```powershell
npm install
npm run dev        # http://localhost:5173
npm run typecheck
npm run build      # outputs dist/ (what Vercel deploys)
npm test
```

- `src/landing` landing page (scroll-driven 3D hero, GSAP ScrollTrigger)
- `src/pages/ConnectGate.tsx` "Start your local server" auto-detect screen
- `src/pages/Hub.tsx` workspaces + analyze (GitHub/GitLab/Azure, local folder, uploads)
- `src/pages/Workspace.tsx` the 3D workspace; `src/three/engine.ts` is the graph renderer
- `src/workspace/actions.ts` every graph action (select, impact, trace, flows, stream) in one place
- `src/lib/api.ts` the only file that talks to the backend

Display options: "Solid surfaces" swaps frosted glass for opaque high-contrast panels (also follows the OS
"reduce transparency" setting); "Performance mode" disables bloom and particles and switches on automatically if the frame rate drops.
