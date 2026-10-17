# NexMind API reference (for the frontend)

Base URL `http://127.0.0.1:8000` · interactive docs at `/docs` · all REST routes under `/api`.

## Workspaces & ingestion
| Method | Path | Notes |
|---|---|---|
| POST | `/api/workspaces` `{name, description}` | create an isolated workspace |
| GET | `/api/workspaces` · `/api/workspaces/{id}` | list / read (`status`: empty, building, ready, error; `stats`) |
| PATCH / DELETE | `/api/workspaces/{id}` | rename / delete everything |
| POST | `/api/workspaces/{id}/ingest` | multipart: `files[]` (pdf, docx, md, code, zip, tar.gz) and/or `git_url`, `branch` → `{job_id, source_ids}` |
| POST | `/api/workspaces/{id}/ingest/git` `{url, branch?, token?}` | https git repo (GitHub, GitLab, Bitbucket, Codeberg, Azure DevOps). `token` is optional, for private repos; used once, never stored |
| POST | `/api/workspaces/{id}/ingest/local` `{path}` | index a folder on the server's machine in place (loopback requests only) |
| GET | `/api/fs/list?path=` | folder browser for the local-folder picker (loopback only) |
| GET | `/api/workspaces/{id}/sources` · DELETE `/sources/{sid}` | delete triggers a rebuild job |
| GET | `/api/workspaces/{id}/sources/{sid}/raw?path=` | original file (e.g. show the PDF) |
| GET | `/api/workspaces/{id}/sources/{sid}/tree` | file tree for a sidebar |
| POST | `/api/workspaces/{id}/rebuild` | rebuild graph |
| GET | `/api/jobs/{job_id}` · `/api/workspaces/{id}/jobs` | job status |

## Graph
| GET | Path | Notes |
|---|---|---|
| | `/api/workspaces/{id}/graph` | query: `types`, `edge_types`, `cluster`, `max_nodes`(3000), `min_score`, `focus`+`depth`, `include_processes`. Returns `{nodes[{id,type,label,x,y,z,cluster,score,path,language}], links[{id,source,target,type,weight,label}], clusters[{id,label,size,color,summary}], legend{node_colors,edge_colors}, truncated}` |
| | `/nodes/{nid}?brief=true` | hover card: summary, degree, cluster, color |
| | `/nodes/{nid}` | click panel: code/text, relations grouped by edge type (in/out), breadcrumb, metrics, processes, passages |
| | `/nodes/{nid}/neighbors?depth=` | expand a node |
| | `/nodes/{nid}/explain` | LLM explanation (falls back to summary offline) |
| | `/edges/{eid}` | explanation sentence + evidence (code line / text) |
| | `/search?q=` | `{nodes, passages, highlight{nodes}}` |
| | `/impact?node=&direction=upstream\|downstream&depth=` | `{levels, risk{level}, highlight{nodes,edges}, processes_affected}` |
| | `/trace?source=&target=` | `{found, nodes, edges, highlight}` |
| | `/processes` · `/clusters` · `/insights` · `/stats` | execution flows (ordered steps), cluster centers, findings |
| | `/export?format=json\|graphml\|cypher` | downloads |

## Chat (separate threads per workspace)
`GET/POST /api/workspaces/{id}/threads`, `PATCH/DELETE /threads/{tid}`, `GET /threads/{tid}/messages`.
`POST /threads/{tid}/messages {content, stream:true}` → Server-Sent Events:
`start` → `retrieval {activations[{node_id,hop,score,role,delay_ms,label,type}], edges[], citations[], intent: qa|impact|path, structured}` → many `token {text}` → `done {answer, citations, followups[], provider}` (an `error {fallback:true}` event may appear if the LLM fails; an offline answer follows). `stream:false` returns JSON `{retrieval, done}`.
Animate `activations` by `delay_ms`; `role` is hit | neighbor | impact | path.

## WebSocket `/ws/workspaces/{id}`
Server events: `hello`, `job_queued`, `job_started`, `progress {phase, percent, message}`, `log {level, message}`, `graph_stream_start {nodes, edges, clusters}`, `graph_batch {nodes[], edges[]}`, `graph_ready`, `job_done {stats}`, `job_failed {error}`, `pong`.
Client messages: `{"type":"ping"}`, `{"type":"replay_graph"}` (re-stream the graph to this client, e.g. after reload).
Edges in a batch only reference nodes already sent.

## System
`GET /api/health` (returns `app:"nexmind"`, `version`, `capabilities`; the web app polls it to detect the server) · `GET/PUT /api/llm {provider, model}` (offline | anthropic | openai | ollama).

Node types: Source, Folder, File, Document, Section, Class, Function, Method, Module, Concept, Entity, Process.
Edge types: CONTAINS, DEFINES, IMPORTS, CALLS, INHERITS, REFERENCES, MENTIONS, RELATED_TO, SIMILAR_TO, RELATION, HAS_STEP.
