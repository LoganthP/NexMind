import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NewWorkspaceDialog } from '@/components/NewWorkspaceDialog'
import { ConnectPanel } from '@/components/ConnectPanel'
import { DocumentsForm } from '@/components/ModeForms/DocumentsForm'
import { ProjectsForm } from '@/components/ModeForms/ProjectsForm'
import { packFolder, shouldIncludeFile } from '@/lib/folderUpload'
import { useServer } from '@/lib/server'
import { api, ApiError, formatApiError, uploadFiles } from '@/lib/api'

// Mock api methods
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    uploadFiles: vi.fn(),
    api: {
      ...actual.api,
      workspaces: vi.fn(),
      connectSessions: vi.fn(),
      connect: vi.fn(),
      fsList: vi.fn(),
      fsCheck: vi.fn(),
      fsPick: vi.fn(),
      createWorkspace: vi.fn(),
      ingestGit: vi.fn(),
      ingestLocal: vi.fn(),
      probe: vi.fn(),
    },
  }
})

describe('Section 6: New Workspace Experience Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.connectSessions).mockResolvedValue({ now: 1000, sessions: [] })
    vi.mocked(api.createWorkspace).mockResolvedValue({
      id: 'ws-default',
      name: 'Default',
      description: '',
      kind: 'code',
      status: 'ready',
      created_at: 1,
      updated_at: 1,
      source_count: 0,
      thread_count: 0,
      stats: { nodes: 0, edges: 0, files: 0 },
    })
    vi.mocked(uploadFiles).mockResolvedValue({ job_id: 'job-default' })
    useServer.setState({
      status: 'offline',
      base: 'http://127.0.0.1:8000',
      health: null,
      attempts: 1,
    })
  })

  // a) Offline server: choosing Documents, Projects, Live connect shows own tools immediately
  it('a) Offline server: each mode shows its own tools immediately without "Step 1 of 2" screen; bodies are distinct', () => {
    // 1. Documents mode
    const { unmount: unmountDocs } = render(
      <MemoryRouter>
        <NewWorkspaceDialog initialMode="docs" onClose={() => {}} />
      </MemoryRouter>
    )

    // Verify Documents tools
    expect(screen.queryByText(/Step 1 of 2/i)).toBeNull()
    expect(screen.getByText(/Drop PDFs, Word files/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Choose files/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Choose a folder/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Analyze documents/i })).toBeTruthy()
    // No GitHub field or command block in docs
    expect(screen.queryByPlaceholderText(/https:\/\/github\.com/i)).toBeNull()
    expect(screen.queryByText(/Open your project in VS Code/i)).toBeNull()
    unmountDocs()

    // 2. Projects mode
    const { unmount: unmountProj } = render(
      <MemoryRouter>
        <NewWorkspaceDialog initialMode="code" onClose={() => {}} />
      </MemoryRouter>
    )

    // Verify Projects tools
    expect(screen.queryByText(/Step 1 of 2/i)).toBeNull()
    expect(screen.getByRole('tab', { name: 'GitHub' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'GitLab' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Azure DevOps' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Upload project' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Local folder' })).toBeTruthy()
    expect(screen.getByPlaceholderText(/https:\/\/github\.com\//i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Analyze project/i })).toBeTruthy()
    // No command block or dropzone in code
    expect(screen.queryByText(/Open your project in VS Code/i)).toBeNull()
    expect(screen.queryByText(/Drop PDFs, Word files/i)).toBeNull()
    unmountProj()

    // 3. Live connect mode
    const { unmount: unmountLive } = render(
      <MemoryRouter>
        <NewWorkspaceDialog initialMode="live" onClose={() => {}} />
      </MemoryRouter>
    )

    // Verify Live connect tools
    expect(screen.queryByText(/Step 1 of 2/i)).toBeNull()
    expect(screen.getByText(/Open your project in VS Code/i)).toBeTruthy()
    expect(screen.getByText(/Waiting for your project/i)).toBeTruthy()
    expect(screen.getByText(/No terminal\? Pick the folder here/i)).toBeTruthy()
    // No GitHub tabs or document dropzone
    expect(screen.queryByRole('tab', { name: 'GitHub' })).toBeNull()
    expect(screen.queryByText(/Drop PDFs, Word files/i)).toBeNull()
    unmountLive()
  })

  // b) Offline + press Analyze: inputs stay, help section expands, "Waiting for server...", runs once on connect, Cancel clears
  it('b) Offline + press Analyze in Projects: keeps inputs, queues action, runs once when server connects, Cancel clears', async () => {
    vi.mocked(api.createWorkspace).mockResolvedValue({
      id: 'ws-git-test',
      name: 'my-repo',
      description: '',
      kind: 'code',
      status: 'ready',
      created_at: 100,
      updated_at: 100,
      source_count: 0,
      thread_count: 0,
      stats: { nodes: 0, edges: 0, files: 0 },
    })
    vi.mocked(api.ingestGit).mockResolvedValue({
      job_id: 'job-git-1',
    })

    const onStarted = vi.fn()
    render(
      <MemoryRouter>
        <ProjectsForm onStarted={onStarted} />
      </MemoryRouter>
    )

    // Type repo URL while offline
    const urlInput = screen.getByPlaceholderText(/https:\/\/github\.com\//i) as HTMLInputElement
    fireEvent.change(urlInput, { target: { value: 'https://github.com/my-org/my-repo' } })
    expect(urlInput.value).toBe('https://github.com/my-org/my-repo')

    // Submit while offline
    const submitBtn = screen.getByRole('button', { name: /Analyze project/i })
    fireEvent.click(submitBtn)

    // Inputs stay
    expect(urlInput.value).toBe('https://github.com/my-org/my-repo')

    // Button shows "Waiting for server…"
    expect(screen.getByText(/Waiting for server…/i)).toBeTruthy()
    expect(screen.getAllByText(/We'll start as soon as the server connects/i).length).toBeGreaterThan(0)

    // Help section expanded
    expect(screen.getByText(/Start the server/i)).toBeTruthy()

    // Cancel link clears the pending action
    const cancelBtn = screen.getAllByRole('button', { name: /Cancel/i })[0]
    fireEvent.click(cancelBtn)
    expect(screen.getByRole('button', { name: /Analyze project/i })).toBeTruthy()
    expect(screen.queryByText(/Waiting for server…/i)).toBeNull()

    // Submit again and simulate server connecting
    fireEvent.click(screen.getByRole('button', { name: /Analyze project/i }))
    expect(screen.getByText(/Waiting for server…/i)).toBeTruthy()

    // Server connects!
    act(() => {
      useServer.setState({ status: 'online' })
    })

    // Action executed automatically once
    await waitFor(() => {
      expect(api.ingestGit).toHaveBeenCalledTimes(1)
      expect(onStarted).toHaveBeenCalledWith('job-git-1', 'ws-git-test')
    })
  })

  // b2) Offline + Documents form keeps files in memory and queues action
  it('b2) Offline + Documents form keeps files in memory and queues upload on connect', async () => {
    vi.mocked(api.createWorkspace).mockResolvedValue({
      id: 'ws-docs-test',
      name: 'notes',
      description: '',
      kind: 'docs',
      status: 'ready',
      created_at: 1,
      updated_at: 1,
      source_count: 0,
      thread_count: 0,
      stats: { nodes: 0, edges: 0, files: 0 },
    })
    vi.mocked(uploadFiles).mockResolvedValue({
      job_id: 'job-docs-1',
    })

    const onStarted = vi.fn()
    render(
      <MemoryRouter>
        <DocumentsForm onStarted={onStarted} />
      </MemoryRouter>
    )

    // Mock drop a file
    const mockFile = new File(['hello world'], 'notes.md', { type: 'text/markdown' })
    const dropzone = screen.getByText(/Drop PDFs, Word files/i).closest('div')!
    fireEvent.drop(dropzone, {
      dataTransfer: {
        files: [mockFile],
      },
    })

    // File list shows file
    expect(await screen.findByText('notes.md')).toBeTruthy()

    // Click Analyze documents while offline
    const submitBtn = screen.getByRole('button', { name: /Analyze documents/i })
    fireEvent.click(submitBtn)

    // Button shows "Waiting for server…" and Cancel is available
    expect(screen.getByText(/Waiting for server…/i)).toBeTruthy()
    const cancelBtn = screen.getAllByRole('button', { name: /Cancel/i })[0]
    expect(cancelBtn).toBeTruthy()

    // File is still in list
    expect(screen.getByText('notes.md')).toBeTruthy()

    // Server connects!
    act(() => {
      useServer.setState({ status: 'online' })
    })

    await waitFor(() => {
      expect(uploadFiles).toHaveBeenCalledTimes(1)
      expect(onStarted).toHaveBeenCalledWith('job-docs-1', 'ws-docs-test')
    })
  })

  // c) folderUpload packing tests
  it('c) folderUpload packs files into a zip, skips ignored directories, respects size limit and mode rules', async () => {
    // 1. Inclusion test
    expect(shouldIncludeFile('my-app/node_modules/pkg/index.js', 100, 'code')).toBe(false)
    expect(shouldIncludeFile('my-app/.git/HEAD', 100, 'code')).toBe(false)
    expect(shouldIncludeFile('my-app/dist/bundle.js', 100, 'code')).toBe(false)
    expect(shouldIncludeFile('my-app/src/main.ts', 100, 'code')).toBe(true)
    expect(shouldIncludeFile('my-app/src/main.ts', 100, 'docs')).toBe(false)
    expect(shouldIncludeFile('my-app/docs/spec.pdf', 100, 'docs')).toBe(true)
    expect(shouldIncludeFile('my-app/docs/spec.pdf', 100, 'code')).toBe(false)

    // 2. Mock file packing
    const file1 = new File(['const x = 1'], 'index.ts', { type: 'text/typescript' })
    Object.defineProperty(file1, 'webkitRelativePath', { value: 'my-proj/src/index.ts' })

    const file2 = new File(['# Readme'], 'README.md', { type: 'text/markdown' })
    Object.defineProperty(file2, 'webkitRelativePath', { value: 'my-proj/README.md' })

    const fileIgnored = new File(['console.log()'], 'dep.js', { type: 'application/javascript' })
    Object.defineProperty(fileIgnored, 'webkitRelativePath', { value: 'my-proj/node_modules/dep/dep.js' })

    const res = await packFolder([file1, file2, fileIgnored], 'code', 'my-proj')
    expect(res.file.name).toBe('my-proj.zip')
    expect(res.file.size).toBeGreaterThan(0)
    expect(res.fileCount).toBe(2)

    // 3. Oversize input check
    const hugeFile = new File([''], 'huge.pdf')
    Object.defineProperty(hugeFile, 'size', { value: 350 * 1024 * 1024 })
    Object.defineProperty(hugeFile, 'webkitRelativePath', { value: 'my-docs/huge.pdf' })

    await expect(packFolder([hugeFile], 'docs')).rejects.toThrow(/exceeds 300 MB/i)
  })

  // d) Browse native /api/fs/pick and fallback
  it('d) Browse: fsPick fills field and checks summary; cancel does nothing; 501 opens in-app picker; src accepted', async () => {
    vi.mocked(api.fsPick).mockResolvedValue({
      path: 'C:\\Users\\me\\project\\src',
      cancelled: false,
    })
    vi.mocked(api.fsCheck).mockResolvedValue({
      ok: true,
      exists: true,
      is_dir: true,
      readable: true,
      markers: ['package.json'],
      supported_files: 42,
      has_code: true,
      has_docs: false,
      message: '≈ 42 supported files · Node.js project',
    })

    render(
      <MemoryRouter>
        <ProjectsForm />
      </MemoryRouter>
    )

    // Switch to Local folder tab
    fireEvent.click(screen.getByRole('tab', { name: 'Local folder' }))

    // Click Browse...
    const browseBtn = screen.getByRole('button', { name: /^Browse…$/i })
    fireEvent.click(browseBtn)

    await waitFor(() => {
      expect(api.fsPick).toHaveBeenCalled()
      expect(api.fsCheck).toHaveBeenCalledWith('C:\\Users\\me\\project\\src')
    })

    // Field filled and summary displayed
    const input = screen.getByPlaceholderText(/projects/i) as HTMLInputElement
    expect(input.value).toBe('C:\\Users\\me\\project\\src')
    expect(await screen.findByText(/42 supported files/i)).toBeTruthy()

    // Cancel case
    vi.mocked(api.fsPick).mockResolvedValue({ path: null, cancelled: true })
    fireEvent.click(browseBtn)
    await waitFor(() => {
      expect(input.value).toBe('C:\\Users\\me\\project\\src')
    })

    // 501 fallback opens in-app picker
    vi.mocked(api.fsPick).mockRejectedValue(new ApiError('Folder window not available', 501))
    vi.mocked(api.fsList).mockResolvedValue({
      path: '/root',
      parent: '',
      crumbs: [{ name: 'root', path: '/root' }],
      roots: [{ name: 'Home', path: '/root' }],
      entries: [{ name: 'my-project', path: '/root/my-project', kind: 'dir', is_project: true }],
      truncated: false,
    })

    fireEvent.click(browseBtn)
    expect(await screen.findByText('Choose a project folder')).toBeTruthy()
  })

  // e) ConnectPanel: command text uses detected server address and never "&&"; dimmed offline; session navigates
  it('e) ConnectPanel: command text uses detected server address without "&&"; dimmed offline; session navigates', async () => {
    useServer.setState({
      status: 'offline',
      base: 'http://127.0.0.1:8765',
    })

    const onSuccess = vi.fn()
    render(
      <MemoryRouter>
        <ConnectPanel onSuccess={onSuccess} />
      </MemoryRouter>
    )

    // Windows universal command: uses 127.0.0.1:8765, NEVER "&&"
    const commandText = screen.getByText(/irm http:\/\/127\.0\.0\.1:8765\/connect\.py \| python - \./i)
    expect(commandText).toBeTruthy()
    expect(commandText.textContent).not.toContain('&&')

    // Dimmed indicator shown when offline
    expect(screen.getByText('Start the server first (see below)')).toBeTruthy()

    // When session is found, navigates
    vi.mocked(api.connectSessions).mockResolvedValue({
      now: 2000,
      sessions: [
        {
          workspace_id: 'ws-live-e2e',
          name: 'LiveApp',
          path: '/app/LiveApp',
          job_id: 'job-live-2',
          created_at: 1999,
          reused: false,
        },
      ],
    })

    // Connects
    act(() => {
      useServer.setState({ status: 'online' })
    })

    await screen.findByText(/Connected LiveApp · live sync on/i, {}, { timeout: 4000 })
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledWith('ws-live-e2e')
    }, { timeout: 3000 })
  })

  // f) No form shows raw JSON errors; Esc closes dialog
  it('f) Form errors are human-readable (no raw JSON), and Esc closes dialog', () => {
    const rawError = {
      detail: [{ loc: ['body', 'url'], msg: 'invalid url format' }],
    }
    const formatted = formatApiError(rawError)
    expect(formatted).not.toContain('{')
    expect(formatted).not.toContain('[')
    expect(formatted).not.toContain('"msg"')

    const onClose = vi.fn()
    render(
      <MemoryRouter>
        <NewWorkspaceDialog onClose={onClose} />
      </MemoryRouter>
    )

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
