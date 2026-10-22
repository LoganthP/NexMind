import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectWorkspaceSocket } from '@/lib/socket'

/** The workspace "socket" is an event feed + job runner over plain HTTP (works on Vercel). */
type Call = { url: string; init?: RequestInit }

function ndjson(lines: object[]): Response {
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  return new Response(text, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } })
}

describe('connectWorkspaceSocket (event feed)', () => {
  let calls: Call[]
  beforeEach(() => {
    calls = []
    vi.useRealTimers()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('sends hello first, skips old events, runs the pending job and replays the finished graph', async () => {
    let feedCount = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.includes('/events')) {
        feedCount += 1
        if (feedCount === 1) {
          return new Response(JSON.stringify({ events: [{ seq: 3, type: 'job_done' }], seq: 3, status: 'building', pending_job: { id: 'job_1', status: 'queued' }, running_job: null }))
        }
        return new Response(JSON.stringify({ events: [], seq: 6, status: 'ready', pending_job: null, running_job: null }))
      }
      if (url.includes('/jobs/job_1/run')) {
        return ndjson([{ seq: 4, type: 'job_started' }, { seq: 0, type: 'progress', percent: 50, phase: 'parse', message: 'Reading' }, { seq: 5, type: 'job_done', stats: { nodes: 2 } }])
      }
      if (url.includes('/graph')) {
        return new Response(JSON.stringify({ nodes: [{ id: 'a', score: 1 }, { id: 'b', score: 0.5 }], links: [{ id: 'e', source: 'a', target: 'b' }], clusters: [], truncated: false, total_nodes: 2, total_edges: 1, status: 'ready', legend: { node_colors: {}, edge_colors: {} } }))
      }
      return new Response('{}', { status: 404 })
    }))
    const events: { type: string }[] = []
    const states: boolean[] = []
    const sock = connectWorkspaceSocket('ws_1', (e) => events.push(e as { type: string }), (c) => states.push(c))
    await vi.waitFor(() => expect(events.some((e) => e.type === 'job_done')).toBe(true), { timeout: 4000 })
    sock.close()
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('hello')
    expect(types.filter((t) => t === 'job_done')).toHaveLength(1) // the old seq 3 job_done was not replayed
    expect(types).toContain('progress')
    const ready = types.indexOf('graph_ready')
    expect(types.indexOf('graph_stream_start')).toBeLessThan(ready)
    expect(ready).toBeLessThan(types.lastIndexOf('job_done'))
    expect(states[0]).toBe(true)
    const runCall = calls.find((c) => c.url.includes('/run'))!
    expect((runCall.init!.headers as Record<string, string>)['X-NexMind-Key']).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
  })

  it('reports disconnection and backs off when the server is unreachable, without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const states: boolean[] = []
    const sock = connectWorkspaceSocket('ws_2', () => {}, (c) => states.push(c))
    await vi.waitFor(() => expect(states).toContain(false), { timeout: 2000 })
    sock.close()
  })

  it('a 409 from the job runner (someone else builds it) is harmless', async () => {
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/events')) {
        n += 1
        return new Response(JSON.stringify({ events: [], seq: 1, status: 'building', pending_job: n === 1 ? { id: 'job_9', status: 'running' } : null, running_job: null }))
      }
      if (url.includes('/run')) return new Response(JSON.stringify({ detail: 'Job is running' }), { status: 409 })
      return new Response('{}')
    }))
    const events: { type: string }[] = []
    const sock = connectWorkspaceSocket('ws_3', (e) => events.push(e as { type: string }))
    await vi.waitFor(() => expect(n).toBeGreaterThan(1), { timeout: 4000 })
    sock.close()
    expect(events[0].type).toBe('hello')
  })
})
