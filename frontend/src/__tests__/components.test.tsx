import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Modal } from '@/components/Modal'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ConnectPanel } from '@/components/ConnectPanel'
import { AnalyzePanel } from '@/components/AnalyzePanel'
import { FolderPicker } from '@/components/FolderPicker'
import Hub from '@/pages/Hub'
import { api } from '@/lib/api'
import { useServer } from '@/lib/server'
import type { Workspace } from '@/lib/types'

// Mock api
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: {
      ...actual.api,
      workspaces: vi.fn(),
      deleteWorkspace: vi.fn(),
      renameWorkspace: vi.fn(),
      connectSessions: vi.fn(),
      connect: vi.fn(),
      fsList: vi.fn(),
      fsCheck: vi.fn(),
    },
  }
})

describe('Component test suite', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.clearAllMocks()
  })

  describe('Modal component', () => {
  it('renders with accessible dialog role, title, and handles backdrop and escape key', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <Modal open={true} onClose={onClose} title="Test Modal" subtitle="Subtitle">
        <p>Modal content</p>
      </Modal>
    )

    const dialog = screen.getByRole('dialog', { name: 'Test Modal' })
    expect(dialog).toBeTruthy()
    expect(screen.getByText('Modal content')).toBeTruthy()
    expect(screen.getByText('Subtitle')).toBeTruthy()

    // Press Escape
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    // Click close button
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
    expect(onClose).toHaveBeenCalledTimes(2)

    // Not rendered when open=false
    rerender(
      <Modal open={false} onClose={onClose} title="Test Modal">
        <p>Modal content</p>
      </Modal>
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('ErrorBoundary component', () => {
  it('catches render error, renders friendly card without blank screen, and allows Try again', () => {
    const ProblemChild = ({ shouldThrow }: { shouldThrow: boolean }) => {
      if (shouldThrow) throw new Error('Test component crash!')
      return <div>Normal Content</div>
    }

    // Suppress React boundary console.error during this test
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { rerender } = render(
      <ErrorBoundary label="Custom view failed">
        <ProblemChild shouldThrow={true} />
      </ErrorBoundary>
    )

    expect(screen.getByText('Custom view failed')).toBeTruthy()
    expect(screen.getByText('Test component crash!')).toBeTruthy()
    expect(screen.getByText(/Your data lives on the server/i)).toBeTruthy()

    const retryBtn = screen.getByRole('button', { name: 'Try again' })
    expect(retryBtn).toBeTruthy()

    // Rerender with good state and click Try again
    rerender(
      <ErrorBoundary label="Custom view failed">
        <ProblemChild shouldThrow={false} />
      </ErrorBoundary>
    )
    fireEvent.click(retryBtn)
    expect(screen.getByText('Normal Content')).toBeTruthy()

    consoleSpy.mockRestore()
  })
})

describe('ConnectPanel component', () => {
  beforeEach(() => {
    vi.mocked(api.connectSessions).mockResolvedValue({ now: 1000, sessions: [] })
    useServer.setState({
      health: { app: 'nexmind', status: 'ok', version: '1.1.0', llm: { provider: 'mock', model: null, available: true } },
      base: 'http://127.0.0.1:8000',
    })
  })

  it('renders OS selection tabs, universal commands without &&, and help section', async () => {
    render(
      <MemoryRouter>
        <ConnectPanel />
      </MemoryRouter>
    )

    expect(screen.getByText(/Waiting for your project/i)).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Windows' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'macOS' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Linux' })).toBeTruthy()

    // Switch to Windows tab
    fireEvent.click(screen.getByRole('tab', { name: 'Windows' }))
    const winBlocks = screen.getAllByText(/irm "http:\/\/127\.0\.0\.1:8000\/connect\.py\?k=[A-Za-z0-9_-]+" \| python - \./i)
    expect(winBlocks.length).toBeGreaterThan(0)

    // Switch to macOS tab
    fireEvent.click(screen.getByRole('tab', { name: 'macOS' }))
    const macBlocks = screen.getAllByText(/curl -fsSL "http:\/\/127\.0\.0\.1:8000\/connect\.py\?k=[A-Za-z0-9_-]+" \| python3 - \./i)
    expect(macBlocks.length).toBeGreaterThan(0)

    // Check help / fallback section
    expect(screen.getByText(/No terminal\? Pick the folder here/i)).toBeTruthy()
  })
})

describe('AnalyzePanel component', () => {
  it('renders git and local tabs for code kind and upload dropzone for docs kind', () => {
    const { rerender } = render(
      <MemoryRouter>
        <AnalyzePanel kind="code" />
      </MemoryRouter>
    )

    expect(screen.getByRole('tab', { name: 'GitHub' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'GitLab' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Upload project' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Local folder' })).toBeTruthy()

    rerender(
      <MemoryRouter>
        <AnalyzePanel kind="docs" />
      </MemoryRouter>
    )

    // In docs mode, upload is the primary interface
    expect(screen.getByText(/Drop PDFs, Word files/i)).toBeTruthy()
  })
})

describe('FolderPicker component', () => {
  it('renders directory listing, lazy expands subfolder, and enables Select button', async () => {
    vi.mocked(api.fsList).mockImplementation(async (targetPath?: string) => {
      if (targetPath && (targetPath.endsWith('app1') || targetPath.endsWith('app1/'))) {
        return {
          path: 'C:\\Projects\\app1',
          name: 'app1',
          parent: 'C:\\Projects',
          crumbs: [{ name: 'Projects', path: 'C:\\Projects' }, { name: 'app1', path: 'C:\\Projects\\app1' }],
          roots: [{ name: 'Home', path: 'C:\\Users\\test' }],
          entries: [
            { name: 'src', path: 'C:\\Projects\\app1\\src', kind: 'dir' },
            { name: 'package.json', path: 'C:\\Projects\\app1\\package.json', kind: 'file', size: 500 },
          ],
        }
      }
      return {
        path: 'C:\\Projects',
        name: 'Projects',
        parent: 'C:\\',
        crumbs: [{ name: 'Projects', path: 'C:\\Projects' }],
        roots: [{ name: 'Home', path: 'C:\\Users\\test' }],
        entries: [
          { name: 'app1', path: 'C:\\Projects\\app1', kind: 'dir' },
          { name: 'app2', path: 'C:\\Projects\\app2', kind: 'dir' },
          { name: 'notes.txt', path: 'C:\\Projects\\notes.txt', kind: 'file', size: 1024 },
        ],
      }
    })

    vi.mocked(api.fsCheck).mockResolvedValue({
      ok: true,
      exists: true,
      is_dir: true,
      readable: true,
      markers: ['package.json'],
      supported_files: 10,
      has_code: true,
      has_docs: false,
      message: 'Ready',
    })

    const onPick = vi.fn()
    render(<FolderPicker onPick={onPick} onClose={() => {}} initialPath="C:\\Projects" />)

    // Initial folder loaded
    expect(await screen.findByText('app1')).toBeTruthy()
    expect(screen.getByText('app2')).toBeTruthy()
    expect(screen.getByText('notes.txt')).toBeTruthy()

    // Select button is visible
    const selectBtn = screen.getByRole('button', { name: /Select/i })
    expect(selectBtn).toBeTruthy()

    // Expand app1
    const expandBtn = screen.getByRole('button', { name: /Expand app1/i })
    fireEvent.click(expandBtn)

    // Wait for subfolder to appear
    expect(await screen.findByText('src')).toBeTruthy()
    expect(screen.getByText('package.json')).toBeTruthy()

    // Click select button
    fireEvent.click(selectBtn)
    expect(onPick).toHaveBeenCalledWith('C:\\Projects')
  })

  it('renders clear error message when folder listing fails', async () => {
    vi.mocked(api.fsList).mockRejectedValue(new Error('Access is denied'))

    render(<FolderPicker onPick={() => {}} onClose={() => {}} initialPath="C:\\Forbidden" />)

    expect(await screen.findByText(/Access is denied/i)).toBeTruthy()
  })
})

describe('Hub component', () => {
  const sampleWorkspaces: Workspace[] = [
    { id: 'ws-1', name: 'Frontend App', description: '', kind: 'code', status: 'ready', created_at: 100, updated_at: 100, source_count: 1, thread_count: 0, stats: { nodes: 10, edges: 12, files: 5 } },
    { id: 'ws-2', name: 'API Docs', description: '', kind: 'docs', status: 'ready', created_at: 101, updated_at: 101, source_count: 1, thread_count: 0, stats: { nodes: 20, edges: 15, files: 8 } },
    { id: 'ws-3', name: 'Live Session', description: '', kind: 'live', status: 'ready', created_at: 102, updated_at: 102, source_count: 1, thread_count: 0, stats: { nodes: 5, edges: 4, files: 2 } },
  ]

  beforeEach(() => {
    vi.mocked(api.workspaces).mockResolvedValue(sampleWorkspaces)
  })

  it('filters workspaces by tab with accurate counts', async () => {
    render(
      <MemoryRouter>
        <Hub />
      </MemoryRouter>
    )

    // Wait for initial load
    expect(await screen.findByText('Frontend App')).toBeTruthy()

    // Check tabs: Projects (1), Documents (1), Live connect (1)
    const codeTab = screen.getByRole('tab', { name: /Projects\s*\(1\)/i })
    const docsTab = screen.getByRole('tab', { name: /Documents\s*\(1\)/i })
    const liveTab = screen.getByRole('tab', { name: /Live connect\s*\(1\)/i })

    expect(codeTab).toBeTruthy()
    expect(docsTab).toBeTruthy()
    expect(liveTab).toBeTruthy()

    // Switch to Documents tab
    fireEvent.click(docsTab)
    expect(screen.getByText('API Docs')).toBeTruthy()
    expect(screen.queryByText('Frontend App')).toBeNull()

    // Switch to Live connect tab
    fireEvent.click(liveTab)
    expect(screen.getByText('Live Session')).toBeTruthy()
    expect(screen.queryByText('API Docs')).toBeNull()
  })

  it('inline rename with Enter saves and updates workspace', async () => {
    vi.mocked(api.renameWorkspace).mockResolvedValue({
      ...sampleWorkspaces[0],
      name: 'Renamed App',
    })

    render(
      <MemoryRouter>
        <Hub />
      </MemoryRouter>
    )

    const titleH2 = await screen.findByRole('heading', { name: 'Frontend App' })
    expect(titleH2).toBeTruthy()

    // Clicking heading switches to input field
    fireEvent.click(titleH2)

    const input = screen.getByDisplayValue('Frontend App')
    fireEvent.change(input, { target: { value: 'Renamed App' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(api.renameWorkspace).toHaveBeenCalledWith('ws-1', 'Renamed App')
    })
  })

  it('delete workspace requires confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.mocked(api.deleteWorkspace).mockResolvedValue()

    render(
      <MemoryRouter>
        <Hub />
      </MemoryRouter>
    )

    expect(await screen.findByText('Frontend App')).toBeTruthy()

    const deleteBtn = screen.getByRole('button', { name: /Delete Frontend App/i })
    fireEvent.click(deleteBtn)

    expect(confirmSpy).toHaveBeenCalled()
    await waitFor(() => {
      expect(api.deleteWorkspace).toHaveBeenCalledWith('ws-1')
    })

    confirmSpy.mockRestore()
  })
})
})
