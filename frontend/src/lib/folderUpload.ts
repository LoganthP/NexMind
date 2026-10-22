import { zipSync } from 'fflate'

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
  'venv',
  '.venv',
  '__pycache__',
  'target',
  'vendor',
  '.nuxt',
  'coverage',
  '.cache',
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
  '.pdf',
])

export function getRelativePath(file: File): string {
  const rel = (file as any).webkitRelativePath || file.name || 'file'
  return rel.replace(/\\/g, '/').replace(/^\/+/, '')
}

export function shouldIncludeFile(
  path: string,
  fileSize: number,
  mode: 'docs' | 'code'
): boolean {
  const segments = path.split('/')
  const filename = segments[segments.length - 1]

  // Skip hidden files/directories (starting with dot)
  if (segments.some((seg) => seg.startsWith('.'))) {
    return false
  }

  // Skip excluded folders
  const dirSegments = segments.slice(0, -1)
  if (dirSegments.some((seg) => EXCLUDED_FOLDERS.has(seg.toLowerCase()))) {
    return false
  }

  const dotIdx = filename.lastIndexOf('.')
  const ext = dotIdx >= 0 ? filename.slice(dotIdx).toLowerCase() : ''

  if (mode === 'docs') {
    // Keep only supported document types
    return DOC_EXTS.has(ext)
  }

  // mode === 'code'
  // Skip files over 2 MB in code mode
  if (fileSize > 2 * 1024 * 1024) {
    return false
  }

  // Skip binary extensions
  if (BINARY_EXTS.has(ext)) {
    return false
  }

  return true
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

    if (!shouldIncludeFile(relPath, f.size, mode)) {
      continue
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

  const zipBytes = zipSync(zippable)
  const zipFile = new File([zipBytes], `${folderName}.zip`, {
    type: 'application/zip',
  })

  const mb = (totalBytes / (1024 * 1024)).toFixed(1)
  const formattedSize = totalBytes < 1024 * 1024
    ? `${(totalBytes / 1024).toFixed(1)} KB`
    : `${mb} MB`

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
