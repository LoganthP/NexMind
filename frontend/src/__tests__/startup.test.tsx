import { render, screen, cleanup, waitFor, act, fireEvent, within } from '@testing-library/react'
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
import '@/pages/AppShell'
import '@/pages/Hub'
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

describe('startup-flow bug fixes and mode-first server-second flow', () => {
  it('a) Server unreachable: rendering /app shows the three mode cards within 500 ms; "Start your local server" is NOT on screen; header shows "Server not connected"', async () => {
    localStorage.setItem('nexmind.api', 'http://127.0.0.1:59999')
    useServer.setState({ status: 'checking', connected: false, health: null, attempts: 0, base: 'http://127.0.0.1:59999' })

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Unreachable server'))

    const start = Date.now()
    render(
      <MemoryRouter initialEntries={['/app']}>
        <App />
      </MemoryRouter>
    )

    // Shows the three mode cards within 500 ms
    const heading = await screen.findByRole('heading', { name: /Create your first workspace/i }, { timeout: 500 })
    const elapsed = Date.now() - start
    expect(heading).toBeTruthy()
    expect(elapsed).toBeLessThan(1000)

    expect(screen.getByText('Analyze a project')).toBeTruthy()
    expect(screen.getByText('Study from documents')).toBeTruthy()
    expect(screen.getByText('Live connect')).toBeTruthy()

    // The text "Start your local server" is NOT on the screen
    expect(screen.queryByRole('heading', { name: /Start your local server/i })).toBeNull()
    expect(document.body.textContent).not.toContain('Start your local server')

    // The header shows "Server not connected"
    expect(screen.getByText(/Server not connected/i)).toBeTruthy()
  })

  it('b) Clicking "Analyze a project" with the server offline opens dialog on Connect step with Projects chip, numbered steps, no "connect.py", and no "&&"', async () => {
    localStorage.setItem('nexmind.api', 'http://127.0.0.1:59999')
    useServer.setState({ status: 'offline', connected: false, health: null, attempts: 1, base: 'http://127.0.0.1:59999' })

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Unreachable server'))

    render(
      <MemoryRouter initialEntries={['/app']}>
        <App />
      </MemoryRouter>
    )

    await screen.findByText('Analyze a project')
    fireEvent.click(screen.getByText('Analyze a project'))

    // Dialog opens on Connect step
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/Step 1 of 2: connect the NexMind server on this computer/i)).toBeTruthy()

    // With the Projects chip
    const chips = within(dialog).getAllByText('Projects')
    expect(chips.length).toBeGreaterThan(0)

    // Shows the numbered steps
    expect(within(dialog).getByText(/Get NexMind/i)).toBeTruthy()
    expect(within(dialog).getByText(/Start the server/i)).toBeTruthy()
    expect(within(dialog).getByText(/This page continues by itself/i)).toBeTruthy()

    // No "connect.py" text
    expect(dialog.textContent).not.toContain('connect.py')

    // No copied command contains "&&"
    expect(dialog.textContent).not.toContain('&&')
  })

  it('c) When mocked server becomes reachable, dialog shows "Connected" and advances to form without another click (Projects, Documents, Live connect)', async () => {
    const mockHealthyFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
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

    // 1. Projects ('code')
    {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Unreachable server'))
      useServer.setState({ status: 'offline', connected: false, health: null, attempts: 1, base: 'http://127.0.0.1:8000' })
      const { unmount } = render(
        <MemoryRouter initialEntries={['/app']}>
          <App />
        </MemoryRouter>
      )

      await screen.findByText('Analyze a project')
      fireEvent.click(screen.getByText('Analyze a project'))
      expect(await screen.findByText(/Step 1 of 2: connect the NexMind server/i)).toBeTruthy()

      // Mocked server becomes reachable
      globalThis.fetch = mockHealthyFetch
      await act(async () => {
        await useServer.getState().check()
      })

      // Shows "Connected"
      expect(await screen.findByText(/Connected to NexMind/i)).toBeTruthy()

      // Automatically advances to Projects form without another click
      expect(await screen.findByRole('tab', { name: 'GitHub' }, { timeout: 3000 })).toBeTruthy()
      unmount()
    }

    // 2. Documents ('docs')
    {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Unreachable server'))
      useServer.setState({ status: 'offline', connected: false, health: null, attempts: 1, base: 'http://127.0.0.1:8000' })
      const { unmount } = render(
        <MemoryRouter initialEntries={['/app']}>
          <App />
        </MemoryRouter>
      )

      await screen.findByText('Study from documents')
      fireEvent.click(screen.getByText('Study from documents'))
      expect(await screen.findByText(/Step 1 of 2: connect the NexMind server/i)).toBeTruthy()

      globalThis.fetch = mockHealthyFetch
      await act(async () => {
        await useServer.getState().check()
      })

      expect(await screen.findByText(/Connected to NexMind/i)).toBeTruthy()
      expect(await screen.findByText(/Drop PDFs, Word files/i, {}, { timeout: 3000 })).toBeTruthy()
      unmount()
    }

    // 3. Live connect ('live')
    {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Unreachable server'))
      useServer.setState({ status: 'offline', connected: false, health: null, attempts: 1, base: 'http://127.0.0.1:8000' })
      const { unmount } = render(
        <MemoryRouter initialEntries={['/app']}>
          <App />
        </MemoryRouter>
      )

      await screen.findByText('Live connect')
      fireEvent.click(screen.getByText('Live connect'))
      expect(await screen.findByText(/Step 1 of 2: connect the NexMind server/i)).toBeTruthy()

      globalThis.fetch = mockHealthyFetch
      await act(async () => {
        await useServer.getState().check()
      })

      expect(await screen.findByText(/Connected to NexMind/i)).toBeTruthy()
      expect(await screen.findByText(/Waiting for your project/i, {}, { timeout: 3000 })).toBeTruthy()
      unmount()
    }
  })

  it('d) Server reachable from the start: clicking a card goes straight to mode form; "+ New workspace" shows mode chooser first', async () => {
    useServer.setState({
      status: 'online',
      connected: true,
      justConnected: Date.now(),
      base: 'http://127.0.0.1:8000',
      health: { app: 'nexmind', status: 'ok', version: '1.1.0', llm: { provider: 'mock', model: null, available: true } },
    })

    // 0 workspaces -> first-run 3-card screen
    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/workspaces')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    const { unmount } = render(
      <MemoryRouter initialEntries={['/app']}>
        <App />
      </MemoryRouter>
    )

    await screen.findByText('Analyze a project')
    fireEvent.click(screen.getByText('Analyze a project'))

    // Goes straight to Projects form (no connect step)
    expect(screen.queryByText(/Step 1 of 2: connect the NexMind server/i)).toBeNull()
    expect(screen.getByRole('tab', { name: 'GitHub' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Local folder' })).toBeTruthy()
    unmount()

    // Render with an existing workspace
    const sampleWorkspace = {
      id: 'ws-sample-1',
      name: 'Existing Project',
      description: '',
      kind: 'code',
      status: 'ready',
      created_at: 100,
      updated_at: 100,
      source_count: 1,
      thread_count: 0,
      stats: { nodes: 10, edges: 12, files: 5 },
    }

    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/workspaces')) {
        return new Response(JSON.stringify([sampleWorkspace]), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    render(
      <MemoryRouter initialEntries={['/app']}>
        <App />
      </MemoryRouter>
    )

    expect(await screen.findByText('Existing Project')).toBeTruthy()

    // Click "+ New workspace"
    fireEvent.click(screen.getByRole('button', { name: /^New workspace$/i }))

    // Shows mode chooser first
    expect(screen.getByText('What do you want to explore?')).toBeTruthy()
    expect(screen.getByText('Projects')).toBeTruthy()
    expect(screen.getByText('Documents')).toBeTruthy()
    expect(screen.getByText('Live connect')).toBeTruthy()
  })

  it('e) Deep link /app/w/abc with server unreachable shows full-page gate with a "Back to modes" link to /app', async () => {
    localStorage.setItem('nexmind.api', 'http://127.0.0.1:59999')
    useServer.setState({ status: 'offline', connected: false, health: null, attempts: 1, base: 'http://127.0.0.1:59999' })

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Unreachable server'))

    render(
      <MemoryRouter initialEntries={['/app/w/abc']}>
        <App />
      </MemoryRouter>
    )

    // Shows full-page gate
    expect(await screen.findByRole('heading', { name: /Start your local server/i })).toBeTruthy()

    // Has "Back to modes" link that points to /app
    const backLink = screen.getByRole('link', { name: /Back to modes/i })
    expect(backLink).toBeTruthy()
    expect(backLink.getAttribute('href')).toBe('/app')

    // Clicking "Back to modes" returns to /app
    fireEvent.click(backLink)
    expect(await screen.findByRole('heading', { name: /Create your first workspace/i })).toBeTruthy()
  })

  it('f) A previously connected session that loses the server keeps the current page and shows reconnecting banner', async () => {
    sessionStorage.setItem('nexmind.serverSeen', '1')
    useServer.setState({
      status: 'online',
      connected: true,
      justConnected: Date.now(),
      base: 'http://127.0.0.1:8000',
      health: { app: 'nexmind', status: 'ok', version: '1.1.0', llm: { provider: 'mock', model: null, available: true } },
    })

    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/workspaces/ws-live/threads')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/api/workspaces/ws-live/graph')) {
        return new Response(JSON.stringify({
          nodes: [{ id: 'n1', type: 'File', label: 'index.ts', x: 0, y: 0, z: 0, cluster: 1, score: 1 }],
          links: [],
          clusters: [],
          truncated: false,
          total_nodes: 1,
          total_edges: 0,
          status: 'ready',
          legend: { node_colors: {}, edge_colors: {} },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/api/workspaces/ws-live')) {
        return new Response(JSON.stringify({
          id: 'ws-live',
          name: 'Connected Workspace',
          description: '',
          status: 'ready',
          source_count: 1,
          thread_count: 0,
          kind: 'code',
          created_at: Date.now(),
          updated_at: Date.now(),
          stats: { nodes: 1 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    render(
      <MemoryRouter initialEntries={['/app/w/ws-live']}>
        <App />
      </MemoryRouter>
    )

    // Current workspace page renders
    expect(await screen.findByText(/Connected Workspace/i)).toBeTruthy()

    // Server goes offline
    await act(async () => {
      useServer.setState({ status: 'offline', connected: false })
    })

    // Stays on current page: does NOT swap to ConnectGate ("Start your local server")
    expect(screen.queryByRole('heading', { name: /Start your local server/i })).toBeNull()
    expect(screen.getByText(/Connected Workspace/i)).toBeTruthy()

    // Shows reconnecting banner
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText(/Lost connection to the NexMind server — reconnecting…/i)).toBeTruthy()
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
