import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/three/engine', () => {
  class BrainEngine {
    constructor() {
      return new Proxy(this, { get: (_t, k: string) => (k === 'then' ? undefined : () => undefined) })
    }
  }
  return { BrainEngine, NODE_COLORS: {}, EDGE_COLORS: {}, BG: '#000' }
})

import App from '@/App'
import { useServer } from '@/lib/server'
import { useView } from '@/lib/store'

const originalFetch = globalThis.fetch

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  useView.getState().reset()
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('startup-flow bug fixes', () => {
  it('a) healthy server renders dashboard immediately without ConnectGate or 1s delay', async () => {
    localStorage.setItem('nexmind.api', 'http://127.0.0.1:8000')
    useServer.setState({ status: 'checking', health: null, attempts: 0, base: 'http://127.0.0.1:8000' })

    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/health')) {
        return new Response(JSON.stringify({
          app: 'nexmind',
          status: 'ok',
          version: '1.1.0',
          llm: { provider: 'mock', model: null, available: true }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/api/workspaces')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    let sawStartCommands = false
    const observer = new MutationObserver(() => {
      if (document.body.textContent?.includes('Start your local server')) {
        sawStartCommands = true
      }
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })

    const start = Date.now()
    render(<MemoryRouter initialEntries={['/app']}><App /></MemoryRouter>)

    const heading = await screen.findByRole('heading', { name: /Create your first workspace|^Workspaces$/i })
    const elapsed = Date.now() - start
    expect(heading).toBeTruthy()
    // Old behaviour waited 1100 ms before releasing; new behaviour releases immediately
    expect(elapsed).toBeLessThan(2500)

    // Poll every 50 ms for 2 s to assert "Start your local server" is NEVER in the document
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      if (document.body.textContent?.includes('Start your local server')) {
        sawStartCommands = true
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    observer.disconnect()

    expect(sawStartCommands).toBe(false)
  })

  it('b) unreachable server shows commands gate only after ~1.5s, shows Connected when server answers, and releases', async () => {
    localStorage.setItem('nexmind.api', 'http://127.0.0.1:59999')
    useServer.setState({ status: 'checking', health: null, attempts: 0, base: 'http://127.0.0.1:59999' })

    let serverOnline = false
    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/health')) {
        if (!serverOnline) throw new Error('Unreachable')
        return new Response(JSON.stringify({
          app: 'nexmind',
          status: 'ok',
          version: '1.1.0',
          llm: { provider: 'mock', model: null, available: true }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/api/workspaces')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    const start = Date.now()
    render(<MemoryRouter initialEntries={['/app']}><App /></MemoryRouter>)

    // At 1.1s, the gate should not be visible yet
    await new Promise((r) => setTimeout(r, 1100))
    expect(screen.queryByRole('heading', { name: /Start your local server/i })).toBeNull()

    // Gate appears after ~1.5s
    const gate = await screen.findByRole('heading', { name: /Start your local server/i }, { timeout: 4000 })
    const delay = Date.now() - start
    expect(gate).toBeTruthy()
    expect(delay).toBeGreaterThanOrEqual(1300)

    // Now bring server online
    serverOnline = true
    await act(async () => {
      await useServer.getState().check()
    })

    // Gate displays Connected confirmation
    expect(await screen.findByText(/Connected to NexMind/i, {}, { timeout: 4000 })).toBeTruthy()

    // Releases to dashboard
    expect(await screen.findByRole('heading', { name: /Create your first workspace|^Workspaces$/i }, { timeout: 4000 })).toBeTruthy()
  })

  it('c) ready workspace with stats.nodes 654 shows Loading 654 nodes, never flashes empty state or Repository URL, then becomes ready', async () => {
    sessionStorage.setItem('nexmind.serverSeen', '1')
    useServer.setState({
      status: 'online',
      base: 'http://127.0.0.1:8000',
      health: { app: 'nexmind', status: 'ok', version: '1.1.0', llm: { provider: 'mock', model: null, available: true } },
    })

    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/health')) {
        return new Response(JSON.stringify({
          app: 'nexmind',
          status: 'ok',
          version: '1.1.0',
          llm: { provider: 'mock', model: null, available: true }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/api/workspaces/ws-654/threads')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/api/workspaces/ws-654/graph')) {
        await new Promise((r) => setTimeout(r, 2000))
        return new Response(JSON.stringify({
          nodes: [{ id: 'n1', type: 'File', label: 'index.ts', x: 0, y: 0, z: 0, cluster: 1, score: 1 }],
          links: [],
          clusters: [],
          truncated: false,
          total_nodes: 654,
          total_edges: 0,
          status: 'ready',
          legend: { node_colors: {}, edge_colors: {} }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/api/workspaces/ws-654')) {
        return new Response(JSON.stringify({
          id: 'ws-654',
          name: 'Project 654',
          description: '',
          status: 'ready',
          source_count: 1,
          thread_count: 0,
          kind: 'code',
          created_at: Date.now(),
          updated_at: Date.now(),
          stats: { nodes: 654 }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    let sawForbiddenText = false
    const observer = new MutationObserver(() => {
      const text = document.body.textContent ?? ''
      if (text.includes('This workspace is empty') || text.includes('Repository URL')) {
        sawForbiddenText = true
      }
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })

    render(<MemoryRouter initialEntries={['/app/w/ws-654']}><App /></MemoryRouter>)

    // "Loading 654 nodes" is shown first
    expect(await screen.findByText(/Loading 654 nodes/i)).toBeTruthy()

    // Wait for the 2s delayed graph response
    await waitFor(() => {
      expect(useView.getState().nodes.length).toBeGreaterThan(0)
    }, { timeout: 4000 })

    // Graph state becomes ready: loading indicator is gone
    expect(screen.queryByText(/Loading 654 nodes/i)).toBeNull()

    observer.disconnect()
    expect(sawForbiddenText).toBe(false)
  })

  it('d) ready workspace with 0 nodes and source_count 1 shows "Nothing could be analyzed" message with Re-index and Add a source buttons without import form', async () => {
    sessionStorage.setItem('nexmind.serverSeen', '1')
    useServer.setState({
      status: 'online',
      base: 'http://127.0.0.1:8000',
      health: { app: 'nexmind', status: 'ok', version: '1.1.0', llm: { provider: 'mock', model: null, available: true } },
    })

    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/health')) {
        return new Response(JSON.stringify({
          app: 'nexmind',
          status: 'ok',
          version: '1.1.0',
          llm: { provider: 'mock', model: null, available: true }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/api/workspaces/ws-empty/threads')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/api/workspaces/ws-empty/graph')) {
        return new Response(JSON.stringify({
          nodes: [],
          links: [],
          clusters: [],
          truncated: false,
          total_nodes: 0,
          total_edges: 0,
          status: 'ready',
          legend: { node_colors: {}, edge_colors: {} }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/api/workspaces/ws-empty')) {
        return new Response(JSON.stringify({
          id: 'ws-empty',
          name: 'Empty Workspace',
          description: '',
          status: 'ready',
          source_count: 1,
          thread_count: 0,
          kind: 'code',
          created_at: Date.now(),
          updated_at: Date.now(),
          stats: { nodes: 0 }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    render(<MemoryRouter initialEntries={['/app/w/ws-empty']}><App /></MemoryRouter>)

    // Assert the two buttons appear
    const message = await screen.findByText(/Nothing could be analyzed from this source/i)
    expect(message).toBeTruthy()
    const card = message.closest('.glass') as HTMLElement
    expect(card).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Re-index$/i })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^Add a source$/i }).length).toBeGreaterThanOrEqual(2)

    // Assert no GitHub/Local folder form or "Repository URL" is present
    expect(screen.queryByText(/Repository URL/i)).toBeNull()
    expect(screen.queryByRole('tab', { name: /GitHub/i })).toBeNull()
    expect(screen.queryByRole('tab', { name: /Local folder/i })).toBeNull()
    expect(screen.queryByRole('heading', { name: /This workspace is empty/i })).toBeNull()
  })
})
