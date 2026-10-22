import { api, getApiBase, authHeaders, ApiError, uploadChunkedFile } from './api'
import { EXCLUDED_FOLDERS, BINARY_EXTS, shouldIncludeFile, packWithWorker } from './folderUpload'

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
  fileCount?: number
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

const MAX_LEAN_FILES = 5000
const MAX_LEAN_BYTES = 60 * 1024 * 1024 // 60 MB
const MAX_FILE_SIZE = 2 * 1024 * 1024 // 2 MB

export async function walkDirectoryHandle(
  dirHandle: any,
  currentPath = '',
  stats?: { totalFiles: number; totalBytes: number }
): Promise<{ files: FileEntryRecord[]; skippedFolders: Set<string> }> {
  const currentStats = stats || { totalFiles: 0, totalBytes: 0 }
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
      if (!name) continue
      const lowerName = name.toLowerCase()

      if (handle.kind === 'directory') {
        // Skip ignored folders without opening them
        if (EXCLUDED_FOLDERS.has(lowerName) || lowerName.startsWith('.')) {
          skippedFolders.add(name)
          continue
        }
        const subPath = currentPath ? `${currentPath}/${name}` : name
        const sub = await walkDirectoryHandle(handle, subPath, currentStats)
        for (const f of sub.files) files.push(f)
        for (const s of sub.skippedFolders) skippedFolders.add(s)
      } else if (handle.kind === 'file') {
        if (name.startsWith('.')) continue

        const lastDot = name.lastIndexOf('.')
        const ext = lastDot >= 0 ? lowerName.slice(lastDot) : ''
        if (BINARY_EXTS.has(ext)) {
          continue
        }

        const file = await handle.getFile()
        if (file.size > MAX_FILE_SIZE) {
          continue
        }

        const relativePath = currentPath ? `${currentPath}/${name}` : name
        if (shouldIncludeFile(relativePath, file.size, 'code')) {
          currentStats.totalFiles++
          currentStats.totalBytes += file.size

          if (currentStats.totalFiles > MAX_LEAN_FILES || currentStats.totalBytes > MAX_LEAN_BYTES) {
            throw new Error('Too large to upload: choose a sub-folder such as src, or analyze on this computer')
          }

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
  folderName: string,
  manifest?: Record<string, string>
): Promise<{ zipFile: File | null; changedCount: number; deleted: string[] }> {
  if (files.length === 0) {
    throw new Error('This folder has no source files we can analyze')
  }

  const rawFiles = files.map((f) => f.file)
  const res = await packWithWorker(rawFiles, { folderName, manifest })
  return {
    zipFile: res.zipFile,
    changedCount: res.changedCount,
    deleted: res.deleted,
  }
}

export async function uploadArchiveChunked(
  file: File,
  onProgress?: (pct: number) => void
): Promise<string> {
  return uploadChunkedFile(file, file.name, (pct) => onProgress?.(pct))
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
    initialSignature: string,
    fileCount?: number
  ) {
    this.stopSync()
    this.state = {
      active: true,
      folderName,
      pathHint,
      workspaceId,
      lastSyncTime: Date.now(),
      fileCount,
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

      let manifestFiles: Record<string, string> | undefined
      try {
        const manifestRes = await api.sourcesManifest({
          path_hint: this.state.pathHint,
          workspace_id: this.state.workspaceId || undefined,
        })
        if (manifestRes && manifestRes.files) {
          manifestFiles = manifestRes.files
        }
      } catch {
        /* proceed with full upload if manifest not supported */
      }

      const { zipFile, changedCount, deleted } = await packDirectoryFiles(
        walk.files,
        this.state.folderName,
        manifestFiles
      )

      if (manifestFiles && changedCount === 0 && deleted.length === 0) {
        this.lastUploadedSignature = walk.signature
        this.state = {
          ...this.state,
          status: 'syncing',
          lastSyncTime: Date.now(),
          fileCount: walk.count,
          errorMessage: undefined,
        }
        return
      }

      let uploadId: string | null = null
      if (zipFile && changedCount > 0) {
        uploadId = await uploadArchiveChunked(zipFile)
      }

      if (manifestFiles) {
        await api.connectDelta({
          path_hint: this.state.pathHint,
          upload_id: uploadId,
          deleted,
          name: this.state.folderName,
          watch: true,
        })
      } else if (uploadId) {
        await api.connectUpload(uploadId, this.state.pathHint, this.state.folderName, true)
      }

      this.lastUploadedSignature = walk.signature
      this.state = {
        ...this.state,
        status: 'syncing',
        lastSyncTime: Date.now(),
        fileCount: walk.count,
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
