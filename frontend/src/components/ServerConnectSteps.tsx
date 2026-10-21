import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, ChevronDown, Download, Plug } from 'lucide-react'
import { CopyBlock } from '@/components/ui'
import { detectOS, type OS } from '@/lib/os'
import { useServer } from '@/lib/server'
import { toast } from '@/lib/store'

const FIXES: { q: string; a: string }[] = [
  {
    q: 'Python or "nexmind" is not recognized',
    a: 'Install Python 3.10 or newer from python.org (tick “Add python.exe to PATH” on Windows), then open a new terminal and run the command again.',
  },
  {
    q: 'Chrome asks to access devices on my local network',
    a: 'Choose Allow. The web app only talks to the server on your own computer (127.0.0.1) — nothing is sent anywhere else.',
  },
  {
    q: 'It says waiting, but the server is running',
    a: 'Safari blocks https sites from reaching local servers. Use Chrome, Edge or Firefox, or run this web app locally with “npm run dev”. If you started the server on another port, enter its address below.',
  },
  {
    q: 'Something else is broken',
    a: 'Run “python -m nexmind doctor” in the backend folder. It checks Python, packages, git, the data folder and the port, and tells you what to fix.',
  },
]

const hasSeenServerBefore = (): boolean => {
  try {
    return (
      localStorage.getItem('nexmind.serverSeen') === '1' ||
      localStorage.getItem('nexmind.serverEverDetected') === '1'
    )
  } catch {
    return false
  }
}

export interface ServerConnectStepsProps {
  connected?: boolean
}

export default function ServerConnectSteps({ connected = false }: ServerConnectStepsProps) {
  const { status, attempts, health, base, useBase, connected: serverConnected } = useServer()
  const [os, setOs] = useState<OS>('windows')
  const [openFix, setOpenFix] = useState<number | null>(null)
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)
  const [step1Open, setStep1Open] = useState(() => !hasSeenServerBefore())

  useEffect(() => {
    setOs(detectOS())
  }, [])

  const online = connected || serverConnected || status === 'online'

  const connectCustom = async () => {
    setBusy(true)
    const ok = await useBase(custom)
    setBusy(false)
    if (!ok) {
      toast.error('No NexMind server answered at that address. Check the URL and that the server is running.')
    }
  }

  // Environment variables
  const zipUrl = (import.meta.env.VITE_BACKEND_ZIP_URL as string | undefined)?.trim()
  const rawRepoUrl = import.meta.env.VITE_BACKEND_REPO_URL as string | undefined
  const repoUrl = (rawRepoUrl !== undefined ? rawRepoUrl : 'https://github.com/LoganthP/NexMind').trim()
  const pipPkg = (import.meta.env.VITE_PIP_PACKAGE as string | undefined)?.trim()

  const repoName = repoUrl ? repoUrl.split('/').pop()?.replace(/\.git$/, '') || 'NexMind' : 'NexMind'
  const hasAnyMethod = Boolean(zipUrl || repoUrl || pipPkg)

  const cloneCmd =
    os === 'windows'
      ? `git clone ${repoUrl}\ncd ${repoName}\\backend`
      : `git clone ${repoUrl}\ncd ${repoName}/backend`

  const startCmd =
    os === 'windows'
      ? 'powershell -ExecutionPolicy Bypass -File .\\start.ps1'
      : './start.sh'

  return (
    <div className="w-full text-sm text-mist">
      <ol className="space-y-6">
        {/* Step 1: Get NexMind */}
        <li className="flex gap-3 sm:gap-4">
          <span
            className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold ${
              online ? 'bg-plankton text-abyss' : 'bg-plankton/15 text-plankton'
            }`}
          >
            {online ? <Check size={14} /> : 1}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold text-sm text-ink">Get NexMind (first time only)</h3>
              <button
                type="button"
                onClick={() => setStep1Open(!step1Open)}
                className="flex items-center gap-1 text-xs text-mist hover:text-ink"
                aria-expanded={step1Open}
              >
                <span>{step1Open ? 'Collapse' : 'Expand'}</span>
                <ChevronDown
                  size={14}
                  className={`transition-transform ${step1Open ? 'rotate-180' : ''}`}
                />
              </button>
            </div>

            <AnimatePresence initial={false}>
              {step1Open ? (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden"
                >
                  <p className="mt-1 text-xs text-mist">
                    Download or clone the backend folder to your machine:
                  </p>
                  <div className="mt-2.5 space-y-2.5">
                    {zipUrl && (
                      <div>
                        <a
                          href={zipUrl}
                          download
                          className="btn btn-ghost btn-sm inline-flex items-center gap-2 text-xs"
                        >
                          <Download size={14} /> Download backend (.zip)
                        </a>
                      </div>
                    )}

                    {repoUrl && (
                      <CopyBlock
                        label={os === 'windows' ? 'PowerShell · clone & enter' : 'Terminal · clone & enter'}
                        command={cloneCmd}
                      />
                    )}

                    {pipPkg && (
                      <CopyBlock
                        label="pip install"
                        command={`pip install ${pipPkg}`}
                      />
                    )}

                    {!hasAnyMethod && (
                      <p className="rounded-xl border hair bg-black/20 p-3 text-xs text-mist">
                        Ask the project owner for the NexMind backend folder.
                      </p>
                    )}
                  </div>
                </motion.div>
              ) : (
                <p className="mt-1 text-xs text-mist/70">
                  Step collapsed (server detected previously). Click Expand to view instructions.
                </p>
              )}
            </AnimatePresence>
          </div>
        </li>

        {/* Step 2: Start the server */}
        <li className="flex gap-3 sm:gap-4">
          <span
            className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold ${
              online ? 'bg-plankton text-abyss' : 'bg-plankton/15 text-plankton'
            }`}
          >
            {online ? <Check size={14} /> : 2}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold text-sm text-ink">
                Start the server (in the backend folder)
              </h3>
              <div role="tablist" aria-label="Operating system" className="flex gap-1">
                <button
                  type="button"
                  role="tab"
                  aria-selected={os === 'windows'}
                  className={`tab !px-2.5 !py-1 !text-xs ${os === 'windows' ? 'on' : ''}`}
                  onClick={() => setOs('windows')}
                >
                  Windows
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={os === 'mac'}
                  className={`tab !px-2.5 !py-1 !text-xs ${os === 'mac' ? 'on' : ''}`}
                  onClick={() => setOs('mac')}
                >
                  macOS
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={os === 'linux'}
                  className={`tab !px-2.5 !py-1 !text-xs ${os === 'linux' ? 'on' : ''}`}
                  onClick={() => setOs('linux')}
                >
                  Linux
                </button>
              </div>
            </div>

            <div className="mt-2 space-y-2">
              <CopyBlock
                label={os === 'windows' ? 'Windows PowerShell' : os === 'mac' ? 'macOS Terminal' : 'Linux Terminal'}
                command={startCmd}
              />
              <div className="flex items-center justify-between px-1 text-xs text-mist">
                <span>or, if installed via pip:</span>
                <code className="mono text-[13px] text-plankton bg-black/40 px-2 py-0.5 rounded border hair select-all">
                  nexmind serve
                </code>
              </div>
            </div>
          </div>
        </li>

        {/* Step 3: This page continues by itself */}
        <li className="flex gap-3 sm:gap-4">
          <span
            className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold ${
              online ? 'bg-plankton text-abyss' : 'bg-white/10 text-mist'
            }`}
          >
            {online ? <Check size={14} /> : 3}
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-sm text-ink">This page continues by itself</h3>
            <div
              className="mt-2 flex items-center gap-3 rounded-xl border hair bg-black/35 px-4 py-3"
              aria-live="polite"
            >
              <span className={`pulse-dot ${online ? '' : status === 'checking' ? '' : 'off'}`} />
              <div className="min-w-0 text-xs sm:text-sm">
                {online ? (
                  <>
                    <div className="font-medium text-plankton">
                      Connected{health?.version ? ` to NexMind ${health.version}` : ''}
                    </div>
                    <div className="mono truncate text-xs text-mist">{base}</div>
                  </>
                ) : (
                  <>
                    <div className="font-medium text-ink">Listening for server…</div>
                    <div className="text-xs text-mist">
                      Checking {base.replace(/^https?:\/\//, '')} every second
                      {attempts > 6 ? ' — still nothing, see help below' : ''}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </li>
      </ol>

      {/* Still not connected? diagnosis card */}
      <div className="mt-6 rounded-2xl border hair bg-black/25 p-4 space-y-2">
        <h4 className="font-semibold text-xs sm:text-sm text-ink">Still not connected?</h4>
        <p className="text-xs text-mist leading-relaxed">
          If the server is running in your terminal but this page cannot reach it (for example due to browser mixed-content restrictions or Safari), open the local app directly:
        </p>
        <div>
          <a
            href="http://127.0.0.1:8000/app"
            target="_blank"
            rel="noreferrer"
            className="btn btn-ghost btn-sm !h-8 text-xs text-plankton hover:!bg-plankton/10"
          >
            Open NexMind on this computer instead
          </a>
        </div>
      </div>

      {/* Help accordions & custom port */}
      <div className="mt-5 border-t hair pt-4">
        <p className="mb-2 text-xs font-medium text-ink">Troubleshooting</p>
        {FIXES.map((f, i) => (
          <div key={f.q} className="border-b hair last:border-0">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 py-2 text-left text-xs text-mist hover:text-ink"
              aria-expanded={openFix === i}
              onClick={() => setOpenFix(openFix === i ? null : i)}
            >
              <span>{f.q}</span>
              <ChevronDown
                size={14}
                className={`shrink-0 transition-transform ${openFix === i ? 'rotate-180' : ''}`}
              />
            </button>
            <AnimatePresence initial={false}>
              {openFix === i && (
                <motion.p
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden pb-2.5 text-xs leading-relaxed text-mist"
                >
                  {f.a}
                </motion.p>
              )}
            </AnimatePresence>
          </div>
        ))}

        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (custom) void connectCustom()
          }}
        >
          <input
            className="field !h-8 !text-xs"
            placeholder="Server on another port? http://127.0.0.1:8001"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            aria-label="Server address"
          />
          <button
            className="btn btn-ghost btn-sm !h-8 !px-3 text-xs"
            disabled={!custom || busy}
            type="submit"
          >
            <Plug size={14} /> Connect
          </button>
        </form>
      </div>

      <p className="mt-4 text-center text-[11px] text-mist/70">
        Needs Python 3.10+ · default address 127.0.0.1:8000
      </p>
    </div>
  )
}
