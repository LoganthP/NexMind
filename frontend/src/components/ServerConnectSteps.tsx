import { useState, useEffect } from 'react'
import { ExternalLink, Terminal, AlertCircle, ChevronDown, RefreshCw } from 'lucide-react'
import { detectOS, type OS } from '@/lib/os'
import { useServer } from '@/lib/server'
import { CopyBlock } from './ui'

export type BrowserType = 'chrome' | 'brave' | 'safari' | 'other'

export function detectBrowser(): BrowserType {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'chrome'
  const ua = navigator.userAgent || ''
  if ((navigator as any).brave || ua.includes('Brave')) return 'brave'
  if (ua.includes('Safari') && !ua.includes('Chrome') && !ua.includes('Chromium') && !ua.includes('Edg')) return 'safari'
  if (ua.includes('Chrome') || ua.includes('Edg')) return 'chrome'
  return 'chrome'
}

interface ServerConnectStepsProps {
  compact?: boolean
}

export function ServerConnectSteps({ compact = true }: ServerConnectStepsProps) {
  const { status, state, base, attempts, health, check, useBase } = useServer()
  const [os, setOs] = useState<OS>('windows')
  const [showDiag, setShowDiag] = useState(false)
  const [customUrl, setCustomUrl] = useState('')
  const [checkingCustom, setCheckingCustom] = useState(false)
  const [checkResult, setCheckResult] = useState<string | null>(null)
  const [isCheckingInline, setIsCheckingInline] = useState(false)

  const [detectedBrowser, setDetectedBrowser] = useState<BrowserType>('chrome')
  const [expandedBrowsers, setExpandedBrowsers] = useState<Record<string, boolean>>({
    chrome: false,
    brave: false,
    safari: false,
  })

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
    const b = detectBrowser()
    setDetectedBrowser(b)
    setExpandedBrowsers({
      chrome: b === 'chrome',
      brave: b === 'brave',
      safari: b === 'safari',
    })
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
  const isOnline = status === 'online' || state === 'connected'
  const serverAddress = base || 'http://127.0.0.1:8000'

  const handleCustomConnect = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!customUrl.trim()) {
      void handleCheckAgain()
      return
    }
    setCheckingCustom(true)
    try {
      await useBase(customUrl.trim())
    } finally {
      setCheckingCustom(false)
    }
  }

  const handleCheckAgain = async () => {
    setIsCheckingInline(true)
    setCheckResult(null)
    try {
      const ok = await check(true)
      if (ok) {
        setCheckResult('Connected')
      } else {
        const s = useServer.getState().state
        let reason = 'Server not running'
        if (s === 'blocked-browser') reason = 'Browser is blocking local network'
        else if (s === 'blocked-origin') reason = 'Origin not allowed'
        else if (s === 'outdated') reason = 'Server is out of date'
        else if (s === 'other-app') reason = 'Port in use by another app'
        setCheckResult(`Still blocked: ${reason}`)
      }
    } finally {
      setIsCheckingInline(false)
    }
  }

  const toggleBrowser = (b: string) => {
    setExpandedBrowsers((prev) => ({ ...prev, [b]: !prev[b] }))
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

      {/* 3. Direct Test Link */}
      <div className="rounded-lg bg-black/20 p-2.5 border hair space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 font-semibold text-ink">
            <span>Test the server directly:</span>
            <a
              href={`${serverAddress}/api/health`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-plankton hover:underline font-mono text-[0.75rem]"
            >
              {serverAddress}/api/health
              <ExternalLink size={11} />
            </a>
          </div>
        </div>
        <p className="text-[0.75rem] text-mist">
          If you see text starting with <code className="mono text-ink">{`{"app":"nexmind"`}</code>, the server is running and your browser is the problem.
        </p>
      </div>

      {/* 4. Browser-specific instructions */}
      <div className="space-y-1.5 rounded-lg bg-black/20 p-2.5 border hair">
        <div className="font-semibold text-ink mb-1">Browser permissions &amp; troubleshooting:</div>

        {/* Chrome / Edge */}
        <div className="rounded border hair bg-black/30 overflow-hidden">
          <button
            type="button"
            className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-xs hover:bg-white/[0.03]"
            onClick={() => toggleBrowser('chrome')}
          >
            <span className="font-medium text-ink flex items-center gap-1.5">
              <span>Chrome / Edge</span>
              {detectedBrowser === 'chrome' && (
                <span className="chip !text-[0.65rem] !py-0 !px-1.5 text-plankton border-plankton/30">
                  Detected
                </span>
              )}
            </span>
            <ChevronDown
              size={12}
              className={`transition-transform duration-200 ${
                expandedBrowsers.chrome ? 'rotate-180 text-ink' : 'text-mist'
              }`}
            />
          </button>
          {expandedBrowsers.chrome && (
            <div className="px-2.5 pb-2 pt-1 border-t hair text-[0.75rem] text-mist">
              Click the site-settings icon in the address bar, set &ldquo;Local network access&rdquo; to Allow, then reload.
            </div>
          )}
        </div>

        {/* Brave */}
        <div className="rounded border hair bg-black/30 overflow-hidden">
          <button
            type="button"
            className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-xs hover:bg-white/[0.03]"
            onClick={() => toggleBrowser('brave')}
          >
            <span className="font-medium text-ink flex items-center gap-1.5">
              <span>Brave</span>
              {detectedBrowser === 'brave' && (
                <span className="chip !text-[0.65rem] !py-0 !px-1.5 text-plankton border-plankton/30">
                  Detected
                </span>
              )}
            </span>
            <ChevronDown
              size={12}
              className={`transition-transform duration-200 ${
                expandedBrowsers.brave ? 'rotate-180 text-ink' : 'text-mist'
              }`}
            />
          </button>
          {expandedBrowsers.brave && (
            <div className="px-2.5 pb-2 pt-1 border-t hair text-[0.75rem] text-mist">
              Turn Shields off for this site.
            </div>
          )}
        </div>

        {/* Safari */}
        <div className="rounded border hair bg-black/30 overflow-hidden">
          <button
            type="button"
            className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-xs hover:bg-white/[0.03]"
            onClick={() => toggleBrowser('safari')}
          >
            <span className="font-medium text-ink flex items-center gap-1.5">
              <span>Safari</span>
              {detectedBrowser === 'safari' && (
                <span className="chip !text-[0.65rem] !py-0 !px-1.5 text-plankton border-plankton/30">
                  Detected
                </span>
              )}
            </span>
            <ChevronDown
              size={12}
              className={`transition-transform duration-200 ${
                expandedBrowsers.safari ? 'rotate-180 text-ink' : 'text-mist'
              }`}
            />
          </button>
          {expandedBrowsers.safari && (
            <div className="px-2.5 pb-2 pt-1 border-t hair text-[0.75rem] text-mist">
              Use &ldquo;Open NexMind on this computer&rdquo;.
            </div>
          )}
        </div>
      </div>

      {/* 5. Listening indicator & Check again now */}
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

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleCheckAgain}
            disabled={isCheckingInline}
            className="btn btn-ghost btn-sm !h-7 !px-2.5 !text-xs font-medium"
          >
            <RefreshCw size={12} className={isCheckingInline ? 'animate-spin' : ''} />
            <span>Check again now</span>
          </button>
          {checkResult && (
            <span
              className={`text-[0.75rem] font-medium ${
                checkResult === 'Connected' ? 'text-plankton' : 'text-amber'
              }`}
            >
              {checkResult}
            </span>
          )}
        </div>
      </div>

      <div className="flex justify-end">
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

      {/* 6. Custom port / host form */}
      <div className="rounded-lg border hair bg-black/15 overflow-hidden">
        <button
          type="button"
          onClick={() => setShowDiag(!showDiag)}
          className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-white/[0.03] transition-colors"
          aria-expanded={showDiag}
        >
          <span className="flex items-center gap-1.5 font-medium text-ink">
            <AlertCircle size={13} className="text-mist" /> Custom server URL
          </span>
          <ChevronDown
            size={14}
            className={`transition-transform duration-200 ${
              showDiag ? 'rotate-180 text-ink' : 'text-mist'
            }`}
          />
        </button>

        {showDiag && (
          <div className="px-3 pb-3 pt-1 space-y-2 border-t hair text-xs text-mist leading-relaxed">
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
                  Connect
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}
