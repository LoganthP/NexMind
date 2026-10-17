import { create } from 'zustand'
import type { Activation, Cluster, GNode, GLink, ImpactResult, ProcessItem, Thread, TraceResult } from './types'

// ---------------------------------------------------------------- settings (persisted)
interface SettingsState {
  solid: boolean      // swap frosted glass for solid, high-contrast surfaces
  perf: boolean       // no bloom / particles / curved edges
  autoRotate: boolean
  theme: 'light' | 'dark' | 'graphite'
  set: (p: Partial<Omit<SettingsState, 'set'>>) => void
}
const SKEY = 'nexmind.settings'
function loadSettings(): Pick<SettingsState, 'solid' | 'perf' | 'autoRotate' | 'theme'> {
  const prefersSolid = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-transparency: reduce)').matches
  const prefersCalm = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const base = { solid: prefersSolid, perf: false, autoRotate: !prefersCalm, theme: 'dark' as const }
  try { return { ...base, ...JSON.parse(localStorage.getItem(SKEY) || '{}') } } catch { return base }
}
export const useSettings = create<SettingsState>((set, get) => ({
  ...loadSettings(),
  set: (p) => {
    set(p)
    const { solid, perf, autoRotate, theme } = get()
    try { localStorage.setItem(SKEY, JSON.stringify({ solid, perf, autoRotate, theme })) } catch { /* ignore */ }
    document.documentElement.dataset.solid = String(solid)
  },
}))

// ---------------------------------------------------------------- toasts
export interface Toast { id: number; kind: 'info' | 'success' | 'error'; text: string }
interface ToastState { items: Toast[]; push: (kind: Toast['kind'], text: string) => void; dismiss: (id: number) => void }
let tid = 0
export const useToasts = create<ToastState>((set, get) => ({
  items: [],
  push: (kind, text) => {
    const id = ++tid
    set({ items: [...get().items.slice(-3), { id, kind, text }] })
    setTimeout(() => get().dismiss(id), kind === 'error' ? 7000 : 3800)
  },
  dismiss: (id) => set({ items: get().items.filter((t) => t.id !== id) }),
}))
export const toast = {
  info: (t: string) => useToasts.getState().push('info', t),
  success: (t: string) => useToasts.getState().push('success', t),
  error: (t: string) => useToasts.getState().push('error', t),
}

// ---------------------------------------------------------------- workspace view state
export type Mode = 'explore' | 'impact' | 'trace' | 'flow'
export type Panel = 'sources' | 'threads' | 'insights' | 'flows' | 'filters' | null

export interface FocusState {
  label: string
  nodes: Set<string>
  edges: Set<string>
}

export interface IngestState {
  active: boolean; percent: number; phase: string; message: string; logs: { level: string; message: string }[]
  error?: string; streamed: number; streamTotal: number; uploadPct: number | null
}

interface WsViewState {
  nodes: GNode[]; links: GLink[]; clusters: Cluster[]
  legend: { node: Record<string, string>; edge: Record<string, string> }
  truncated: boolean; totalNodes: number
  selectedId: string | null; selectedEdgeId: string | null
  hoverId: string | null; hoverPos: { x: number; y: number } | null; hoverEdgeId: string | null
  mode: Mode; panel: Panel; drawerOpen: boolean; chatOpen: boolean
  view: 'graph' | 'list' | 'split' | 'mindmap' | 'analytics'
  kind: 'code' | 'docs' | 'live'
  wsKind?: 'code' | 'docs' | 'live'
  focus: FocusState | null
  impact: ImpactResult | null; trace: TraceResult | null; traceFrom: string | null
  activations: Activation[]
  hiddenTypes: Set<string>; hiddenClusters: Set<number>; minScore: number
  ingest: IngestState
  connected: boolean
  version: number
  threads: Thread[]; threadId: string | null; askDraft: string; railOpen: boolean
  flowProc: ProcessItem | null; flowStep: number; flowPlaying: boolean
  reset: () => void
  patch: (p: Partial<WsViewState>) => void
}

const emptyIngest: IngestState = { active: false, percent: 0, phase: '', message: '', logs: [], streamed: 0, streamTotal: 0, uploadPct: null }
const fresh = () => ({
  nodes: [] as GNode[], links: [] as GLink[], clusters: [] as Cluster[], legend: { node: {}, edge: {} },
  truncated: false, totalNodes: 0, selectedId: null, selectedEdgeId: null, hoverId: null, hoverPos: null, hoverEdgeId: null,
  mode: 'explore' as Mode, panel: 'sources' as Panel, drawerOpen: false, chatOpen: true,
  view: 'graph' as const, kind: 'code' as const, wsKind: 'code' as const, focus: null, impact: null, trace: null,
  traceFrom: null, activations: [] as Activation[], hiddenTypes: new Set<string>(), hiddenClusters: new Set<number>(), minScore: 0,
  ingest: { ...emptyIngest }, connected: false, version: 0, threads: [] as Thread[], threadId: null as string | null, askDraft: '', railOpen: true,
  flowProc: null as ProcessItem | null, flowStep: -1, flowPlaying: false,
})

export const useView = create<WsViewState>((set) => ({
  ...fresh(),
  reset: () => set(fresh()),
  patch: (p) => set(p),
}))
