import { create } from 'zustand'
import { DEFAULT_API, getApiBase, sameOriginBase, setApiBase } from './api'
import type { Health } from './types'

export type ConnectionState =
  | 'connected'
  | 'not-running'
  | 'blocked-browser'
  | 'blocked-origin'
  | 'outdated'
  | 'other-app'
  | 'setup-needed'
  | 'backend-error'
  | 'unreachable'

export interface ServerState {
  state: ConnectionState
  status: 'checking' | 'offline' | 'online'
  connected: boolean
  base: string
  failingAddress: string | null
  lastCheckedAt: number | null
  blockedOrigin: string | null
  health: Health | null
  setupRequired: string | null
  backendError: { status: number; reason: string } | null
  localPaths: boolean
  attempts: number
  check: (timeoutMsOrGesture?: number | boolean, isUserGesture?: boolean) => Promise<boolean>
  useBase: (url: string) => Promise<boolean>
}

export interface ProbeResult {
  state: ConnectionState
  base: string
  health?: Health | null
  origin?: string | null
  setupRequired?: string | null
  backendError?: { status: number; reason: string } | null
}

const LAST_HEALTH_KEY = 'nexmind.lastHealth'

export function getCachedHealth(): Health | null {
  try {
    if (typeof sessionStorage !== 'undefined') {
      const raw = sessionStorage.getItem(LAST_HEALTH_KEY)
      if (raw) return JSON.parse(raw)
    }
  } catch {}
  return null
}

export function setCachedHealth(h: Health | null): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      if (h) sessionStorage.setItem(LAST_HEALTH_KEY, JSON.stringify(h))
      else sessionStorage.removeItem(LAST_HEALTH_KEY)
    }
  } catch {}
}

export function isHostedEnvironment(): boolean {
  if (typeof window === 'undefined' || !window.location) return false
  const same = sameOriginBase()
  if (!same) return false
  try {
    const u = new URL(same, window.location.href)
    const host = u.hostname.toLowerCase()
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1'
    return window.location.protocol === 'https:' && !isLocal
  } catch {
    return false
  }
}

export function isLocalPathsSupported(st?: ServerState | null): boolean {
  if (isHostedEnvironment()) return false
  const s = st || (typeof useServer !== 'undefined' ? useServer.getState() : null)
  const h = s?.health || getCachedHealth()
  if (h?.capabilities?.local_paths !== undefined) {
    return Boolean(h.capabilities.local_paths)
  }
  return true
}

import { beginActivity, endActivity, isActivityInProgress } from './activity'
export { beginActivity, endActivity, isActivityInProgress }

let consecutiveFailures = 0
let firstFailureTime: number | null = null

export function resetFailureTracking(): void {
  consecutiveFailures = 0
  firstFailureTime = null
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

export function isSameOrigin(url: string): boolean {
  if (typeof window === 'undefined' || !window.location) return false
  try {
    const parsed = new URL(url, window.location.href)
    if (parsed.origin.toLowerCase() !== window.location.origin.toLowerCase()) {
      return false
    }
    const host = parsed.hostname.toLowerCase()
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1'
    return !isLocal || isHostedEnvironment()
  } catch {
    return false
  }
}

export function getProbeCandidates(): string[] {
  const saved = getApiBase()
  const same = sameOriginBase()
  if (isHostedEnvironment()) {
    const list = [same, saved].filter(Boolean) as string[]
    return Array.from(new Set(list.map((u) => u.replace(/\/+$/, ''))))
  }
  const defaults = [
    ...(same ? [same] : []),
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
  isUserGesture = false
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

  const isSame = isSameOrigin(cleanBase)

  const extractShortReason = async (res: Response): Promise<string> => {
    let shortReason = res.statusText || 'Server Error'
    try {
      const text = await res.text()
      try {
        const j = JSON.parse(text)
        if (typeof j.detail === 'string') return j.detail
      } catch {
        const match = text.match(/<title>([^<]+)<\/title>/i)
        if (match && match[1]) return match[1].trim()
      }
    } catch {}
    return shortReason
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
    // For same-origin (hosted site): never classify failure as browser blocking
    if (isSame) {
      return { state: 'unreachable', base: cleanBase }
    }
    // b) For local server: try fetch(<base>/api/ping, { mode: 'no-cors' })
    return await tryNoCors('/api/ping')
  }

  // If 5xx on ping for same-origin
  if (pingRes.status >= 500 && isSame) {
    const reason = await extractShortReason(pingRes)
    return {
      state: 'backend-error',
      base: cleanBase,
      backendError: { status: pingRes.status, reason },
    }
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
          if (isSame) {
            return {
              state: 'backend-error',
              base: cleanBase,
              backendError: { status: healthRes.status, reason: 'Invalid JSON' },
            }
          }
          return { state: 'other-app', base: cleanBase }
        }
        if (h && h.app === 'nexmind') {
          if (h.setup_required && isSame) {
            return {
              state: 'setup-needed',
              base: cleanBase,
              health: h,
              setupRequired: h.setup_required,
            }
          }
          if (!h.capabilities) {
            return { state: 'outdated', health: h, base: cleanBase }
          }
          return { state: 'connected', health: h, base: cleanBase }
        }
        return { state: 'other-app', base: cleanBase }
      } else {
        if (isSame) {
          const reason = await extractShortReason(healthRes)
          return {
            state: 'backend-error',
            base: cleanBase,
            backendError: { status: healthRes.status, reason },
          }
        }
        return await tryNoCors('/api/health')
      }
    } catch {
      if (isSame) {
        return { state: 'unreachable', base: cleanBase }
      }
      return await tryNoCors('/api/health')
    }
  }

  // If response status is not ok
  if (!pingRes.ok) {
    if (isSame) {
      const reason = await extractShortReason(pingRes)
      return {
        state: 'backend-error',
        base: cleanBase,
        backendError: { status: pingRes.status, reason },
      }
    }
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
    if (isSame) {
      return {
        state: 'backend-error',
        base: cleanBase,
        backendError: { status: pingRes.status, reason: 'Invalid JSON' },
      }
    }
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
      let h: any = null
      try {
        h = await healthRes.json()
      } catch {
        if (isSame) {
          return {
            state: 'backend-error',
            base: cleanBase,
            backendError: { status: healthRes.status, reason: 'Invalid JSON' },
          }
        }
        return { state: 'other-app', base: cleanBase }
      }
      if (h && h.app === 'nexmind') {
        if (h.setup_required && isSame) {
          return {
            state: 'setup-needed',
            base: cleanBase,
            health: h,
            setupRequired: h.setup_required,
          }
        }
        return { state: 'connected', health: h, base: cleanBase }
      }
      return { state: 'other-app', base: cleanBase }
    }
    if (isSame) {
      const reason = await extractShortReason(healthRes)
      return {
        state: 'backend-error',
        base: cleanBase,
        backendError: { status: healthRes.status, reason },
      }
    }
    return { state: 'outdated', base: cleanBase }
  } catch {
    if (isSame) {
      return { state: 'unreachable', base: cleanBase }
    }
    return { state: 'outdated', base: cleanBase }
  }
}

let inFlight: Promise<boolean> | null = null
let isFirstProbe = true

export const useServer = create<ServerState>((set, get) => {
  const initialHealth = getCachedHealth()
  return {
    state: 'not-running',
    status: 'checking',
    connected: false,
    base: getApiBase(),
    failingAddress: null,
    lastCheckedAt: null,
    blockedOrigin: null,
    health: initialHealth,
    setupRequired: null,
    backendError: null,
    localPaths: isHostedEnvironment() ? false : (initialHealth?.capabilities?.local_paths ?? true),
    attempts: 0,
    check: async (timeoutMsOrGesture?: number | boolean, isUserGesture?: boolean) => {
      const defaultTimeout = isHostedEnvironment() ? 5000 : (isFirstProbe ? 1200 : 2500)
      let probeTimeout = defaultTimeout
      let userGesture = false

      if (typeof timeoutMsOrGesture === 'boolean') {
        userGesture = timeoutMsOrGesture
        probeTimeout = defaultTimeout
      } else if (typeof timeoutMsOrGesture === 'number') {
        probeTimeout = timeoutMsOrGesture
        userGesture = Boolean(isUserGesture)
      } else {
        probeTimeout = defaultTimeout
        userGesture = Boolean(isUserGesture)
      }
      isFirstProbe = false

      if (isActivityInProgress() && !userGesture) {
        return true
      }

      if (inFlight && !userGesture) return inFlight

      const run = async (): Promise<boolean> => {
        try {
          const wasOnline = get().status === 'online' || get().connected
          const candidates = getProbeCandidates()
          const failures: ProbeResult[] = []

          for (const base of candidates) {
            const res = await probeCandidate(base, probeTimeout, userGesture)
            if (res.state === 'connected') {
              resetFailureTracking()
              setCachedHealth(res.health || null)
              setApiBase(res.base)
              set({
                state: 'connected',
                status: 'online',
                connected: true,
                base: res.base,
                health: res.health || null,
                setupRequired: null,
                backendError: null,
                localPaths: isLocalPathsSupported({ health: res.health } as any),
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
            'setup-needed': 1,
            'backend-error': 2,
            'unreachable': 3,
            'blocked-origin': 4,
            'blocked-browser': 5,
            'outdated': 6,
            'other-app': 7,
            'not-running': 8,
            'connected': 9,
          }
          failures.sort((a, b) => failurePriority[a.state] - failurePriority[b.state])
          const best = failures[0] || { state: 'not-running', base: candidates[0] || DEFAULT_API }

          const now = Date.now()
          consecutiveFailures++
          if (firstFailureTime === null) {
            firstFailureTime = now
          }
          const failureSpan = now - firstFailureTime

          const shouldDebounceOffline =
            wasOnline &&
            (best.state === 'not-running' || best.state === 'unreachable') &&
            !userGesture &&
            (isHostedEnvironment() || isActivityInProgress())

          if (shouldDebounceOffline && (consecutiveFailures < 3 || failureSpan < 6000)) {
            // Under threshold: preserve connected/online status
            set({
              attempts: get().attempts + 1,
              lastCheckedAt: now,
            })
            return false
          }

          set({
            state: best.state,
            status: 'offline',
            connected: false,
            health: best.health || null,
            setupRequired: best.setupRequired || null,
            backendError: best.backendError || null,
            localPaths: isLocalPathsSupported({ health: null } as any),
            failingAddress: best.base,
            blockedOrigin: best.origin || null,
            lastCheckedAt: now,
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
      const wasOnline = get().status === 'online' || get().connected
      const res = await probeCandidate(clean, 2500, true)
      if (res.state === 'connected') {
        resetFailureTracking()
        setCachedHealth(res.health || null)
        setApiBase(clean)
        set({
          state: 'connected',
          status: 'online',
          connected: true,
          base: clean,
          health: res.health || null,
          setupRequired: null,
          backendError: null,
          localPaths: isLocalPathsSupported({ health: res.health } as any),
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
        health: res.health || null,
        setupRequired: res.setupRequired || null,
        backendError: res.backendError || null,
        localPaths: isLocalPathsSupported({ health: null } as any),
        failingAddress: clean,
        blockedOrigin: res.origin || null,
        lastCheckedAt: Date.now(),
        attempts: get().attempts + 1,
      })
      return false
    },
  }
})

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
    if (isActivityInProgress()) {
      scheduleNext(2000)
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
