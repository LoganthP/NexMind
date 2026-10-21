import { create } from 'zustand'
import { api, DEFAULT_API, getApiBase, setApiBase } from './api'
import type { Health } from './types'

export interface ServerState {
  status: 'checking' | 'offline' | 'online'
  connected: boolean
  justConnected: number
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

async function probeWithTimeout(base: string, timeoutMs: number): Promise<Health | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })
  try {
    return await Promise.race([api.probe(base), timeoutPromise])
  } finally {
    clearTimeout(timer)
  }
}

let inFlight: Promise<boolean> | null = null
let isFirstProbe = true

export const useServer = create<ServerState>((set, get) => ({
  status: 'checking',
  connected: false,
  justConnected: 0,
  base: getApiBase(),
  health: null,
  attempts: 0,
  check: async () => {
    if (inFlight) return inFlight
    const isFirst = isFirstProbe
    isFirstProbe = false

    const runCheck = async (): Promise<boolean> => {
      try {
        const timeout = isFirst ? 1200 : 2500
        for (const base of candidates()) {
          const h = await probeWithTimeout(base, timeout)
          if (h) {
            setApiBase(base)
            const wasOnline = get().status === 'online' || get().connected
            set({
              status: 'online',
              connected: true,
              justConnected: wasOnline ? (get().justConnected || Date.now()) : Date.now(),
              base,
              health: h,
              attempts: 0,
            })
            try {
              sessionStorage.setItem('nexmind.serverSeen', '1')
              localStorage.setItem('nexmind.serverSeen', '1')
              localStorage.setItem('nexmind.serverEverDetected', '1')
            } catch { /* ignore */ }
            return true
          }
        }
        set({ status: 'offline', connected: false, health: null, attempts: get().attempts + 1 })
        return false
      } finally {
        inFlight = null
      }
    }

    if (isFirst) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadlinePromise = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          set({ status: 'offline', connected: false, health: null, attempts: get().attempts + 1 })
          resolve(false)
        }, 1200)
      })
      inFlight = Promise.race([runCheck(), deadlinePromise]).finally(() => {
        clearTimeout(timer)
        inFlight = null
      })
      return inFlight
    }

    inFlight = runCheck()
    return inFlight
  },
  useBase: async (url) => {
    const clean = url.trim().replace(/\/+$/, '')
    if (!/^https?:\/\//.test(clean)) return false
    const h = await api.probe(clean)
    if (!h) return false
    setApiBase(clean)
    const wasOnline = get().status === 'online' || get().connected
    set({
      status: 'online',
      connected: true,
      justConnected: wasOnline ? (get().justConnected || Date.now()) : Date.now(),
      base: clean,
      health: h,
      attempts: 0,
    })
    try {
      sessionStorage.setItem('nexmind.serverSeen', '1')
      localStorage.setItem('nexmind.serverSeen', '1')
      localStorage.setItem('nexmind.serverEverDetected', '1')
    } catch { /* ignore */ }
    return true
  },
}))

// Auto-sync connected flag whenever status changes (e.g. via direct useServer.setState in tests)
useServer.subscribe((state) => {
  if (state.status === 'online' && !state.connected) {
    useServer.setState({
      connected: true,
      justConnected: state.justConnected || Date.now(),
    })
  } else if (state.status !== 'online' && state.connected) {
    useServer.setState({ connected: false })
  }
})

let timer: ReturnType<typeof setTimeout> | undefined
let running = false
/** Poll for the local server: fast while it is missing (like "Listening for server…"), slow once connected. */
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

  // Remove the duplicate first probe: startServerWatch should not fire its own immediate check if one is already in flight.
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
