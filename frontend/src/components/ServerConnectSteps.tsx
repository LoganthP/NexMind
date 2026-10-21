import { useState, useEffect } from 'react'
import { ExternalLink, Terminal, AlertCircle, ChevronDown, Check, RefreshCw } from 'lucide-react'
import { detectOS, type OS } from '@/lib/os'
import { useServer } from '@/lib/server'
import { CopyBlock } from './ui'

interface ServerConnectStepsProps {
  compact?: boolean
}

export function ServerConnectSteps({ compact = true }: ServerConnectStepsProps) {
  const { status, base, attempts, health, check, useBase } = useServer()
  const [os, setOs] = useState<OS>('windows')
  const [showDiag, setShowDiag] = useState(false)
  const [customUrl, setCustomUrl] = useState('')
  const [checkingCustom, setCheckingCustom] = useState(false)

  // Keep localStorage serverSeen only to auto-collapse the "Get NexMind" step
  const [showGetRepo, setShowGetRepo] = useState(() => {
    try {
      return localStorage.getItem('nexmind.serverSeen') !== '1'
    } catch {
      return true
    }
  })

  useEffect(() => {
    setOs(detectOS())
  }, [])

  const repoUrl =
    (typeof import.meta !== 'undefined' &&
      ((import.meta as any).env?.VITE_BACKEND_REPO_URL || (import.meta as any).env?.VITE_REPO_URL)) ||
    'https://github.com/LoganthP/NexMind'

  const startCmd =
    os === 'windows'
      ? 'powershell -ExecutionPolicy Bypass -File .\\start.ps1'
      : './start.sh'

  const shortCmd = 'nexmind serve'
  const isOnline = status === 'online'
  const serverAddress = base || 'http://127.0.0.1:8000'

  const handleCustomConnect = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!customUrl.trim()) {
      void check()
      return
    }
    setCheckingCustom(true)
    try {
      await useBase(customUrl.trim())
    } finally {
      setCheckingCustom(false)
    }
  }

  return (
    <div className="space-y-3 text-xs text-mist">
      {/* 1. Optional Get NexMind (auto-collapsed if serverSeen) */}
      <div className="rounded-lg bg-black/20 p-2.5 border hair">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            className="flex items-center gap-1.5 font-semibold text-ink text-left hover:text-plankton"
            onClick={() => setShowGetRepo(!showGetRepo)}
          >
            <span>1. Get NexMind</span>
            <ChevronDown
              size={12}
              className={`transition-transform duration-200 ${showGetRepo ? 'rotate-180' : ''}`}
            />
          </button>
          <a
            href={repoUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-plankton hover:underline font-mono text-[0.7rem]"
          >
            {repoUrl.replace(/^https?:\/\//, '')}
            <ExternalLink size={10} />
          </a>
        </div>
        {showGetRepo && (
          <p className="mt-1 text-[0.75rem] text-mist">
            Clone or download the repository to your computer: <code className="mono text-ink">git clone {repoUrl}.git</code>
          </p>
        )}
      </div>

      {/* 2. Start the server per OS */}
      <div className="space-y-2 rounded-lg bg-black/20 p-2.5 border hair">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Terminal size={14} className="text-plankton" />
            <span className="font-semibold text-ink">2. Start the server:</span>
          </div>
          <div role="tablist" aria-label="Server OS" className="flex items-center gap-1">
            {(['windows', 'mac', 'linux'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={os === k}
                className={`tab !h-6 !px-2 !text-[0.7rem] ${os === k ? 'on' : ''}`}
                onClick={() => setOs(k)}
              >
                {k === 'windows' ? 'Windows' : k === 'mac' ? 'macOS' : 'Linux'}
              </button>
            ))}
          </div>
        </div>

        <CopyBlock
          label={`${os === 'windows' ? 'PowerShell' : 'Terminal'} · start script`}
          command={startCmd}
        />

        <div className="flex items-center justify-between gap-2 pt-1 text-[0.7rem]">
          <span>Or short command if installed:</span>
          <CopyBlock
            label="CLI"
            command={shortCmd}
          />
        </div>
      </div>

      {/* 3. Listening indicator */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-black/25 px-3 py-2 border hair">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              isOnline ? 'bg-plankton' : 'bg-amber animate-pulse'
            }`}
          />
          <span className="font-medium text-ink truncate">
            {isOnline
              ? `Connected to NexMind ${health?.version || ''}`
              : `Listening for server on ${serverAddress}…`}
          </span>
          {!isOnline && attempts > 1 && (
            <span className="text-mist/70 text-[0.7rem] shrink-0">({attempts} checks)</span>
          )}
        </div>
        <a
          href="http://127.0.0.1:8000/app"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-plankton hover:underline shrink-0 text-[0.75rem]"
        >
          Open NexMind on this computer instead
          <ExternalLink size={11} />
        </a>
      </div>

      {/* 4. Diagnosis card */}
      <div className="rounded-lg border hair bg-black/15 overflow-hidden">
        <button
          type="button"
          onClick={() => setShowDiag(!showDiag)}
          className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-white/[0.03] transition-colors"
          aria-expanded={showDiag}
        >
          <span className="flex items-center gap-1.5 font-medium text-ink">
            <AlertCircle size={13} className="text-mist" /> Still not connected?
          </span>
          <ChevronDown
            size={14}
            className={`transition-transform duration-200 ${
              showDiag ? 'rotate-180 text-ink' : 'text-mist'
            }`}
          />
        </button>

        {showDiag && (
          <div className="px-3 pb-3 pt-1 space-y-2.5 border-t hair text-xs text-mist leading-relaxed">
            <ul className="list-disc pl-4 space-y-1.5">
              <li>
                <strong className="text-ink">Direct test link:</strong> Open{' '}
                <a
                  href={`${serverAddress}/api/health`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-plankton underline"
                >
                  {serverAddress}/api/health
                </a>{' '}
                in a new tab to see if the server responds directly.
              </li>
              <li>
                <strong className="text-ink">Chrome / Edge permissions:</strong> If asked to access devices on your local network, choose <strong>Allow</strong>.
              </li>
              <li>
                <strong className="text-ink">Brave Shields:</strong> Turn Shields down for this site if Brave blocks HTTP connections to localhost.
              </li>
              <li>
                <strong className="text-ink">Safari:</strong> Safari restricts HTTPS pages from accessing local HTTP servers. Use Chrome, Edge, or Firefox, or click &ldquo;Open NexMind on this computer instead&rdquo; above.
              </li>
            </ul>

            <form onSubmit={handleCustomConnect} className="pt-1">
              <label htmlFor="custom-server-url" className="block text-[0.7rem] text-mist mb-1">
                Custom server URL (if running on another port or host):
              </label>
              <div className="flex gap-2">
                <input
                  id="custom-server-url"
                  className="field !h-7 !text-xs flex-1"
                  placeholder="http://127.0.0.1:8000"
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                />
                <button
                  type="submit"
                  disabled={checkingCustom}
                  className="btn btn-ghost btn-sm !h-7 !px-2.5 !text-xs whitespace-nowrap"
                >
                  <RefreshCw size={11} className={checkingCustom ? 'animate-spin' : ''} />
                  Check again now
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}
