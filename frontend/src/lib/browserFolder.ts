import { zipSync } from 'fflate'
import { api, getApiBase, authHeaders, ApiError } from './api'
import { EXCLUDED_FOLDERS, shouldIncludeFile } from './folderUpload'

export interface FileEntryRecord {
  file: File
  relativePath: string
}

export interface HandleWalkResult {
  files: FileEntryRecord[]
  skippedFolders: string[]
  count: number
  newestLastModified: number
  totalBytes: number
  signature: string
}

export interface SyncState {
  active: boolean
  folderName: string
  pathHint: string
  workspaceId: string | null
  lastSyncTime: number | null
  status: 'idle' | 'syncing' | 'permission-needed' | 'uploading' | 'error'
  errorMessage?: string
  dirHandle: any | null
}

export function hasShowDirectoryPicker(): boolean {
  return typeof window !== 'undefined' && typeof (window as any).showDirectoryPicker === 'function'
}

export function getBrowserPathHint(folderName: string): string {
  const storageKey = `nexmind.folder_id.${folderName}`
  let stableId = ''
  try {
    stableId = localStorage.getItem(storageKey) || ''
    if (!stableId || !/^[A-Za-z0-9_-]{8,32}$/.test(stableId)) {
      const bytes = new Uint8Array(8)
      crypto.getRandomValues(bytes)
      stableId = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
      localStorage.setItem(storageKey, stableId)
    }
  } catch {
    stableId = 'session' + Math.random().toString(36).slice(2, 10)
  }
  return `browser:${folderName}:${stableId}`
}

export async function walkDirectoryHandle(
  dirHandle: any,
  currentPath = ''
): Promise<{ files: FileEntryRecord[]; skippedFolders: Set<string> }> {
  const files: FileEntryRecord[] = []
  const skippedFolders = new Set<string>()

  let iter: any = null
  if (typeof dirHandle.entries === 'function') {
    iter = dirHandle.entries()
  } else if (typeof dirHandle.values === 'function') {
    iter = dirHandle.values()
  }

  if (iter) {
    for await (const item of iter) {
      const [name, handle] = Array.isArray(item) ? item : [item.name, item]
      if (!name || name.startsWith('.')) continue

      if (handle.kind === 'directory') {
        if (EXCLUDED_FOLDERS.has(name.toLowerCase())) {
          skippedFolders.add(name)
          continue
        }
        const subPath = currentPath ? `${currentPath}/${name}` : name
        const sub = await walkDirectoryHandle(handle, subPath)
        for (const f of sub.files) files.push(f)
        for (const s of sub.skippedFolders) skippedFolders.add(s)
      } else if (handle.kind === 'file') {
        const file = await handle.getFile()
        const relativePath = currentPath ? `${currentPath}/${name}` : name
        if (shouldIncludeFile(relativePath, file.size, 'code')) {
          files.push({ file, relativePath })
        }
      }
    }
  }

  return { files, skippedFolders }
}

export async function computeHandleSignature(dirHandle: any): Promise<HandleWalkResult> {
  const { files, skippedFolders } = await walkDirectoryHandle(dirHandle)
  let newestLastModified = 0
  let totalBytes = 0
  for (const { file } of files) {
    totalBytes += file.size
    if (file.lastModified > newestLastModified) {
      newestLastModified = file.lastModified
    }
  }
  const count = files.length
  const signature = `${count}:${newestLastModified}:${totalBytes}`
  return {
    files,
    skippedFolders: Array.from(skippedFolders).sort(),
    count,
    newestLastModified,
    totalBytes,
    signature,
  }
}

export async function packDirectoryFiles(
  files: FileEntryRecord[],
  folderName: string
): Promise<File> {
  if (files.length === 0) {
    throw new Error('This folder has no source files we can analyze')
  }

  const totalBytes = files.reduce((acc, f) => acc + f.file.size, 0)
  if (totalBytes > 120 * 1024 * 1024) {
    throw new Error('Folder is larger than 120 MB after skipping dependencies; choose a sub-folder such as src')
  }

  const zippable: Record<string, Uint8Array> = {}
  for (const item of files) {
    const buf = await item.file.arrayBuffer()
    zippable[item.relativePath] = new Uint8Array(buf)
  }
  const zipBytes = zipSync(zippable)
  return new File([zipBytes], `${folderName}.zip`, { type: 'application/zip' })
}

export async function uploadArchiveChunked(
  file: File,
  onProgress?: (pct: number) => void
): Promise<string> {
  const name = file.name.slice(0, 300)
  const initRes = await fetch(`${getApiBase()}/api/uploads`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, size: file.size }),
  })
  if (!initRes.ok) {
    let detail = `Upload initialization failed (${initRes.status})`
    try {
      const d = await initRes.json()
      if (typeof d.detail === 'string') detail = d.detail
    } catch {}
    throw new ApiError(detail, initRes.status)
  }
  const init = (await initRes.json()) as { upload_id: string; chunk_size: number; chunks: number }

  for (let i = 0; i < init.chunks; i++) {
    const part = file.slice(i * init.chunk_size, (i + 1) * init.chunk_size)
    let attempt = 0
    for (;;) {
      try {
        const res = await fetch(`${getApiBase()}/api/uploads/${init.upload_id}/chunks/${i}`, {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/octet-stream' },
          body: part,
        })
        if (!res.ok) {
          let detail = `Upload failed (${res.status})`
          try {
            const d = await res.json()
            if (typeof d.detail === 'string') detail = d.detail
          } catch {}
          throw new ApiError(detail, res.status)
        }
        break
      } catch (e) {
        attempt += 1
        if (attempt >= 3 || (e instanceof ApiError && e.status >= 400 && e.status < 500)) {
          throw e instanceof ApiError ? e : new ApiError('Cannot reach the NexMind server. Is it running?')
        }
        await new Promise((r) => setTimeout(r, 600 * attempt))
      }
    }
    onProgress?.(Math.min(99, Math.round(((i + 1) / init.chunks) * 100)))
  }
  onProgress?.(100)
  return init.upload_id
}

class BrowserFolderSyncManager {
  private state: SyncState = {
    active: false,
    folderName: '',
    pathHint: '',
    workspaceId: null,
    lastSyncTime: null,
    status: 'idle',
    dirHandle: null,
  }

  private listeners = new Set<() => void>()
  private checkInterval: any = null
  private debounceTimer: any = null
  private lastUploadedSignature = ''
  private pendingCandidateSignature: string | null = null
  private isProcessing = false

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => this.stopSync())
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.state.active) {
          void this.performSignatureCheck()
        }
      })
    }
  }

  public getState(): SyncState {
    return this.state
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify() {
    this.listeners.forEach((l) => l())
  }

  public startSync(
    handle: any,
    folderName: string,
    pathHint: string,
    workspaceId: string,
    initialSignature: string
  ) {
    this.stopSync()
    this.state = {
      active: true,
      folderName,
      pathHint,
      workspaceId,
      lastSyncTime: Date.now(),
      status: 'syncing',
      dirHandle: handle,
    }
    this.lastUploadedSignature = initialSignature
    this.pendingCandidateSignature = null
    this.notify()

    this.checkInterval = setInterval(() => {
      void this.performSignatureCheck()
    }, 3000)
  }

  public stopSync() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval)
      this.checkInterval = null
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.state = {
      ...this.state,
      active: false,
      status: 'idle',
    }
    this.pendingCandidateSignature = null
    this.notify()
  }

  public async requestPermissionAgain(): Promise<boolean> {
    if (!this.state.dirHandle) return false
    try {
      if (typeof this.state.dirHandle.requestPermission === 'function') {
        const res = await this.state.dirHandle.requestPermission({ mode: 'read' })
        if (res === 'granted') {
          this.state = {
            ...this.state,
            status: 'syncing',
            errorMessage: undefined,
          }
          this.notify()
          void this.performSignatureCheck()
          return true
        }
      }
    } catch {
      // Permission request error
    }
    return false
  }

  public async performSignatureCheck() {
    if (!this.state.active || !this.state.dirHandle || this.isProcessing) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return

    try {
      if (typeof this.state.dirHandle.queryPermission === 'function') {
        const perm = await this.state.dirHandle.queryPermission({ mode: 'read' })
        if (perm !== 'granted') {
          this.state = { ...this.state, status: 'permission-needed' }
          this.notify()
          return
        }
      }

      const walk = await computeHandleSignature(this.state.dirHandle)
      const currentSignature = walk.signature

      if (currentSignature !== this.lastUploadedSignature) {
        if (this.pendingCandidateSignature !== currentSignature) {
          this.pendingCandidateSignature = currentSignature
          if (this.debounceTimer) clearTimeout(this.debounceTimer)
          this.debounceTimer = setTimeout(() => {
            void this.triggerReupload(walk)
          }, 2000)
        }
      } else {
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer)
          this.debounceTimer = null
        }
        this.pendingCandidateSignature = null
      }
    } catch (e: any) {
      if (e?.name === 'NotAllowedError') {
        this.state = { ...this.state, status: 'permission-needed' }
        this.notify()
      }
    }
  }

  private async triggerReupload(walk: HandleWalkResult) {
    if (!this.state.active || this.isProcessing) return
    this.isProcessing = true
    this.debounceTimer = null
    this.pendingCandidateSignature = null

    try {
      this.state = { ...this.state, status: 'uploading' }
      this.notify()

      const zipFile = await packDirectoryFiles(walk.files, this.state.folderName)
      const uploadId = await uploadArchiveChunked(zipFile)
      await api.connectUpload(uploadId, this.state.pathHint, this.state.folderName, true)

      this.lastUploadedSignature = walk.signature
      this.state = {
        ...this.state,
        status: 'syncing',
        lastSyncTime: Date.now(),
        errorMessage: undefined,
      }
    } catch (err: any) {
      this.state = {
        ...this.state,
        status: 'error',
        errorMessage: err?.message || 'Sync failed',
      }
    } finally {
      this.isProcessing = false
      this.notify()
    }
  }
}

export const browserFolderSync = new BrowserFolderSyncManager()
