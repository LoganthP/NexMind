import { supportsTargetAddressSpace } from './server'

export interface LocalServerResult {
  running: boolean
  port: number | null
  url: string | null
}

/**
 * Probe local NexMind server at 127.0.0.1:8000 then 8001 with 1.5s timeout.
 * Used from the hosted page when the user opens Local folder or Live connect.
 */
export async function probeLocalServer(isUserGesture = false): Promise<LocalServerResult> {
  const ports = [8000, 8001]
  const timeoutMs = 1500

  for (const port of ports) {
    const url = `http://127.0.0.1:${port}`
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    const opts: RequestInit & { targetAddressSpace?: string } = {
      method: 'GET',
      signal: ctl.signal,
    }
    if (isUserGesture && supportsTargetAddressSpace()) {
      try {
        opts.targetAddressSpace = 'local'
      } catch {}
    }

    try {
      const res = await fetch(`${url}/api/ping`, opts)
      clearTimeout(timer)
      if (res.ok) {
        const j = await res.json()
        if (j && j.app === 'nexmind') {
          return { running: true, port, url }
        }
      }
    } catch {
      clearTimeout(timer)
    }
  }

  return { running: false, port: null, url: null }
}
