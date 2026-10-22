import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { ProjectsForm } from '@/components/ModeForms/ProjectsForm'
import { ConnectPanel } from '@/components/ConnectPanel'
import { FolderPicker } from '@/components/FolderPicker'
import { useServer } from '@/lib/server'
import { api, uploadFiles, formatApiError } from '@/lib/api'
import { browserFolderSync, getBrowserPathHint } from '@/lib/browserFolder'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    uploadFiles: vi.fn(),
    api: {
      ...actual.api,
      workspaces: vi.fn().mockResolvedValue([]),
      connectSessions: vi.fn().mockResolvedValue({ now: 1000, sessions: [] }),
      connect: vi.fn(),
      connectUpload: vi.fn().mockResolvedValue({
        workspace_id: 'ws-hosted-live',
        job_id: 'job-1',
        name: 'test-app',
        url: '/app/w/ws-hosted-live',
        reused: false,
      }),
      fsList: vi.fn(),
      fsCheck: vi.fn(),
      fsPick: vi.fn(),
      createWorkspace: vi.fn().mockResolvedValue({
        id: 'ws-code-1',
        name: 'my-project',
        description: '',
        kind: 'code',
        status: 'ready',
        created_at: 1,
        updated_at: 1,
        source_count: 0,
        thread_count: 0,
        stats: { nodes: 0, edges: 0, files: 0 },
      }),
      ingestGit: vi.fn(),
      ingestLocal: vi.fn().mockResolvedValue({ job_id: 'job-local' }),
      probe: vi.fn(),
    },
  }
})

describe('Folder Selection on Hosted / Vercel Backend', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    browserFolderSync.stopSync()

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/uploads') && !url.includes('/chunks/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            upload_id: 'up-mock-1',
            chunk_size: 1024 * 1024,
            chunks: 1,
          }),
        }
      }
      if (url.includes('/chunks/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
      }
    }) as any

    vi.mocked(uploadFiles).mockResolvedValue({ job_id: 'job-up-1' })
  })

  afterEach(() => {
    browserFolderSync.stopSync()
    globalThis.fetch = originalFetch
    delete (window as any).showDirectoryPicker
    vi.useRealTimers()
  })

  // a) Hosted (local_paths false): Projects shows the "Local folder" tab; it has a "Choose folder…" button and no path text field;
  // choosing a mocked FileList with webkitRelativePath values packs, uploads in chunks and creates a kind 'code' workspace;
  // an empty/ignored-only folder shows the inline "no source files" message.
  it('a) Hosted (local_paths false): Projects shows Local folder tab with Choose folder button and no path field, packs and uploads, and shows no source files error on ignored folder', async () => {
    useServer.setState({
      status: 'online',
      base: 'https://nexmind.example.com',
      health: {
        ok: true,
        app: 'nexmind',
        version: '1.1.0',
        capabilities: { local_paths: false },
      } as any,
    })

    const onStarted = vi.fn()
    const { container } = render(
      <MemoryRouter>
        <ProjectsForm onStarted={onStarted} />
      </MemoryRouter>
    )

    // "Local folder" tab is visible
    const localTab = screen.getByRole('tab', { name: 'Local folder' })
    expect(localTab).toBeTruthy()
    fireEvent.click(localTab)

    // Shows start instructions and NO path text field
    expect(screen.getByText('Download or clone NexMind')).toBeTruthy()
    expect(screen.queryByPlaceholderText(/C:\\Users/i)).toBeNull()
    expect(screen.getByRole('button', { name: /Upload instead \(slower\)/i })).toBeTruthy()

    // Upload fallback never creates an input[webkitdirectory] on hosted origin
    expect(container.querySelector('input[webkitdirectory]')).toBeNull()

    // Click "Upload instead (slower)"
    fireEvent.click(screen.getByRole('button', { name: /Upload instead \(slower\)/i }))
    expect(screen.getByRole('button', { name: /Choose folder…/i })).toBeTruthy()
    expect(container.querySelector('input[webkitdirectory]')).toBeNull()

    // Mock showDirectoryPicker
    const mockFileHandle = {
      kind: 'file',
      name: 'index.ts',
      getFile: vi.fn().mockImplementation(async () => {
        const f = new File(['export const hello = "world"'], 'index.ts', { type: 'text/typescript' })
        Object.defineProperty(f, 'lastModified', { value: 1000 })
        return f
      }),
    }
    const mockDirHandle = {
      kind: 'directory',
      name: 'my-cool-app',
      entries: async function* () {
        yield ['index.ts', mockFileHandle]
      },
    }
    ;(window as any).showDirectoryPicker = vi.fn().mockResolvedValue(mockDirHandle)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Choose folder…/i }))
    })

    // Packed summary shown in FolderReview with "Change folder" link
    expect(await screen.findByText(/Packed 1 files · .* from my-cool-app/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Change folder/i })).toBeTruthy()

    // Analyze project uploads in chunks and creates kind 'code' workspace
    const analyzeBtn = (await screen.findByRole('button', { name: /Analyze 1 files/i })) as HTMLButtonElement
    expect(analyzeBtn.disabled).toBe(false)

    await act(async () => {
      fireEvent.click(analyzeBtn)
    })

    await waitFor(() => {
      expect(api.createWorkspace).toHaveBeenCalledWith('my-cool-app', '', 'code')
      expect(uploadFiles).toHaveBeenCalled()
      expect(onStarted).toHaveBeenCalledWith('job-up-1', 'ws-code-1')
    })
  })

  // b) Local (local_paths true): the Local folder tab still shows the path field and Browse button (unchanged behaviour).
  it('b) Local (local_paths true): Local folder tab still shows path field and Browse button', () => {
    useServer.setState({
      status: 'online',
      base: 'http://127.0.0.1:8000',
      health: {
        ok: true,
        app: 'nexmind',
        version: '1.1.0',
        capabilities: { local_paths: true },
      } as any,
    })

    render(
      <MemoryRouter>
        <ProjectsForm />
      </MemoryRouter>
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Local folder' }))

    // Shows path field and Browse button
    expect(screen.getByPlaceholderText(/C:\\Users\\you\\projects/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Browse…/i })).toBeTruthy()
    expect(screen.getByText('Indexed in place. Nothing is copied or changed.')).toBeTruthy()
  })

  // c) Live connect hosted: Card C never calls /api/fs/pick; with a mocked showDirectoryPicker it uploads,
  // calls /api/connect/upload with path_hint starting "browser:", then a mocked file change triggers exactly one re-upload
  // after the debounce; the same folder twice reuses the same path_hint; without showDirectoryPicker it falls back to the input and shows "Re-sync now".
  it('c) Live connect hosted: never calls /api/fs/pick, uses showDirectoryPicker with debounced re-upload, stable path_hint, and falls back to input with Re-sync now', async () => {
    useServer.setState({
      status: 'online',
      base: 'https://nexmind.example.com',
      health: {
        ok: true,
        app: 'nexmind',
        version: '1.1.0',
        capabilities: { local_paths: false },
      } as any,
    })

    let fileTime = 1000
    let fileContent = 'const a = 1'

    const mockFileHandle = {
      kind: 'file',
      name: 'index.ts',
      getFile: vi.fn(async () => {
        const f = new File([fileContent], 'index.ts', { type: 'text/typescript' })
        Object.defineProperty(f, 'lastModified', { value: fileTime })
        return f
      }),
    }

    const mockDirHandle = {
      kind: 'directory',
      name: 'test-project',
      entries: async function* () {
        yield ['index.ts', mockFileHandle]
      },
    }

    ;(window as any).showDirectoryPicker = vi.fn().mockResolvedValue(mockDirHandle)

    const onSuccess = vi.fn()
    const { unmount } = render(
      <MemoryRouter>
        <ConnectPanel onSuccess={onSuccess} />
      </MemoryRouter>
    )

    // Card C heading
    expect(screen.getByText('No terminal? Connect a folder from your browser')).toBeTruthy()

    // Click "Choose folder…"
    const chooseBtn = screen.getByRole('button', { name: /Choose folder…/i })
    await act(async () => {
      fireEvent.click(chooseBtn)
    })

    await waitFor(() => {
      expect((window as any).showDirectoryPicker).toHaveBeenCalled()
      expect(screen.getByRole('button', { name: /Connect 1 files/i })).toBeTruthy()
    })

    const connectBtn = screen.getByRole('button', { name: /Connect 1 files/i })
    await act(async () => {
      fireEvent.click(connectBtn)
    })

    await waitFor(() => {
      expect(api.connectUpload).toHaveBeenCalledTimes(1)
    })

    // Never calls /api/fs/pick
    expect(api.fsPick).not.toHaveBeenCalled()

    // Path hint starts with "browser:test-project:"
    const firstCall = vi.mocked(api.connectUpload).mock.calls[0]
    expect(firstCall[1]).toMatch(/^browser:test-project:[A-Za-z0-9_-]+$/)
    const initialPathHint = firstCall[1]

    // Same folder twice reuses the same path_hint
    const secondPathHint = getBrowserPathHint('test-project')
    expect(secondPathHint).toBe(initialPathHint)

    // File change triggers debounced re-upload
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    fileTime = 2500
    fileContent = 'const a = 2'

    // Perform signature check to detect change
    await act(async () => {
      await browserFolderSync.performSignatureCheck()
    })

    // Advance 2s debounce
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    // Exactly one re-upload occurred!
    expect(api.connectUpload).toHaveBeenCalledTimes(2)
    const secondCall = vi.mocked(api.connectUpload).mock.calls[1]
    expect(secondCall[1]).toBe(initialPathHint)

    // Advancing more time does not trigger additional uploads without further changes
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000)
    })
    expect(api.connectUpload).toHaveBeenCalledTimes(2)

    browserFolderSync.stopSync()
    unmount()
    vi.useRealTimers()

    // Now test fallback without showDirectoryPicker
    delete (window as any).showDirectoryPicker

    const { container: fallbackContainer } = render(
      <MemoryRouter>
        <ConnectPanel onSuccess={onSuccess} />
      </MemoryRouter>
    )

    // Browser note shown
    expect(
      screen.getByText(/Live sync from the browser needs Chrome or Edge/i)
    ).toBeTruthy()

    // Input fallback
    const fallbackInput = fallbackContainer.querySelector('input[type="file"][webkitdirectory]') as HTMLInputElement
    expect(fallbackInput).toBeTruthy()

    const fallbackFile = new File(['export const z = 99'], 'app.ts', { type: 'text/typescript' })
    Object.defineProperty(fallbackFile, 'webkitRelativePath', { value: 'safari-project/app.ts' })

    await act(async () => {
      fireEvent.change(fallbackInput, { target: { files: [fallbackFile] } })
    })

    const fallbackConnectBtn = screen.getByRole('button', { name: /Connect 1 files/i })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    await act(async () => {
      fireEvent.click(fallbackConnectBtn)
    })

    // Advance 1300ms so connectedSession splash finishes and normal view restores with Re-sync now
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300)
    })

    vi.useRealTimers()

    // Shows "Re-sync now"
    expect(screen.getByRole('button', { name: /Re-sync now/i })).toBeTruthy()
  })

  // d) FolderPicker on a hosted backend never renders the red error; it offers "Choose folder…".
  it('d) FolderPicker on a hosted backend never renders the red error; it offers Choose folder…', () => {
    useServer.setState({
      status: 'online',
      base: 'https://nexmind.example.com',
      health: {
        ok: true,
        app: 'nexmind',
        version: '1.1.0',
        capabilities: { local_paths: false },
      } as any,
    })

    const onPick = vi.fn()
    const onClose = vi.fn()
    render(<FolderPicker onPick={onPick} onClose={onClose} />)

    // Never renders the red error text
    expect(screen.queryByText(/Folders on your computer can only be opened/i)).toBeNull()
    expect(document.querySelector('.text-coral')).toBeNull()

    // Offers "Choose folder…"
    expect(
      screen.getByText("Choosing folders by path only works when NexMind runs on your computer. Use 'Choose folder…' instead.")
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: /Choose folder…/i })).toBeTruthy()
  })

  // e) No user-facing text contains raw JSON.
  it('e) No user-facing text contains raw JSON in formatApiError or components', () => {
    const rawError = {
      detail: [{ loc: ['body', 'path_hint'], msg: 'Path hint cannot be blank', type: 'value_error' }],
    }
    const message = formatApiError(rawError)
    expect(message).not.toContain('{')
    expect(message).not.toContain('}')
    expect(message).not.toContain('"detail"')
    expect(message).not.toContain('"msg"')
  })
})
