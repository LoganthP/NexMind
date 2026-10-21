import { useState, useRef, useEffect, useCallback, type DragEvent } from 'react'
import {
  AlertCircle,
  Archive,
  BookOpen,
  FileText,
  FileUp,
  FolderUp,
  Loader2,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react'
import { api, formatApiError, uploadFiles } from '@/lib/api'
import { useServer } from '@/lib/server'
import { packFolder } from '@/lib/folderUpload'
import { ServerStatusBar } from '../ServerStatusBar'

interface DocumentsFormProps {
  onStarted?: (jobId: string, workspaceId: string) => void
  workspaceId?: string
}

const SUPPORTED_DOC_EXTS = new Set([
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

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

function getFileExt(name: string): string {
  if (name.toLowerCase().endsWith('.tar.gz')) return '.tar.gz'
  const idx = name.lastIndexOf('.')
  return idx >= 0 ? name.slice(idx).toLowerCase() : ''
}

export function DocumentsForm({ onStarted, workspaceId }: DocumentsFormProps) {
  const { status, health } = useServer()
  const isOnline = status === 'online'

  const [files, setFiles] = useState<File[]>([])
  const [name, setName] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [packing, setPacking] = useState(false)
  const [packNote, setPackNote] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pct, setPct] = useState<number | null>(null)

  // Pending action state when clicking submit while server is offline
  const [pending, setPending] = useState(false)
  const [helpExpanded, setHelpExpanded] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const inFlightRef = useRef(false)

  const maxUploadMb = (health as any)?.max_upload_mb || 300
  const maxUploadBytes = maxUploadMb * 1024 * 1024

  const addIndividualFiles = useCallback(
    (newFiles: FileList | File[]) => {
      setError(null)
      const list = Array.from(newFiles)
      const valid: File[] = []
      const warns: string[] = []

      for (const f of list) {
        const ext = getFileExt(f.name)
        if (!SUPPORTED_DOC_EXTS.has(ext)) {
          warns.push(`Skipped "${f.name}": unsupported file type (${ext || 'no extension'})`)
          continue
        }
        if (f.size > maxUploadBytes) {
          warns.push(`Skipped "${f.name}": exceeds server limit of ${maxUploadMb} MB`)
          continue
        }
        valid.push(f)
      }

      if (warns.length > 0) {
        setWarnings((prev) => [...prev, ...warns].slice(-5))
      }

      if (valid.length > 0) {
        setFiles((prev) => [...prev, ...valid])
      }
    },
    [maxUploadBytes, maxUploadMb]
  )

  const handleFolderSelect = async (folderFiles: FileList | File[]) => {
    setError(null)
    setPacking(true)
    setPackNote(null)
    try {
      const arr = Array.from(folderFiles)
      const firstRel = (arr[0] as any)?.webkitRelativePath || arr[0]?.name || ''
      const folderName = firstRel.split('/')[0] || 'documents'

      const res = await packFolder(arr, 'docs', folderName)
      setFiles((prev) => [...prev, res.file])
      setPackNote(res.label)
      if (!name) {
        setName(folderName)
      }
    } catch (err: any) {
      setError(err?.message || 'Could not pack folder.')
    } finally {
      setPacking(false)
    }
  }

  const handleDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)

    // Check if items contain directory or relative paths
    const droppedFiles = Array.from(e.dataTransfer.files)
    if (droppedFiles.length === 0) return

    // If webkitRelativePath exists on dropped files or user dropped a bunch
    const hasRelative = droppedFiles.some(
      (f) => (f as any).webkitRelativePath && (f as any).webkitRelativePath.includes('/')
    )

    if (hasRelative) {
      await handleFolderSelect(droppedFiles)
    } else {
      addIndividualFiles(droppedFiles)
    }
  }

  const removeFile = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx))
  }

  const defaultName = files.length > 0
    ? files[0].name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ')
    : 'Document study'

  const executeSubmit = useCallback(async () => {
    if (files.length === 0 || inFlightRef.current) return
    inFlightRef.current = true
    setBusy(true)
    setError(null)
    setPct(null)

    try {
      const finalName = name.trim() || defaultName
      let wsId = workspaceId

      if (!wsId) {
        const created = await api.createWorkspace(finalName, '', 'docs')
        wsId = created.id
      }

      const job = await uploadFiles(wsId, files, setPct)
      setPending(false)
      onStarted?.(job.job_id, wsId)
    } catch (err: any) {
      setError(formatApiError(err))
      setPending(false)
    } finally {
      setBusy(false)
      setPct(null)
      inFlightRef.current = false
    }
  }, [files, name, defaultName, workspaceId, onStarted])

  // If action was pending and server becomes online, run it automatically once
  useEffect(() => {
    if (pending && isOnline && !inFlightRef.current) {
      void executeSubmit()
    }
  }, [pending, isOnline, executeSubmit])

  const handleSubmit = () => {
    if (files.length === 0) return
    if (!isOnline) {
      setPending(true)
      setHelpExpanded(true)
      return
    }
    void executeSubmit()
  }

  const totalBytes = files.reduce((acc, f) => acc + f.size, 0)

  return (
    <div className="space-y-4">
      {/* Server Status Bar */}
      <ServerStatusBar
        expanded={helpExpanded}
        onToggleExpand={setHelpExpanded}
        pending={pending}
        onCancelPending={() => setPending(false)}
      />

      {/* Dropzone */}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`relative flex flex-col items-center justify-center rounded-2xl border-2 border-dashed p-6 text-center transition-all ${
          dragOver
            ? 'border-amber bg-amber/10'
            : 'border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.03]'
        }`}
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber/10 text-amber mb-3">
          <BookOpen size={24} />
        </div>

        <p className="text-sm font-medium text-ink">
          Drop PDFs, Word files, notes or zipped folders of documents
        </p>
        <p className="mt-1 text-xs text-mist max-w-[40ch]">
          Accepts .pdf, .docx, .doc, .md, .txt, .html, .zip, .tar.gz and folders
        </p>

        <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
          <button
            type="button"
            className="btn btn-ghost btn-sm flex items-center gap-1.5 !h-8 !px-3"
            onClick={() => fileInputRef.current?.click()}
          >
            <FileUp size={15} className="text-amber" />
            <span>Choose files</span>
          </button>

          <button
            type="button"
            className="btn btn-ghost btn-sm flex items-center gap-1.5 !h-8 !px-3"
            onClick={() => folderInputRef.current?.click()}
            disabled={packing}
          >
            {packing ? (
              <Loader2 size={15} className="animate-spin text-amber" />
            ) : (
              <FolderUp size={15} className="text-amber" />
            )}
            <span>{packing ? 'Packing folder…' : 'Choose a folder'}</span>
          </button>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            accept=".pdf,.docx,.doc,.md,.txt,.html,.zip,.tar.gz"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                addIndividualFiles(e.target.files)
              }
              e.target.value = ''
            }}
          />

          <input
            ref={folderInputRef}
            type="file"
            multiple
            hidden
            {...({ webkitdirectory: '', directory: '' } as any)}
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                void handleFolderSelect(e.target.files)
              }
              e.target.value = ''
            }}
          />
        </div>

        {packNote && (
          <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-amber/30 bg-amber/10 px-3 py-1 text-xs text-amber font-medium">
            <Archive size={13} />
            <span>{packNote}</span>
          </div>
        )}
      </div>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="space-y-1">
          {warnings.map((w, idx) => (
            <div
              key={idx}
              className="flex items-center justify-between gap-2 rounded-lg bg-amber/10 border border-amber/20 px-3 py-1.5 text-xs text-amber"
            >
              <span>{w}</span>
              <button
                type="button"
                className="text-amber/70 hover:text-amber"
                onClick={() => setWarnings((prev) => prev.filter((_, i) => i !== idx))}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* File List */}
      {files.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-mist">
            <span className="font-medium text-ink">Selected documents ({files.length})</span>
            <span>Total: {formatBytes(totalBytes)}</span>
          </div>

          <ul className="max-h-40 overflow-y-auto space-y-1.5 pr-1 text-xs">
            {files.map((file, i) => {
              const isZip = file.name.endsWith('.zip') || file.name.endsWith('.tar.gz')
              return (
                <li
                  key={i}
                  className="flex items-center justify-between gap-2 rounded-xl bg-white/[0.04] border hair px-3 py-2 text-ink"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {isZip ? (
                      <Archive size={15} className="text-amber shrink-0" />
                    ) : (
                      <FileText size={15} className="text-amber/80 shrink-0" />
                    )}
                    <span className="truncate font-medium">{file.name}</span>
                    <span className="mono text-[0.7rem] text-mist shrink-0">
                      {formatBytes(file.size)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="text-mist hover:text-coral transition-colors shrink-0"
                    onClick={() => removeFile(i)}
                    aria-label={`Remove ${file.name}`}
                  >
                    <X size={14} />
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* Workspace Name */}
      <div>
        <label className="block text-xs font-medium text-mist mb-1.5">
          Workspace name <span className="text-mist/60">(optional)</span>
        </label>
        <input
          className="field text-sm"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={defaultName}
          autoComplete="off"
        />
      </div>

      {/* Error Banner with Retry */}
      {error && (
        <div className="flex items-start gap-2.5 rounded-xl border border-coral/40 bg-coral/10 p-3 text-xs text-coral">
          <AlertCircle size={15} className="shrink-0 mt-0.5" />
          <div className="flex-1 leading-relaxed">{error}</div>
          <button
            type="button"
            className="btn btn-ghost btn-sm !h-6 !px-2 text-coral hover:!bg-coral/20 shrink-0 flex items-center gap-1"
            onClick={() => void executeSubmit()}
          >
            <RotateCcw size={12} /> Retry
          </button>
        </div>
      )}

      {/* Submit Button & Pending state */}
      <div className="space-y-2 pt-1">
        <button
          type="button"
          className="btn btn-primary w-full !h-11 text-sm font-semibold"
          disabled={files.length === 0 || busy || packing || pending}
          onClick={handleSubmit}
        >
          {busy ? (
            <>
              <Loader2 className="animate-spin" size={17} />
              <span>{pct !== null ? `Uploading ${pct}%` : 'Analyzing documents…'}</span>
            </>
          ) : pending ? (
            <>
              <Loader2 className="animate-spin" size={17} />
              <span>Waiting for server…</span>
            </>
          ) : (
            <>
              <Sparkles size={17} />
              <span>Analyze documents</span>
            </>
          )}
        </button>

        {pending && (
          <div className="flex items-center justify-between text-xs text-amber px-1">
            <span>We&apos;ll start as soon as the server connects.</span>
            <button
              type="button"
              className="underline hover:text-ink transition-colors"
              onClick={() => setPending(false)}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
