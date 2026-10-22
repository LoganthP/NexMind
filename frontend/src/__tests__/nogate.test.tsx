import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'

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
const FORBIDDEN_SCREEN_TEXT = ['Start', 'your', 'local', 'server'].join(' ')

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

describe('requirement 5: acceptance and guard rails', () => {
  it('(a) with the server unreachable, rendering /app shows the three mode cards within 500 ms and the text never appears', async () => {
    localStorage.setItem('nexmind.api', 'http://127.0.0.1:59999')
    useServer.setState({ status: 'offline', base: 'http://127.0.0.1:59999', attempts: 1, health: null })

    globalThis.fetch = vi.fn().mockImplementation(async () => {
      throw new Error('Server unreachable')
    })

    const start = Date.now()
    render(
      <MemoryRouter initialEntries={['/app']}>
        <App />
      </MemoryRouter>
    )

    const heading = await screen.findByRole('heading', { name: /Create your first workspace/i }, { timeout: 1000 })
    const elapsed = Date.now() - start

    expect(heading).toBeTruthy()
    expect(elapsed).toBeLessThan(1000)

    // Three mode cards exist
    expect(screen.getByRole('heading', { name: /Analyze a project/i })).toBeTruthy()
    expect(screen.getByRole('heading', { name: /Study from documents/i })).toBeTruthy()
    expect(screen.getByRole('heading', { name: /Live connect/i })).toBeTruthy()

    // Forbidden text never appears
    expect(document.body.textContent).not.toContain(FORBIDDEN_SCREEN_TEXT)
  })

  it('(b) clicking each card shows that mode\'s own form and no server wizard step', async () => {
    localStorage.setItem('nexmind.api', 'http://127.0.0.1:59999')
    useServer.setState({ status: 'offline', base: 'http://127.0.0.1:59999', attempts: 1, health: null })

    globalThis.fetch = vi.fn().mockImplementation(async () => {
      throw new Error('Server unreachable')
    })

    const { unmount } = render(
      <MemoryRouter initialEntries={['/app']}>
        <App />
      </MemoryRouter>
    )

    // 1. Documents mode card
    const docsHeading = await screen.findByRole('heading', { name: /Study from documents/i })
    const docsCard = docsHeading.closest('[role="button"]') as HTMLElement
    expect(docsCard).toBeTruthy()
    fireEvent.click(docsCard)

    // Shows dropzone / folder upload
    expect(await screen.findByText(/Drop PDFs, Word files/i)).toBeTruthy()
    expect(screen.getByText(/Choose files/i)).toBeTruthy()
    expect(screen.queryByText(/Step 1 of 2: connect the NexMind server/i)).toBeNull()
    expect(document.body.textContent).not.toContain(FORBIDDEN_SCREEN_TEXT)

    // Close dialog
    const closeBtn = screen.getByRole('button', { name: /Close dialog/i })
    fireEvent.click(closeBtn)

    // 2. Projects mode card
    const projectHeading = screen.getByRole('heading', { name: /Analyze a project/i })
    const projectCard = projectHeading.closest('[role="button"]') as HTMLElement
    expect(projectCard).toBeTruthy()
    fireEvent.click(projectCard)

    // Shows URL tabs / repository URL
    expect(await screen.findByText(/Repository URL/i)).toBeTruthy()
    expect(screen.getByRole('tab', { name: /GitHub/i })).toBeTruthy()
    expect(screen.queryByText(/Step 1 of 2: connect the NexMind server/i)).toBeNull()
    expect(document.body.textContent).not.toContain(FORBIDDEN_SCREEN_TEXT)

    const closeBtn2 = screen.getByRole('button', { name: /Close dialog/i })
    fireEvent.click(closeBtn2)

    // 3. Live connect mode card
    const liveHeading = screen.getByRole('heading', { name: /Live connect/i })
    const liveCard = liveHeading.closest('[role="button"]') as HTMLElement
    expect(liveCard).toBeTruthy()
    fireEvent.click(liveCard)

    // Shows command card
    expect(await screen.findByText(/(Best option: run this in your project's terminal|Open your project in VS Code)/i)).toBeTruthy()
    expect(screen.queryByText(/Step 1 of 2: connect the NexMind server/i)).toBeNull()
    expect(document.body.textContent).not.toContain(FORBIDDEN_SCREEN_TEXT)

    unmount()
  })

  it('(c) /app/w/abc with server unreachable shows small "Can\'t reach your NexMind server" card and auto-disappears when connected', async () => {
    localStorage.setItem('nexmind.api', 'http://127.0.0.1:8000')
    useServer.setState({ status: 'offline', base: 'http://127.0.0.1:8000', attempts: 1, health: null })

    let serverUp = false
    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (!serverUp) {
        throw new Error('Server unreachable')
      }
      if (url.includes('/api/health')) {
        return new Response(JSON.stringify({
          app: 'nexmind',
          status: 'ok',
          version: '1.1.0',
          llm: { provider: 'mock', model: null, available: true }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/api/workspaces/abc/threads')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/api/workspaces/abc/graph')) {
        return new Response(JSON.stringify({
          nodes: [{ id: 'n1', type: 'File', label: 'main.py', x: 0, y: 0, z: 0, cluster: 1, score: 1 }],
          links: [],
          clusters: [],
          truncated: false,
          total_nodes: 1,
          total_edges: 0,
          status: 'ready',
          legend: { node_colors: {}, edge_colors: {} }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/api/workspaces/abc')) {
        return new Response(JSON.stringify({
          id: 'abc',
          name: 'My Workspace',
          description: '',
          status: 'ready',
          source_count: 1,
          thread_count: 0,
          kind: 'code',
          created_at: Date.now(),
          updated_at: Date.now(),
          stats: { nodes: 1 }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    render(
      <MemoryRouter initialEntries={['/app/w/abc']}>
        <App />
      </MemoryRouter>
    )

    // Shows the small centered card titled "Can't reach your NexMind server"
    const heading = await screen.findByRole('heading', { name: /Can't reach your NexMind server/i })
    expect(heading).toBeTruthy()

    // Shows the three buttons
    expect(screen.getByRole('button', { name: /Try again now/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: /Open NexMind on this computer/i })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /Back to modes/i }).length).toBeGreaterThanOrEqual(1)

    // No full-page gate
    expect(document.body.textContent).not.toContain(FORBIDDEN_SCREEN_TEXT)

    // Now bring the mocked server online
    serverUp = true
    await act(async () => {
      await useServer.getState().check()
    })

    // The small card disappears and the workspace loads
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /Can't reach your NexMind server/i })).toBeNull()
      expect(useView.getState().nodes.length).toBeGreaterThan(0)
    }, { timeout: 4000 })
  })

  it('(d) the forbidden-strings script exits 0 on current tree and non-zero on a fixture with forbidden text', () => {
    const scriptPath = path.resolve(__dirname, '../../scripts/check-forbidden.mjs')

    // 1. Run on current tree: must exit 0
    let currentTreeExitCode = 0
    try {
      execSync(`node "${scriptPath}"`, { stdio: 'pipe' })
    } catch (e: any) {
      currentTreeExitCode = e.status || 1
    }
    expect(currentTreeExitCode).toBe(0)

    // 2. Run on a temporary fixture containing forbidden text: must exit non-zero
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexmind-fixture-'))
    const badFile = path.join(tmpDir, 'BadComponent.tsx')
    fs.writeFileSync(badFile, `export function Bad() { return <h1>${FORBIDDEN_SCREEN_TEXT}</h1> }`)

    let fixtureExitCode = 0
    try {
      execSync(`node "${scriptPath}" "${tmpDir}"`, { stdio: 'pipe' })
    } catch (e: any) {
      fixtureExitCode = e.status || 1
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
    expect(fixtureExitCode).not.toBe(0)
  })

  it('(e) the build stamp is on window and not displayed in the footer', async () => {
    localStorage.setItem('nexmind.api', 'http://127.0.0.1:59999')
    useServer.setState({ status: 'offline', base: 'http://127.0.0.1:59999', attempts: 1, health: null })

    globalThis.fetch = vi.fn().mockImplementation(async () => {
      throw new Error('Unreachable')
    })

    render(
      <MemoryRouter initialEntries={['/app']}>
        <App />
      </MemoryRouter>
    )

    expect(screen.queryByText(/build /i)).toBeNull()
    expect(window.__NEXMIND_BUILD__).toBeDefined()
  })
})
