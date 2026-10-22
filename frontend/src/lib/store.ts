import { create } from 'zustand'
import type { Activation, Cluster, GNode, GLink, ImpactResult, ProcessItem, Thread, TraceResult } from './types'

// ---------------------------------------------------------------- settings (persisted)
export const SETTINGS_VERSION = 2
export const SKEY = 'nexmind.settings'

export interface SettingsValues {
  solid: boolean      // swap frosted glass for solid, high-contrast surfaces
  perf: boolean       // no bloom / particles / curved edges
  autoRotate: boolean
  theme: 'light' | 'dark' | 'graphite'
  glow: number        // 0 = off, capped at 0.35
  version: number
}

export interface SettingsState extends SettingsValues {
  set: (p: Partial<Omit<SettingsState, 'set'>>) => void
}

export function loadSettings(): SettingsValues {
  const prefersSolid = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-transparency: reduce)').matches
  const prefersCalm = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const base: SettingsValues = {
    solid: prefersSolid,
    perf: false,
    autoRotate: !prefersCalm,
    theme: 'dark' as const,
    glow: 0,
    version: SETTINGS_VERSION,
  }
  try {
    const raw = localStorage.getItem(SKEY)
    if (!raw) return base
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || parsed.version !== SETTINGS_VERSION) {
      // Stored values from older builds or other domains are reset to the new defaults (glow 0, performance mode off)
      const migrated: SettingsValues = {
        ...base,
        solid: typeof parsed?.solid === 'boolean' ? parsed.solid : base.solid,
        autoRotate: typeof parsed?.autoRotate === 'boolean' ? parsed.autoRotate : base.autoRotate,
        theme: parsed?.theme === 'light' || parsed?.theme === 'graphite' ? parsed.theme : base.theme,
        glow: 0,
        perf: false,
        version: SETTINGS_VERSION,
      }
      try { localStorage.setItem(SKEY, JSON.stringify(migrated)) } catch { /* ignore */ }
      return migrated
    }
    return {
      ...base,
      ...parsed,
      glow: typeof parsed.glow === 'number' ? Math.min(Math.max(parsed.glow, 0), 0.35) : 0,
    }
  } catch {
    return base
  }
}

export const useSettings = create<SettingsState>((set, get) => ({
  ...loadSettings(),
  set: (p) => {
    set(p)
    const { solid, perf, autoRotate, theme, glow, version } = get()
    try { localStorage.setItem(SKEY, JSON.stringify({ solid, perf, autoRotate, theme, glow, version })) } catch { /* ignore */ }
    document.documentElement.dataset.solid = String(solid)
    document.documentElement.dataset.perf = String(perf)
  },
}))

import { formatApiError } from './api'

// ---------------------------------------------------------------- toasts
export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  text: string
  baseText?: string
  count?: number
  timestamp?: number
}
interface ToastState {
  items: Toast[]
  push: (kind: Toast['kind'], text: string) => void
  dismiss: (id: number) => void
}
let tid = 0
export const useToasts = create<ToastState>((set, get) => ({
  items: [],
  push: (kind, text) => {
    const formatted = formatApiError(text)
    const now = Date.now()
    const current = get().items
    const existingIdx = current.findIndex(
      (t) => (t.baseText || t.text) === formatted && t.kind === kind && now - (t.timestamp || 0) < 5000
    )

    if (existingIdx !== -1) {
      const existing = current[existingIdx]
      const count = (existing.count || 1) + 1
      const updated: Toast = {
        ...existing,
        count,
        timestamp: now,
        text: `${formatted} x${count}`,
      }
      const nextItems = [...current]
      nextItems[existingIdx] = updated
      set({ items: nextItems.slice(-2) })
      setTimeout(() => get().dismiss(existing.id), kind === 'error' ? 7000 : 3800)
      return
    }

    const id = ++tid
    const item: Toast = {
      id,
      kind,
      text: formatted,
      baseText: formatted,
      count: 1,
      timestamp: now,
    }
    set({ items: [...current.slice(-1), item] })
    setTimeout(() => get().dismiss(id), kind === 'error' ? 7000 : 3800)
  },
  dismiss: (id) => set({ items: get().items.filter((t) => t.id !== id) }),
}))
export const toast = {
  info: (t: string) => useToasts.getState().push('info', t),
  success: (t: string) => useToasts.getState().push('success', t),
  error: (t: unknown) => useToasts.getState().push('error', typeof t === 'string' ? t : (t as any)),
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
