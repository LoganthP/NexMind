import type {
  ChatMessage, EdgeDetail, FsListing, GraphPayload, Health, ImpactResult, Insight, JobInfo, NodeDetail, ProcessItem,
  Retrieval, SearchResult, SourceItem, Thread, TraceResult, TreeNode, Workspace, Citation,
} from './types'

const KEY = 'nexmind.api'
export const DEFAULT_API = 'http://127.0.0.1:8000'

export function getApiBase(): string {
  try {
    return (localStorage.getItem(KEY) || (import.meta.env.VITE_API_URL as string | undefined) || DEFAULT_API).replace(/\/+$/, '')
  } catch {
    return DEFAULT_API
  }
}
export function setApiBase(url: string): void {
  try { localStorage.setItem(KEY, url.replace(/\/+$/, '')) } catch { /* private mode */ }
}
export function wsBase(base = getApiBase()): string {
  return base.replace(/^http/, 'ws')
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status = 0) { super(message); this.status = status }
}

async function request<T>(path: string, init: RequestInit = {}, base = getApiBase(), timeoutMs = 30000): Promise<T> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) }
    if (init.body && typeof init.body === 'string') headers['Content-Type'] = 'application/json'
    const res = await fetch(base + path, { ...init, headers, signal: init.signal ?? ctl.signal })
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`
      try {
        const j = await res.json()
        detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail ?? j)
      } catch { /* not json */ }
      throw new ApiError(detail, res.status)
    }
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  } catch (e) {
    if (e instanceof ApiError) throw e
    if ((e as Error).name === 'AbortError') throw new ApiError('The server took too long to respond', 0)
    throw new ApiError('Cannot reach the NexMind server. Is it running?', 0)
  } finally {
    clearTimeout(timer)
  }
}

const j = (body: unknown) => JSON.stringify(body)
const q = (o: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams()
  Object.entries(o).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, String(v)) })
  const s = p.toString()
  return s ? `?${s}` : ''
}

export const api = {
  /** Used by the connect screen: short timeout, explicit base, validates that it is really NexMind. */
  async probe(base: string): Promise<Health | null> {
    try {
      const h = await request<Health>('/api/health', {}, base.replace(/\/+$/, ''), 2500)
      return h && h.app === 'nexmind' ? h : null
    } catch { return null }
  },
  health: () => request<Health>('/api/health'),
  llm: () => request<{ provider: string; model: string | null; available: boolean; available_providers: string[] }>('/api/llm'),
  setLlm: (provider: string, model?: string) => request<{ provider: string }>('/api/llm', { method: 'PUT', body: j({ provider, model }) }),

  workspaces: () => request<Workspace[]>('/api/workspaces'),
  workspace: (id: string) => request<Workspace>(`/api/workspaces/${id}`),
  createWorkspace: (name: string, description = '', kind: 'code' | 'docs' | 'live' = 'code') => request<Workspace>('/api/workspaces', { method: 'POST', body: j({ name, description, kind }) }),
  renameWorkspace: (id: string, name: string) => request<Workspace>(`/api/workspaces/${id}`, { method: 'PATCH', body: j({ name }) }),
  deleteWorkspace: (id: string) => request<void>(`/api/workspaces/${id}`, { method: 'DELETE' }),
  sources: (id: string) => request<SourceItem[]>(`/api/workspaces/${id}/sources`),
  deleteSource: (id: string, sid: string) => request<{ job_id: string }>(`/api/workspaces/${id}/sources/${sid}`, { method: 'DELETE' }),
  sourceTree: (id: string, sid: string) => request<TreeNode>(`/api/workspaces/${id}/sources/${sid}/tree`),
  rebuild: (id: string) => request<{ job_id: string }>(`/api/workspaces/${id}/rebuild`, { method: 'POST' }),
  ingestGit: (id: string, url: string, token?: string, branch?: string) =>
    request<{ job_id: string }>(`/api/workspaces/${id}/ingest/git`, { method: 'POST', body: j({ url, token: token || undefined, branch: branch || undefined }) }),
  ingestLocal: (id: string, path: string) => request<{ job_id: string }>(`/api/workspaces/${id}/ingest/local`, { method: 'POST', body: j({ path }) }),
  fsList: (path?: string) => request<FsListing>(`/api/fs/list${q({ path })}`),
  job: (id: string) => request<JobInfo>(`/api/jobs/${id}`),
  rawUrl: (wsId: string, sid: string, path: string) => `${getApiBase()}/api/workspaces/${wsId}/sources/${sid}/raw${q({ path })}`,

  graph: (id: string, o: { types?: string; cluster?: number; max_nodes?: number; focus?: string; depth?: number } = {}) =>
    request<GraphPayload>(`/api/workspaces/${id}/graph${q(o)}`, {}, getApiBase(), 120000),
  node: (id: string, nid: string) => request<NodeDetail>(`/api/workspaces/${id}/nodes/${encodeURIComponent(nid)}`),
  nodeBrief: (id: string, nid: string) => request<NodeDetail>(`/api/workspaces/${id}/nodes/${encodeURIComponent(nid)}?brief=true`),
  neighbors: (id: string, nid: string, depth = 1) => request<{ nodes: GraphPayload['nodes']; links: GraphPayload['links'] }>(`/api/workspaces/${id}/nodes/${encodeURIComponent(nid)}/neighbors${q({ depth })}`),
  explain: (id: string, nid: string) => request<{ explanation: string; provider: string }>(`/api/workspaces/${id}/nodes/${encodeURIComponent(nid)}/explain`, {}, getApiBase(), 90000),
  edge: (id: string, eid: string) => request<EdgeDetail>(`/api/workspaces/${id}/edges/${eid}`),
  search: (id: string, text: string) => request<SearchResult>(`/api/workspaces/${id}/search${q({ q: text })}`),
  impact: (id: string, node: string, direction: 'upstream' | 'downstream' = 'upstream', depth = 4) => request<ImpactResult>(`/api/workspaces/${id}/impact${q({ node, direction, depth })}`),
  trace: (id: string, source: string, target: string) => request<TraceResult>(`/api/workspaces/${id}/trace${q({ source, target })}`),
  processes: (id: string) => request<ProcessItem[]>(`/api/workspaces/${id}/processes`),
  insights: (id: string) => request<Insight[]>(`/api/workspaces/${id}/insights`),
  exportUrl: (id: string, format: 'json' | 'graphml' | 'cypher') => `${getApiBase()}/api/workspaces/${id}/export?format=${format}`,

  threads: (id: string) => request<Thread[]>(`/api/workspaces/${id}/threads`),
  createThread: (id: string, title = 'New chat') => request<Thread>(`/api/workspaces/${id}/threads`, { method: 'POST', body: j({ title }) }),
  renameThread: (id: string, tid: string, title: string) => request<Thread>(`/api/workspaces/${id}/threads/${tid}`, { method: 'PATCH', body: j({ title }) }),
  deleteThread: (id: string, tid: string) => request<void>(`/api/workspaces/${id}/threads/${tid}`, { method: 'DELETE' }),
  messages: (id: string, tid: string) => request<ChatMessage[]>(`/api/workspaces/${id}/threads/${tid}/messages`),
}

/** Upload files with real progress (fetch cannot report upload progress). */
export function uploadFiles(wsId: string, files: File[], onProgress: (pct: number) => void): Promise<{ job_id: string }> {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    files.forEach((f) => form.append('files', f, f.name))
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${getApiBase()}/api/workspaces/${wsId}/ingest`)
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)) }
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText || '{}')
        if (xhr.status >= 200 && xhr.status < 300) resolve(body)
        else reject(new ApiError(typeof body.detail === 'string' ? body.detail : `Upload failed (${xhr.status})`, xhr.status))
      } catch { reject(new ApiError(`Upload failed (${xhr.status})`, xhr.status)) }
    }
    xhr.onerror = () => reject(new ApiError('Cannot reach the NexMind server. Is it running?'))
    xhr.send(form)
  })
}

export interface ChatHandlers {
  onStart?: () => void
  onRetrieval?: (r: Retrieval) => void
  onToken?: (t: string) => void
  onError?: (message: string, fallback: boolean) => void
  onDone?: (d: { answer: string; citations: Citation[]; followups: string[]; provider: string }) => void
}

/** POST + Server-Sent Events over fetch (EventSource cannot POST). */
export async function streamChat(wsId: string, tid: string, content: string, h: ChatHandlers, signal?: AbortSignal): Promise<void> {
  let res: Response
  try {
    res = await fetch(`${getApiBase()}/api/workspaces/${wsId}/threads/${tid}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: j({ content, stream: true }), signal,
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') return
    throw new ApiError('Cannot reach the NexMind server. Is it running?')
  }
  if (!res.ok || !res.body) throw new ApiError(`Chat failed (${res.status})`, res.status)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const dispatch = (block: string) => {
    const lines = block.split('\n')
    const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim()
    const dataLine = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
    if (!ev || !dataLine) return
    let data: any
    try { data = JSON.parse(dataLine) } catch { return }
    if (ev === 'start') h.onStart?.()
    else if (ev === 'retrieval') h.onRetrieval?.(data)
    else if (ev === 'token') h.onToken?.(data.text)
    else if (ev === 'error') h.onError?.(data.message, !!data.fallback)
    else if (ev === 'done') h.onDone?.(data)
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        dispatch(buf.slice(0, idx))
        buf = buf.slice(idx + 2)
      }
    }
    if (buf.trim()) dispatch(buf)
  } catch (e) {
    if ((e as Error).name !== 'AbortError') throw e
  }
}
