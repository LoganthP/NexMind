import { useState, useRef, useEffect, useCallback, type DragEvent } from 'react'
import {
  AlertCircle,
  Archive,
  Code2,
  ExternalLink,
  Folder,
  FolderOpen,
  FolderUp,
  GitBranch,
  GitMerge,
  GitPullRequest,
  KeyRound,
  Loader2,
  RefreshCw,
  RotateCcw,
  Sparkles,
  UploadCloud,
  X,
} from 'lucide-react'
import { api, formatApiError, uploadFiles } from '@/lib/api'
import { useServer, isLocalPathsSupported, isHostedEnvironment } from '@/lib/server'
import { probeLocalServer } from '@/lib/localServer'
import { detectOS } from '@/lib/os'
import { CopyBlock } from '../ui'
import { computeHandleSignature } from '@/lib/browserFolder'
import { packFolder, getFilesFromDataTransfer, packWithWorker, type PackFolderResult } from '@/lib/folderUpload'
import type { FsCheckResult } from '@/lib/types'
import { FolderPicker } from '../FolderPicker'
import { FolderReview } from '../FolderReview'
import { ServerStatusBar } from '../ServerStatusBar'

interface ProjectsFormProps {
  onStarted?: (jobId: string, workspaceId: string) => void
  workspaceId?: string
  initialTab?: Tab
}

type Tab = 'github' | 'gitlab' | 'azure' | 'upload' | 'local'

interface TabMeta {
  id: Tab
  label: string
  icon: typeof GitPullRequest
  placeholder: string
}

const TABS: TabMeta[] = [
  { id: 'github', label: 'GitHub', icon: GitPullRequest, placeholder: 'https://github.com/owner/repo' },
  { id: 'gitlab', label: 'GitLab', icon: GitMerge, placeholder: 'https://gitlab.com/owner/repo' },
  { id: 'azure', label: 'Azure DevOps', icon: GitBranch, placeholder: 'https://dev.azure.com/org/project/_git/repo' },
  { id: 'upload', label: 'Upload project', icon: UploadCloud, placeholder: '' },
  { id: 'local', label: 'Local folder', icon: Folder, placeholder: 'C:\\Users\\you\\projects\\my-app' },
]

function nameFromUrl(u: string): string {
  return u.replace(/\/+$/, '').replace(/\.git$/, '').split('/').pop() || 'Repository'
}

function validateRepoUrl(url: string, tab: Tab): boolean {
  const trimmed = url.trim()
  if (!trimmed) return false
  if (tab === 'github') {
    return (
      /^https?:\/\/(www\.)?github\.com\/[^/]+\/[^/]+/i.test(trimmed) ||
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)
    )
  }
  if (tab === 'gitlab') {
    return (
      /^https?:\/\/(www\.)?gitlab\.com\/[^/]+\/[^/]+/i.test(trimmed) ||
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)
    )
  }
  if (tab === 'azure') {
    return /^https?:\/\/(dev\.azure\.com|[^.]+\.visualstudio\.com)\/[^/]+/i.test(trimmed)
  }
  return trimmed.length > 5
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

export function ProjectsForm({ onStarted, workspaceId, initialTab }: ProjectsFormProps) {
  const { status, health, check } = useServer()
  const isHosted = isHostedEnvironment()
  const localOk = useServer((st) => isLocalPathsSupported(st)) && !isHosted
  const isOnline = status === 'online'

  useEffect(() => {
    if (!health?.setup_required) return
    const id = setInterval(() => {
      void check(true)
    }, 10000)
    return () => clearInterval(id)
  }, [health?.setup_required, check])

  const [tab, setTab] = useState<Tab>(() => initialTab || 'github')

  useEffect(() => {
    if (initialTab) {
      setTab(initialTab)
    }
  }, [initialTab])

  const [url, setUrl] = useState('')
  const [branch, setBranch] = useState('')
  const [token, setToken] = useState('')
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [files, setFiles] = useState<File[]>([])

  // Local server detection on hosted site
  const [localServer, setLocalServer] = useState<{
    probing: boolean
    detected: boolean
    url: string | null
  }>({
    probing: false,
    detected: false,
    url: null,
  })
  const [showUploadFallback, setShowUploadFallback] = useState(false)

  const probeLocal = useCallback(async (isUserGesture = false) => {
    setLocalServer((prev) => ({ ...prev, probing: true }))
    try {
      const res = await probeLocalServer(isUserGesture)
      setLocalServer({
        probing: false,
        detected: res.running,
        url: res.url,
      })
      return res
    } catch {
      setLocalServer({
        probing: false,
        detected: false,
        url: null,
      })
      return { running: false, port: null, url: null }
    }
  }, [])

  useEffect(() => {
    if (tab === 'local' && isHosted) {
      void probeLocal(false)
    }
  }, [tab, isHosted, probeLocal])

  // FolderReview state
  const [reviewFiles, setReviewFiles] = useState<File[] | null>(null)
  const [reviewFolderName, setReviewFolderName] = useState<string>('')
  const [reviewSourceTab, setReviewSourceTab] = useState<'local' | 'upload'>('local')

  // Upload phase & progress
  const [uploadPhase, setUploadPhase] = useState<'reading' | 'packing' | 'uploading' | 'building' | null>(null)
  const [uploadProgressText, setUploadProgressText] = useState('')
  const [uploadProgressPct, setUploadProgressPct] = useState(0)
  const abortControllerRef = useRef<AbortController | null>(null)

  // Local folder checking
  const [checkInfo, setCheckInfo] = useState<FsCheckResult | null>(null)
  const [checkingPath, setCheckingPath] = useState(false)
  const [pickingNative, setPickingNative] = useState(false)
  const [pickerModalOpen, setPickerModalOpen] = useState(false)

  // Upload packing
  const [dragOver, setDragOver] = useState(false)
  const [packing, setPacking] = useState(false)
  const [packNote, setPackNote] = useState<string | null>(null)

  // Hosted local folder packing
  const [packedLocalFolder, setPackedLocalFolder] = useState<PackFolderResult | null>(null)
  const [localFolderName, setLocalFolderName] = useState('')
  const [packingLocal, setPackingLocal] = useState(false)
  const [localDragOver, setLocalDragOver] = useState(false)
  const localFolderInputRef = useRef<HTMLInputElement>(null)

  // Status & pending
  const [busy, setBusy] = useState(false)
  const [pct, setPct] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [helpExpanded, setHelpExpanded] = useState(false)

  const archiveInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const inFlightRef = useRef(false)

  const isGit = tab === 'github' || tab === 'gitlab' || tab === 'azure'
  const canPickFolder =
    typeof window !== 'undefined' &&
    !(window as any).__MOCK_UNSUPPORTED_FOLDER_BROWSER__ &&
    ('webkitdirectory' in HTMLInputElement.prototype ||
      typeof (window as any).showDirectoryPicker === 'function' ||
      process.env.NODE_ENV === 'test')

  // Readiness validation
  const isReady = isGit
    ? validateRepoUrl(url, tab)
    : tab === 'local'
      ? localOk
        ? path.trim().length > 0
        : files.length > 0
      : files.length > 0

  // Derive default workspace name
  let defaultName = 'My workspace'
  if (isGit && url.trim()) {
    defaultName = nameFromUrl(url.trim())
  } else if (tab === 'local') {
    if (localOk && path.trim()) {
      defaultName = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'Local project'
    } else if (!localOk && localFolderName) {
      defaultName = localFolderName
    }
  } else if (files.length > 0) {
    defaultName = files[0].name.replace(/\.[^.]+$/, '')
  }

  // Check path on change
  const runPathCheck = useCallback((targetPath: string) => {
    if (!targetPath.trim()) {
      setCheckInfo(null)
      return
    }
    setCheckingPath(true)
    api
      .fsCheck(targetPath.trim())
      .then((res) => {
        setCheckInfo(res)
      })
      .catch((e) => {
        setCheckInfo({
          ok: false,
          exists: false,
          is_dir: false,
          readable: false,
          markers: [],
          supported_files: 0,
          has_code: false,
          has_docs: false,
          message: formatApiError(e),
        })
      })
      .finally(() => setCheckingPath(false))
  }, [])

  const handlePickFolderNative = async () => {
    setPickingNative(true)
    setError(null)
    try {
      const res = await api.fsPick('Select a project or source folder', path || undefined)
      if (res.cancelled) {
        // user cancelled dialog
        return
      }
      if (res.path) {
        setPath(res.path)
        runPathCheck(res.path)
        if (!name) {
          setName(res.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '')
        }
      }
    } catch {
      // 501, 404, or network error: open in-app FolderPicker fallback without error toast
      setPickerModalOpen(true)
    } finally {
      setPickingNative(false)
    }
  }

  const handleConfirmReview = async (selectedFiles: File[]) => {
    setError(null)
    setBusy(true)
    const ctl = new AbortController()
    abortControllerRef.current = ctl
    setUploadPhase('reading')
    setUploadProgressText('Reading files…')
    setUploadProgressPct(10)

    try {
      const folderName = reviewFolderName || 'project'
      const packRes = await packWithWorker(selectedFiles, {
        folderName,
        onProgress: (_phase, text, pct) => {
          setUploadPhase('packing')
          setUploadProgressText(text)
          setUploadProgressPct(pct)
        },
        signal: ctl.signal,
      })

      if (!packRes.zipFile) {
        throw new Error('This folder has no source files we can analyze')
      }

      setUploadPhase('uploading')
      setUploadProgressText('Uploading…')
      setUploadProgressPct(60)

      let wsId = workspaceId
      const finalName = name.trim() || defaultName || folderName
      if (!wsId) {
        const created = await api.createWorkspace(finalName, '', 'code')
        wsId = created.id
      }

      const job = await uploadFiles(
        wsId,
        [packRes.zipFile],
        (pct, text) => {
          setUploadProgressPct(60 + Math.round((pct / 100) * 35))
          if (text) setUploadProgressText(text)
        },
        ctl.signal
      )

      setUploadPhase('building')
      setUploadProgressText('Building graph…')
      setUploadProgressPct(99)

      setReviewFiles(null)
      onStarted?.(job.job_id, wsId)
    } catch (err: any) {
      if (ctl.signal.aborted || err?.message === 'Packing cancelled' || err?.message === 'Upload cancelled') {
        // aborted by user
      } else {
        setError(formatApiError(err))
      }
    } finally {
      setBusy(false)
      setUploadPhase(null)
      abortControllerRef.current = null
    }
  }

  const handleCancelUpload = () => {
    abortControllerRef.current?.abort()
    setUploadPhase(null)
    setBusy(false)
  }

  const handleFolderUpload = async (folderFiles: FileList | File[]) => {
    setError(null)
    const arr = Array.from(folderFiles)
    if (arr.length === 0) return
    const firstRel = (arr[0] as any)?.webkitRelativePath || arr[0]?.name || ''
    const folderName = firstRel.split('/')[0] || 'project'
    setReviewFiles(arr)
    setReviewFolderName(folderName)
    setReviewSourceTab('upload')
    if (!name) setName(folderName)
  }

  const os = detectOS()
  const repoUrl =
    (typeof import.meta !== 'undefined' &&
      ((import.meta as any).env?.VITE_BACKEND_REPO_URL || (import.meta as any).env?.VITE_REPO_URL)) ||
    'https://github.com/LoganthP/NexMind'

  const startCmd =
    os === 'windows'
      ? 'powershell -ExecutionPolicy Bypass -File .\\start.ps1'
      : './start.sh'

  const handlePickDirectoryHandle = async () => {
    setError(null)
    if (typeof (window as any).showDirectoryPicker !== 'function') {
      setError(
        'Your browser does not support folder selection without reading dependencies. Use Chrome or Edge, or analyze on this computer.'
      )
      return
    }
    try {
      const handle = await (window as any).showDirectoryPicker()
      const folderName = handle.name || 'project'
      setLocalFolderName(folderName)
      setReviewFolderName(folderName)

      const walkRes = await computeHandleSignature(handle)
      const fileList = walkRes.files.map((rec) => {
        const f = rec.file
        try {
          Object.defineProperty(f, 'webkitRelativePath', {
            value: rec.relativePath,
            writable: true,
            configurable: true,
          })
        } catch {}
        return f
      })
      if (fileList.length === 0) {
        setError('This folder has no source files we can analyze')
        return
      }
      setReviewFiles(fileList)
      setReviewSourceTab('local')
      if (!name) setName(folderName)
    } catch (err: any) {
      if (err?.name === 'AbortError') return
      setError(err?.message || 'Failed to select folder')
    }
  }

  const handleHostedFolderPick = async (folderFiles: FileList | File[]) => {
    setError(null)
    const arr = Array.from(folderFiles)
    if (arr.length === 0) return
    const firstRel = (arr[0] as any)?.webkitRelativePath || arr[0]?.name || ''
    const folderName = firstRel.split('/')[0] || 'project'
    setLocalFolderName(folderName)
    setReviewFiles(arr)
    setReviewFolderName(folderName)
    setReviewSourceTab('local')
    if (!name) setName(folderName)
  }

  const handleDropArchive = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length > 0) {
      const dropped = Array.from(e.dataTransfer.files)
      const hasRelative = dropped.some(
        (f) => (f as any).webkitRelativePath && (f as any).webkitRelativePath.includes('/')
      )
      if (hasRelative) {
        void handleFolderUpload(dropped)
      } else {
        setFiles(dropped.slice(0, 5))
      }
    }
  }

  const executeSubmit = useCallback(async () => {
    if (!isReady || inFlightRef.current) return
    inFlightRef.current = true
    setBusy(true)
    setError(null)
    setPct(null)

    try {
      const finalName = name.trim() || defaultName
      let wsId = workspaceId

      if (!wsId) {
        const created = await api.createWorkspace(finalName, '', 'code')
        wsId = created.id
      }

      let job: { job_id: string }
      if (isGit) {
        let fullUrl = url.trim()
        if (!/^https?:\/\//i.test(fullUrl)) {
          fullUrl = 'https://' + fullUrl
        }
        job = await api.ingestGit(wsId, fullUrl, token.trim() || undefined, branch.trim() || undefined)
      } else if (tab === 'local') {
        if (localOk) {
          job = await api.ingestLocal(wsId, path.trim())
        } else {
          job = await uploadFiles(wsId, files, setPct)
        }
      } else {
        job = await uploadFiles(wsId, files, setPct)
      }

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
  }, [isReady, name, defaultName, workspaceId, isGit, url, token, branch, tab, localOk, path, files, onStarted])

  useEffect(() => {
    if (pending && isOnline && !inFlightRef.current) {
      void executeSubmit()
    }
  }, [pending, isOnline, executeSubmit])

  const handleSubmit = () => {
    if (!isReady) return
    if (!isOnline) {
      setPending(true)
      setHelpExpanded(true)
      return
    }
    void executeSubmit()
  }

  const currentMeta = TABS.find((t) => t.id === tab)!

  return (
    <div className="space-y-4">
      {/* Setup needed banner */}
      {health?.setup_required && (
        <div className="rounded-xl border border-amber/30 bg-amber/10 p-2.5 text-xs text-amber flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-amber animate-pulse shrink-0" />
          <span className="font-medium">Setup needed: {health.setup_required}</span>
        </div>
      )}

      {/* Server Status Bar */}
      <ServerStatusBar
        expanded={helpExpanded}
        onToggleExpand={setHelpExpanded}
        pending={pending}
        onCancelPending={() => setPending(false)}
      />

      {/* Tabs */}
      <div role="tablist" aria-label="Project source" className="flex flex-wrap gap-1">
        {TABS.map((t) => {
          const Icon = t.icon
          const isSelected = tab === t.id
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={isSelected}
              className={`tab flex items-center gap-1.5 !h-8 !px-3 text-xs ${isSelected ? 'on' : ''}`}
              onClick={() => {
                setTab(t.id)
                setError(null)
              }}
            >
              <Icon size={14} />
              <span>{t.label}</span>
            </button>
          )
        })}
      </div>

      <div className="space-y-3.5 pt-1">
        {/* Git forms: GitHub | GitLab | Azure DevOps */}
        {isGit && (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-mist mb-1.5">
                Repository URL
              </label>
              <input
                className="field text-sm"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value)
                  setError(null)
                }}
                placeholder={currentMeta.placeholder}
                spellCheck={false}
                autoComplete="off"
                onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-mist mb-1.5">
                  Branch <span className="text-mist/60">(optional, default branch used)</span>
                </label>
                <input
                  className="field text-sm"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="main"
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-mist mb-1.5">
                  <span className="flex items-center gap-1">
                    <KeyRound size={13} /> Access token{' '}
                    <span className="text-mist/60">(private repos)</span>
                  </span>
                </label>
                <input
                  className="field mono text-sm"
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="ghp_… / glpat-…"
                  autoComplete="off"
                />
              </div>
            </div>

            <p className="text-[0.72rem] text-mist leading-relaxed">
              Public repositories need no token. A token is used once to clone, never stored, and never leaves your machine.
            </p>
          </div>
        )}

        {/* Upload project tab */}
        {tab === 'upload' && (
          <div className="space-y-3">
            {reviewFiles && reviewSourceTab === 'upload' ? (
              <FolderReview
                files={reviewFiles}
                mode="code"
                folderName={reviewFolderName}
                onConfirm={handleConfirmReview}
                onChangeFolder={() => {
                  setReviewFiles(null)
                  setTimeout(() => folderInputRef.current?.click(), 0)
                }}
                disabled={Boolean(health?.setup_required)}
              />
            ) : (
              <div
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragOver(true)
                }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDropArchive}
              className={`relative flex flex-col items-center justify-center rounded-2xl border-2 border-dashed p-6 text-center transition-all ${
                dragOver
                  ? 'border-plankton bg-plankton/10'
                  : 'border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.03]'
              }`}
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-plankton/10 text-plankton mb-3">
                <Archive size={24} />
              </div>

              <p className="text-sm font-medium text-ink">
                Upload a project .zip, .tar.gz or folder
              </p>
              <p className="mt-1 text-xs text-mist max-w-[42ch]">
                Drop an archive or project folder. Code files are extracted and indexed right on your computer.
              </p>

              <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm flex items-center gap-1.5 !h-8 !px-3"
                  onClick={() => archiveInputRef.current?.click()}
                >
                  <Archive size={15} className="text-plankton" />
                  <span>Choose archive</span>
                </button>

                <button
                  type="button"
                  className="btn btn-ghost btn-sm flex items-center gap-1.5 !h-8 !px-3"
                  onClick={() => {
                    if (isHosted) {
                      void handlePickDirectoryHandle()
                    } else {
                      folderInputRef.current?.click()
                    }
                  }}
                  disabled={packing}
                >
                  {packing ? (
                    <Loader2 size={15} className="animate-spin text-plankton" />
                  ) : (
                    <FolderUp size={15} className="text-plankton" />
                  )}
                  <span>{packing ? 'Packing project…' : 'Upload a project folder'}</span>
                </button>

                <input
                  ref={archiveInputRef}
                  type="file"
                  hidden
                  accept=".zip,.tar.gz,.tgz,.tar"
                  onChange={(e) => {
                    if (e.target.files && e.target.files.length > 0) {
                      setFiles(Array.from(e.target.files))
                    }
                    e.target.value = ''
                  }}
                />

                {!isHosted && (
                  <input
                    ref={folderInputRef}
                    type="file"
                    multiple
                    hidden
                    {...({ webkitdirectory: '', directory: '' } as any)}
                    onChange={(e) => {
                      if (e.target.files && e.target.files.length > 0) {
                        void handleFolderUpload(e.target.files)
                      }
                      e.target.value = ''
                    }}
                  />
                )}
              </div>

              {packNote && (
                <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-plankton/30 bg-plankton/10 px-3 py-1 text-xs text-plankton font-medium">
                  <Archive size={13} />
                  <span>{packNote}</span>
                </div>
              )}
            </div>
            )}

            {files.length > 0 && !reviewFiles && (
              <ul className="space-y-1.5 text-xs">
                {files.map((f, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between rounded-xl bg-white/[0.04] border hair px-3 py-2 text-ink"
                  >
                    <div className="flex items-center gap-2 truncate">
                      <Archive size={15} className="text-plankton shrink-0" />
                      <span className="truncate font-medium">{f.name}</span>
                      <span className="mono text-mist text-[0.7rem] shrink-0">
                        {formatBytes(f.size)}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="text-mist hover:text-coral transition-colors ml-2"
                      onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                      aria-label={`Remove ${f.name}`}
                    >
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Local folder tab */}
        {tab === 'local' && (
          localOk ? (
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-mist mb-1.5">
                  Folder on this computer <span className="text-mist/60">(project root or source subfolder)</span>
                </label>

                <div className="flex gap-2">
                  <input
                    className="field mono text-sm flex-1"
                    value={path}
                    onChange={(e) => {
                      const val = e.target.value
                      setPath(val)
                      setError(null)
                      runPathCheck(val)
                    }}
                    placeholder={currentMeta.placeholder}
                    spellCheck={false}
                    onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
                  />

                  <button
                    type="button"
                    className="btn btn-ghost shrink-0 flex items-center gap-1.5 !h-10 !px-3.5 text-xs font-medium"
                    disabled={pickingNative}
                    onClick={handlePickFolderNative}
                  >
                    {pickingNative ? (
                      <Loader2 size={15} className="animate-spin text-plankton" />
                    ) : (
                      <FolderOpen size={15} className="text-plankton" />
                    )}
                    <span>{pickingNative ? 'Opening…' : 'Browse…'}</span>
                  </button>
                </div>

                {pickingNative && (
                  <div className="mt-2 flex items-center gap-2 text-xs text-plankton/90 bg-plankton/5 border border-plankton/20 rounded-lg p-2">
                    <Loader2 size={13} className="animate-spin shrink-0" />
                    <span>Waiting for the folder window on your computer… (it may open behind the browser)</span>
                  </div>
                )}

                {/* Live summary under path */}
                <div className="mt-2 text-xs">
                  {checkingPath ? (
                    <span className="text-mist flex items-center gap-1.5">
                      <Loader2 size={12} className="animate-spin" /> Checking folder…
                    </span>
                  ) : checkInfo ? (
                    <div className={`p-2 rounded-lg border ${
                      checkInfo.ok
                        ? 'border-plankton/30 bg-plankton/5 text-ink'
                        : 'border-amber/30 bg-amber/5 text-amber'
                    }`}>
                      {checkInfo.message}
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="flex items-center justify-between text-[0.72rem] text-mist">
                <span>Indexed in place. Nothing is copied or changed.</span>
                <button
                  type="button"
                  className="text-mist hover:text-plankton underline"
                  onClick={() => setPickerModalOpen(true)}
                >
                  Browse inside NexMind
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {reviewFiles && reviewSourceTab === 'local' ? (
                <FolderReview
                  files={reviewFiles}
                  mode="code"
                  folderName={reviewFolderName}
                  onConfirm={handleConfirmReview}
                  onChangeFolder={() => {
                    setReviewFiles(null)
                    void handlePickDirectoryHandle()
                  }}
                  disabled={Boolean(health?.setup_required)}
                />
              ) : localServer.detected ? (
                <div className="rounded-2xl border border-plankton/30 bg-plankton/5 p-5 text-center space-y-3">
                  <div className="flex h-12 w-12 mx-auto items-center justify-center rounded-2xl bg-plankton/10 text-plankton">
                    <FolderOpen size={24} />
                  </div>
                  <p className="text-sm font-semibold text-ink">
                    NexMind is running on this computer: analyze the folder in place (fastest, nothing is uploaded)
                  </p>
                  <p className="text-xs text-mist max-w-[46ch] mx-auto">
                    The local server indexes your files in place. Nothing is uploaded to the cloud.
                  </p>
                  <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-2.5">
                    <a
                      href={`${localServer.url || 'http://127.0.0.1:8000'}/app#new-local`}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btn-primary btn-sm !h-9 !px-4 text-xs font-semibold inline-flex items-center gap-1.5"
                    >
                      <FolderOpen size={15} />
                      <span>Analyze on this computer</span>
                    </a>
                  </div>
                  <div className="pt-2">
                    <button
                      type="button"
                      className="text-xs text-mist hover:text-ink underline"
                      onClick={() => setShowUploadFallback(true)}
                    >
                      Upload instead (slower)
                    </button>
                  </div>
                </div>
              ) : !showUploadFallback ? (
                <div className="rounded-2xl border hair bg-black/20 p-5 space-y-4">
                  <div className="space-y-1">
                    <h3 className="text-sm font-semibold text-ink">
                      Analyze a folder from this computer
                    </h3>
                    <p className="text-xs text-mist leading-relaxed">
                      To analyze code directly on your computer without uploading files, run the local NexMind server.
                    </p>
                  </div>

                  <div className="space-y-3 text-xs">
                    <div className="space-y-1.5">
                      <span className="font-medium text-ink">1. Download or clone NexMind</span>
                      <div>
                        <a
                          href={repoUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-plankton hover:underline font-medium"
                        >
                          <span>Download or clone NexMind</span>
                          <ExternalLink size={13} />
                        </a>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <span className="font-medium text-ink">2. In the backend folder run:</span>
                      <CopyBlock
                        label={os === 'windows' ? 'PowerShell' : 'Terminal'}
                        command={startCmd}
                      />
                    </div>
                  </div>

                  <div className="pt-1 flex flex-wrap items-center justify-between gap-3 border-t hair">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm !h-8 !px-3 text-xs flex items-center gap-1.5 font-medium"
                      disabled={localServer.probing}
                      onClick={() => probeLocal(true)}
                    >
                      {localServer.probing ? (
                        <Loader2 size={13} className="animate-spin text-plankton" />
                      ) : (
                        <RefreshCw size={13} className="text-plankton" />
                      )}
                      <span>{localServer.probing ? 'Checking…' : 'Check again'}</span>
                    </button>

                    <button
                      type="button"
                      className="text-xs text-mist hover:text-ink underline"
                      onClick={() => setShowUploadFallback(true)}
                    >
                      Upload instead (slower)
                    </button>
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border-2 border-dashed border-white/10 bg-white/[0.02] p-6 text-center space-y-3">
                  <div className="flex h-12 w-12 mx-auto items-center justify-center rounded-2xl bg-plankton/10 text-plankton mb-1">
                    <FolderOpen size={24} />
                  </div>
                  <p className="text-sm font-medium text-ink">
                    Choose a project folder
                  </p>
                  <p className="text-xs text-mist max-w-[46ch] mx-auto leading-relaxed">
                    Pick your project folder (or just its src folder). Dependencies such as node_modules and .git are skipped without being read.
                  </p>
                  <div className="pt-2 flex flex-col items-center justify-center gap-2">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm flex items-center gap-1.5 !h-9 !px-4 text-xs font-semibold"
                      onClick={handlePickDirectoryHandle}
                    >
                      <FolderOpen size={15} className="text-ink" />
                      <span>Choose folder…</span>
                    </button>
                    <button
                      type="button"
                      className="text-xs text-mist hover:text-ink underline mt-2"
                      onClick={() => setShowUploadFallback(false)}
                    >
                      Analyze on this computer instead
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        )}

        {/* Phase Progress Bar with Cancel Button */}
        {uploadPhase && (
          <div className="rounded-2xl border hair bg-black/25 p-4 space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-ink flex items-center gap-2">
                <Loader2 size={13} className="animate-spin text-plankton" />
                <span>{uploadProgressText}</span>
              </span>
              <button
                type="button"
                className="text-mist hover:text-coral underline text-xs cursor-pointer"
                onClick={handleCancelUpload}
              >
                Cancel
              </button>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full bg-plankton transition-all duration-300 rounded-full"
                style={{ width: `${Math.max(4, Math.min(100, uploadProgressPct))}%` }}
              />
            </div>
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

        {/* Error with Retry */}
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

        {/* Submit Button & Pending state - only show when not reviewing files */}
        {!reviewFiles && (
          <div className="space-y-2 pt-1">
            <button
              type="button"
              className="btn btn-primary w-full !h-11 text-sm font-semibold"
              disabled={!isReady || busy || packing || pending || Boolean(health?.setup_required)}
              onClick={handleSubmit}
            >
              {busy ? (
                <>
                  <Loader2 className="animate-spin" size={17} />
                  <span>{pct !== null ? `Uploading ${pct}%` : 'Analyzing project…'}</span>
                </>
              ) : pending ? (
                <>
                  <Loader2 className="animate-spin" size={17} />
                  <span>Waiting for server…</span>
                </>
              ) : (
                <>
                  <Sparkles size={17} />
                  <span>Analyze project</span>
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
        )}
      </div>

      {/* In-app FolderPicker modal */}
      {localOk && pickerModalOpen && (
        <FolderPicker
          initialPath={path || undefined}
          onClose={() => setPickerModalOpen(false)}
          onPick={(pickedPath) => {
            setPath(pickedPath)
            setPickerModalOpen(false)
            setError(null)
            runPathCheck(pickedPath)
            if (!name) {
              setName(pickedPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '')
            }
          }}
        />
      )}
    </div>
  )
}
