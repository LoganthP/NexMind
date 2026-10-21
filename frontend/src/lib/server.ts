import { create } from 'zustand'
import { DEFAULT_API, getApiBase, setApiBase } from './api'
import type { Health } from './types'

export type ConnectionState =
  | 'connected'
  | 'not-running'
  | 'blocked-browser'
  | 'blocked-origin'
  | 'outdated'
  | 'other-app'

export interface ServerState {
  state: ConnectionState
  status: 'checking' | 'offline' | 'online'
  connected: boolean
  base: string
  failingAddress: string | null
  lastCheckedAt: number | null
  blockedOrigin: string | null
  health: Health | null
  attempts: number
  check: (timeoutMsOrGesture?: number | boolean, isUserGesture?: boolean) => Promise<boolean>
  useBase: (url: string) => Promise<boolean>
}

export interface ProbeResult {
  state: ConnectionState
  base: string
  health?: Health | null
  origin?: string | null
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

export function supportsTargetAddressSpace(): boolean {
  try {
    if (typeof Request !== 'undefined') {
      if ('targetAddressSpace' in Request.prototype) return true
      if ((Request as any).targetAddressSpaceSupported) return true
    }
  } catch {
    /* ignore */
  }
  return false
}

export function getProbeCandidates(): string[] {
  const saved = getApiBase()
  const defaults = [
    'http://127.0.0.1:8000',
    'http://localhost:8000',
    'http://127.0.0.1:8001',
  ]
  const list = [saved, ...defaults].filter(Boolean).map((u) => u.replace(/\/+$/, ''))
  return Array.from(new Set(list))
}

export async function probeCandidate(
  base: string,
  timeoutMs: number,
  isUserGesture: boolean
): Promise<ProbeResult> {
  const cleanBase = base.replace(/\/+$/, '')

  const buildFetchOpts = (mode?: RequestMode): RequestInit & { targetAddressSpace?: string } => {
    const opts: RequestInit & { targetAddressSpace?: string } = {
      method: 'GET',
    }
    if (mode) opts.mode = mode
    if (isUserGesture && supportsTargetAddressSpace()) {
      try {
        opts.targetAddressSpace = 'local'
      } catch {
        /* ignore unsupported */
      }
    }
    return opts
  }

  const fetchWithTimeout = async (url: string, opts: RequestInit): Promise<Response> => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      return await fetch(url, { ...opts, signal: ctl.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  const tryNoCors = async (path = '/api/ping'): Promise<ProbeResult> => {
    try {
      await fetchWithTimeout(`${cleanBase}${path}`, buildFetchOpts('no-cors'))
      return { state: 'blocked-browser', base: cleanBase }
    } catch {
      return { state: 'not-running', base: cleanBase }
    }
  }

  // a) fetch(<base>/api/ping) as a normal CORS GET with no custom headers
  let pingRes: Response
  try {
    pingRes = await fetchWithTimeout(`${cleanBase}/api/ping`, buildFetchOpts())
  } catch {
    // b) If a) fails with a network/CORS error, try fetch(<base>/api/ping, { mode: 'no-cors' })
    return await tryNoCors('/api/ping')
  }

  // c) If /api/ping returns 404, fall back to /api/health with CORS
  if (pingRes.status === 404) {
    try {
      const healthRes = await fetchWithTimeout(`${cleanBase}/api/health`, buildFetchOpts())
      if (healthRes.ok) {
        let h: any = null
        try {
          h = await healthRes.json()
        } catch {
          return { state: 'other-app', base: cleanBase }
        }
        if (h && h.app === 'nexmind') {
          if (!h.capabilities) {
            return { state: 'outdated', health: h, base: cleanBase }
          }
          return { state: 'connected', health: h, base: cleanBase }
        }
        return { state: 'other-app', base: cleanBase }
      } else {
        return await tryNoCors('/api/health')
      }
    } catch {
      return await tryNoCors('/api/health')
    }
  }

  // If response status is not ok
  if (!pingRes.ok) {
    try {
      const j = await pingRes.json()
      if (j && j.app === 'nexmind') {
        if (j.origin_allowed === false) {
          return { state: 'blocked-origin', origin: j.origin || null, base: cleanBase }
        }
      } else {
        return { state: 'other-app', base: cleanBase }
      }
    } catch {
      return await tryNoCors('/api/ping')
    }
  }

  // Parse ping JSON
  let pingData: any = null
  try {
    pingData = await pingRes.json()
  } catch {
    return { state: 'other-app', base: cleanBase }
  }

  // d) If the JSON is not app nexmind -> 'other-app'
  if (!pingData || pingData.app !== 'nexmind') {
    return { state: 'other-app', base: cleanBase }
  }

  // origin_allowed false -> 'blocked-origin'
  if (pingData.origin_allowed === false) {
    return {
      state: 'blocked-origin',
      origin: pingData.origin || null,
      base: cleanBase,
    }
  }

  // origin_allowed true -> GET /api/health -> 'connected' (store health)
  try {
    const healthRes = await fetchWithTimeout(`${cleanBase}/api/health`, buildFetchOpts())
    if (healthRes.ok) {
      const h = await healthRes.json()
      if (h && h.app === 'nexmind') {
        return { state: 'connected', health: h, base: cleanBase }
      }
      return { state: 'other-app', base: cleanBase }
    }
    return { state: 'outdated', base: cleanBase }
  } catch {
    return { state: 'outdated', base: cleanBase }
  }
}

let inFlight: Promise<boolean> | null = null
let isFirstProbe = true

export const useServer = create<ServerState>((set, get) => ({
  state: 'not-running',
  status: 'checking',
  connected: false,
  base: getApiBase(),
  failingAddress: null,
  lastCheckedAt: null,
  blockedOrigin: null,
  health: null,
  attempts: 0,
  check: async (timeoutMsOrGesture?: number | boolean, isUserGesture?: boolean) => {
    let probeTimeout = 2500
    let userGesture = false

    if (typeof timeoutMsOrGesture === 'boolean') {
      userGesture = timeoutMsOrGesture
      probeTimeout = isFirstProbe ? 1200 : 2500
    } else if (typeof timeoutMsOrGesture === 'number') {
      probeTimeout = timeoutMsOrGesture
      userGesture = Boolean(isUserGesture)
    } else {
      probeTimeout = isFirstProbe ? 1200 : 2500
      userGesture = Boolean(isUserGesture)
    }
    isFirstProbe = false

    if (inFlight && !userGesture) return inFlight

    const run = async (): Promise<boolean> => {
      try {
        const wasOnline = get().status === 'online'
        const candidates = getProbeCandidates()
        const failures: ProbeResult[] = []

        for (const base of candidates) {
          const res = await probeCandidate(base, probeTimeout, userGesture)
          if (res.state === 'connected') {
            setApiBase(res.base)
            set({
              state: 'connected',
              status: 'online',
              connected: true,
              base: res.base,
              health: res.health || null,
              failingAddress: null,
              blockedOrigin: null,
              lastCheckedAt: Date.now(),
              attempts: 0,
            })
            try { sessionStorage.setItem('nexmind.serverSeen', '1') } catch {}
            try { localStorage.setItem('nexmind.serverSeen', '1') } catch {}
            if (!wasOnline && res.health) {
              notifyJustConnected({ base: res.base, health: res.health })
            }
            return true
          }
          failures.push(res)
        }

        const failurePriority: Record<ConnectionState, number> = {
          'blocked-origin': 1,
          'blocked-browser': 2,
          'outdated': 3,
          'other-app': 4,
          'not-running': 5,
          'connected': 6,
        }
        failures.sort((a, b) => failurePriority[a.state] - failurePriority[b.state])
        const best = failures[0] || { state: 'not-running', base: candidates[0] || DEFAULT_API }

        set({
          state: best.state,
          status: 'offline',
          connected: false,
          health: null,
          failingAddress: best.base,
          blockedOrigin: best.origin || null,
          lastCheckedAt: Date.now(),
          attempts: get().attempts + 1,
        })
        return false
      } finally {
        if (inFlight === promise) {
          inFlight = null
        }
      }
    }

    const promise = run()
    if (!userGesture) {
      inFlight = promise
    }
    return promise
  },
  useBase: async (url: string) => {
    const clean = url.trim().replace(/\/+$/, '')
    if (!/^https?:\/\//.test(clean)) return false
    const wasOnline = get().status === 'online'
    const res = await probeCandidate(clean, 2500, true)
    if (res.state === 'connected') {
      setApiBase(clean)
      set({
        state: 'connected',
        status: 'online',
        connected: true,
        base: clean,
        health: res.health || null,
        failingAddress: null,
        blockedOrigin: null,
        lastCheckedAt: Date.now(),
        attempts: 0,
      })
      try { sessionStorage.setItem('nexmind.serverSeen', '1') } catch {}
      try { localStorage.setItem('nexmind.serverSeen', '1') } catch {}
      if (!wasOnline && res.health) {
        notifyJustConnected({ base: clean, health: res.health })
      }
      return true
    }
    set({
      state: res.state,
      status: 'offline',
      connected: false,
      health: null,
      failingAddress: clean,
      blockedOrigin: res.origin || null,
      lastCheckedAt: Date.now(),
      attempts: get().attempts + 1,
    })
    return false
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
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return
    }
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
