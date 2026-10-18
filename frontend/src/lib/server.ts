import { create } from 'zustand'
import { api, DEFAULT_API, getApiBase, setApiBase } from './api'
import type { Health } from './types'

interface ServerState {
  status: 'checking' | 'offline' | 'online'
  base: string
  health: Health | null
  attempts: number
  check: () => Promise<boolean>
  useBase: (url: string) => Promise<boolean>
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

export const useServer = create<ServerState>((set, get) => ({
  status: 'checking',
  base: getApiBase(),
  health: null,
  attempts: 0,
  check: async () => {
    if (inFlight) return inFlight
    inFlight = (async () => {
      try {
        for (const base of candidates()) {
          const h = await api.probe(base)
          if (h) {
            setApiBase(base)
            set({ status: 'online', base, health: h, attempts: 0 })
            try { sessionStorage.setItem('nexmind.serverSeen', '1') } catch { /* ignore */ }
            return true
          }
        }
        set({ status: 'offline', health: null, attempts: get().attempts + 1 })
        return false
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  },
  useBase: async (url) => {
    const clean = url.trim().replace(/\/+$/, '')
    if (!/^https?:\/\//.test(clean)) return false
    const h = await api.probe(clean)
    if (!h) return false
    setApiBase(clean)
    set({ status: 'online', base: clean, health: h, attempts: 0 })
    try { sessionStorage.setItem('nexmind.serverSeen', '1') } catch { /* ignore */ }
    return true
  },
}))

let timer: ReturnType<typeof setTimeout> | undefined
let running = false
/** Poll for the local server: fast while it is missing (like "Listening for server…"), slow once connected. */
export function startServerWatch(): () => void {
  running = true
  const loop = async () => {
    if (!running) return
    const ok = await useServer.getState().check()
    if (!running) return
    timer = setTimeout(loop, ok ? 7000 : 1500)
  }
  // Remove the duplicate first probe: startServerWatch should not fire its own immediate check if one is already in flight.
  if (inFlight) {
    inFlight.then((ok) => {
      if (!running) return
      timer = setTimeout(loop, ok ? 7000 : 1500)
    })
  } else {
    void loop()
  }
  return () => { running = false; clearTimeout(timer) }
}
