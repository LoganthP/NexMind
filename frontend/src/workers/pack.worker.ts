import { zip, type AsyncZippable } from 'fflate'

export interface PackFileItem {
  path: string
  file: File
}

export interface PackWorkerRequest {
  id: string
  action: 'pack'
  files: PackFileItem[]
  manifest?: Record<string, string>
}

export interface PackWorkerProgressMessage {
  type: 'progress'
  id: string
  phase: 'reading' | 'packing'
  read?: number
  total?: number
}

export interface PackWorkerDoneMessage {
  type: 'done'
  id: string
  zipBuffer: ArrayBuffer | null
  hashes: Record<string, string>
  changedCount: number
  deleted: string[]
  totalFiles: number
}

export interface PackWorkerErrorMessage {
  type: 'error'
  id: string
  error: string
}

export type PackWorkerResponse =
  | PackWorkerProgressMessage
  | PackWorkerDoneMessage
  | PackWorkerErrorMessage

function bufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

addEventListener('message', async (e: MessageEvent<PackWorkerRequest>) => {
  const req = e.data
  if (!req || req.action !== 'pack') return

  const { id, files, manifest } = req
  const hashes: Record<string, string> = {}
  const toZip: AsyncZippable = {}
  const deleted: string[] = []

  try {
    const total = files.length
    const BATCH_SIZE = 200

    // Read and hash in batches of 200 to keep memory and event loop smooth
    for (let i = 0; i < total; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE)
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
        // If manifest is present, compare hashes
        if (manifest) {
          if (manifest[path] !== sha1) {
            toZip[path] = new Uint8Array(buf)
          }
        } else {
          toZip[path] = new Uint8Array(buf)
        }
      }

      postMessage({
        type: 'progress',
        id,
        phase: 'reading',
        read: Math.min(i + batch.length, total),
        total,
      } as PackWorkerProgressMessage)
    }

    // Determine deleted files
    if (manifest) {
      for (const mPath of Object.keys(manifest)) {
        if (!hashes[mPath]) {
          deleted.push(mPath)
        }
      }
    }

    const changedKeys = Object.keys(toZip)
    if (changedKeys.length === 0) {
      // Nothing changed
      postMessage({
        type: 'done',
        id,
        zipBuffer: null,
        hashes,
        changedCount: 0,
        deleted,
        totalFiles: total,
      } as PackWorkerDoneMessage)
      return
    }

    postMessage({
      type: 'progress',
      id,
      phase: 'packing',
      read: total,
      total,
    } as PackWorkerProgressMessage)

    zip(toZip, { level: 6 }, (err, data) => {
      if (err) {
        postMessage({
          type: 'error',
          id,
          error: err.message || 'Zip packing failed',
        } as PackWorkerErrorMessage)
        return
      }

      const resMessage: PackWorkerDoneMessage = {
        type: 'done',
        id,
        zipBuffer: data.buffer,
        hashes,
        changedCount: changedKeys.length,
        deleted,
        totalFiles: total,
      }

      ;(self as any).postMessage(resMessage, [data.buffer])
    })
  } catch (err: any) {
    postMessage({
      type: 'error',
      id,
      error: err?.message || String(err),
    } as PackWorkerErrorMessage)
  }
})
