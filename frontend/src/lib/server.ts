import { create } from 'zustand'
import { api, DEFAULT_API, getApiBase, setApiBase } from './api'
import type { Health } from './types'

export interface ServerState {
  status: 'checking' | 'offline' | 'online'
  connected: boolean
  base: string
  health: Health | null
  attempts: number
  check: (timeoutMs?: number) => Promise<boolean>
  useBase: (url: string) => Promise<boolean>
}

type JustConnectedListener = (detail: { base: string; health: Health }) => void
const justConnectedListeners = new Set<JustConnectedListener>()

/**
 * Register a listener for when the server transitions from disconnected to connected.
 */
export function onJustConnected(cb: JustConnectedListener): () => void {
  justConnectedListeners.add(cb)
  return () => {
    justConnectedListeners.delete(cb)
  }
}

function notifyJustConnected(detail: { base: string; health: Health }): void {
  justConnectedListeners.forEach((cb) => {
    try {
      cb(detail)
    } catch {
      /* ignore listener error */
    }
  })
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new CustomEvent('nexmind:justConnected', { detail }))
    } catch {
      /* ignore */
    }
  }
}

function candidates(): string[] {
  const base = getApiBase()
  if (base && base !== DEFAULT_API && base !== 'http://localhost:8000') {
    return [base]
  }
  const origin =
    typeof window !== 'undefined' &&
    window.location?.origin &&
    !window.location.origin.startsWith('file:') &&
    !window.location.port.includes('5173')
      ? window.location.origin
      : ''
  const list = [origin, base, DEFAULT_API, 'http://localhost:8000', 'http://127.0.0.1:8001', 'http://127.0.0.1:8765'].filter(Boolean)
  return [...new Set(list)]
}

let inFlight: Promise<boolean> | null = null
let isFirstProbe = true

export const useServer = create<ServerState>((set, get) => ({
  status: 'checking',
  connected: false,
  base: getApiBase(),
  health: null,
  attempts: 0,
  check: async (timeoutMs?: number) => {
    if (inFlight) return inFlight
    const probeTimeout = timeoutMs ?? (isFirstProbe ? 1200 : 2500)
    isFirstProbe = false

    inFlight = (async () => {
      try {
        const wasOnline = get().status === 'online'
        for (const base of candidates()) {
          const h = await api.probe(base, probeTimeout)
          if (h) {
            setApiBase(base)
            set({ status: 'online', connected: true, base, health: h, attempts: 0 })
            try { sessionStorage.setItem('nexmind.serverSeen', '1') } catch { /* ignore */ }
            try { localStorage.setItem('nexmind.serverSeen', '1') } catch { /* ignore */ }
            if (!wasOnline) {
              notifyJustConnected({ base, health: h })
            }
            return true
          }
        }
        set({ status: 'offline', connected: false, health: null, attempts: get().attempts + 1 })
        return false
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  },
  useBase: async (url: string) => {
    const clean = url.trim().replace(/\/+$/, '')
    if (!/^https?:\/\//.test(clean)) return false
    const wasOnline = get().status === 'online'
    const h = await api.probe(clean, 2500)
    if (!h) return false
    setApiBase(clean)
    set({ status: 'online', connected: true, base: clean, health: h, attempts: 0 })
    try { sessionStorage.setItem('nexmind.serverSeen', '1') } catch { /* ignore */ }
    try { localStorage.setItem('nexmind.serverSeen', '1') } catch { /* ignore */ }
    if (!wasOnline) {
      notifyJustConnected({ base: clean, health: h })
    }
    return true
  },
}))

let timer: ReturnType<typeof setTimeout> | undefined
let running = false

/** Poll for the local server in the background: 1.5s when offline, 15s when connected. */
export function startServerWatch(): () => void {
  running = true

  const scheduleNext = (delay: number) => {
    clearTimeout(timer)
    if (!running) return
    timer = setTimeout(loop, delay)
  }

  const loop = async () => {
    if (!running) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return
    }
    const ok = await useServer.getState().check()
    if (!running) return
    scheduleNext(ok ? 15000 : 1500)
  }

  const onVisChange = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      if (running) void loop()
    } else {
      clearTimeout(timer)
    }
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisChange)
  }

  if (inFlight) {
    inFlight.then((ok) => {
      if (!running) return
      scheduleNext(ok ? 15000 : 1500)
    })
  } else {
    void loop()
  }

  return () => {
    running = false
    clearTimeout(timer)
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisChange)
    }
  }
}
