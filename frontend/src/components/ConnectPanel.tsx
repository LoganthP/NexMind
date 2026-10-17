import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckCircle2, Folder, Terminal, AlertCircle } from 'lucide-react'
import { api, formatApiError, ApiError } from '@/lib/api'
import { useServer } from '@/lib/server'
import { detectOS, getUniversalConnectCommands, type OS } from '@/lib/os'
import { CopyBlock, Spinner, Switch } from './ui'
import { FolderPicker } from './FolderPicker'

interface Props {
  onSuccess?: (wsId: string) => void
  onClose?: () => void
}

export function ConnectPanel({ onSuccess, onClose }: Props) {
  const nav = useNavigate()
  const base = useServer((s) => s.base)
  const [os, setOs] = useState<OS>(detectOS())
  const [connectedSession, setConnectedSession] = useState<{
    name: string
    workspace_id: string
    reused: boolean
  } | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [keepSync, setKeepSync] = useState(true)
  const [connecting, setConnecting] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  const startTimestampRef = useRef<number>(0)
  const timerRef = useRef<any>(null)

  // Initialize since timestamp and start polling sessions
  useEffect(() => {
    let active = true

    api
      .connectSessions(0)
      .then((res) => {
        if (!active) return
        startTimestampRef.current = res.now || Date.now() / 1000

        const poll = async () => {
          if (!active) return
          try {
            const data = await api.connectSessions(startTimestampRef.current)
            if (!active) return
            if (data.sessions && data.sessions.length > 0) {
              const latest = data.sessions[data.sessions.length - 1]
              setConnectedSession(latest)
              setTimeout(() => {
                if (onSuccess) onSuccess(latest.workspace_id)
                else nav(`/app/w/${latest.workspace_id}`)
              }, 1200)
              return
            }
          } catch {
            // Polling error silently handled
          }
          timerRef.current = setTimeout(poll, 1500)
        }

        timerRef.current = setTimeout(poll, 1500)
      })
      .catch(() => {
        startTimestampRef.current = Date.now() / 1000
      })

    return () => {
      active = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [nav, onSuccess])

  // Use the live server base URL so the command works regardless of port.
  // Fall back to the python executable path (old-style) when the backend is
  // recent enough to serve /connect.py; otherwise show the classic command.
  const serverBase = (base || 'http://127.0.0.1:8000').replace(/\/$/, '')
  const { primary: primaryCommand, alt: altCommand } = getUniversalConnectCommands(os, serverBase)
  const shellLabel = os === 'windows' ? 'PowerShell' : 'Terminal'

  // Standard fallback command if user installed nexmind via pip
  const legacyCommand = altCommand

  const handlePickFolder = async (path: string) => {
    setConnecting(true)
    setErrorMsg('')
    try {
      const res = await api.connect(path, undefined, keepSync)
      setConnectedSession({
        name: res.name,
        workspace_id: res.workspace_id,
        reused: res.reused,
      })
      setTimeout(() => {
        if (onSuccess) onSuccess(res.workspace_id)
        else nav(`/app/w/${res.workspace_id}`)
      }, 1200)
    } catch (e: any) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 422)) {
        setErrorMsg('Your backend is out of date. Restart it with: python -m nexmind serve')
      } else {
        setErrorMsg(formatApiError(e))
      }
    } finally {
      setConnecting(false)
    }
  }

  if (connectedSession) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
        <CheckCircle2 size={40} className="text-plankton animate-bounce" />
        <h3 className="text-xl font-bold text-ink">
          {connectedSession.reused
            ? `Re-indexing ${connectedSession.name}`
            : `Connected ${connectedSession.name} · live sync on`}
        </h3>
        <p className="text-xs text-mist">Opening workspace…</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Step 1: Terminal commands */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <Terminal size={16} className="text-plankton shrink-0" />
            <h3 className="text-sm font-semibold text-ink">
              Open your project in VS Code and run in terminal{' '}
              <span className="font-mono text-xs font-normal text-mist">
                ({os === 'mac' ? 'Cmd + `' : 'Ctrl + `'})
              </span>
            </h3>
          </div>

          <div role="tablist" aria-label="Operating system" className="flex items-center gap-1 shrink-0">
            {(['windows', 'mac', 'linux'] as const).map((key) => (
              <button
                key={key}
                role="tab"
                aria-selected={os === key}
                className={`tab !h-7 !px-2.5 !text-xs ${os === key ? 'on' : ''}`}
                onClick={() => setOs(key)}
              >
                {key === 'windows' ? 'Windows' : key === 'mac' ? 'macOS' : 'Linux'}
              </button>
            ))}
          </div>
        </div>

        {/* Universal one-liner (no nexmind install required) */}
        <CopyBlock label={`${shellLabel} · no install needed`} command={primaryCommand} />

        {/* Fallback: installed via pip */}
        <div className="space-y-1.5">
          <p className="text-xs text-mist">Or, if you installed nexmind via pip:</p>
          <CopyBlock label={`${shellLabel} · pip`} command={legacyCommand} />
        </div>

        <p className="text-xs text-mist leading-relaxed">
          Run it from your project&apos;s root folder. Use <code className="mono text-ink">--no-watch</code> to index once without continuous sync.
        </p>
      </div>

      {/* Step 2: Waiting indicator */}
      <div className="flex items-center gap-3 rounded-xl border border-plankton/30 bg-plankton/5 p-4">
        <div className="relative grid h-4 w-4 place-items-center">
          <span className="absolute h-full w-full animate-ping rounded-full bg-plankton/40" />
          <span className="h-2 w-2 rounded-full bg-plankton" />
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium text-ink">Waiting for your project…</p>
          <p className="text-xs text-mist">
            Once you run the command, NexMind connects automatically and opens the live graph.
          </p>
        </div>
        <Spinner size={16} />
      </div>

      {/* Inline error if any */}
      {errorMsg && (
        <div className="flex items-center gap-2 rounded-xl border border-coral/40 bg-coral/10 p-3 text-xs text-coral">
          <AlertCircle size={16} className="shrink-0" />
          <span className="flex-1">{errorMsg}</span>
        </div>
      )}

      {/* Fallback: No terminal? */}
      <div className="border-t border-line/60 pt-4 space-y-3">
        <h4 className="text-xs font-semibold text-mist uppercase tracking-wider">
          No terminal? Pick the folder here
        </h4>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 rounded-xl border border-line bg-black/20 p-3">
          <div className="flex-1">
            <Switch
              label="Keep in sync (live)"
              checked={keepSync}
              onChange={setKeepSync}
            />
          </div>

          <button
            type="button"
            className="btn btn-ghost btn-sm !h-8 shrink-0 flex items-center gap-2"
            disabled={connecting}
            onClick={() => setPickerOpen(true)}
          >
            {connecting ? <Spinner size={14} /> : <Folder size={14} className="text-plankton" />}
            <span>Choose folder…</span>
          </button>
        </div>
      </div>

      {pickerOpen && (
        <FolderPicker
          onPick={(path) => {
            setPickerOpen(false)
            void handlePickFolder(path)
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  )
}
