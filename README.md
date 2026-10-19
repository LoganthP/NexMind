<div align="center">

<img src="assets/nexmind-banner.svg" alt="NexMind" width="100%"/>

<a href="https://nexmind-three.vercel.app">
  <img src="https://readme-typing-svg.demolab.com?font=Fira+Code&weight=600&size=22&pause=1000&color=818CF8&center=true&vCenter=true&width=720&lines=Analyze+any+GitHub+%2F+GitLab+%2F+Azure+DevOps+repo;Watch+your+code+become+a+3D+knowledge+graph;Ask+questions.+Get+cited+answers.;Local-first.+Your+code+never+leaves+your+machine." alt="Typing animation"/>
</a>

<br/>

<img src="https://img.shields.io/badge/Python-3.10%2B-3776AB?style=for-the-badge&logo=python&logoColor=white" alt="Python"/>
<img src="https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white" alt="FastAPI"/>
<img src="https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB" alt="React"/>
<img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript"/>
<img src="https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white" alt="Vite"/>
<img src="https://img.shields.io/badge/three.js-000000?style=for-the-badge&logo=threedotjs&logoColor=white" alt="three.js"/>
<br/>
<img src="https://img.shields.io/badge/OpenAI-412991?style=for-the-badge&logo=openai&logoColor=white" alt="OpenAI"/>
<img src="https://img.shields.io/badge/Anthropic-191919?style=for-the-badge&logo=anthropic&logoColor=white" alt="Anthropic"/>
<img src="https://img.shields.io/badge/Ollama-000000?style=for-the-badge&logo=ollama&logoColor=white" alt="Ollama"/>
<img src="https://img.shields.io/badge/RAG-Knowledge%20Graph-7C3AED?style=for-the-badge" alt="RAG + Knowledge Graph"/>
<img src="https://img.shields.io/badge/Vercel-000000?style=for-the-badge&logo=vercel&logoColor=white" alt="Vercel"/>
<img src="https://img.shields.io/badge/pytest-0A9EDC?style=for-the-badge&logo=pytest&logoColor=white" alt="pytest"/>
<img src="https://img.shields.io/badge/Playwright-2EAD33?style=for-the-badge" alt="Playwright"/>

<br/><br/>

[**🌐 Live Demo**](https://nexmind-three.vercel.app) &nbsp;·&nbsp;
[**⚡ Quick Start**](#-quick-start) &nbsp;·&nbsp;
[**✨ Features**](#-features) &nbsp;·&nbsp;
[**🏗️ Architecture**](#️-architecture) &nbsp;·&nbsp;
[**🛠️ Troubleshooting**](#️-troubleshooting)

</div>

<img src="assets/divider.svg" width="100%" alt=""/>

## 🧠 About

**NexMind** turns code repositories and documents into a **living 3D knowledge graph** you can explore and talk to.
Point it at a GitHub, GitLab or Azure DevOps repository, a folder on your computer, or a pile of PDFs, Word files, Markdown, source code and zips. NexMind parses everything, links it into a graph of entities and relationships, and lets you **chat with it**: every answer cites its sources and lights up the exact nodes it came from.

It is **local-first**. The Python server runs on your own machine, and the hosted web app simply connects to it, so your code and documents never leave your computer.

<div align="center">
  <img src="assets/pipeline.svg" alt="Sources → Parse → Graph → Index → Chat" width="100%"/>
</div>

## ✨ Features

<table>
<tr>
<td width="33%" valign="top">

### 📥 Analyze anything
GitHub / GitLab / Azure DevOps repos (private ones with an access token), a local folder, or uploaded **PDF, Word, Markdown, code and ZIP** files.

</td>
<td width="33%" valign="top">

### 🌌 Live 3D graph
Watch the graph **grow in real time** while it builds. Hover for a summary; click for code or text, relations, flows and explanations.

</td>
<td width="33%" valign="top">

### 💬 Cited chat
Separate **chat threads per workspace**. Answers cite their sources and **highlight the nodes** they came from.

</td>
</tr>
<tr>
<td valign="top">

### 💥 Impact
See **what depends on** any file, function or concept before you change it.

</td>
<td valign="top">

### 🔗 Trace &amp; Flows
**Trace** how two things connect, and **play a call path** step by step through the graph.

</td>
<td valign="top">

### 🔍 Insights
Spot **circular imports, hub nodes and dead code** automatically.

</td>
</tr>
<tr>
<td valign="top">

### 🤖 Bring your own LLM
OpenAI, Anthropic or local **Ollama**. No key? You still get **offline extractive answers**.

</td>
<td valign="top">

### 🔒 Local-first &amp; private
The server runs on `127.0.0.1`. The hosted site only talks to **your** machine.

</td>
<td valign="top">

### 🚀 Zero-config deploy
The web app is a static site: deploy the `frontend` folder to **Vercel** with no environment variables.

</td>
</tr>
</table>

### 🗂️ Workspace modes

Each workspace starts by choosing what it is for:

| Mode | Input | Best for |
| :--- | :--- | :--- |
| 🧩 **Projects** | GitHub / GitLab links, project ZIPs | Code analysis: structure, dependencies, impact, flows |
| 📚 **Documents** | PDFs, Word, Markdown, ZIPs | Study and general RAG over your documents |
| 🔌 **Live connect** | A command run in your VS Code terminal | Connecting the project you have open to your local server and building its graph live |

<img src="assets/divider.svg" width="100%" alt=""/>

## 🏗️ Architecture

```mermaid
flowchart LR
    subgraph SRC["📥 Sources"]
        R["GitHub · GitLab · Azure DevOps"]
        L["Local folder"]
        U["PDF · Word · Markdown · Code · ZIP"]
    end

    subgraph SRV["🐍 NexMind Server · FastAPI · runs on your machine"]
        I["Ingestion & parsing"]
        G[("Knowledge graph")]
        V[("Retrieval index")]
        A["Analysis engine<br/>Impact · Trace · Flows · Insights"]
        Q["RAG chat engine"]
    end

    subgraph WEB["🌐 Web App · React · Vite · three.js"]
        W["3D graph view"]
        C["Workspace chat threads"]
    end

    LLM{{"LLM: OpenAI · Anthropic · Ollama<br/>or offline extractive answers"}}

    R --> I
    L --> I
    U --> I
    I --> G
    I --> V
    G --> A --> W
    G --> Q
    V --> Q
    Q <--> LLM
    Q --> C
    C -. "cited nodes light up" .-> W

    classDef src fill:#0e7490,stroke:#22d3ee,color:#fff
    classDef srv fill:#3730a3,stroke:#818cf8,color:#fff
    classDef web fill:#86198f,stroke:#e879f9,color:#fff
    class R,L,U src
    class I,G,V,A,Q srv
    class W,C web
```

### 🔄 From source to cited answer

```mermaid
sequenceDiagram
    autonumber
    actor You
    participant Web as Web App
    participant Srv as NexMind Server
    participant KG as Graph + Index

    You->>Web: Add a repo link, folder or files
    Web->>Srv: Start analysis
    Srv->>Srv: Clone with git or read files, then parse into chunks
    loop While the graph builds
        Srv->>KG: Add nodes and relations
        Srv-->>Web: Progress and new nodes
        Web-->>You: Graph grows live in 3D
    end
    You->>Web: Ask a question in a chat thread
    Web->>Srv: Question + workspace
    Srv->>KG: Retrieve relevant nodes and chunks
    Srv->>Srv: Compose answer (LLM or extractive)
    Srv-->>Web: Answer with source citations
    Web-->>You: Cited nodes light up in the graph
```

### 🔌 How the hosted site reaches your server

The hosted page cannot run Python, so it connects to the server on **your** computer:

```mermaid
stateDiagram-v2
    [*] --> ShowCommand: Open the hosted site
    ShowCommand: Show the start command for your OS
    ShowCommand --> Polling
    Polling: Poll /api/health on port 8000
    Polling --> Polling: No answer yet
    Polling --> Connected: Server answers
    Connected: Open your workspaces
    Connected --> [*]
```

<img src="assets/divider.svg" width="100%" alt=""/>

## 🧰 Tech Stack

| Layer | Technology | Role |
| :--- | :--- | :--- |
| **Backend** | ![Python](https://img.shields.io/badge/-Python-3776AB?logo=python&logoColor=white) ![FastAPI](https://img.shields.io/badge/-FastAPI-009688?logo=fastapi&logoColor=white) | Local API server on `127.0.0.1:8000`; also serves a built copy of the web app |
| **CLI** | `nexmind serve` · `nexmind doctor` | Start the server; check Python, packages, git and port |
| **Ingestion** | ![Git](https://img.shields.io/badge/-git-F05032?logo=git&logoColor=white) + file parsers | Clone repos; read PDF, Word, Markdown, code and ZIP |
| **Intelligence** | RAG · Knowledge graph · Retrieval index | Link entities and relations; ground answers in sources |
| **LLM** | ![OpenAI](https://img.shields.io/badge/-OpenAI-412991?logo=openai&logoColor=white) ![Anthropic](https://img.shields.io/badge/-Anthropic-191919?logo=anthropic&logoColor=white) ![Ollama](https://img.shields.io/badge/-Ollama-000000?logo=ollama&logoColor=white) | Optional answer generation; offline extractive fallback |
| **Frontend** | ![React](https://img.shields.io/badge/-React-20232A?logo=react&logoColor=61DAFB) ![TypeScript](https://img.shields.io/badge/-TypeScript-3178C6?logo=typescript&logoColor=white) ![Vite](https://img.shields.io/badge/-Vite-646CFF?logo=vite&logoColor=white) | Web app, workspaces and chat UI |
| **3D Graph** | ![three.js](https://img.shields.io/badge/-three.js-000000?logo=threedotjs&logoColor=white) | Interactive 3D knowledge-graph rendering |
| **Hosting** | ![Vercel](https://img.shields.io/badge/-Vercel-000000?logo=vercel&logoColor=white) | Static SPA deploy of `frontend/` |
| **Testing** | ![pytest](https://img.shields.io/badge/-pytest-0A9EDC?logo=pytest&logoColor=white) ![Playwright](https://img.shields.io/badge/-Playwright-2EAD33) | 19 backend tests, typecheck, UI tests and end-to-end tests |

## 📁 Project Structure

```text
NexMind/
├── backend/              🐍 FastAPI server + `nexmind` CLI (ships a built copy of the web app)
│   ├── start.ps1         One-shot setup & run (Windows)
│   ├── start.sh          One-shot setup & run (macOS / Linux)
│   ├── tests/            Backend test suite (pytest)
│   └── .env              Your LLM keys & settings (create it, never commit it)
├── frontend/             ⚛️ React + Vite + three.js web app (deploy this to Vercel)
│   └── vercel.json       SPA rewrites → index.html
├── e2e/                  🎭 Playwright end-to-end tests
├── playwright.config.ts
├── DEPLOY.md             Deployment notes
└── PERF_REPORT.md        Performance report
```

<img src="assets/divider.svg" width="100%" alt=""/>

## ⚡ Quick Start

### ✅ Prerequisites

| Requirement | Version | Needed for |
| :--- | :--- | :--- |
| Python | **3.10+** | The NexMind server |
| Git | any recent | Importing GitHub / GitLab / Azure DevOps links only |
| Node.js | **20 or 22** | Frontend development and Vercel builds only |
| Browser | Chrome, Edge or Firefox | Using the hosted site (see [Safari note](#️-troubleshooting)) |

### 1️⃣ Clone the repository

```bash
git clone https://github.com/LoganthP/NexMind.git
cd NexMind
```

### 2️⃣ Run everything locally (no hosting needed)

<details open>
<summary><b>🪟 Windows (PowerShell)</b></summary>

Run one command per line (PowerShell 5 cannot run `&&`):

```powershell
cd backend
powershell -ExecutionPolicy Bypass -File .\start.ps1
```
</details>

<details open>
<summary><b>🍎 macOS / 🐧 Linux</b></summary>

```bash
cd backend
./start.sh
```
</details>

The first run creates a virtual environment and installs everything (a few minutes). Then open **http://127.0.0.1:8000** 🎉

**Already installed?** Use the short form from the `backend` folder:

```bash
pip install -e .
nexmind serve          # start the server
nexmind doctor         # check Python, packages, git and port
```

### 3️⃣ Connect an LLM (optional)

Create `backend/.env` and add a provider. Without one, NexMind still works with offline extractive answers.

```env
# Choose one provider (or none for offline extractive answers)
OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-ant-...
# OLLAMA_BASE_URL=http://localhost:11434

# Optional hardening: only accept requests from your deployed site
NEXMIND_CORS_ORIGINS=https://nexmind-three.vercel.app
```

### 4️⃣ Develop the web app (hot reload)

Keep the backend running in one terminal, then in another:

```powershell
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**. The page finds the backend by itself.

<img src="assets/divider.svg" width="100%" alt=""/>

## 🚀 Deploy to Vercel

The web app is a static site, so there is nothing to configure beyond the folder.

1. Push the project to GitHub.
2. In Vercel, choose **Add New → Project** and import the repo.
3. Set **Root Directory to `frontend`** ⚠️ (important). Framework Preset: **Vite** (auto-detected).
   Build Command `npm run build` and Output Directory `dist` are already set in `frontend/vercel.json`.
4. Deploy. No environment variables are required; Node 20 or 22 both work.

> [!TIP]
> `vercel.json` rewrites every path to `index.html`, so refreshing a deep link like `/app/w/...` never returns a 404.

> [!IMPORTANT]
> The hosted site shows the start command for your OS, then polls `http://127.0.0.1:8000/api/health` and continues the moment your local server answers. Your code and documents never leave your machine.

- Use **Chrome, Edge or Firefox**. Chrome may ask to allow access to devices on your local network: choose **Allow**.
- Running on another port? Start with `nexmind serve --port 8001` and enter that address on the connect screen.

<img src="assets/divider.svg" width="100%" alt=""/>

## 🧪 Testing

```powershell
# Backend: 19 tests
cd backend ; pip install -e ".[dev]" ; python -m pytest tests -q

# Frontend: types, production build, UI tests
cd frontend ; npm run typecheck ; npm run build ; npm test
```

`npm test` also runs a full **UI-against-live-server** test when the backend is running and these are set:

| Variable | Value |
| :--- | :--- |
| `NEXMIND_TEST_SAMPLE` | Path of a folder to analyze |
| `NEXMIND_TEST_API` | Address of the running backend |

## 🛠️ Troubleshooting

<details>
<summary><b>⬜ I see a blank page</b></summary>

1. Open the browser console (**F12**). A crash now shows a readable card instead of a blank screen; copy its message.
2. Check that http://127.0.0.1:8000/api/health returns `"app":"nexmind"`.
3. Replace an old `frontend` folder completely (delete it first) so stale files do not mix with the new version.
4. Run `npm install` again after replacing it, and use `npm run typecheck` to catch TypeScript errors early.
</details>

<details>
<summary><b>🧭 Safari won't connect</b></summary>

Safari blocks https pages from calling local servers. Use Chrome, Edge or Firefox, or open **http://127.0.0.1:8000** directly.
</details>

<details>
<summary><b>🔐 Chrome asks about local network access</b></summary>

Choose **Allow**. The hosted site needs it to reach the server on your own machine.
</details>

<details>
<summary><b>🔌 Port 8000 is already in use</b></summary>

Run `nexmind serve --port 8001`, then enter `http://127.0.0.1:8001` on the connect screen. `nexmind doctor` also checks the port for you.
</details>

<details>
<summary><b>📦 Importing a repo link fails</b></summary>

Git is required for GitHub / GitLab / Azure DevOps imports. Run `nexmind doctor` to confirm it is installed, and provide an access token for private repositories.
</details>

<img src="assets/divider.svg" width="100%" alt=""/>

## 👤 Author

<div align="center">

**Loganth P**

<a href="https://github.com/LoganthP"><img src="https://img.shields.io/badge/GitHub-LoganthP-181717?style=for-the-badge&logo=github&logoColor=white" alt="GitHub"/></a>
<a href="https://www.linkedin.com/in/loganth-p-158667280/"><img src="https://img.shields.io/badge/LinkedIn-Loganth%20P-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white" alt="LinkedIn"/></a>
<a href="mailto:loganthp55@gmail.com"><img src="https://img.shields.io/badge/Email-loganthp55%40gmail.com-EA4335?style=for-the-badge&logo=gmail&logoColor=white" alt="Email"/></a>

<br/><br/>

⭐ **If NexMind helps you understand a codebase faster, consider giving it a star!** ⭐

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:22d3ee,50:818cf8,100:e879f9&height=120&section=footer" width="100%" alt=""/>

</div>
