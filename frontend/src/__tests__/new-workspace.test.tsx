import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NewWorkspaceDialog } from '@/components/NewWorkspaceDialog'
import { FolderPicker } from '@/components/FolderPicker'
import Hub from '@/pages/Hub'
import { toast, useToasts } from '@/lib/store'
import { api, formatApiError } from '@/lib/api'
import { useServer } from '@/lib/server'
import type { Workspace } from '@/lib/types'

// Mock api methods
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: {
      ...actual.api,
      workspaces: vi.fn(),
      connectSessions: vi.fn(),
      connect: vi.fn(),
      fsList: vi.fn(),
      fsCheck: vi.fn(),
      createWorkspace: vi.fn(),
      ingestGit: vi.fn(),
      ingestLocal: vi.fn(),
    },
  }
})

describe('NewWorkspaceDialog and Live Connect experience', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useToasts.setState({ items: [] })
    useServer.setState({
      status: 'online',
      connected: true,
      justConnected: Date.now(),
      base: 'http://127.0.0.1:8000',
      health: { app: 'nexmind', status: 'ok', version: '1.1.0', llm: { provider: 'mock', model: null, available: true } },
    })
  })

  it('a) Clicking "New workspace" shows step 1 with exactly three cards and no URL/token/folder fields', () => {
    render(
      <MemoryRouter>
        <NewWorkspaceDialog onClose={() => {}} />
      </MemoryRouter>
    )

    // Heading for Step 1
    expect(screen.getByText('What do you want to explore?')).toBeTruthy()

    // Exactly three cards
    expect(screen.getByText('Projects')).toBeTruthy()
    expect(screen.getByText('Documents')).toBeTruthy()
    expect(screen.getByText('Live connect')).toBeTruthy()

    // No form fields on step 1
    expect(screen.queryByPlaceholderText(/https:\/\/github\.com/i)).toBeNull()
    expect(screen.queryByPlaceholderText(/ghp_/i)).toBeNull()
    expect(screen.queryByPlaceholderText(/Folder on this computer/i)).toBeNull()
    expect(screen.queryByPlaceholderText(/Workspace name/i)).toBeNull()
  })

  it('b) Choosing Live connect shows command blocks and "Waiting for your project", and NO GitHub/GitLab tabs; detects session and navigates', async () => {
    let callCount = 0
    vi.mocked(api.connectSessions).mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return { now: 1000, sessions: [] }
      }
      return {
        now: 1002,
        sessions: [
          {
            workspace_id: 'ws-live-test',
            name: 'SampleLive',
            path: '/Users/test/SampleLive',
            job_id: 'job-live-1',
            created_at: 1001,
            reused: false,
          },
        ],
      }
    })

    const onClose = vi.fn()
    render(
      <MemoryRouter>
        <NewWorkspaceDialog initialMode="live" onClose={onClose} />
      </MemoryRouter>
    )

    // Step 1: select Live connect
    fireEvent.click(screen.getByText('Live connect'))

    // Step 2 should display command blocks and "Waiting for your project"
    expect(await screen.findByText(/Waiting for your project/i)).toBeTruthy()
    expect(screen.getByText(/Open your project in VS Code/i)).toBeTruthy()
    expect(screen.getAllByText(/nexmind connect \./i).length).toBeGreaterThan(0)

    // Must NOT show GitHub/GitLab/Azure/Upload tabs
    expect(screen.queryByRole('tab', { name: 'GitHub' })).toBeNull()
    expect(screen.queryByRole('tab', { name: 'GitLab' })).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Azure DevOps' })).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Upload project' })).toBeNull()

    // Wait for polling to find the new session and show Connected
    await screen.findByText(/Connected SampleLive · live sync on/i, {}, { timeout: 4000 })
  })

  it('c) Choosing Projects shows five tabs; choosing Documents shows only upload area', () => {
    const { unmount } = render(
      <MemoryRouter>
        <NewWorkspaceDialog onClose={() => {}} />
      </MemoryRouter>
    )

    // Choose Projects
    fireEvent.click(screen.getByText('Projects'))

    // Verify 5 tabs in Projects
    expect(screen.getByRole('tab', { name: 'GitHub' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'GitLab' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Azure DevOps' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Upload project' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Local folder' })).toBeTruthy()

    unmount()

    // Render again for Documents
    render(
      <MemoryRouter>
        <NewWorkspaceDialog onClose={() => {}} />
      </MemoryRouter>
    )

    fireEvent.click(screen.getByText('Documents'))

    // Only upload area and name field
    expect(screen.queryByRole('tab', { name: 'GitHub' })).toBeNull()
    expect(screen.queryByRole('tab', { name: 'GitLab' })).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Azure DevOps' })).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Local folder' })).toBeNull()
    expect(screen.getByText(/Drop PDFs, Word files, notes or zipped folders of documents/i)).toBeTruthy()
    expect(screen.getByPlaceholderText('Document study')).toBeTruthy()
  })

  it('d) Mocked 422 response produces one readable toast (no braces/quotes JSON) and three identical errors collapse', () => {
    const pydanticError = {
      detail: [{ loc: ['body', 'kind'], msg: "Input should be 'code' or 'docs'" }],
    }

    const formatted = formatApiError(pydanticError)
    expect(formatted).toBe('The workspace type is not supported by this server version. Restart the backend after updating.')
    expect(formatted).not.toContain('{')
    expect(formatted).not.toContain('[')

    // Trigger toast 3 times with the error
    toast.error(pydanticError)
    toast.error(pydanticError)
    toast.error(pydanticError)

    const state = useToasts.getState()
    // Identical toasts should collapse into 1 item
    expect(state.items.length).toBe(1)
    expect(state.items[0].text).toContain('x3')
    expect(state.items[0].kind).toBe('error')
  })

  it('e) FolderPicker: expands folder inline, selects with one click, shows files, and Select button is enabled', async () => {
    vi.mocked(api.fsList).mockImplementation(async (path?: string) => {
      if (path === '/root/my-app') {
        return {
          path: '/root/my-app',
          parent: '/root',
          crumbs: [
            { name: 'root', path: '/root' },
            { name: 'my-app', path: '/root/my-app' },
          ],
          roots: [{ name: 'Home', path: '/root' }],
          entries: [
            { name: 'src', path: '/root/my-app/src', kind: 'dir', is_project: false },
            { name: 'package.json', path: '/root/my-app/package.json', kind: 'file', size: 1024 },
          ],
          truncated: false,
        }
      }
      return {
        path: '/root',
        parent: '',
        crumbs: [{ name: 'root', path: '/root' }],
        roots: [{ name: 'Home', path: '/root' }],
        entries: [
          { name: 'my-app', path: '/root/my-app', kind: 'dir', is_project: true, markers: ['package.json'] },
        ],
        truncated: false,
      }
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

    const onPick = vi.fn()
    render(<FolderPicker initialPath="/root" onPick={onPick} onClose={() => {}} />)

    // Wait for initial load of /root
    await screen.findByText('my-app')
    expect(screen.getByText('Project')).toBeTruthy()

    // Expand folder inline by clicking chevron
    const chevronBtn = screen.getByLabelText(/Expand my-app/i)
    fireEvent.click(chevronBtn)

    // Children loaded inline: src directory and package.json file row
    await screen.findByText('package.json')
    expect(screen.getByText('src')).toBeTruthy()

    // Select my-app folder with one click on the folder name/row
    fireEvent.click(screen.getByText('my-app'))

    // The Select button should be enabled without scrolling
    const selectBtn = screen.getByRole('button', { name: /Select this folder/i })
    expect(selectBtn).not.toBeNull()
    expect((selectBtn as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(selectBtn)
    expect(onPick).toHaveBeenCalledWith('/root/my-app')

    // Typing a path and pressing Enter navigates
    const pathInput = screen.getByPlaceholderText(/Paste or type path/i)
    fireEvent.change(pathInput, { target: { value: '/root/my-app' } })
    fireEvent.submit(pathInput.closest('form')!)

    await waitFor(() => {
      expect(api.fsList).toHaveBeenCalledWith('/root/my-app', 1)
    })
  })
})

describe('Mode selection and step skipping UX in Hub and NewWorkspaceDialog', () => {
  const sampleWorkspace: Workspace = {
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

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.connectSessions).mockResolvedValue({ now: 1000, sessions: [] })
    useServer.setState({
      status: 'online',
      connected: true,
      justConnected: Date.now(),
      base: 'http://127.0.0.1:8000',
      health: { app: 'nexmind', status: 'ok', version: '1.1.0', llm: { provider: 'mock', model: null, available: true } },
    })
  })

  it('(a) first-run screen: clicking each card opens the dialog on step 2 for the right mode, and the text "What do you want to explore?" is NOT shown', async () => {
    vi.mocked(api.workspaces).mockResolvedValue([])

    const { unmount } = render(
      <MemoryRouter>
        <Hub />
      </MemoryRouter>
    )

    expect(await screen.findByText('Create your first workspace')).toBeTruthy()

    // 1. Analyze a project card -> step 2 code
    const codeCard = screen.getByText('Analyze a project')
    fireEvent.click(codeCard)
    expect(screen.queryByText('What do you want to explore?')).toBeNull()
    expect(screen.getByText('New Projects')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'GitHub' })).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Close dialog'))
    expect(screen.queryByRole('dialog')).toBeNull()

    // 2. Study from documents card -> step 2 docs
    const docsCard = screen.getByText('Study from documents')
    fireEvent.click(docsCard)
    expect(screen.queryByText('What do you want to explore?')).toBeNull()
    expect(screen.getByText('New Documents')).toBeTruthy()
    expect(screen.getByText(/Drop PDFs, Word files/i)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Close dialog'))
    expect(screen.queryByRole('dialog')).toBeNull()

    // 3. Live connect card -> step 2 live
    const liveCard = screen.getByText('Live connect')
    fireEvent.click(liveCard)
    expect(screen.queryByText('What do you want to explore?')).toBeNull()
    expect(screen.getByText('New Live connect')).toBeTruthy()
    expect(screen.getByText(/Waiting for your project/i)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Close dialog'))

    unmount()
  })

  it('(b) top-right "+ New workspace" (render the Hub with one existing workspace) opens step 1 showing exactly three options', async () => {
    vi.mocked(api.workspaces).mockResolvedValue([sampleWorkspace])

    render(
      <MemoryRouter>
        <Hub />
      </MemoryRouter>
    )

    expect(await screen.findByText('Existing Project')).toBeTruthy()

    // Click top-right "+ New workspace"
    const newWsBtn = screen.getByRole('button', { name: /^New workspace$/i })
    fireEvent.click(newWsBtn)

    // Opens step 1
    expect(screen.getByText('What do you want to explore?')).toBeTruthy()
    expect(screen.getByText('Projects')).toBeTruthy()
    expect(screen.getByText('Documents')).toBeTruthy()
    expect(screen.getByText('Live connect')).toBeTruthy()
  })

  it('(c) choosing an option in step 1 goes to step 2 of that mode', async () => {
    vi.mocked(api.workspaces).mockResolvedValue([sampleWorkspace])

    render(
      <MemoryRouter>
        <Hub />
      </MemoryRouter>
    )

    expect(await screen.findByText('Existing Project')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^New workspace$/i }))

    expect(screen.getByText('What do you want to explore?')).toBeTruthy()

    // Click 'Projects' option in step 1
    fireEvent.click(screen.getByText('Projects'))

    // Navigates to step 2 for Projects
    expect(screen.queryByText('What do you want to explore?')).toBeNull()
    expect(screen.getByText('New Projects')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'GitHub' })).toBeTruthy()
  })

  it('(d) Back from a step-2 dialog opened from a card returns to step 1', async () => {
    vi.mocked(api.workspaces).mockResolvedValue([])

    render(
      <MemoryRouter>
        <Hub />
      </MemoryRouter>
    )

    expect(await screen.findByText('Create your first workspace')).toBeTruthy()

    // Click Study from documents card (opens directly on step 2)
    fireEvent.click(screen.getByText('Study from documents'))
    expect(screen.getByText('New Documents')).toBeTruthy()
    expect(screen.queryByText('What do you want to explore?')).toBeNull()

    // Click Back button
    const backBtn = screen.getByRole('button', { name: /Back to choices/i })
    fireEvent.click(backBtn)

    // Returns to step 1 chooser
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('What do you want to explore?')).toBeTruthy()
    expect(within(dialog).getByText('Projects')).toBeTruthy()
    expect(within(dialog).getByText('Documents')).toBeTruthy()
    expect(within(dialog).getByText('Live connect')).toBeTruthy()
  })

  it('(e) closing and reopening from the top-right button shows step 1 again, then from a card shows step 2', async () => {
    vi.mocked(api.workspaces).mockResolvedValue([sampleWorkspace])

    const { unmount } = render(
      <MemoryRouter>
        <Hub />
      </MemoryRouter>
    )

    expect(await screen.findByText('Existing Project')).toBeTruthy()

    // 1. Open from top-right -> step 1
    fireEvent.click(screen.getByRole('button', { name: /^New workspace$/i }))
    expect(screen.getByText('What do you want to explore?')).toBeTruthy()

    // 2. Close dialog
    fireEvent.click(screen.getByLabelText('Close dialog'))
    expect(screen.queryByRole('dialog')).toBeNull()

    // 3. Open from top-right again -> still step 1
    fireEvent.click(screen.getByRole('button', { name: /^New workspace$/i }))
    expect(screen.getByText('What do you want to explore?')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Close dialog'))

    unmount()

    // 4. Now render first-run and click a card -> step 2
    vi.mocked(api.workspaces).mockResolvedValue([])
    render(
      <MemoryRouter>
        <Hub />
      </MemoryRouter>
    )
    expect(await screen.findByText('Create your first workspace')).toBeTruthy()
    fireEvent.click(screen.getByText('Live connect'))
    expect(screen.queryByText('What do you want to explore?')).toBeNull()
    expect(screen.getByText('New Live connect')).toBeTruthy()
  })

  it('(f) empty-tab CTA opens step 2 with the tab\'s mode', async () => {
    vi.mocked(api.workspaces).mockResolvedValue([sampleWorkspace])

    render(
      <MemoryRouter>
        <Hub />
      </MemoryRouter>
    )

    expect(await screen.findByText('Existing Project')).toBeTruthy()

    // Switch to Documents tab (which has 0 workspaces)
    const docsTab = screen.getByRole('tab', { name: /Documents\s*\(0\)/i })
    fireEvent.click(docsTab)

    expect(screen.getByText('No document study workspaces yet.')).toBeTruthy()

    // Click empty-tab CTA button (the second "New workspace" button on page, btn-ghost)
    const buttons = screen.getAllByRole('button', { name: /^New workspace$/i })
    const ctaBtn = buttons.find((b) => b.classList.contains('btn-ghost')) || buttons[1]
    fireEvent.click(ctaBtn)

    // Opens step 2 with docs mode directly
    expect(screen.queryByText('What do you want to explore?')).toBeNull()
    expect(screen.getByText('New Documents')).toBeTruthy()
    expect(screen.getByText(/Drop PDFs, Word files/i)).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Close dialog'))

    // Switch to Live connect tab (which also has 0 workspaces)
    const liveTab = screen.getByRole('tab', { name: /Live connect\s*\(0\)/i })
    fireEvent.click(liveTab)

    expect(screen.getByText('No live connect workspaces yet.')).toBeTruthy()
    const liveButtons = screen.getAllByRole('button', { name: /^New workspace$/i })
    const liveCta = liveButtons.find((b) => b.classList.contains('btn-ghost')) || liveButtons[1]
    fireEvent.click(liveCta)

    // Opens step 2 with live mode directly
    expect(screen.queryByText('What do you want to explore?')).toBeNull()
    expect(screen.getByText('New Live connect')).toBeTruthy()
    expect(screen.getByText(/Waiting for your project/i)).toBeTruthy()
  })

  it('autofocuses the first input of that mode when opening on step 2', async () => {
    // 1. code mode -> repository URL input
    const { unmount: unmountCode } = render(
      <MemoryRouter>
        <NewWorkspaceDialog initialMode="code" onClose={() => {}} />
      </MemoryRouter>
    )
    await waitFor(() => {
      const active = document.activeElement
      expect(active?.tagName).toBe('INPUT')
      expect((active as HTMLInputElement).placeholder).toContain('github.com')
    })
    unmountCode()

    // 2. docs mode -> Choose files button
    const { unmount: unmountDocs } = render(
      <MemoryRouter>
        <NewWorkspaceDialog initialMode="docs" onClose={() => {}} />
      </MemoryRouter>
    )
    await waitFor(() => {
      const active = document.activeElement
      expect(active?.tagName).toBe('BUTTON')
      expect(active?.textContent).toContain('Choose files')
    })
    unmountDocs()

    // 3. live mode -> Copy command button
    const { unmount: unmountLive } = render(
      <MemoryRouter>
        <NewWorkspaceDialog initialMode="live" onClose={() => {}} />
      </MemoryRouter>
    )
    await waitFor(() => {
      const active = document.activeElement
      expect(active?.tagName).toBe('BUTTON')
      expect(active?.getAttribute('aria-label')).toMatch(/^Copy command/i)
    })
    unmountLive()
  })
})
