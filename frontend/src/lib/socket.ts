import { api, authHeaders, getApiBase } from './api'
import type { GNode, GLink, WsEvent } from './types'

export interface WorkspaceSocket {
  send: (msg: object) => void
  close: () => void
}

type Feed = {
  events: (WsEvent & { seq: number })[]
  seq: number
  status: string
  pending_job: { id: string; status: string } | null
  running_job: { id: string; progress: number; phase: string; message: string } | null
}

/**
 * Live workspace updates without WebSockets (so it works on Vercel and any serverless host).
 * Polls the event feed, runs queued graph builds (the build happens inside that request and streams its
 * progress), and replays the finished graph as the same stream events the 3D view already animates.
 * Same interface as the old WebSocket client.
 */
export function connectWorkspaceSocket(wsId: string, onEvent: (e: WsEvent) => void, onState?: (connected: boolean) => void): WorkspaceSocket {
  let closed = false
  let after = 0
  let first = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let failures = 0
  const seen = new Set<number>()
  const runners = new Set<string>()
  let streaming = false

  const emit = (e: WsEvent) => { if (!closed) { try { onEvent(e) } catch { /* UI errors must not stop the feed */ } } }

  const replayGraph = async () => {
    try {
      const g = await api.graph(wsId, { max_nodes: 4000 })
      const nodes = [...g.nodes].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      emit({ type: 'graph_stream_start', nodes: nodes.length, edges: g.links.length, clusters: g.clusters } as WsEvent)
      const sent = new Set<string>()
      let pending: GLink[] = [...g.links]
      const size = 250
      for (let i = 0; i < nodes.length; i += size) {
        const batch = nodes.slice(i, i + size) as GNode[]
        batch.forEach((n) => sent.add(n.id))
        const ready = pending.filter((l) => sent.has(String(l.source)) && sent.has(String(l.target)))
        pending = pending.filter((l) => !(sent.has(String(l.source)) && sent.has(String(l.target))))
        emit({ type: 'graph_batch', nodes: batch, edges: ready } as unknown as WsEvent)
        await new Promise((r) => setTimeout(r, 30))
      }
      emit({ type: 'graph_ready', stats: { nodes: nodes.length, edges: g.links.length } } as WsEvent)
    } catch { /* the page's own fallback reloads the graph */ }
  }

  const handle = async (ev: WsEvent & { seq?: number }) => {
    if (ev.seq) {
      if (seen.has(ev.seq)) return
      seen.add(ev.seq)
      if (ev.seq > after) after = ev.seq
    }
    if (ev.type === 'job_done') {
      await replayGraph()
      emit(ev)
    } else if ((ev.type as string) === 'relayout_done') {
      await replayGraph()
    } else {
      emit(ev)
    }
  }

  const runJob = async (jobId: string) => {
    if (runners.has(jobId)) return
    runners.add(jobId)
    streaming = true
    try {
      const res = await fetch(`${getApiBase()}/api/jobs/${jobId}/run`, { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: '{}' })
      if (!res.ok || !res.body) return // 409: someone else builds it; the feed shows the progress
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim()
          buf = buf.slice(idx + 1)
          if (!line) continue
          try { await handle(JSON.parse(line)) } catch { /* ignore malformed line */ }
        }
      }
    } catch { /* network cut: the feed (and a later runner) takes over */ } finally {
      streaming = false
    }
  }

  const tick = async () => {
    if (closed) return
    try {
      const res = await fetch(`${getApiBase()}/api/workspaces/${wsId}/events?after=${after}`, { headers: authHeaders() })
      if (!res.ok) throw new Error(String(res.status))
      const feed = (await res.json()) as Feed
      failures = 0
      onState?.(true)
      if (first) {
        first = false
        after = feed.seq || 0
        feed.events.forEach((e) => e.seq && seen.add(e.seq))
        const rj = feed.running_job
        emit({ type: 'hello', status: feed.status, last_progress: rj ? { percent: rj.progress, phase: rj.phase, message: rj.message } : null } as WsEvent)
      } else {
        for (const e of feed.events) await handle(e)
      }
      if (feed.pending_job) void runJob(feed.pending_job.id)
    } catch {
      failures += 1
      onState?.(false)
    }
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
    const delay = hidden ? 6000 : streaming ? 2500 : failures ? Math.min(10000, 1500 * 2 ** failures) : 1500
    timer = setTimeout(tick, delay)
  }

  void tick()
  return {
    send: (msg) => { const m = msg as { type?: string }; if (m.type === 'replay_graph') void replayGraph() },
    close: () => { closed = true; clearTimeout(timer) },
  }
}
