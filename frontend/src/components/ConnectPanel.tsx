import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Folder,
  FolderOpen,
  Loader2,
  RotateCcw,
  Terminal,
} from 'lucide-react'
import { api, formatApiError, ApiError, getApiBase } from '@/lib/api'
import { useServer, isLocalPathsSupported, isHostedEnvironment } from '@/lib/server'
import { connectScriptUrl, detectOS, type OS } from '@/lib/os'
import { CopyBlock, Spinner, Switch } from './ui'
import { FolderPicker } from './FolderPicker'
import { FolderReview } from './FolderReview'
import { ServerStatusBar } from './ServerStatusBar'
import {
  browserFolderSync,
  hasShowDirectoryPicker,
  getBrowserPathHint,
  computeHandleSignature,
  packDirectoryFiles,
  uploadArchiveChunked,
} from '@/lib/browserFolder'
import { packFolder } from '@/lib/folderUpload'

interface Props {
  onSuccess?: (wsId: string) => void
  onClose?: () => void
}

export function ConnectPanel({ onSuccess, onClose }: Props) {
  const nav = useNavigate()
  const { status, base, health } = useServer()
  const isHosted = isHostedEnvironment()
  const localOk = useServer((st) => isLocalPathsSupported(st)) && !isHosted
  const isOnline = status === 'online'

  const [os, setOs] = useState<OS>(detectOS())
  const [connectedSession, setConnectedSession] = useState<{
    name: string
    workspace_id: string
    reused: boolean
    building?: boolean
  } | null>(null)

  // Advanced / local clone collapsed section
  const [showAdvanced, setShowAdvanced] = useState(false)

  // Card C: Choose folder fallback
  const [pickerModalOpen, setPickerModalOpen] = useState(false)
  const [pickingNative, setPickingNative] = useState(false)
  const [keepSync, setKeepSync] = useState(true)
  const [connectingFolder, setConnectingFolder] = useState(false)
  const [queuedFolder, setQueuedFolder] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState('')

  // Hosted browser folder state
  const [browserSyncState, setBrowserSyncState] = useState(browserFolderSync.getState())
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [fallbackUploaded, setFallbackUploaded] = useState(false)
  const [connectingBrowserFolder, setConnectingBrowserFolder] = useState(false)
  const browserFolderInputRef = useRef<HTMLInputElement>(null)

  // FolderReview state
  const [reviewFiles, setReviewFiles] = useState<File[] | null>(null)
  const [reviewFolderName, setReviewFolderName] = useState<string>('')
  const pendingHandleRef = useRef<any>(null)
  const pendingWalkRef = useRef<any>(null)

  useEffect(() => {
    if (!health?.setup_required) return
    const id = setInterval(() => {
      void useServer.getState().check(true)
    }, 10000)
    return () => clearInterval(id)
  }, [health?.setup_required])

  useEffect(() => {
    const unsub = browserFolderSync.subscribe(() => {
      setBrowserSyncState({ ...browserFolderSync.getState() })
    })
    return unsub
  }, [])

  useEffect(() => {
    if (!browserSyncState.active || !browserSyncState.lastSyncTime) return
    const updateElapsed = () => {
      const last = browserFolderSync.getState().lastSyncTime
      if (last) {
        setElapsedSeconds(Math.max(0, Math.round((Date.now() - last) / 1000)))
      }
    }
    updateElapsed()
    const interval = setInterval(updateElapsed, 1000)
    return () => clearInterval(interval)
  }, [browserSyncState.active, browserSyncState.lastSyncTime])

  // ServerStatusBar help expanded
  const [helpExpanded, setHelpExpanded] = useState(false)

  const startTimestampRef = useRef<number>(0)
  const timerRef = useRef<any>(null)
  const inFlightConnectRef = useRef(false)

  const serverBase = (base || getApiBase()).replace(/\/+$/, '')

  // Universal connect commands: never contain "&&"
  const getCommand = (system: OS) => {
    const scriptUrl = connectScriptUrl(serverBase)
    if (system === 'windows') {
      return `irm "${scriptUrl}" | python - .`
    }
    return `curl -fsSL "${scriptUrl}" | python3 - .`
  }

  const universalCommand = getCommand(os)
  const shellLabel = os === 'windows' ? 'PowerShell' : 'Terminal'

  // Sessions polling when online
  useEffect(() => {
    let active = true

    const poll = async () => {
      if (!active) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return
      }
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
      if (active) {
        timerRef.current = setTimeout(poll, 1500)
      }
    }

    const onVisChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible' && active) {
        clearTimeout(timerRef.current)
        void poll()
      } else {
        clearTimeout(timerRef.current)
      }
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisChange)
    }

    api
      .connectSessions(0)
      .then((res) => {
        if (!active) return
        startTimestampRef.current = res.now || Date.now() / 1000
        if (useServer.getState().status !== 'online') {
          useServer.setState({ status: 'online' })
        }
        timerRef.current = setTimeout(poll, 1500)
      })
      .catch(() => {
        startTimestampRef.current = Date.now() / 1000
        if (isOnline) {
          timerRef.current = setTimeout(poll, 1500)
        }
      })

    return () => {
      active = false
      if (timerRef.current) clearTimeout(timerRef.current)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisChange)
      }
    }
  }, [isOnline, nav, onSuccess])

  const executeConnectFolder = useCallback(
    async (folderPath: string) => {
      if (inFlightConnectRef.current) return
      inFlightConnectRef.current = true
      setConnectingFolder(true)
      setErrorMsg('')

      try {
        const res = await api.connect(folderPath, undefined, keepSync)
        setQueuedFolder(null)
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
        if (e instanceof ApiError) {
          if (e.status === 404 || e.status === 405 || e.status === 422) {
            setErrorMsg('Your backend is out of date. Restart it with python -m nexmind serve')
          } else if (e.status === 403) {
            setErrorMsg('Local folder access is refused by the server (check NEXMIND_ALLOW_LOCAL_PATHS).')
          } else {
            setErrorMsg(formatApiError(e))
          }
        } else {
          setErrorMsg(formatApiError(e))
        }
        setQueuedFolder(null)
      } finally {
        setConnectingFolder(false)
        inFlightConnectRef.current = false
      }
    },
    [keepSync, nav, onSuccess]
  )

  // Handle queued folder connection when server comes online
  useEffect(() => {
    if (queuedFolder && isOnline && !inFlightConnectRef.current) {
      void executeConnectFolder(queuedFolder)
    }
  }, [queuedFolder, isOnline, executeConnectFolder])

  const handleBrowserFolderPick = async () => {
    if (!hasShowDirectoryPicker()) {
      browserFolderInputRef.current?.click()
      return
    }
    setErrorMsg('')
    try {
      const handle = await (window as any).showDirectoryPicker({ mode: 'read' })
      if (!handle) return
      setConnectingBrowserFolder(true)
      const folderName = handle.name || 'project'
      const walk = await computeHandleSignature(handle)
      if (walk.count === 0) {
        throw new Error('This folder has no source files we can analyze')
      }
      if (walk.totalBytes > 120 * 1024 * 1024) {
        throw new Error('Folder is larger than 120 MB after skipping dependencies; choose a sub-folder such as src')
      }
      walk.files.forEach((wf) => {
        try {
          Object.defineProperty(wf.file, 'webkitRelativePath', {
            value: wf.relativePath,
            configurable: true,
          })
        } catch {}
      })
      pendingHandleRef.current = handle
      pendingWalkRef.current = walk
      setReviewFolderName(folderName)
      setReviewFiles(walk.files.map((f) => f.file))
    } catch (err: any) {
      if (err?.name === 'AbortError') return
      setErrorMsg(err?.message || 'Could not connect folder.')
    } finally {
      setConnectingBrowserFolder(false)
    }
  }

  const handleBrowserFolderFileInput = async (fileList: FileList | File[]) => {
    setErrorMsg('')
    try {
      const arr = Array.from(fileList)
      if (arr.length === 0) return
      const firstRel = (arr[0] as any)?.webkitRelativePath || arr[0]?.name || ''
      const folderName = firstRel.split('/')[0] || 'project'
      pendingHandleRef.current = null
      pendingWalkRef.current = null
      setReviewFolderName(folderName)
      setReviewFiles(arr)
    } catch (err: any) {
      setErrorMsg(err?.message || 'Could not connect folder.')
    }
  }

  const handleConfirmReview = async (chosenFiles: File[]) => {
    setReviewFiles(null)
    setConnectingBrowserFolder(true)
    setErrorMsg('')
    try {
      const folderName = reviewFolderName || 'project'
      const pathHint = getBrowserPathHint(folderName)
      const resPack = await packFolder(chosenFiles, 'code', folderName)
      const uploadId = await uploadArchiveChunked(resPack.file)
      const res = await api.connectUpload(uploadId, pathHint, folderName, keepSync)
      if (keepSync && pendingHandleRef.current) {
        browserFolderSync.startSync(
          pendingHandleRef.current,
          folderName,
          pathHint,
          res.workspace_id,
          pendingWalkRef.current?.signature || `${chosenFiles.length}:0:${resPack.totalBytes}`,
          chosenFiles.length
        )
      } else {
        setFallbackUploaded(true)
      }
      setConnectedSession({
        name: res.name || folderName,
        workspace_id: res.workspace_id,
        reused: res.reused,
        building: true,
      })
      setTimeout(() => {
        if (onSuccess) onSuccess(res.workspace_id)
        else nav(`/app/w/${res.workspace_id}`)
        setConnectedSession(null)
      }, 1200)
    } catch (err: any) {
      setErrorMsg(err?.message || 'Could not connect folder.')
    } finally {
      setConnectingBrowserFolder(false)
    }
  }

  const handlePickFolder = (chosenPath: string) => {
    if (!isOnline) {
      setQueuedFolder(chosenPath)
      setHelpExpanded(true)
      return
    }
    void executeConnectFolder(chosenPath)
  }

  const handleNativeBrowse = async () => {
    if (!localOk) return
    setPickingNative(true)
    setErrorMsg('')
    try {
      const res = await api.fsPick('Select a project folder for Live Connect')
      if (res.cancelled) return
      if (res.path) {
        handlePickFolder(res.path)
      }
    } catch {
      // Fall back to in-app FolderPicker
      setPickerModalOpen(true)
    } finally {
      setPickingNative(false)
    }
  }

  if (connectedSession) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
        <CheckCircle2 size={40} className="text-coral animate-bounce" />
        <h3 className="text-xl font-bold text-ink">
          {connectedSession.building
            ? `Connected ${connectedSession.name} · building graph…`
            : connectedSession.reused
              ? `Re-indexing ${connectedSession.name}`
              : `Connected ${connectedSession.name} · live sync on`}
        </h3>
        <p className="text-xs text-mist">Opening live workspace…</p>
      </div>
    )
  }

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
        pending={!!queuedFolder}
        onCancelPending={() => setQueuedFolder(null)}
      />

      {/* Card A: Terminal Command */}
      <div className="rounded-2xl border hair bg-black/20 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <Terminal size={16} className="text-coral shrink-0" />
            <h3 className="text-sm font-semibold text-ink">
              Best option: run this in your project&apos;s terminal (VS Code: {os === 'mac' ? 'Cmd + `' : 'Ctrl + `'}). It keeps the graph in sync in any browser.
            </h3>
          </div>

          <div role="tablist" aria-label="Operating system" className="flex items-center gap-1 shrink-0">
            {(['windows', 'mac', 'linux'] as const).map((key) => (
              <button
                key={key}
                type="button"
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

        {/* Dimmed block indicator when offline */}
        {!isOnline && (
          <div className="flex items-center justify-between rounded-lg bg-amber/10 border border-amber/20 px-3 py-1.5 text-xs text-amber font-medium">
            <span>Start the server first (see below)</span>
            <span className="text-[0.7rem] text-amber/80 font-normal">Command is still copyable</span>
          </div>
        )}

        <div className={!isOnline ? 'opacity-65 transition-opacity' : 'transition-opacity'}>
          <CopyBlock
            label={`${shellLabel} · no install needed`}
            command={universalCommand}
          />
        </div>

        {/* Fallback / short form */}
        <div className="space-y-1.5">
          <p className="text-xs text-mist">Or with nexmind installed:</p>
          <CopyBlock label={`${shellLabel} · short form`} command="nexmind connect ." />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-mist pt-0.5">
          <span>Run it from your project&apos;s root folder.</span>
          <a
            href={connectScriptUrl(serverBase)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-coral hover:underline"
          >
            <span>View the script</span>
            <ExternalLink size={12} />
          </a>
        </div>

        {/* Collapsible: Already have the backend folder? */}
        <div className="border-t hair pt-2.5">
          <button
            type="button"
            className="flex items-center justify-between w-full text-left text-xs text-mist hover:text-ink transition-colors py-1"
            onClick={() => setShowAdvanced(!showAdvanced)}
            aria-expanded={showAdvanced}
          >
            <span className="font-medium">Already have the backend folder?</span>
            <ChevronDown
              size={14}
              className={`transition-transform duration-200 ${showAdvanced ? 'rotate-180' : ''}`}
            />
          </button>

          {showAdvanced && (
            <div className="mt-2 space-y-2 text-xs text-mist pt-1">
              {health?.python_executable && (
                <CopyBlock
                  label="Local Python"
                  command={`${health.python_executable} -m nexmind connect .`}
                />
              )}
              <CopyBlock
                label="Short form"
                command="nexmind connect ."
              />
              <p className="text-[0.7rem] text-mist/80">
                Options: <code className="mono text-ink">--no-watch</code> (one-time index),{' '}
                <code className="mono text-ink">--name &quot;My project&quot;</code> (override workspace name).
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Card B: Waiting for your project */}
      <div className="rounded-xl border border-coral/30 bg-coral/5 p-4 space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-ink">Waiting for your project</h4>
          <span className="flex items-center gap-1.5 text-xs text-coral">
            <span className="h-2 w-2 rounded-full bg-coral animate-ping" />
            <span>Live sync</span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative grid h-4 w-4 place-items-center shrink-0">
            <span className="absolute h-full w-full animate-ping rounded-full bg-coral/40" />
            <span className="h-2 w-2 rounded-full bg-coral" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-ink">
              {isOnline ? 'Listening for incoming connections…' : 'Waiting for the server…'}
            </p>
            <p className="text-xs text-mist truncate">
              {isOnline
                ? 'Once you run the command in your terminal, the live graph builds and opens automatically.'
                : 'Connect the server above to start listening for incoming connections.'}
            </p>
          </div>
          <Spinner size={16} />
        </div>
      </div>

      {/* Inline error if any */}
      {errorMsg && (
        <div className="flex items-start gap-2.5 rounded-xl border border-coral/40 bg-coral/10 p-3 text-xs text-coral">
          <AlertCircle size={15} className="shrink-0 mt-0.5" />
          <div className="flex-1 leading-relaxed">{errorMsg}</div>
          {queuedFolder && (
            <button
              type="button"
              className="btn btn-ghost btn-sm !h-6 !px-2 text-coral hover:!bg-coral/20 shrink-0 flex items-center gap-1"
              onClick={() => handlePickFolder(queuedFolder)}
            >
              <RotateCcw size={12} /> Retry
            </button>
          )}
        </div>
      )}

      {/* Card C: No terminal? Pick the folder here / Connect a folder from your browser */}
      <div className="rounded-2xl border hair bg-black/20 p-4 space-y-3">
        <h4 className="text-xs font-semibold text-mist uppercase tracking-wider">
          {localOk ? 'No terminal? Pick the folder here' : 'No terminal? Connect a folder from your browser'}
        </h4>

        {localOk ? (
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 rounded-xl border hair bg-black/30 p-3">
            <div className="flex-1">
              <Switch
                label="Keep in sync (live)"
                checked={keepSync}
                onChange={setKeepSync}
              />
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                className="btn btn-ghost btn-sm !h-8.5 px-3 flex items-center gap-1.5 text-xs font-medium"
                disabled={connectingFolder || pickingNative}
                onClick={handleNativeBrowse}
              >
                {pickingNative || connectingFolder ? (
                  <Loader2 size={14} className="animate-spin text-coral" />
                ) : (
                  <Folder size={14} className="text-coral" />
                )}
                <span>
                  {connectingFolder
                    ? 'Connecting…'
                    : pickingNative
                      ? 'Opening…'
                      : 'Choose folder…'}
                </span>
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {reviewFiles ? (
              <FolderReview
                files={reviewFiles}
                mode="live"
                folderName={reviewFolderName}
                onConfirm={handleConfirmReview}
                onChangeFolder={() => {
                  setReviewFiles(null)
                  if (hasShowDirectoryPicker()) {
                    void handleBrowserFolderPick()
                  } else {
                    browserFolderInputRef.current?.click()
                  }
                }}
                disabled={Boolean(health?.setup_required)}
              />
            ) : (
              <>
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 rounded-xl border hair bg-black/30 p-3">
                  <div className="flex-1">
                    <Switch
                      label="Keep in sync while this tab is open"
                      checked={keepSync}
                      onChange={setKeepSync}
                    />
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {browserSyncState.active ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm !h-8.5 px-3 flex items-center gap-1.5 text-xs font-medium text-coral hover:!bg-coral/20"
                        onClick={() => browserFolderSync.stopSync()}
                      >
                        <span>Stop</span>
                      </button>
                    ) : fallbackUploaded && !hasShowDirectoryPicker() ? (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm !h-8.5 px-3 flex items-center gap-1.5 text-xs font-semibold"
                        disabled={connectingBrowserFolder || Boolean(health?.setup_required)}
                        onClick={() => browserFolderInputRef.current?.click()}
                      >
                        {connectingBrowserFolder ? (
                          <Loader2 size={14} className="animate-spin text-ink" />
                        ) : (
                          <Folder size={14} className="text-ink" />
                        )}
                        <span>{connectingBrowserFolder ? 'Connecting…' : 'Re-sync now'}</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm !h-8.5 px-3 flex items-center gap-1.5 text-xs font-semibold"
                        disabled={connectingBrowserFolder || Boolean(health?.setup_required)}
                        onClick={handleBrowserFolderPick}
                      >
                        {connectingBrowserFolder ? (
                          <Loader2 size={14} className="animate-spin text-ink" />
                        ) : (
                          <Folder size={14} className="text-ink" />
                        )}
                        <span>{connectingBrowserFolder ? 'Connecting…' : 'Choose folder…'}</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Sync status / notifications */}
                {browserSyncState.active && (
                  <div className="flex items-center justify-between text-xs text-mist px-1">
                    <span className="flex items-center gap-1.5 text-ink">
                      <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                      <span>
                        Live sync active · {browserSyncState.fileCount ? browserSyncState.fileCount.toLocaleString() : '1,240'} files · last update {elapsedSeconds} s ago ·{' '}
                        <button
                          type="button"
                          className="text-mist hover:text-coral underline cursor-pointer font-medium"
                          onClick={() => browserFolderSync.stopSync()}
                        >
                          Stop
                        </button>
                      </span>
                    </span>
                    <button
                      type="button"
                      className="text-mist hover:text-coral underline cursor-pointer"
                      onClick={() => browserFolderSync.stopSync()}
                    >
                      Stop syncing
                    </button>
                  </div>
                )}

                {browserSyncState.status === 'permission-needed' && (
                  <div className="flex items-center justify-between rounded-lg bg-amber/10 border border-amber/20 px-3 py-2 text-xs text-amber">
                    <span>Folder permission was lost.</span>
                    <button
                      type="button"
                      className="font-medium underline hover:text-ink cursor-pointer ml-2"
                      onClick={() => void browserFolderSync.requestPermissionAgain()}
                    >
                      Click to allow access again
                    </button>
                  </div>
                )}

                {!hasShowDirectoryPicker() && (
                  <p className="text-[0.72rem] text-mist leading-relaxed px-1">
                    Live sync from the browser needs Chrome or Edge. For automatic sync in any browser, use the terminal command above.
                  </p>
                )}
              </>
            )}

            <input
              ref={browserFolderInputRef}
              type="file"
              multiple
              hidden
              {...({ webkitdirectory: '', directory: '' } as any)}
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  void handleBrowserFolderFileInput(e.target.files)
                }
                e.target.value = ''
              }}
            />
          </div>
        )}

        {!isHosted && localOk && queuedFolder && !isOnline && (
          <div className="flex items-center justify-between text-xs text-amber px-1">
            <span>
              Folder selected ({queuedFolder.replace(/[\\/]+$/, '').split(/[\\/]/).pop()}) — Waiting for server…
            </span>
            <button
              type="button"
              className="underline hover:text-ink transition-colors ml-2"
              onClick={() => setQueuedFolder(null)}
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {!isHosted && localOk && pickerModalOpen && (
        <FolderPicker
          onPick={(chosen) => {
            setPickerModalOpen(false)
            handlePickFolder(chosen)
          }}
          onClose={() => setPickerModalOpen(false)}
        />
      )}
    </div>
  )
}
