import { api, ApiError } from '@/lib/api'
import { toast, useView } from '@/lib/store'
import type { GLink, GNode, ProcessItem, WsEvent } from '@/lib/types'
import type { BrainEngine } from '@/three/engine'

/** The 3D engine instance for the open workspace (set by GraphCanvas). */
export const eng: { current: BrainEngine | null; wsId: string } = { current: null, wsId: '' }

const patch = useView.getState().patch
const get = () => useView.getState()
const msg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback)

// ------------------------------------------------------------------ selection / focus
export function clearAll() {
  eng.current?.cancelPath()
  eng.current?.setSelected(null)
  eng.current?.setFocus(null)
  eng.current?.releasePivot()
  eng.current?.clearFocusState()
  patch({ selectedId: null, selectedEdgeId: null, drawerOpen: false, focus: null, impact: null, trace: null, traceFrom: null, activations: [], flowProc: null, flowStep: -1, flowPlaying: false })
}

export function applyFocus(label: string, nodes: string[], edges: string[], fit = true) {
  eng.current?.setFocus({ nodes, edges })
  patch({ focus: { label, nodes: new Set(nodes), edges: new Set(edges) } })
  if (fit && nodes.length) eng.current?.fitTo(nodes)
}

export function selectNode(id: string, fly = true) {
  const v = get()
  if (v.mode === 'trace') return void traceClick(id)
  eng.current?.setSelected(id)
  if (fly) eng.current?.flyTo(id, 120, 1100, { force: true })
  patch({ selectedId: id, selectedEdgeId: null, drawerOpen: v.mode !== 'impact' })
  if (v.mode === 'impact') void runImpact(id)
}

export function selectEdge(id: string) {
  patch({ selectedEdgeId: id, drawerOpen: true })
}

export function setMode(mode: 'explore' | 'impact' | 'trace' | 'flow') {
  try {
    const current = get().mode
    if (current === mode) {
      mode = 'explore'
    }
    eng.current?.cancelPath()
    if (mode === 'flow') {
      patch({ mode, panel: 'flows', railOpen: true, impact: null, trace: null, traceFrom: null, flowPlaying: false })
    } else {
      eng.current?.setFocus(null)
      patch({ mode, impact: null, trace: null, traceFrom: null, flowPlaying: false, focus: null, flowProc: null, flowStep: -1 })
    }
  } catch (e) {
    toast.error('Failed to change mode')
  }
}

export function setView(view: 'graph' | 'list' | 'split' | 'mindmap' | 'analytics') {
  patch({ view })
}

// ------------------------------------------------------------------ analysis
export async function runImpact(id: string, direction: 'upstream' | 'downstream' = 'upstream') {
  try {
    const res = await api.impact(eng.wsId, id, direction, 4)
    eng.current?.setSelected(id)
    patch({ impact: res, drawerOpen: false, selectedId: id })
    applyFocus(`Impact of ${res.target.label}`, res.highlight.nodes, res.highlight.edges, true)
    eng.current?.shockwave(id, res.levels.map((l) => l.nodes.map((n) => n.id)))
  } catch (e) { toast.error(msg(e, 'Impact analysis failed')) }
}

export async function traceClick(id: string) {
  const { traceFrom } = get()
  if (!traceFrom) {
    patch({ traceFrom: id, trace: null }); eng.current?.setSelected(id); eng.current?.flash(id, 1.5)
    toast.info('Now click the node you want to reach')
    return
  }
  if (traceFrom === id) return
  try {
    const res = await api.trace(eng.wsId, traceFrom, id)
    patch({ trace: res, traceFrom: null })
    if (!res.found) { toast.error('These two nodes are not connected'); return }
    applyFocus('Connection path', res.highlight?.nodes ?? res.nodes.map((n) => n.id), res.highlight?.edges ?? res.edges.map((e) => e.id), true)
    playTrace(res.nodes.map((n) => n.id))
  } catch (e) { toast.error(msg(e, 'Trace failed')) }
}
export function playTrace(ids: string[]) { eng.current?.playPath(ids, undefined, 650) }

export function playProcess(p: ProcessItem, from = 0) {
  const eng_ = eng.current; if (!eng_) return
  patch({ mode: 'flow', flowProc: p, flowPlaying: true, impact: null, trace: null, drawerOpen: false })
  const ids = p.steps.map((s) => s.node_id)
  eng_.fitTo(ids)
  eng_.playPath(ids.slice(from), (i) => patch({ flowStep: i + from }), 750, () => patch({ flowPlaying: false }))
  patch({ flowStep: from })
}
export function pauseFlow() { eng.current?.cancelPath(); patch({ flowPlaying: false }) }
export function seekFlow(i: number) {
  const { flowProc } = get(); if (!flowProc) return
  eng.current?.cancelPath()
  const ids = flowProc.steps.slice(0, i + 1).map((s) => s.node_id)
  const edges = flowProc.highlight.edges.slice(0, i)
  eng.current?.setFocus({ nodes: ids, edges })
  eng.current?.flash(ids[ids.length - 1], 1.2)
  patch({ flowStep: i, flowPlaying: false })
}

export async function expandNeighbors(id: string) {
  try {
    const r = await api.neighbors(eng.wsId, id, 1)
    const fresh = r.nodes.filter((n) => !eng.current?.hasNode(n.id))
    const links = r.links.map((l) => ({ ...l })) as GLink[]
    eng.current?.addBatch(fresh.map((n) => ({ ...n })) as GNode[], links)
    const ids = r.nodes.map((n) => n.id)
    applyFocus(`Neighbors of ${get().nodes.find((n) => n.id === id)?.label ?? 'node'}`, ids, links.map((l) => l.id))
    toast.success(fresh.length ? `${fresh.length} hidden connection${fresh.length > 1 ? 's' : ''} revealed` : 'Everything connected is already visible')
  } catch (e) { toast.error(msg(e, 'Could not expand')) }
}

export async function focusEgo(id: string, depth = 2) {
  try {
    const r = await api.neighbors(eng.wsId, id, depth)
    applyFocus(`Around ${get().nodes.find((n) => n.id === id)?.label ?? 'node'}`, r.nodes.map((n) => n.id), r.links.map((l) => l.id))
  } catch (e) { toast.error(msg(e, 'Could not focus')) }
}

export function applyFilters() {
  const v = get()
  eng.current?.setFilters(v.hiddenTypes, v.hiddenClusters, v.minScore)
}

// ------------------------------------------------------------------ loading + live stream
export async function loadGraph(wsId: string) {
  try {
    const g = await api.graph(wsId, { max_nodes: 4000 })
    eng.current?.setColors(g.legend?.node_colors, g.legend?.edge_colors)
    eng.current?.setData(g.nodes, g.links, g.clusters)
    patch({
      nodes: g.nodes, links: g.links, clusters: g.clusters, truncated: g.truncated, totalNodes: g.total_nodes,
      legend: { node: g.legend?.node_colors ?? {}, edge: g.legend?.edge_colors ?? {} }, version: get().version + 1,
    })
  } catch (e) { toast.error(msg(e, 'Could not load the graph')) }
}

let streamNodes: GNode[] = []
let streamLinks: GLink[] = []
let streamClusters: ReturnType<typeof get>['clusters'] = []
let doneTimer: ReturnType<typeof setTimeout> | undefined

export function handleSocketEvent(ev: WsEvent) {
  const v = get()
  switch (ev.type) {
    case 'hello':
      if (ev.status === 'building') patch({ ingest: { ...v.ingest, active: true, percent: ev.last_progress?.percent ?? 0, phase: ev.last_progress?.phase ?? 'queued', message: ev.last_progress?.message ?? 'Working…' } })
      break
    case 'job_queued':
    case 'job_started':
      clearTimeout(doneTimer)
      patch({ ingest: { active: true, percent: 1, phase: 'queued', message: 'Starting…', logs: [], error: undefined, streamed: 0, streamTotal: 0, uploadPct: null } })
      break
    case 'progress':
      patch({ ingest: { ...v.ingest, active: true, percent: ev.percent, phase: ev.phase, message: ev.message } })
      break
    case 'log':
      patch({ ingest: { ...v.ingest, logs: [...v.ingest.logs.slice(-60), { level: ev.level, message: ev.message }] } })
      break
    case 'graph_stream_start':
      streamNodes = []; streamLinks = []; streamClusters = ev.clusters
      clearAll()
      eng.current?.clear()
      patch({ nodes: [], links: [], clusters: ev.clusters, ingest: { ...get().ingest, active: true, streamTotal: ev.nodes, streamed: 0 } })
      break
    case 'graph_batch': {
      const links = ev.edges as unknown as GLink[]
      eng.current?.addBatch(ev.nodes, links)
      streamNodes.push(...ev.nodes); streamLinks.push(...links)
      patch({ ingest: { ...get().ingest, streamed: streamNodes.length } })
      break
    }
    case 'graph_ready':
      eng.current?.setClusters(streamClusters)
      eng.current?.clearFocusState()
      patch({ nodes: streamNodes, links: streamLinks, clusters: streamClusters, totalNodes: streamNodes.length, version: get().version + 1 })
      setTimeout(() => {
        eng.current?.frameGraph()
      }, 900)
      break
    case 'job_done':
      patch({ ingest: { ...get().ingest, percent: 100, phase: 'done', message: 'Graph ready' } })
      clearTimeout(doneTimer)
      doneTimer = setTimeout(() => patch({ ingest: { ...get().ingest, active: false } }), 1600)
      if (!get().nodes.length) void loadGraph(eng.wsId)
      toast.success('Your graph is ready')
      break
    case 'job_failed':
      patch({ ingest: { ...get().ingest, active: false, error: ev.error } })
      toast.error(ev.error)
      break
    default:
  }
}
