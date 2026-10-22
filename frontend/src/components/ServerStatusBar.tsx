import { useState, useEffect } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import { useServer, isSameOrigin, isHostedEnvironment } from '@/lib/server'
import { CopyBlock } from './ui'
import { ServerConnectSteps } from './ServerConnectSteps'

export interface ServerStatusBarProps {
  expanded?: boolean
  onToggleExpand?: (expanded: boolean) => void
  pending?: boolean
  onCancelPending?: () => void
}

export function ServerStatusBar({
  expanded: controlledExpanded,
  onToggleExpand,
  pending = false,
  onCancelPending,
}: ServerStatusBarProps) {
  const { state, status, connected, health, base, blockedOrigin, setupRequired, backendError, check } = useServer()
  const [internalExpanded, setInternalExpanded] = useState(false)
  const [showFallbackButton, setShowFallbackButton] = useState(false)
  const [isChecking, setIsChecking] = useState(false)

  const isOnline = connected || status === 'online'
  const isExpanded = controlledExpanded !== undefined ? controlledExpanded : internalExpanded

  useEffect(() => {
    if (isOnline) {
      setShowFallbackButton(false)
      return
    }
    const timer = setTimeout(() => {
      setShowFallbackButton(true)
    }, 10000)
    return () => clearTimeout(timer)
  }, [isOnline])

  const handleToggle = () => {
    const next = !isExpanded
    setInternalExpanded(next)
    onToggleExpand?.(next)
  }

  const handleAllowAccess = async () => {
    setIsChecking(true)
    try {
      await check(true)
    } finally {
      setIsChecking(false)
    }
  }

  const handleTryAnotherPort = () => {
    if (!isExpanded) {
      setInternalExpanded(true)
      onToggleExpand?.(true)
    }
    setTimeout(() => {
      document.getElementById('custom-server-url')?.focus()
    }, 50)
  }

  if (isOnline) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-plankton/10 border border-plankton/25 px-3 py-1.5 text-xs text-plankton">
        <span className="h-1.5 w-1.5 rounded-full bg-plankton" />
        <span className="font-medium">Server connected</span>
        {health?.version && (
          <span className="text-mist/70 text-[0.7rem]">v{health.version}</span>
        )}
      </div>
    )
  }

  const currentState = state || 'not-running'
  const isSame = isSameOrigin(base)

  if (isSame) {
    let sameOriginMessage = 'Server unreachable (retrying…)'
    if (currentState === 'setup-needed') {
      sameOriginMessage = `Setup needed: ${setupRequired || health?.setup_required || 'Configuration required'}`
    } else if (currentState === 'backend-error') {
      sameOriginMessage = `Backend error: ${backendError ? `${backendError.status} ${backendError.reason}` : 'Server Error'}`
    } else if (currentState === 'unreachable') {
      sameOriginMessage = 'Server unreachable (retrying…)'
    }

    return (
      <div className="rounded-xl border border-amber/30 bg-amber/10 p-2.5 text-xs text-amber space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="h-2 w-2 rounded-full bg-amber animate-pulse shrink-0" />
            <span className="font-medium truncate">{sameOriginMessage}</span>
            {pending && (
              <span className="text-amber/90 truncate text-[0.7rem]">
                — We&apos;ll start as soon as the server connects.
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {pending && onCancelPending && (
              <button
                type="button"
                className="text-amber/80 hover:text-amber underline text-xs"
                onClick={onCancelPending}
              >
                Cancel
              </button>
            )}
            {currentState === 'backend-error' && (
              <a
                href={`${(base || '').replace(/\/+$/, '')}/api/health`}
                target="_blank"
                rel="noreferrer"
                className="text-amber/80 hover:text-amber underline text-xs inline-flex items-center gap-1"
              >
                <span>Open the server status</span>
                <ExternalLink size={10} />
              </a>
            )}
          </div>
        </div>
      </div>
    )
  }

  let message = 'Server not running'
  if (currentState === 'blocked-browser') {
    message = 'Server found, but your browser is blocking this page'
  } else if (currentState === 'blocked-origin') {
    message = "Server found, but it doesn't allow this site yet"
  } else if (currentState === 'outdated') {
    message = 'Your NexMind server is out of date'
  } else if (currentState === 'other-app') {
    message = 'Something else is using this address'
  }

  const effectiveOrigin =
    blockedOrigin ||
    (typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '') ||
    'https://nexmind.vercel.app'

  return (
    <div className="rounded-xl border border-amber/30 bg-amber/10 p-2.5 text-xs text-amber space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="h-2 w-2 rounded-full bg-amber animate-pulse shrink-0" />
          <span className="font-medium truncate">{message}</span>
          {pending && (
            <span className="text-amber/90 truncate text-[0.7rem]">
              — We&apos;ll start as soon as the server connects.
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {pending && onCancelPending && (
            <button
              type="button"
              className="text-amber/80 hover:text-amber underline text-xs"
              onClick={onCancelPending}
            >
              Cancel
            </button>
          )}

          {showFallbackButton ? (
            <a
              href="http://127.0.0.1:8000/app"
              target="_blank"
              rel="noreferrer"
              role="button"
              className="btn btn-ghost btn-sm !h-6 !px-2.5 text-amber border border-amber/40 hover:!bg-amber/20 text-xs inline-flex items-center gap-1"
            >
              <span>Open NexMind on this computer</span>
              <ExternalLink size={10} />
            </a>
          ) : (
            <a
              href="http://127.0.0.1:8000/app"
              target="_blank"
              rel="noreferrer"
              className="text-amber/80 hover:text-amber underline text-xs transition-colors"
            >
              Open NexMind on this computer
            </a>
          )}

          {currentState === 'blocked-browser' && (
            <>
              <button
                type="button"
                className="btn btn-ghost btn-sm !h-6 !px-2.5 text-amber hover:!bg-amber/20 font-medium"
                onClick={handleAllowAccess}
                disabled={isChecking}
              >
                {isChecking ? (
                  <span className="inline-flex items-center gap-1">
                    <Loader2 size={12} className="animate-spin" />
                    Checking…
                  </span>
                ) : (
                  'Allow access'
                )}
              </button>
              <button
                type="button"
                className="text-amber/80 hover:text-amber underline text-xs ml-1"
                onClick={handleToggle}
              >
                {isExpanded ? 'Hide' : 'Show me how'}
              </button>
            </>
          )}

          {currentState === 'blocked-origin' && (
            <button
              type="button"
              className="btn btn-ghost btn-sm !h-6 !px-2.5 text-amber hover:!bg-amber/20 font-medium"
              onClick={handleToggle}
            >
              {isExpanded ? 'Hide' : 'How to fix'}
            </button>
          )}

          {currentState === 'outdated' && (
            <button
              type="button"
              className="btn btn-ghost btn-sm !h-6 !px-2.5 text-amber hover:!bg-amber/20 font-medium"
              onClick={handleToggle}
            >
              {isExpanded ? 'Hide' : 'How to update'}
            </button>
          )}

          {currentState === 'other-app' && (
            <>
              <button
                type="button"
                className="btn btn-ghost btn-sm !h-6 !px-2.5 text-amber hover:!bg-amber/20 font-medium"
                onClick={handleTryAnotherPort}
              >
                Try another port
              </button>
              {isExpanded && (
                <button
                  type="button"
                  className="text-amber/80 hover:text-amber underline text-xs ml-1"
                  onClick={handleToggle}
                >
                  Hide
                </button>
              )}
            </>
          )}

          {currentState === 'not-running' && (
            <button
              type="button"
              className="btn btn-ghost btn-sm !h-6 !px-2.5 text-amber hover:!bg-amber/20 font-medium"
              onClick={handleToggle}
            >
              {isExpanded ? 'Hide' : 'Show me how'}
            </button>
          )}
        </div>
      </div>

      {currentState === 'blocked-origin' && (
        <div className="pt-2 border-t border-amber/20 space-y-1.5 text-xs text-amber/90">
          <p>
            Restart the backend after updating, or add this address to{' '}
            <code className="mono text-ink font-semibold">NEXMIND_CORS_ORIGINS</code> in{' '}
            <code className="mono text-ink font-semibold">backend/.env</code>:
          </p>
          <CopyBlock
            label="backend/.env"
            command={`NEXMIND_CORS_ORIGINS=${effectiveOrigin}`}
          />
        </div>
      )}

      {isExpanded && (
        <div className="pt-2 border-t border-amber/20 space-y-2">
          {currentState === 'outdated' && (
            <div className="space-y-1 text-xs text-amber/90">
              <p>Pull the latest code and restart:</p>
              <CopyBlock label="Terminal" command="python -m nexmind serve" />
            </div>
          )}
          <ServerConnectSteps />
        </div>
      )}
    </div>
  )
}
