import type {
  ChatMessage, EdgeDetail, FsListing, GraphPayload, Health, ImpactResult, Insight, JobInfo, NodeDetail, ProcessItem,
  Retrieval, SearchResult, SourceItem, Thread, TraceResult, TreeNode, Workspace, Citation,
} from './types'

const KEY = 'nexmind.api.v2' // v1 stored http://127.0.0.1:8000 on hosted sites; ignored from now on
const BROWSER_KEY = 'nexmind.key'
export const DEFAULT_API = 'http://127.0.0.1:8000'

/** The backend lives on the same site when deployed (Vercel) or when the local server serves the app. */
export function sameOriginBase(): string | null {
  if (typeof window === 'undefined' || !window.location) return null
  const { protocol, port, origin } = window.location
  if (protocol !== 'http:' && protocol !== 'https:') return null
  if (port === '5173' || port === '4173') return null // Vite dev / preview servers have no backend
  return origin
}

export function getApiBase(): string {
  try {
    const env = import.meta.env.VITE_API_URL as string | undefined
    return (localStorage.getItem(KEY) || env || sameOriginBase() || DEFAULT_API).replace(/\/+$/, '')
  } catch {
    return sameOriginBase() || DEFAULT_API
  }
}
export function setApiBase(url: string): void {
  try { localStorage.setItem(KEY, url.replace(/\/+$/, '')) } catch { /* private mode */ }
}

/** A random key per browser: on the hosted app each browser only sees its own workspaces. */
export function getBrowserKey(): string {
  try {
    let k = localStorage.getItem(BROWSER_KEY)
    if (!k || !/^[A-Za-z0-9_-]{16,64}$/.test(k)) {
      const bytes = new Uint8Array(16)
      crypto.getRandomValues(bytes)
      k = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
      localStorage.setItem(BROWSER_KEY, k)
    }
    return k
  } catch {
    return 'nexmindanonymous0000'
  }
}
export function authHeaders(): Record<string, string> {
  return { 'X-NexMind-Key': getBrowserKey() }
}
function withKey(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}k=${encodeURIComponent(getBrowserKey())}`
}
export function wsBase(base = getApiBase()): string {
  return base.replace(/^http/, 'ws')
}

export class ApiError extends Error {
  status: number
  rawDetail?: unknown
  constructor(message: string, status = 0, rawDetail?: unknown) {
    super(message)
    this.status = status
    this.rawDetail = rawDetail
  }
}

export function formatApiError(e: unknown): string {
  if (!e) return 'An unexpected error occurred.'

  const status = typeof (e as any)?.status === 'number' ? (e as any).status : undefined

  if (status === 413) {
    return 'That file is too large.'
  }
  if (status !== undefined && status >= 500 && status < 600) {
    return 'The server hit a problem. Try again; details are in the server terminal.'
  }

  let rawDetail: any = (e as any)?.rawDetail ?? (e as any)?.detail ?? (e as any)?.message ?? e
  if (typeof rawDetail === 'string') {
    const trimmed = rawDetail.trim()
    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
      try {
        rawDetail = JSON.parse(trimmed)
      } catch { /* keep as string */ }
    }
  }

  // 1. FastAPI validation array [{loc, msg, ...}]
  if (Array.isArray(rawDetail)) {
    const hasKind = rawDetail.some((item) => Array.isArray(item?.loc) && item.loc.includes('kind'))
    if (hasKind) {
      return 'The workspace type is not supported by this server version. Restart the backend after updating.'
    }
    const first = rawDetail[0]
    if (first && typeof first === 'object') {
      const field = Array.isArray(first.loc) && first.loc.length > 0 ? String(first.loc[first.loc.length - 1]) : 'field'
      const msg = first.msg ? String(first.msg) : 'Invalid value'
      return `${field}: ${msg}`
    }
  }

  // 2. detail is an object
  if (rawDetail && typeof rawDetail === 'object' && !(rawDetail instanceof Error)) {
    if (typeof (rawDetail as any).detail === 'string') {
      return (rawDetail as any).detail
    }
    if (typeof (rawDetail as any).message === 'string') {
      return (rawDetail as any).message
    }
    const entries = Object.entries(rawDetail)
      .filter(([k, v]) => typeof v === 'string' || typeof v === 'number')
      .map(([k, v]) => `${k}: ${v}`)
    if (entries.length > 0) return entries.join(', ')
    return 'The server rejected this request.'
  }

  const str = String(rawDetail)
  if (/Failed to fetch|NetworkError|Cannot reach/i.test(str)) {
    return 'Cannot reach the NexMind server. Is it running?'
  }

  return str.replace(/^Error:\s*/i, '').replace(/^\d{3}\s+/, '').trim() || 'An error occurred.'
}

class LRUCache<K, V> {
  private max: number
  private map = new Map<K, V>()

  constructor(max = 500) {
    this.max = max
  }

  get(key: K): V | undefined {
    const val = this.map.get(key)
    if (val !== undefined) {
      this.map.delete(key)
      this.map.set(key, val)
    }
    return val
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  set(key: K, val: V): void {
    if (this.map.has(key)) {
      this.map.delete(key)
    } else if (this.map.size >= this.max) {
      const firstKey = this.map.keys().next().value
      if (firstKey !== undefined) this.map.delete(firstKey)
    }
    this.map.set(key, val)
  }

  clear(): void {
    this.map.clear()
  }
}

const nodeBriefCache = new LRUCache<string, NodeDetail>(500)
const edgeCache = new LRUCache<string, EdgeDetail>(500)
const inFlightGets = new Map<string, Promise<any>>()

function wrapWithSignal<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new DOMException('The user aborted a request.', 'AbortError'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('The user aborted a request.', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (val) => { signal.removeEventListener('abort', onAbort); resolve(val) },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err) },
    )
  })
}

async function request<T>(path: string, init: RequestInit = {}, base = getApiBase(), timeoutMs = 30000): Promise<T> {
  const method = (init.method || 'GET').toUpperCase()
  const isGet = method === 'GET'
  const cacheKey = isGet ? `${base}${path}` : null

  if (isGet && cacheKey) {
    const existing = inFlightGets.get(cacheKey)
    if (existing) {
      return wrapWithSignal(existing as Promise<T>, init.signal)
    }
  }

  const exec = async (): Promise<T> => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    let abortListener: (() => void) | undefined
    if (init.signal) {
      if (init.signal.aborted) {
        clearTimeout(timer)
        throw new DOMException('The user aborted a request.', 'AbortError')
      }
      abortListener = () => ctl.abort()
      init.signal.addEventListener('abort', abortListener, { once: true })
    }
    try {
      const headers: Record<string, string> = { ...authHeaders(), ...(init.headers as Record<string, string> | undefined) }
      // Keep GET requests "simple": no custom headers, no Content-Type on GETs to avoid extra preflights
      if (!isGet && init.body && typeof init.body === 'string') {
        headers['Content-Type'] = 'application/json'
      }
      const res = await fetch(base + path, { ...init, headers, signal: ctl.signal })
      if (!res.ok) {
        let detail = `${res.status} ${res.statusText}`
        let raw: any = undefined
        try {
          const j = await res.json()
          raw = j.detail ?? j
          detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail ?? j)
        } catch { /* not json */ }
        throw new ApiError(detail, res.status, raw)
      }
      if (res.status === 204) return undefined as T
      return (await res.json()) as T
    } catch (e) {
      if (e instanceof ApiError) throw e
      if ((e as Error).name === 'AbortError') {
        if (init.signal?.aborted) throw e
        throw new ApiError('The server took too long to respond', 0)
      }
      throw new ApiError('Cannot reach the NexMind server. Is it running?', 0)
    } finally {
      clearTimeout(timer)
      if (abortListener && init.signal) {
        init.signal.removeEventListener('abort', abortListener)
      }
    }
  }

  if (isGet && cacheKey) {
    const promise = exec()
    inFlightGets.set(cacheKey, promise)
    promise.finally(() => {
      inFlightGets.delete(cacheKey)
    }).catch(() => {})
    return wrapWithSignal(promise, init.signal)
  }

  return exec()
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
  async probe(
    base: string,
    timeoutMs = 2500,
    options?: { isUserGesture?: boolean; targetAddressSpace?: 'local' }
  ): Promise<Health | null> {
    try {
      const cleanBase = base.replace(/\/+$/, '')
      const init: RequestInit & { targetAddressSpace?: string } = {}
      if (options?.targetAddressSpace) {
        init.targetAddressSpace = options.targetAddressSpace
      } else if (options?.isUserGesture && typeof Request !== 'undefined' && 'targetAddressSpace' in Request.prototype) {
        init.targetAddressSpace = 'local'
      }
      const h = await request<Health>('/api/health', init, cleanBase, timeoutMs)
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
    request<{ job_id: string }>(`/api/workspaces/${id}/ingest/git`, { method: 'POST', body: j({ url, token: token || undefined, branch: branch || undefined }) }, getApiBase(), 300000),
  ingestLocal: (id: string, path: string) => request<{ job_id: string }>(`/api/workspaces/${id}/ingest/local`, { method: 'POST', body: j({ path }) }),
  fsList: (path?: string, files = 1) => request<FsListing>(`/api/fs/list${q({ path, files })}`),
  fsCheck: (path: string) => request<import('./types').FsCheckResult>(`/api/fs/check${q({ path })}`),
  fsPick: (title?: string, initial?: string) =>
    request<{ path: string | null; cancelled: boolean }>('/api/fs/pick', { method: 'POST', body: j({ title, initial }) }),
  connect: (path: string, name?: string, watch = true) =>
    request<{ workspace_id: string; job_id: string; name: string; url: string; reused: boolean }>('/api/connect', { method: 'POST', body: j({ path, name, watch }) }),
  connectUpload: (uploadId: string, pathHint: string, name?: string, watch = true) =>
    request<{ workspace_id: string; job_id: string; name: string; url: string; reused: boolean }>('/api/connect/upload', {
      method: 'POST',
      body: j({ upload_id: uploadId, path_hint: pathHint, name: name || undefined, watch }),
    }),
  connectSessions: (since = 0) =>
    request<{ now: number; sessions: { workspace_id: string; name: string; path: string; job_id: string; created_at: number; reused: boolean }[] }>(`/api/connect/sessions${q({ since })}`),
  setSourceWatch: (id: string, sid: string, enabled: boolean) =>
    request<{ ok: boolean; source_id: string; watch: number }>(`/api/workspaces/${id}/sources/${sid}/watch`, { method: 'POST', body: j({ enabled }) }),
  job: (id: string) => request<JobInfo>(`/api/jobs/${id}`),
  rawUrl: (wsId: string, sid: string, path: string) => withKey(`${getApiBase()}/api/workspaces/${wsId}/sources/${sid}/raw${q({ path })}`),

  graph: (id: string, o: { types?: string; cluster?: number; max_nodes?: number; focus?: string; depth?: number } = {}, signal?: AbortSignal) =>
    request<GraphPayload>(`/api/workspaces/${id}/graph${q(o)}`, { signal }, getApiBase(), 120000),
  node: (id: string, nid: string, signal?: AbortSignal) =>
    request<NodeDetail>(`/api/workspaces/${id}/nodes/${encodeURIComponent(nid)}`, { signal }).then((data) => {
      nodeBriefCache.set(`${id}:${nid}`, data)
      return data
    }),
  nodeBrief: (id: string, nid: string, signal?: AbortSignal) => {
    const key = `${id}:${nid}`
    const cached = nodeBriefCache.get(key)
    if (cached) return Promise.resolve(cached)
    return request<NodeDetail>(`/api/workspaces/${id}/nodes/${encodeURIComponent(nid)}?brief=true`, { signal }).then((data) => {
      nodeBriefCache.set(key, data)
      return data
    })
  },
  neighbors: (id: string, nid: string, depth = 1, signal?: AbortSignal) =>
    request<{ nodes: GraphPayload['nodes']; links: GraphPayload['links'] }>(`/api/workspaces/${id}/nodes/${encodeURIComponent(nid)}/neighbors${q({ depth })}`, { signal }),
  explain: (id: string, nid: string, signal?: AbortSignal) =>
    request<{ explanation: string; provider: string }>(`/api/workspaces/${id}/nodes/${encodeURIComponent(nid)}/explain`, { signal }, getApiBase(), 90000),
  edge: (id: string, eid: string, signal?: AbortSignal) => {
    const key = `${id}:${eid}`
    const cached = edgeCache.get(key)
    if (cached) return Promise.resolve(cached)
    return request<EdgeDetail>(`/api/workspaces/${id}/edges/${eid}`, { signal }).then((data) => {
      edgeCache.set(key, data)
      return data
    })
  },
  getNodeBriefCached: (wsId: string, nid: string): NodeDetail | undefined => nodeBriefCache.get(`${wsId}:${nid}`),
  hasNodeBrief: (wsId: string, nid: string): boolean => nodeBriefCache.has(`${wsId}:${nid}`),
  getEdgeCached: (wsId: string, eid: string): EdgeDetail | undefined => edgeCache.get(`${wsId}:${eid}`),
  hasEdge: (wsId: string, eid: string): boolean => edgeCache.has(`${wsId}:${eid}`),
  clearCache: (): void => {
    nodeBriefCache.clear()
    edgeCache.clear()
  },
  search: (id: string, text: string) => request<SearchResult>(`/api/workspaces/${id}/search${q({ q: text })}`),
  impact: (id: string, node: string, direction: 'upstream' | 'downstream' = 'upstream', depth = 4) => request<ImpactResult>(`/api/workspaces/${id}/impact${q({ node, direction, depth })}`),
  trace: (id: string, source: string, target: string) => request<TraceResult>(`/api/workspaces/${id}/trace${q({ source, target })}`),
  processes: (id: string, signal?: AbortSignal) => request<ProcessItem[]>(`/api/workspaces/${id}/processes`, { signal }),
  insights: (id: string, signal?: AbortSignal) => request<Insight[]>(`/api/workspaces/${id}/insights`, { signal }),
  exportUrl: (id: string, format: 'json' | 'graphml' | 'cypher') => withKey(`${getApiBase()}/api/workspaces/${id}/export?format=${format}`),

  threads: (id: string) => request<Thread[]>(`/api/workspaces/${id}/threads`),
  createThread: (id: string, title = 'New chat') => request<Thread>(`/api/workspaces/${id}/threads`, { method: 'POST', body: j({ title }) }),
  renameThread: (id: string, tid: string, title: string) => request<Thread>(`/api/workspaces/${id}/threads/${tid}`, { method: 'PATCH', body: j({ title }) }),
  deleteThread: (id: string, tid: string) => request<void>(`/api/workspaces/${id}/threads/${tid}`, { method: 'DELETE' }),
  messages: (id: string, tid: string) => request<ChatMessage[]>(`/api/workspaces/${id}/threads/${tid}/messages`),
}

/** Upload files with real progress (fetch cannot report upload progress). */
/** Upload files in chunks (each request stays under Vercel's 4.5 MB limit) with real progress. */
export async function uploadFiles(wsId: string, files: File[], onProgress: (pct: number) => void): Promise<{ job_id: string }> {
  const total = files.reduce((n, f) => n + f.size, 0) || 1
  let sent = 0
  const ids: string[] = []
  for (const f of files) {
    const name = ((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name).slice(0, 300)
    const init = await request<{ upload_id: string; chunk_size: number; chunks: number }>('/api/uploads', { method: 'POST', body: j({ name, size: f.size }) })
    for (let i = 0; i < init.chunks; i++) {
      const part = f.slice(i * init.chunk_size, (i + 1) * init.chunk_size)
      let attempt = 0
      for (;;) {
        try {
          const res = await fetch(`${getApiBase()}/api/uploads/${init.upload_id}/chunks/${i}`, { method: 'PUT', headers: { ...authHeaders(), 'Content-Type': 'application/octet-stream' }, body: part })
          if (!res.ok) {
            let detail = `Upload failed (${res.status})`
            try { const d = await res.json(); if (typeof d.detail === 'string') detail = d.detail } catch { /* not json */ }
            throw new ApiError(detail, res.status)
          }
          break
        } catch (e) {
          attempt += 1
          if (attempt >= 3 || (e instanceof ApiError && e.status >= 400 && e.status < 500)) {
            throw e instanceof ApiError ? e : new ApiError('Cannot reach the NexMind server. Is it running?')
          }
          await new Promise((r) => setTimeout(r, 600 * attempt))
        }
      }
      sent += part.size
      onProgress(Math.min(99, Math.round((sent / total) * 100)))
    }
    ids.push(init.upload_id)
  }
  const res = await request<{ job_id: string }>(`/api/workspaces/${wsId}/ingest/uploads`, { method: 'POST', body: j({ upload_ids: ids }) }, getApiBase(), 300000)
  onProgress(100)
  return res
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
      method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: j({ content, stream: true }), signal,
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
