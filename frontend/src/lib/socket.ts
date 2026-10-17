import { wsBase } from './api'
import type { WsEvent } from './types'

export interface WorkspaceSocket {
  send: (msg: object) => void
  close: () => void
}

/** WebSocket with automatic reconnect (exponential backoff). Never throws. */
export function connectWorkspaceSocket(wsId: string, onEvent: (e: WsEvent) => void, onState?: (connected: boolean) => void): WorkspaceSocket {
  let sock: WebSocket | null = null
  let closed = false
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let ping: ReturnType<typeof setInterval> | undefined

  const open = () => {
    if (closed) return
    try {
      sock = new WebSocket(`${wsBase()}/ws/workspaces/${wsId}`)
    } catch {
      schedule()
      return
    }
    sock.onopen = () => {
      attempt = 0
      onState?.(true)
      ping = setInterval(() => { try { sock?.send(JSON.stringify({ type: 'ping' })) } catch { /* ignore */ } }, 25000)
    }
    sock.onmessage = (m) => {
      try { onEvent(JSON.parse(m.data) as WsEvent) } catch { /* ignore malformed */ }
    }
    sock.onclose = () => {
      clearInterval(ping)
      onState?.(false)
      schedule()
    }
    sock.onerror = () => { try { sock?.close() } catch { /* ignore */ } }
  }
  const schedule = () => {
    if (closed) return
    attempt += 1
    timer = setTimeout(open, Math.min(8000, 400 * 2 ** attempt))
  }
  open()
  return {
    send: (msg) => { try { if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg)) } catch { /* ignore */ } },
    close: () => { closed = true; clearTimeout(timer); clearInterval(ping); try { sock?.close() } catch { /* ignore */ } },
  }
}
