export type NodeType =
  | 'Source' | 'Folder' | 'File' | 'Document' | 'Section' | 'Class' | 'Function' | 'Method'
  | 'Module' | 'Concept' | 'Entity' | 'Process'

export interface Health {
  app: string; status: string; version: string
  llm: { provider: string; model: string | null; available: boolean }
  capabilities?: { local_paths: boolean; git_token: boolean }
  platform?: string
  python_executable?: string
  install_dir?: string
}

export interface Workspace {
  id: string; name: string; description: string; status: 'empty' | 'building' | 'ready' | 'error'
  created_at: number; updated_at: number; source_count: number; thread_count: number
  kind: 'code' | 'docs' | 'live'
  stats: { nodes?: number; edges?: number; clusters?: number; files?: number; documents?: number; processes?: number }
}

export interface GNode {
  id: string; type: NodeType; label: string; x: number; y: number; z: number
  cluster: number; score: number; path?: string | null; language?: string | null
  // runtime (set by the engine)
  fx?: number; fy?: number; fz?: number
  degree?: number; betweenness?: number; pagerank?: number
  [k: string]: unknown
}
export interface GLink { id: string; source: string | GNode; target: string | GNode; type: string; weight: number; label?: string | null }
export interface Cluster { id: number; label: string; size: number; color: string; summary: string }
export interface GraphPayload {
  nodes: GNode[]; links: GLink[]; clusters: Cluster[]; truncated: boolean
  total_nodes: number; total_edges: number; status: string
  legend: { node_colors: Record<string, string>; edge_colors: Record<string, string> }
}

export interface Brief { id: string; label: string; type: NodeType; path?: string | null; cluster: number; score: number }
export interface Relation { edge_id: string; weight: number; label?: string | null; node: Brief }
export interface NodeDetail {
  id: string; type: NodeType; label: string; cluster: Cluster | null; score: number; summary: string
  path?: string | null; language?: string | null; degree: { in: number; out: number }; color?: string
  props?: Record<string, unknown>; text?: string | null
  code?: { path: string; start: number; end: number; total_lines: number; text: string; truncated: boolean } | null
  breadcrumb?: Brief[]; relations?: Record<string, { out: Relation[]; in: Relation[] }>
  metrics?: { pagerank: number; betweenness: number; degree: number }
  processes?: { id: string; label: string; step_count: number }[]
  steps?: { node_id: string; depth: number; label: string; type: string }[] | null
  passages?: { id: string; text: string; meta: Record<string, unknown> }[]
  source_id?: string | null
}
export interface EdgeDetail {
  id: string; type: string; weight: number; label?: string | null; explanation: string
  source: Brief; target: Brief; evidence: { kind: string; path?: string; line?: number; text: string; title?: string }[]; color?: string
}

export interface Thread { id: string; title: string; updated_at: number; message_count: number; last_message?: string | null }
export interface Activation { node_id: string; hop: number; score: number; role: 'hit' | 'neighbor' | 'impact' | 'path'; delay_ms: number; label: string; type: NodeType }
export interface Citation { n: number; node_id: string; label: string; type: string; path?: string | null; page?: number | null; start?: number | null; end?: number | null; score: number; snippet: string }
export interface Retrieval { activations: Activation[]; edges: string[]; citations: Citation[]; intent: 'qa' | 'impact' | 'path'; structured: ImpactResult | TraceResult | null }
export interface ChatMessage {
  id: string; role: 'user' | 'assistant'; content: string; created_at?: number
  meta?: { citations?: Citation[]; followups?: string[]; activations?: Activation[]; edges?: string[]; intent?: string; structured?: ImpactResult | TraceResult | null; provider?: string; partial?: boolean }
  streaming?: boolean
}

export interface ImpactResult {
  target: { id: string; label: string; type: string }; direction: string; max_depth: number; total: number
  levels: { depth: number; nodes: { id: string; label: string; type: string; confidence: number; path?: string | null; cluster: number }[] }[]
  files_affected: string[]; clusters_affected: number[]; processes_affected: { id: string; label: string }[]
  risk: { level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; score: number; reasons: string[] }
  highlight: { nodes: string[]; edges: string[] }
}
export interface TraceResult { found: boolean; mode: string | null; length: number; nodes: { id: string; label: string; type: string }[]; edges: { id: string }[]; highlight?: { nodes: string[]; edges: string[] } }
export interface ProcessItem {
  id: string; label: string; entry: Brief; step_count: number; max_depth: number; clusters: number[]
  steps: { node_id: string; depth: number; label: string; type: string; path?: string | null; via?: string | null }[]
  highlight: { nodes: string[]; edges: string[] }
}
export interface Insight { id: string; kind: string; severity: 'info' | 'low' | 'medium' | 'high'; title: string; detail: string; node_ids: string[] }
export interface SearchResult { query: string; nodes: Brief[]; passages: { score: number; node: Brief; snippet: string; kind: string }[]; highlight: { nodes: string[] } }
export interface SourceItem { id: string; name: string; kind: string; origin: string; size: number; file_count: number }
export interface FsEntry {
  name: string
  path: string
  kind: 'dir' | 'file'
  size?: number
  is_project?: boolean
  markers?: string[] | null
}
export interface FsListing {
  path: string
  parent: string | null
  crumbs: { name: string; path: string }[]
  roots: { name: string; path: string }[]
  entries: FsEntry[]
  truncated?: boolean
}
export interface FsCheckResult {
  ok: boolean
  exists: boolean
  is_dir: boolean
  readable: boolean
  markers: string[]
  supported_files: number
  has_code: boolean
  has_docs: boolean
  message: string
}
export interface JobInfo { id: string; status: 'queued' | 'running' | 'done' | 'failed'; progress: number; phase: string; message: string; error?: string | null; result?: Record<string, unknown> | null }
export interface TreeNode extends Brief { children: TreeNode[] }

export type WsEvent =
  | { type: 'hello'; status: string; last_progress?: { percent: number; phase: string; message: string } | null }
  | { type: 'job_queued' | 'job_started'; job_id: string; kind?: string }
  | { type: 'progress'; job_id: string; phase: string; percent: number; message: string }
  | { type: 'log'; level: string; message: string }
  | { type: 'graph_stream_start'; nodes: number; edges: number; clusters: Cluster[]; replay?: boolean }
  | { type: 'graph_batch'; nodes: GNode[]; edges: { id: string; source: string; target: string; type: string; weight: number; label?: string | null }[]; replay?: boolean }
  | { type: 'graph_ready'; stats: { nodes: number; edges: number }; replay?: boolean }
  | { type: 'job_done'; stats: Record<string, unknown> }
  | { type: 'job_failed'; error: string }
  | { type: 'pong' }
