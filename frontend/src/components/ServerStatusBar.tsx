import { useState } from 'react'
import { useServer } from '@/lib/server'
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
  const { status, health } = useServer()
  const [internalExpanded, setInternalExpanded] = useState(false)
  const isExpanded = controlledExpanded !== undefined ? controlledExpanded : internalExpanded

  const handleToggle = () => {
    const next = !isExpanded
    setInternalExpanded(next)
    onToggleExpand?.(next)
  }

  if (status === 'online') {
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

  return (
    <div className="rounded-xl border border-amber/30 bg-amber/10 p-2.5 text-xs text-amber space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="h-2 w-2 rounded-full bg-amber animate-pulse shrink-0" />
          <span className="font-medium truncate">Server not connected</span>
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
          <button
            type="button"
            className="btn btn-ghost btn-sm !h-6 !px-2.5 text-amber hover:!bg-amber/20"
            onClick={handleToggle}
          >
            {isExpanded ? 'Hide' : 'Connect'}
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className="pt-2 border-t border-amber/20">
          <ServerConnectSteps />
        </div>
      )}
    </div>
  )
}
