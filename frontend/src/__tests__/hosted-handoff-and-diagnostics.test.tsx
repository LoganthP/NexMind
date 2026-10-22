import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { ServerStatusBar } from '@/components/ServerStatusBar'
import { ProjectsForm } from '@/components/ModeForms/ProjectsForm'
import { ConnectPanel } from '@/components/ConnectPanel'
import Hub from '@/pages/Hub'
import { useServer, probeCandidate } from '@/lib/server'
import * as localServerMod from '@/lib/localServer'
import { computeHandleSignature } from '@/lib/browserFolder'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    uploadFiles: vi.fn().mockResolvedValue({ job_id: 'job-1' }),
    api: {
      ...actual.api,
      workspaces: vi.fn().mockResolvedValue([]),
      connectSessions: vi.fn().mockResolvedValue({ now: 1000, sessions: [] }),
      createWorkspace: vi.fn().mockResolvedValue({
        id: 'ws-1',
        name: 'test',
        kind: 'code',
        status: 'ready',
        created_at: 1,
        updated_at: 1,
        source_count: 0,
        thread_count: 0,
        stats: { nodes: 0, edges: 0, files: 0 },
      }),
    },
  }
})

describe('Part 2: Frontend Shows Real Reason on Same Origin', () => {
  const originalLocation = window.location

  beforeEach(() => {
    vi.restoreAllMocks()
    delete (window as any).location
    window.location = new URL('https://nexmind.vercel.app/app') as any
  })

  afterEach(() => {
    ;(window as any).location = originalLocation
  })

  it('same-origin 500 HTML maps to backend-error and renders "Backend error: 500 Internal Server Error" with status link', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      headers: new Headers({ 'content-type': 'text/html' }),
      text: async () => '<html><body>500 Internal Server Error</body></html>',
      json: async () => {
        throw new Error('Not JSON')
      },
    })
    globalThis.fetch = mockFetch as any

    const res = await probeCandidate('https://nexmind.vercel.app', 1000)
    expect(res.state).toBe('backend-error')
    expect(res.backendError).toEqual({ status: 500, reason: 'Internal Server Error' })

    // Render ServerStatusBar in this state
    useServer.setState({
      status: 'offline',
      state: 'backend-error',
      base: 'https://nexmind.vercel.app',
      backendError: { status: 500, reason: 'Internal Server Error' },
      setupRequired: null,
    })

    render(<ServerStatusBar />)
    expect(screen.getByText(/Backend error: 500 Internal Server Error/i)).toBeTruthy()
    const link = screen.getByRole('link', { name: /Open the server status/i })
    expect(link).toBeTruthy()
    expect(link.getAttribute('href')).toContain('/api/health')
    // Never shows browser-blocking or Chrome-permission instructions
    expect(screen.queryByText(/browser is blocking/i)).toBeNull()
  })

  it('same-origin JSON with setup_required maps to setup line', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        app: 'nexmind',
        version: '1.1.0',
        ok: false,
        setup_required: 'Database unreachable: check DATABASE_URL',
        database: {
          configured: true,
          ok: false,
          error: 'Database unreachable: check DATABASE_URL',
          env_var: 'DATABASE_URL',
        },
      }),
    })
    globalThis.fetch = mockFetch as any

    const res = await probeCandidate('https://nexmind.vercel.app', 1000)
    expect(res.state).toBe('setup-needed')
    expect(res.setupRequired).toBe('Database unreachable: check DATABASE_URL')

    // Render ServerStatusBar
    useServer.setState({
      status: 'offline',
      state: 'setup-needed',
      base: 'https://nexmind.vercel.app',
      setupRequired: 'Database unreachable: check DATABASE_URL',
      backendError: null,
    })

    render(<ServerStatusBar />)
    expect(screen.getByText(/Setup needed: Database unreachable: check DATABASE_URL/i)).toBeTruthy()
    expect(screen.queryByText(/browser is blocking/i)).toBeNull()
  })

  it('network failure on same-origin produces "unreachable" and never "blocked-browser"', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    globalThis.fetch = mockFetch as any

    const res = await probeCandidate('https://nexmind.vercel.app', 1000)
    expect(res.state).toBe('unreachable')
    expect(res.state).not.toBe('blocked-browser')

    useServer.setState({
      status: 'offline',
      state: 'unreachable',
      base: 'https://nexmind.vercel.app',
      backendError: null,
      setupRequired: null,
    })

    render(<ServerStatusBar />)
    expect(screen.getByText(/Server unreachable \(retrying…\)/i)).toBeTruthy()
    expect(screen.queryByText(/browser is blocking/i)).toBeNull()
  })
})

describe('Part 3: Analyze Local Folders on User Computer (Handoff & Lean Upload)', () => {
  const originalLocation = window.location

  beforeEach(() => {
    vi.restoreAllMocks()
    delete (window as any).location
    window.location = new URL('https://nexmind.vercel.app/app') as any
    useServer.setState({
      status: 'online',
      base: 'https://nexmind.vercel.app',
      health: {
        ok: true,
        app: 'nexmind',
        version: '1.1.0',
        capabilities: { local_paths: false },
      } as any,
    })
  })

  afterEach(() => {
    ;(window as any).location = originalLocation
  })

  it('hosted + local server detected -> shows "Analyze on this computer" button with http://127.0.0.1:8000/app#new-local', async () => {
    vi.spyOn(localServerMod, 'probeLocalServer').mockResolvedValue({
      running: true,
      port: 8000,
      url: 'http://127.0.0.1:8000',
    })

    render(
      <MemoryRouter>
        <ProjectsForm initialTab="local" />
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(
        screen.getByText(/NexMind is running on this computer: analyze the folder in place/i)
      ).toBeTruthy()
    })

    const btn = screen.getByRole('link', { name: /Analyze on this computer/i })
    expect(btn).toBeTruthy()
    expect(btn.getAttribute('href')).toBe('http://127.0.0.1:8000/app#new-local')
  })

  it('hosted + no local server -> shows start instructions and "Upload instead (slower)"', async () => {
    vi.spyOn(localServerMod, 'probeLocalServer').mockResolvedValue({
      running: false,
      port: null,
      url: null,
    })

    render(
      <MemoryRouter>
        <ProjectsForm initialTab="local" />
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('Download or clone NexMind')).toBeTruthy()
      expect(screen.getByText('powershell -ExecutionPolicy Bypass -File .\\start.ps1')).toBeTruthy()
      expect(screen.getByRole('button', { name: /Check again/i })).toBeTruthy()
      expect(screen.getByRole('button', { name: /Upload instead \(slower\)/i })).toBeTruthy()
    })
  })

  it('upload fallback never creates an <input webkitdirectory> for Projects on a hosted origin', async () => {
    vi.spyOn(localServerMod, 'probeLocalServer').mockResolvedValue({
      running: false,
      port: null,
      url: null,
    })

    const { container } = render(
      <MemoryRouter>
        <ProjectsForm initialTab="local" />
      </MemoryRouter>
    )

    // Initially in instructions view
    expect(container.querySelector('input[webkitdirectory]')).toBeNull()

    // Switch to upload fallback
    fireEvent.click(screen.getByRole('button', { name: /Upload instead \(slower\)/i }))
    expect(screen.getByRole('button', { name: /Choose folder…/i })).toBeTruthy()

    // Still no input[webkitdirectory]
    expect(container.querySelector('input[webkitdirectory]')).toBeNull()

    // Also check on upload tab
    fireEvent.click(screen.getByRole('tab', { name: 'Upload project' }))
    expect(container.querySelector('input[webkitdirectory]')).toBeNull()
  })

  it('ignored folders are not even listed (handle-walk mock)', async () => {
    const openedDirectories: string[] = []

    const mockNodeModulesHandle = {
      kind: 'directory',
      name: 'node_modules',
      entries: async function* () {
        openedDirectories.push('node_modules')
        yield ['package.json', { kind: 'file', name: 'package.json', getFile: async () => new File(['{}'], 'package.json') }]
      },
    }

    const mockGitHandle = {
      kind: 'directory',
      name: '.git',
      entries: async function* () {
        openedDirectories.push('.git')
        yield ['config', { kind: 'file', name: 'config', getFile: async () => new File([''], 'config') }]
      },
    }

    const mockSrcHandle = {
      kind: 'directory',
      name: 'src',
      entries: async function* () {
        openedDirectories.push('src')
        yield [
          'app.ts',
          {
            kind: 'file',
            name: 'app.ts',
            getFile: async () => new File(['export const x = 1'], 'app.ts', { type: 'text/typescript' }),
          },
        ]
      },
    }

    const mockRootDirHandle = {
      kind: 'directory',
      name: 'root',
      entries: async function* () {
        yield ['node_modules', mockNodeModulesHandle]
        yield ['.git', mockGitHandle]
        yield ['src', mockSrcHandle]
      },
    }

    const walk = await computeHandleSignature(mockRootDirHandle)

    // node_modules and .git were SKIPPED without opening them!
    expect(openedDirectories).toEqual(['src'])
    expect(walk.skippedFolders).toContain('node_modules')
    expect(walk.skippedFolders).toContain('.git')
    expect(walk.files.length).toBe(1)
    expect(walk.files[0].relativePath).toBe('src/app.ts')
  })

  it('file and size limits block with "Too large to upload: choose a sub-folder such as src, or analyze on this computer"', async () => {
    // Test file limit (> 5000 files)
    const largeFilesHandle = {
      kind: 'directory',
      name: 'huge-project',
      entries: async function* () {
        for (let i = 0; i < 5002; i++) {
          yield [
            `f${i}.ts`,
            {
              kind: 'file',
              name: `f${i}.ts`,
              getFile: async () => new File(['x'], `f${i}.ts`),
            },
          ]
        }
      },
    }

    await expect(computeHandleSignature(largeFilesHandle)).rejects.toThrow(
      'Too large to upload: choose a sub-folder such as src, or analyze on this computer'
    )

    // Test size limit (> 60 MB)
    const largeSizeHandle = {
      kind: 'directory',
      name: 'big-project',
      entries: async function* () {
        for (let i = 0; i < 35; i++) {
          yield [
            `f${i}.ts`,
            {
              kind: 'file',
              name: `f${i}.ts`,
              getFile: async () => new File([new Uint8Array(1.9 * 1024 * 1024)], `f${i}.ts`),
            },
          ]
        }
      },
    }

    await expect(computeHandleSignature(largeSizeHandle)).rejects.toThrow(
      'Too large to upload: choose a sub-folder such as src, or analyze on this computer'
    )
  })

  it('hash routes #new-local and #new-live in Hub open the right dialog states', async () => {
    window.location.hash = '#new-local'

    const { unmount } = render(
      <MemoryRouter>
        <Hub />
      </MemoryRouter>
    )

    // #new-local opens New workspace dialog in Projects mode with Local folder tab active
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /New Projects/i })).toBeTruthy()
      expect(screen.getByRole('tab', { name: 'Local folder' }).getAttribute('aria-selected')).toBe('true')
    })
    unmount()

    // Test #new-live
    window.location.hash = '#new-live'
    render(
      <MemoryRouter>
        <Hub />
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /New Live connect/i })).toBeTruthy()
    })

    window.location.hash = ''
  })

  it('Live connect (ConnectPanel) on hosted site detects local server and offers "Connect on this computer instead"', async () => {
    vi.spyOn(localServerMod, 'probeLocalServer').mockResolvedValue({
      running: true,
      port: 8000,
      url: 'http://127.0.0.1:8000',
    })

    render(
      <MemoryRouter>
        <ConnectPanel />
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /Connect on this computer instead/i })).toBeTruthy()
    })

    const link = screen.getByRole('link', { name: /Connect on this computer instead/i })
    expect(link.getAttribute('href')).toBe('http://127.0.0.1:8000/app#new-live')
  })
})
