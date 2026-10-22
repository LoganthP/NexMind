import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import {
  useServer,
  beginActivity,
  endActivity,
  resetFailureTracking,
  isHostedEnvironment,
  isLocalPathsSupported,
} from '@/lib/server'
import { uploadChunkedFile, api } from '@/lib/api'
import { FolderReview } from '@/components/FolderReview'
import { ProjectsForm } from '@/components/ModeForms/ProjectsForm'
import { DocumentsForm } from '@/components/ModeForms/DocumentsForm'
import { ConnectPanel } from '@/components/ConnectPanel'
import { packWithWorker, isDefaultExcluded } from '@/lib/folderUpload'

describe('Fast Upload, Connection Stability, and Folder Review', () => {
  const originalFetch = globalThis.fetch
  const originalLocation = window.location

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    sessionStorage.clear()
    resetFailureTracking()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
    vi.useRealTimers()
  })

  // 1. server.ts tests
  describe('server.ts connection stability', () => {
    it('one failed probe during an active upload does not flip to offline; three failures over 6 s do; on an https non-localhost origin local_paths is false even with no health', async () => {
      // (a) https non-localhost origin: local_paths is false even with no health
      Object.defineProperty(window, 'location', {
        value: {
          href: 'https://nexmind-hosted.vercel.app/app',
          protocol: 'https:',
          host: 'nexmind-hosted.vercel.app',
          hostname: 'nexmind-hosted.vercel.app',
          port: '',
          origin: 'https://nexmind-hosted.vercel.app',
        },
        writable: true,
        configurable: true,
      })

      expect(isHostedEnvironment()).toBe(true)
      expect(isLocalPathsSupported({ health: null } as any)).toBe(false)

      // Initialize server state as online
      useServer.setState({
        status: 'online',
        connected: true,
        base: 'https://nexmind-hosted.vercel.app',
        health: { ok: true, app: 'nexmind', version: '1.1.0', capabilities: { local_paths: false } } as any,
      })

      // Mock fetch to simulate failure
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))

      // (b) One failed probe during an active upload does NOT flip to offline
      const endAct = beginActivity()
      try {
        const checkResult = await useServer.getState().check(100)
        // With active upload, check skips/preserves online
        expect(checkResult).toBe(true)
        expect(useServer.getState().status).toBe('online')
      } finally {
        endAct()
      }

      // (c) Now without active upload: failure debouncing
      // First probe failure
      await useServer.getState().check(100)
      expect(useServer.getState().status).toBe('online') // 1st failure: debounced

      // Second probe failure immediately
      await useServer.getState().check(100)
      expect(useServer.getState().status).toBe('online') // 2nd failure: debounced (<3 failures and <6s)

      // Fast forward time by 6500ms and 3rd failure
      vi.useFakeTimers()
      vi.advanceTimersByTime(6500)

      await useServer.getState().check(100)
      expect(useServer.getState().status).toBe('offline') // Now 3 failures and >6s: flips to offline
    })
  })

  // 2. setup_required banner in all three modes
  describe('setup_required from health', () => {
    it('setup_required from health shows the amber setup line and disables primary buttons in all three modes', async () => {
      useServer.setState({
        status: 'online',
        connected: true,
        base: 'https://nexmind.example.com',
        health: {
          ok: true,
          app: 'nexmind',
          version: '1.1.0',
          capabilities: { local_paths: false },
          setup_required: 'Postgres database connection string is not set',
        } as any,
      })

      // Mode 1: ProjectsForm
      const { unmount: unmountProjects } = render(
        <MemoryRouter>
          <ProjectsForm />
        </MemoryRouter>
      )
      expect(
        screen.getByText('Setup needed: Postgres database connection string is not set')
      ).toBeTruthy()
      const projectSubmitBtn = screen.getByRole('button', { name: /Analyze project/i }) as HTMLButtonElement
      expect(projectSubmitBtn.disabled).toBe(true)
      unmountProjects()

      // Mode 2: DocumentsForm
      const { unmount: unmountDocs } = render(
        <MemoryRouter>
          <DocumentsForm />
        </MemoryRouter>
      )
      expect(
        screen.getByText('Setup needed: Postgres database connection string is not set')
      ).toBeTruthy()
      const docSubmitBtn = screen.getByRole('button', { name: /Analyze documents/i }) as HTMLButtonElement
      expect(docSubmitBtn.disabled).toBe(true)
      unmountDocs()

      // Mode 3: ConnectPanel
      const { unmount: unmountConnect } = render(
        <MemoryRouter>
          <ConnectPanel />
        </MemoryRouter>
      )
      expect(
        screen.getByText('Setup needed: Postgres database connection string is not set')
      ).toBeTruthy()
      unmountConnect()
    })
  })

  // 3. FolderReview component
  describe('FolderReview component', () => {
    it('default exclusions applied (node_modules unchecked), counts update, "Only source files" works, limits block with message', async () => {
      expect(isDefaultExcluded('node_modules/react/index.js', 100, 'code')).toBe(true)
      expect(isDefaultExcluded('.git/HEAD', 50, 'code')).toBe(true)
      expect(isDefaultExcluded('src/app.tsx', 500, 'code')).toBe(false)
      expect(isDefaultExcluded('large-file.bin', 3 * 1024 * 1024, 'code')).toBe(true) // > 2MB

      const f1 = new File(['code'], 'index.ts', { type: 'text/typescript' })
      Object.defineProperty(f1, 'webkitRelativePath', { value: 'proj/src/index.ts' })
      const f2 = new File(['ignored'], 'react.js', { type: 'text/javascript' })
      Object.defineProperty(f2, 'webkitRelativePath', { value: 'proj/node_modules/react.js' })

      const onConfirm = vi.fn()
      const onChangeFolder = vi.fn()

      const { rerender } = render(
        <FolderReview
          files={[f1, f2]}
          mode="code"
          folderName="proj"
          onConfirm={onConfirm}
          onChangeFolder={onChangeFolder}
        />
      )

      // Node_modules unchecked by default: 1 of 2 files selected
      expect(screen.getByText(/Selected 1 of 2 files/i)).toBeTruthy()

      // Click "Select all"
      fireEvent.click(screen.getByRole('button', { name: /Select all/i }))
      expect(screen.getByText(/Selected 2 of 2 files/i)).toBeTruthy()

      // Click "Only source files"
      fireEvent.click(screen.getByRole('button', { name: /Only source files/i }))
      expect(screen.getByText(/Selected 1 of 2 files/i)).toBeTruthy()

      // Confirm submits only selected files
      fireEvent.click(screen.getByRole('button', { name: /Analyze 1 files/i }))
      expect(onConfirm).toHaveBeenCalledWith([f1])

      // Limits block: over 30,000 files or 120MB
      const hugeFile = new File(['data'], 'huge.ts', { type: 'text/typescript' })
      Object.defineProperty(hugeFile, 'size', { value: 130 * 1024 * 1024 })
      Object.defineProperty(hugeFile, 'webkitRelativePath', { value: 'proj/src/huge.ts' })

      rerender(
        <FolderReview
          files={[hugeFile]}
          mode="code"
          folderName="proj"
          onConfirm={onConfirm}
          onChangeFolder={onChangeFolder}
        />
      )

      // Select all to force-include the 130MB file
      fireEvent.click(screen.getByRole('button', { name: /Select all/i }))

      expect(
        screen.getByText(
          'Too much for one upload: choose a sub-folder such as src or uncheck large folders.'
        )
      ).toBeTruthy()
      expect((screen.getByRole('button', { name: /Analyze project/i }) as HTMLButtonElement).disabled).toBe(true)
    })
  })

  // 4. Uploader: 3 parallel chunks, retries, resume sends only missing chunks, Cancel aborts
  describe('Uploader chunking, retries, resume, and cancellation', () => {
    it('3 parallel chunks, retries, resume sends only missing chunks, Cancel aborts', async () => {
      const putCalls: number[] = []
      let putAttempts = 0

      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/uploads') && !url.includes('/chunks/')) {
          if (init?.method === 'POST') {
            return {
              ok: true,
              json: async () => ({ upload_id: 'up-123', chunk_size: 100, chunks: 5 }),
            }
          }
          if (init?.method === 'GET' || !init?.method) {
            // Server reports chunk 0 and 1 were already received (resume test)
            return {
              ok: true,
              json: async () => ({ upload_id: 'up-123', chunk_size: 100, chunks: 5, received: [0, 1] }),
            }
          }
        }
        if (url.includes('/chunks/')) {
          const match = url.match(/\/chunks\/(\d+)/)
          const chunkIdx = match ? parseInt(match[1], 10) : -1
          putAttempts++
          // Simulate transient failure on first attempt of chunk 2
          if (chunkIdx === 2 && putAttempts === 1) {
            return { ok: false, status: 500, json: async () => ({ detail: 'Transient error' }) }
          }
          putCalls.push(chunkIdx)
          return { ok: true, status: 200, json: async () => ({ ok: true }) }
        }
        return { ok: true, json: async () => ({}) }
      }) as any

      const dummyFile = new File([new Uint8Array(500)], 'test.zip', { type: 'application/zip' })

      // Run chunked upload (should resume from missing chunks [2, 3, 4] and retry chunk 2)
      const uploadId = await uploadChunkedFile(dummyFile, 'test.zip')
      expect(uploadId).toBe('up-123')
      // Only chunks 2, 3, 4 were sent (chunks 0 and 1 were already on server!)
      expect(putCalls.includes(0)).toBe(false)
      expect(putCalls.includes(1)).toBe(false)
      expect(putCalls.includes(2)).toBe(true)
      expect(putCalls.includes(3)).toBe(true)
      expect(putCalls.includes(4)).toBe(true)

      // Test Cancel aborts upload
      const ctl = new AbortController()
      ctl.abort()
      await expect(uploadChunkedFile(dummyFile, 'test.zip', undefined, ctl.signal)).rejects.toThrow(
        /Upload cancelled|aborted/i
      )
    })
  })

  // 5. Incremental sync
  describe('Incremental sync with SHA-1 hashing', () => {
    it('second sync of an unchanged folder uploads nothing; one changed file uploads only that file; a deleted file is sent in "deleted"', async () => {
      const f1 = new File(['alpha content'], 'alpha.ts', { type: 'text/typescript' })
      Object.defineProperty(f1, 'webkitRelativePath', { value: 'proj/alpha.ts' })
      const f2 = new File(['beta content'], 'beta.ts', { type: 'text/typescript' })
      Object.defineProperty(f2, 'webkitRelativePath', { value: 'proj/beta.ts' })

      // First pack (no manifest)
      const res1 = await packWithWorker([f1, f2], { folderName: 'proj' })
      expect(res1.zipFile).toBeTruthy()
      expect(res1.changedCount).toBe(2)
      const manifest1 = res1.hashes
      expect(manifest1['proj/alpha.ts']).toBeDefined()
      expect(manifest1['proj/beta.ts']).toBeDefined()

      // (a) Second sync of unchanged folder uploads nothing (zipFile is null, changedCount is 0)
      const res2 = await packWithWorker([f1, f2], { folderName: 'proj', manifest: manifest1 })
      expect(res2.zipFile).toBeNull()
      expect(res2.changedCount).toBe(0)
      expect(res2.deleted).toEqual([])

      // (b) One changed file uploads only that file
      const f1Changed = new File(['alpha modified content!'], 'alpha.ts', { type: 'text/typescript' })
      Object.defineProperty(f1Changed, 'webkitRelativePath', { value: 'proj/alpha.ts' })

      const res3 = await packWithWorker([f1Changed, f2], { folderName: 'proj', manifest: manifest1 })
      expect(res3.zipFile).toBeTruthy()
      expect(res3.changedCount).toBe(1)
      expect(res3.deleted).toEqual([])

      // (c) A deleted file is sent in "deleted"
      // Only f1 exists now (beta.ts was deleted)
      const res4 = await packWithWorker([f1], { folderName: 'proj', manifest: manifest1 })
      expect(res4.deleted).toContain('proj/beta.ts')
    })
  })

  // 6. Web Worker execution & mocking
  describe('Web Worker execution', () => {
    it('The pack worker is used (main thread not blocked; mock the worker in tests)', async () => {
      const mockPostMessage = vi.fn()
      const mockTerminate = vi.fn()

      class MockWorker {
        onmessage: any = null
        onerror: any = null
        terminate = mockTerminate

        postMessage = (req: any) => {
          mockPostMessage(req)
          setTimeout(() => {
            if (this.onmessage) {
              const doneMsg = {
                type: 'done',
                id: req.id,
                zipBuffer: new ArrayBuffer(8),
                hashes: { 'proj/a.ts': 'sha123' },
                changedCount: 1,
                deleted: [],
                totalFiles: 1,
              }
              this.onmessage({ data: doneMsg })
            }
          }, 0)
        }
      }

      ;(globalThis as any).Worker = MockWorker as any

      const f = new File(['const x = 1'], 'a.ts', { type: 'text/typescript' })
      Object.defineProperty(f, 'webkitRelativePath', { value: 'proj/a.ts' })

      const res = await packWithWorker([f], { folderName: 'proj' })
      expect(mockPostMessage).toHaveBeenCalled()
      expect(res.zipFile).toBeTruthy()
      expect(res.hashes['proj/a.ts']).toBe('sha123')
      expect(mockTerminate).toHaveBeenCalled()

      delete (globalThis as any).Worker
    })
  })
})
