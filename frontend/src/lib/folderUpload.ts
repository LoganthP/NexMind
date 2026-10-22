import { zipSync, zip, type AsyncZippable } from 'fflate'
import { beginActivity, endActivity } from './server'
import type {
  PackWorkerRequest,
  PackWorkerResponse,
  PackWorkerProgressMessage,
  PackWorkerDoneMessage,
  PackWorkerErrorMessage,
} from '@/workers/pack.worker'

export interface PackFolderResult {
  file: File
  fileCount: number
  totalBytes: number
  formattedSize: string
  label: string
  skippedFolders: string[]
}

export const EXCLUDED_FOLDERS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'out',
  'target',
  'venv',
  '.venv',
  '__pycache__',
  'coverage',
  '.cache',
  'vendor',
  '.nuxt',
  'bower_components',
])

const DOC_EXTS = new Set([
  '.pdf',
  '.docx',
  '.doc',
  '.md',
  '.markdown',
  '.txt',
  '.html',
  '.htm',
  '.rtf',
  '.zip',
  '.tar.gz',
])

const BINARY_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.tiff',
  '.svg',
  '.psd',
  '.ai',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.pyc',
  '.pyo',
  '.o',
  '.a',
  '.class',
  '.jar',
  '.war',
  '.ear',
  '.wasm',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.7z',
  '.rar',
  '.iso',
  '.dmg',
  '.pkg',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.mp3',
  '.mp4',
  '.wav',
  '.avi',
  '.mov',
  '.mkv',
  '.webm',
  '.ogg',
  '.flac',
  '.m4a',
  '.pdf',
])

export function getRelativePath(file: File): string {
  const rel = (file as any).webkitRelativePath || file.name || 'file'
  return rel.replace(/\\/g, '/').replace(/^\/+/, '')
}

/** Check if a file should be excluded by default in FolderReview */
export function isDefaultExcluded(
  path: string,
  fileSize: number,
  mode: 'code' | 'docs' | 'live' = 'code'
): boolean {
  const cleanPath = path.replace(/\\/g, '/').replace(/^\/+/, '')
  const segments = cleanPath.split('/')
  const filename = segments[segments.length - 1]
  const lowerFilename = filename.toLowerCase()

  // Hidden files or directory segments (starting with dot)
  if (segments.some((seg) => seg.startsWith('.'))) {
    return true
  }

  // Pre-unchecked folders: node_modules, .git, dist, build, .next, out, target, venv/.venv, __pycache__, coverage, .cache, vendor
  const dirSegments = segments.slice(0, -1)
  if (dirSegments.some((seg) => EXCLUDED_FOLDERS.has(seg.toLowerCase()))) {
    return true
  }

  // Lock files, minified files, sourcemaps
  if (
    lowerFilename.endsWith('.lock') ||
    lowerFilename === 'package-lock.json' ||
    lowerFilename === 'pnpm-lock.yaml' ||
    lowerFilename === 'yarn.lock' ||
    lowerFilename === 'cargo.lock' ||
    lowerFilename === 'poetry.lock' ||
    lowerFilename === 'gemfile.lock' ||
    lowerFilename === 'composer.lock' ||
    lowerFilename.endsWith('.min.js') ||
    lowerFilename.endsWith('.min.css') ||
    lowerFilename.endsWith('.map')
  ) {
    return true
  }

  const dotIdx = filename.lastIndexOf('.')
  const ext = dotIdx >= 0 ? filename.slice(dotIdx).toLowerCase() : ''

  if (mode === 'docs') {
    // Documents limit: 30 MB
    if (fileSize > 30 * 1024 * 1024) return true
    return !DOC_EXTS.has(ext)
  }

  // Projects / Live mode: 2 MB limit & binaries/media
  if (fileSize > 2 * 1024 * 1024) {
    return true
  }

  if (BINARY_EXTS.has(ext)) {
    return true
  }

  return false
}

export function shouldIncludeFile(
  path: string,
  fileSize: number,
  mode: 'docs' | 'code'
): boolean {
  return !isDefaultExcluded(path, fileSize, mode)
}

function bufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

export interface PackWorkerResult {
  zipFile: File | null
  hashes: Record<string, string>
  changedCount: number
  deleted: string[]
  totalFiles: number
}

/**
 * Packs files using Web Worker (with fallback to main thread if Worker is unavailable).
 */
export async function packWithWorker(
  files: File[],
  options: {
    folderName?: string
    manifest?: Record<string, string>
    onProgress?: (phase: 'reading' | 'packing', text: string, pct: number) => void
    signal?: AbortSignal
  } = {}
): Promise<PackWorkerResult> {
  const { folderName = 'project', manifest, onProgress, signal } = options
  const endAct = beginActivity()

  try {
    const fileItems = files.map((f) => ({
      path: getRelativePath(f),
      file: f,
    }))

    // In browsers that support Worker, use the dedicated worker
    let worker: Worker | null = null
    try {
      if (typeof Worker !== 'undefined') {
        worker = new Worker(new URL('../workers/pack.worker.ts', import.meta.url), {
          type: 'module',
        })
      }
    } catch {
      worker = null
    }

    if (worker) {
      return await new Promise<PackWorkerResult>((resolve, reject) => {
        const id = Math.random().toString(36).slice(2)

        const cleanup = () => {
          if (worker) {
            worker.terminate()
            worker = null
          }
          if (signal) {
            signal.removeEventListener('abort', onAbort)
          }
        }

        const onAbort = () => {
          cleanup()
          reject(new Error('Packing cancelled'))
        }

        if (signal) {
          if (signal.aborted) {
            cleanup()
            return reject(new Error('Packing cancelled'))
          }
          signal.addEventListener('abort', onAbort)
        }

        worker!.onmessage = (e: MessageEvent<PackWorkerResponse>) => {
          const msg = e.data
          if (!msg || msg.id !== id) return

          if (msg.type === 'progress') {
            const pct =
              msg.phase === 'reading'
                ? Math.round(((msg.read || 0) / (msg.total || 1)) * 60)
                : 60 + Math.round(((msg.read || 0) / (msg.total || 1)) * 40)
            const text = msg.phase === 'reading' ? 'Reading files…' : 'Packing…'
            onProgress?.(msg.phase, text, pct)
          } else if (msg.type === 'done') {
            cleanup()
            let zipFile: File | null = null
            if (msg.zipBuffer) {
              zipFile = new File([msg.zipBuffer], `${folderName}.zip`, {
                type: 'application/zip',
              })
            }
            resolve({
              zipFile,
              hashes: msg.hashes,
              changedCount: msg.changedCount,
              deleted: msg.deleted,
              totalFiles: msg.totalFiles,
            })
          } else if (msg.type === 'error') {
            cleanup()
            reject(new Error(msg.error || 'Pack worker failed'))
          }
        }

        worker!.onerror = (err) => {
          cleanup()
          reject(new Error(err?.message || 'Pack worker error'))
        }

        worker!.postMessage({
          id,
          action: 'pack',
          files: fileItems,
          manifest,
        } as PackWorkerRequest)
      })
    }

    // Direct fallback (e.g. Node/test environment without Worker)
    const hashes: Record<string, string> = {}
    const toZip: AsyncZippable = {}
    const deleted: string[] = []
    const total = fileItems.length
    const BATCH_SIZE = 200

    for (let i = 0; i < total; i += BATCH_SIZE) {
      if (signal?.aborted) throw new Error('Packing cancelled')
      const batch = fileItems.slice(i, i + BATCH_SIZE)
      const buffers = await Promise.all(
        batch.map(async (item) => {
          const buf = await item.file.arrayBuffer()
          const hashBuf = await crypto.subtle.digest('SHA-1', new Uint8Array(buf))
          const sha1 = bufferToHex(hashBuf)
          return { path: item.path, buf, sha1 }
        })
      )

      for (const { path, buf, sha1 } of buffers) {
        hashes[path] = sha1
        if (manifest) {
          if (manifest[path] !== sha1) {
            toZip[path] = new Uint8Array(buf)
          }
        } else {
          toZip[path] = new Uint8Array(buf)
        }
      }

      onProgress?.(
        'reading',
        'Reading files…',
        Math.round((Math.min(i + batch.length, total) / total) * 60)
      )
    }

    if (manifest) {
      for (const mPath of Object.keys(manifest)) {
        if (!hashes[mPath]) {
          deleted.push(mPath)
        }
      }
    }

    const changedCount = Object.keys(toZip).length
    if (changedCount === 0) {
      return {
        zipFile: null,
        hashes,
        changedCount: 0,
        deleted,
        totalFiles: total,
      }
    }

    onProgress?.('packing', 'Packing…', 80)

    const zipBytes = await new Promise<Uint8Array>((res, rej) => {
      zip(toZip, { level: 6 }, (err, data) => {
        if (err) rej(err)
        else res(data)
      })
    })

    const zipFile = new File([zipBytes as any as BlobPart], `${folderName}.zip`, {
      type: 'application/zip',
    })

    return {
      zipFile,
      hashes,
      changedCount,
      deleted,
      totalFiles: total,
    }
  } finally {
    endAct()
  }
}

async function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') {
    const buf = await file.arrayBuffer()
    return new Uint8Array(buf)
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      resolve(new Uint8Array(reader.result as ArrayBuffer))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(file)
  })
}

export async function packFolder(
  files: FileList | File[],
  mode: 'docs' | 'code',
  folderName = 'folder'
): Promise<PackFolderResult> {
  const fileArray = Array.from(files)
  const zippable: Record<string, Uint8Array> = {}
  let totalBytes = 0
  let fileCount = 0
  const skippedFoldersSet = new Set<string>()

  for (const f of fileArray) {
    const relPath = getRelativePath(f)
    const segments = relPath.split('/')
    for (const seg of segments.slice(0, -1)) {
      if (EXCLUDED_FOLDERS.has(seg.toLowerCase())) {
        skippedFoldersSet.add(seg)
      }
    }

    const dotIdx = f.name.lastIndexOf('.')
    const ext = dotIdx >= 0 ? f.name.slice(dotIdx).toLowerCase() : ''

    if (mode === 'docs') {
      if (!DOC_EXTS.has(ext)) continue
      if (segments.some((seg) => seg.startsWith('.'))) continue
      if (segments.slice(0, -1).some((seg) => EXCLUDED_FOLDERS.has(seg.toLowerCase()))) continue
    } else {
      if (isDefaultExcluded(relPath, f.size, mode)) {
        continue
      }
    }

    totalBytes += f.size
    if (mode === 'code' && totalBytes > 120 * 1024 * 1024) {
      throw new Error(
        'Folder is larger than 120 MB after skipping dependencies; choose a sub-folder such as src'
      )
    }
    if (totalBytes > 300 * 1024 * 1024) {
      throw new Error(
        `Folder content exceeds 300 MB limit (${(totalBytes / (1024 * 1024)).toFixed(1)} MB). Choose a smaller folder or remove large files.`
      )
    }

    const bytes = await readFileBytes(f)
    zippable[relPath] = bytes
    fileCount++
  }

  if (fileCount === 0) {
    throw new Error(
      mode === 'docs'
        ? 'No supported document files found in this folder (.pdf, .docx, .md, .txt, .html).'
        : 'This folder has no source files we can analyze'
    )
  }

  const zipBytes = zipSync(zippable, { level: 6 })
  const zipFile = new File([zipBytes], `${folderName}.zip`, {
    type: 'application/zip',
  })

  const mb = (totalBytes / (1024 * 1024)).toFixed(1)
  const formattedSize =
    totalBytes < 1024 * 1024 ? `${(totalBytes / 1024).toFixed(1)} KB` : `${mb} MB`

  const label = `${fileCount} files packed, ${mb} MB`

  return {
    file: zipFile,
    fileCount,
    totalBytes,
    formattedSize,
    label,
    skippedFolders: Array.from(skippedFoldersSet).sort(),
  }
}

export async function getFilesFromDataTransfer(dataTransfer: DataTransfer): Promise<File[]> {
  const items = dataTransfer.items
  if (!items || items.length === 0) {
    return Array.from(dataTransfer.files || [])
  }

  const files: File[] = []

  async function traverseEntry(entry: any, path = ''): Promise<void> {
    if (!entry) return
    if (entry.isFile) {
      await new Promise<void>((resolve) => {
        entry.file(
          (file: File) => {
            const relPath = path ? `${path}/${file.name}` : file.name
            try {
              Object.defineProperty(file, 'webkitRelativePath', {
                value: relPath,
                configurable: true,
              })
            } catch {
              // ignore
            }
            files.push(file)
            resolve()
          },
          () => resolve()
        )
      })
    } else if (entry.isDirectory) {
      const dirReader = entry.createReader()
      const readBatch = (): Promise<any[]> =>
        new Promise((resolve) => {
          dirReader.readEntries(
            (entries: any[]) => resolve(entries || []),
            () => resolve([])
          )
        })
      let batch: any[]
      do {
        batch = await readBatch()
        for (const child of batch) {
          await traverseEntry(child, path ? `${path}/${entry.name}` : entry.name)
        }
      } while (batch.length > 0)
    }
  }

  const entries: any[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (typeof item.webkitGetAsEntry === 'function') {
      const entry = item.webkitGetAsEntry()
      if (entry) entries.push(entry)
    }
  }

  if (entries.length > 0) {
    for (const entry of entries) {
      await traverseEntry(entry)
    }
    return files
  }

  return Array.from(dataTransfer.files || [])
}
