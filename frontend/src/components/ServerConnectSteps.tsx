import { useState, useEffect } from 'react'
import { ExternalLink, Terminal, AlertCircle, ChevronDown, Check } from 'lucide-react'
import { detectOS, COMMANDS, type OS } from '@/lib/os'
import { useServer } from '@/lib/server'
import { CopyBlock } from './ui'

interface ServerConnectStepsProps {
  compact?: boolean
}

export function ServerConnectSteps({ compact = true }: ServerConnectStepsProps) {
  const { status, base, attempts, health } = useServer()
  const [os, setOs] = useState<OS>('windows')
  const [showDiag, setShowDiag] = useState(false)

  useEffect(() => {
    setOs(detectOS())
  }, [])

  const repoUrl =
    (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_REPO_URL) ||
    'https://github.com/LoganthP/NexMind'

  const startCmd =
    os === 'windows'
      ? 'powershell -ExecutionPolicy Bypass -File .\\start.ps1'
      : './start.sh'

  const shortCmd = 'nexmind serve'
  const isOnline = status === 'online'

  return (
    <div className="space-y-3.5 text-xs text-mist">
      {/* 1. Get NexMind */}
      <div className="flex items-center justify-between gap-2 rounded-lg bg-black/20 p-2.5 border hair">
        <div>
          <span className="font-semibold text-ink">1. Get NexMind:</span>{' '}
          <span>Clone or download the repository</span>
        </div>
        <a
          href={repoUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-plankton hover:underline font-mono"
        >
          {repoUrl.replace(/^https?:\/\//, '')}
          <ExternalLink size={12} />
        </a>
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
          <span>Or short form if installed:</span>
          <CopyBlock
            label="CLI"
            command={shortCmd}
          />
        </div>
      </div>

      {/* 3. Listening indicator */}
      <div className="flex items-center justify-between gap-2 rounded-lg bg-black/25 px-3 py-2 border hair">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${
              isOnline ? 'bg-plankton' : 'bg-amber animate-pulse'
            }`}
          />
          <span className="font-medium text-ink">
            {isOnline
              ? `Connected to NexMind ${health?.version || ''}`
              : `Listening for server on ${base || 'http://127.0.0.1:8000'}…`}
          </span>
          {!isOnline && attempts > 1 && (
            <span className="text-mist/70">({attempts} checks)</span>
          )}
        </div>
        <a
          href="http://127.0.0.1:8000/app"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-plankton hover:underline shrink-0"
        >
          Open NexMind on this computer instead
          <ExternalLink size={12} />
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
            <AlertCircle size={13} className="text-mist" /> Still having trouble connecting?
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
            <ul className="list-disc pl-4 space-y-1">
              <li>
                <strong className="text-ink">Python 3.10+ required:</strong> Download from{' '}
                <a
                  href="https://python.org"
                  target="_blank"
                  rel="noreferrer"
                  className="text-plankton underline"
                >
                  python.org
                </a>{' '}
                (tick &ldquo;Add python.exe to PATH&rdquo; on Windows).
              </li>
              <li>
                <strong className="text-ink">Local network access:</strong> If Chrome or Edge asks for
                permission to access local network devices, click <strong>Allow</strong>.
              </li>
              <li>
                <strong className="text-ink">Run diagnostics:</strong> Open your terminal in the backend
                folder and run <code className="mono text-ink">python -m nexmind doctor</code>.
              </li>
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
