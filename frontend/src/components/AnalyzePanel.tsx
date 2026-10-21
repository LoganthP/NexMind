import { useCallback, useRef, useState, type DragEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, FileUp, Folder, FolderOpen, GitBranch, GitMerge, GitPullRequest, KeyRound, Loader2, RotateCcw, Sparkles, UploadCloud, X } from 'lucide-react'
import { api, formatApiError, uploadFiles } from '@/lib/api'
import { toast } from '@/lib/store'
import { useServer } from '@/lib/server'
import { FolderPicker } from './FolderPicker'

type Tab = 'github' | 'gitlab' | 'azure' | 'upload' | 'local'
const TABS: { id: Tab; label: string; icon: typeof GitBranch; placeholder: string }[] = [
  { id: 'github', label: 'GitHub', icon: GitPullRequest, placeholder: 'https://github.com/owner/repo' },
  { id: 'gitlab', label: 'GitLab', icon: GitMerge, placeholder: 'https://gitlab.com/owner/repo' },
  { id: 'azure', label: 'Azure DevOps', icon: GitBranch, placeholder: 'https://dev.azure.com/org/project/_git/repo' },
  { id: 'upload', label: 'Upload project', icon: UploadCloud, placeholder: '' },
  { id: 'local', label: 'Local folder', icon: Folder, placeholder: 'C:\\Users\\you\\projects\\my-app' },
]

function nameFromUrl(u: string) {
  return u.replace(/\/+$/, '').replace(/\.git$/, '').split('/').pop() || 'Repository'
}

interface Props {
  workspaceId?: string
  onStarted?: (jobId: string, workspaceId: string) => void
  compact?: boolean
  kind?: 'code' | 'docs' | 'live'
  replaceSourceId?: string
}

export function AnalyzePanel({ workspaceId, onStarted, compact, kind = 'code', replaceSourceId }: Props) {
  const nav = useNavigate()
  const localOk = useServer((s) => s.health?.capabilities?.local_paths ?? true)
  const [tab, setTab] = useState<Tab>(kind === 'docs' ? 'upload' : 'github')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [pct, setPct] = useState<number | null>(null)
  const [picker, setPicker] = useState(false)
  const [drag, setDrag] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const meta = TABS.find((t) => t.id === tab)!
  const isGit = kind === 'code' && (tab === 'github' || tab === 'gitlab' || tab === 'azure')

  const addFiles = useCallback((list: FileList | File[]) => {
    setFiles((f) => [...f, ...Array.from(list)].slice(0, 200))
    setError(null)
  }, [])

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDrag(false)
    if (e.dataTransfer.files.length) {
      if (kind === 'code') setTab('upload')
      addFiles(e.dataTransfer.files)
    }
  }

  const ready = kind === 'docs'
    ? files.length > 0
    : isGit
      ? url.trim().length > 8
      : tab === 'local'
        ? path.trim().length > 1
        : files.length > 0

  const submit = async () => {
    if (!ready || busy) return
    setBusy(true)
    setPct(null)
    setError(null)

    try {
      let id = workspaceId
      let defaultName = kind === 'docs' ? 'Document study' : 'My workspace'
      let fullUrl = url.trim()

      if (isGit) {
        if (!/^https?:\/\//i.test(fullUrl)) fullUrl = 'https://' + fullUrl
        defaultName = nameFromUrl(fullUrl)
      } else if (tab === 'local') {
        defaultName = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'Local project'
      } else {
        defaultName = files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '') : `${files.length} documents`
      }

      const finalName = name.trim() || defaultName

      if (!id) {
        id = (await api.createWorkspace(finalName, '', kind === 'docs' ? 'docs' : 'code')).id
      }

      if (replaceSourceId) {
        try {
          await api.deleteSource(id, replaceSourceId)
        } catch {
          // ignore if already deleted
        }
      }

      let job: { job_id: string }
      if (isGit) {
        job = await api.ingestGit(id, fullUrl, token.trim() || undefined)
      } else if (tab === 'local') {
        job = await api.ingestLocal(id, path.trim())
      } else {
        job = await uploadFiles(id, files, setPct)
      }

      toast.success(kind === 'docs' ? 'Document indexing started' : 'Analysis started — watch the graph grow')
      onStarted?.(job.job_id, id)
      setUrl('')
      setToken('')
      setFiles([])
      setPath('')
      setName('')

      if (!workspaceId && !onStarted) {
        nav(`/app/w/${id}`)
      }
    } catch (e) {
      const msg = formatApiError(e)
      setError(msg)
      toast.error(msg)
    } finally {
      setBusy(false)
      setPct(null)
    }
  }

  const handleBrowse = async () => {
    try {
      const res = await api.fsPick('Select a folder', path || undefined)
      if (res.cancelled) return
      if (res.path) {
        setPath(res.path)
        setError(null)
      }
    } catch {
      setPicker(true)
    }
  }

  const fileAccept = kind === 'docs'
    ? '.pdf,.docx,.md,.txt,.html,.zip,.tar.gz'
    : '.zip,.tar.gz,.tgz,.tar,.py,.js,.ts,.tsx,.jsx,.go,.rs,.java,.c,.cpp,.h,.rb,.php,.json,.yaml,.yml'

  return (
    <div onDragOver={(e) => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
      {kind === 'code' && (
        <div role="tablist" aria-label="Source type" className="flex flex-wrap gap-1">
          {TABS.filter((t) => t.id !== 'local' || localOk).map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`tab flex items-center gap-1.5 ${tab === t.id ? 'on' : ''}`}
              onClick={() => { setTab(t.id); setError(null) }}
            >
              <t.icon size={15} />
              {!compact && t.label}
              {compact && <span className="sr-only">{t.label}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="mt-4 space-y-3">
        {!workspaceId && (
          <label className="block text-sm text-mist">
            Workspace name <span className="text-xs text-mist/70">(optional)</span>
            <input
              className="field mt-1.5"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={
                kind === 'docs'
                  ? 'Document study'
                  : isGit && url
                    ? nameFromUrl(url)
                    : tab === 'local' && path
                      ? path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'Local project'
                      : 'My workspace'
              }
              autoComplete="off"
            />
          </label>
        )}

        {kind === 'code' && isGit && (
          <>
            <label className="block text-sm text-mist">
              Repository URL
              <input
                className="field mt-1.5"
                value={url}
                onChange={(e) => { setUrl(e.target.value); setError(null) }}
                placeholder={meta.placeholder}
                spellCheck={false}
                autoComplete="off"
                onKeyDown={(e) => e.key === 'Enter' && submit()}
              />
            </label>
            <label className="block text-sm text-mist">
              <span className="flex items-center gap-1.5">
                <KeyRound size={14} /> Access token <span className="text-xs">(only for private repos)</span>
              </span>
              <input
                className="field mono mt-1.5"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ghp_… / glpat-…"
                autoComplete="off"
              />
            </label>
            <p className="text-xs text-mist">
              Public repos need no token. A token is used once to clone, never stored, and never leaves your machine.
            </p>
          </>
        )}

        {kind === 'code' && tab === 'local' && (
          <>
            <label className="block text-sm text-mist">
              Folder on this computer
              <div className="mt-1.5 flex gap-2">
                <input
                  className="field mono"
                  value={path}
                  onChange={(e) => { setPath(e.target.value); setError(null) }}
                  placeholder={meta.placeholder}
                  spellCheck={false}
                  onKeyDown={(e) => e.key === 'Enter' && submit()}
                />
                <button className="btn btn-ghost shrink-0" type="button" onClick={handleBrowse}>
                  <FolderOpen size={16} /> Browse
                </button>
              </div>
            </label>
            <p className="text-xs text-mist">
              Indexed in place — nothing is copied or changed. Re-index any time to pick up edits.
            </p>
          </>
        )}

        {(kind === 'docs' || (kind === 'code' && tab === 'upload')) && (
          <div className={`rounded-2xl border border-dashed px-4 py-7 text-center transition-colors ${drag ? 'border-plankton bg-plankton/10' : 'hair bg-black/20'}`}>
            <FileUp className="mx-auto text-plankton" size={26} />
            <p className="mt-2 text-sm">
              {kind === 'docs'
                ? 'Drop PDFs, Word files, notes or zipped folders of documents'
                : 'Upload a project .zip or .tar.gz'}
            </p>
            <button className="btn btn-ghost btn-sm mt-3" type="button" onClick={() => input.current?.click()}>
              Choose files
            </button>
            <input
              ref={input}
              type="file"
              multiple
              hidden
              accept={fileAccept}
              onChange={(e) => e.target.files && addFiles(e.target.files)}
            />
            {files.length > 0 && (
              <ul className="mt-4 max-h-32 space-y-1 overflow-auto text-left text-sm">
                {files.map((f, i) => (
                  <li key={i} className="flex items-center justify-between rounded-lg bg-white/5 px-2.5 py-1">
                    <span className="truncate">{f.name}</span>
                    <button
                      className="text-mist hover:text-coral"
                      onClick={() => setFiles(files.filter((_, j) => j !== i))}
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

        {error && (
          <div className="flex items-start gap-2.5 rounded-xl border border-coral/30 bg-coral/10 p-3 text-xs text-coral">
            <AlertCircle size={16} className="shrink-0 mt-0.5" />
            <div className="flex-1 leading-relaxed">{error}</div>
            <button
              className="btn btn-ghost btn-sm !h-6 !px-2 text-coral hover:!bg-coral/20 shrink-0"
              type="button"
              onClick={submit}
            >
              <RotateCcw size={12} /> Retry
            </button>
          </div>
        )}

        <button
          className="btn btn-primary w-full !h-11"
          disabled={!ready || busy}
          onClick={submit}
        >
          {busy ? (
            <>
              <Loader2 className="animate-spin" size={17} />
              {pct !== null ? `Uploading ${pct}%` : 'Starting…'}
            </>
          ) : (
            <>
              <Sparkles size={17} />
              {workspaceId
                ? replaceSourceId
                  ? 'Replace source'
                  : 'Add to workspace'
                : kind === 'docs'
                  ? 'Study documents'
                  : 'Analyze project'}
            </>
          )}
        </button>
      </div>

      {picker && (
        <FolderPicker
          onClose={() => setPicker(false)}
          onPick={(p) => {
            setPath(p)
            setPicker(false)
            setError(null)
          }}
        />
      )}
    </div>
  )
}
