import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowLeft, Check, ChevronDown, Plug } from 'lucide-react'
import { Aurora, CopyBlock, Logo } from '@/components/ui'
import { COMMANDS, PIP_COMMAND, detectOS, getUniversalConnectCommands, type OS } from '@/lib/os'
import { useServer } from '@/lib/server'
import { toast } from '@/lib/store'

const FIXES: { q: string; a: string }[] = [
  { q: 'Python or "nexmind" is not recognized', a: 'Install Python 3.10 or newer from python.org (tick “Add python.exe to PATH” on Windows), then open a new terminal and run the command again.' },
  { q: 'Chrome asks to access devices on my local network', a: 'Choose Allow. The web app only talks to the server on your own computer (127.0.0.1) — nothing is sent anywhere else.' },
  { q: 'It says waiting, but the server is running', a: 'Safari blocks https sites from reaching local servers. Use Chrome, Edge or Firefox, or run this web app locally with “npm run dev”. If you started the server on another port, enter its address below.' },
  { q: 'Something else is broken', a: 'Run “python -m nexmind doctor” in the backend folder. It checks Python, packages, git, the data folder and the port, and tells you what to fix.' },
]

export default function ConnectGate({ connected = false }: { connected?: boolean }) {
  const { status, attempts, health, base, useBase } = useServer()
  const [os, setOs] = useState<OS>('windows')
  const [open, setOpen] = useState<number | null>(null)
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => setOs(detectOS()), [])
  const cmd = COMMANDS[os]
  const { primary: connectCmd } = getUniversalConnectCommands(os)
  const online = connected || status === 'online'

  const connectCustom = async () => {
    setBusy(true)
    const ok = await useBase(custom)
    setBusy(false)
    if (!ok) toast.error('No NexMind server answered at that address. Check the URL and that the server is running.')
  }

  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden bg-abyss px-4 py-10">
      <Aurora />
      <Link to="/" className="absolute left-5 top-5 z-10 flex items-center gap-2 text-sm text-mist hover:text-ink"><ArrowLeft size={16} /> Back to site</Link>
      <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }}
        className="glass relative z-10 w-full max-w-[560px] rounded-3xl p-7 sm:p-9">
        <div className="flex flex-col items-center text-center">
          <Logo size={34} />
          <h1 className="mt-5 text-[1.75rem] font-bold leading-tight tracking-tight">Start your local server</h1>
          <p className="mt-2 max-w-[42ch] text-[0.95rem] text-mist">NexMind runs on your computer, so your code and documents stay with you. This page connects the moment the server starts.</p>
        </div>

        <ol className="mt-7 space-y-6">
          <li className="flex gap-4">
            <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-sm font-semibold ${online ? 'bg-plankton text-abyss' : 'bg-plankton/15 text-plankton'}`}>{online ? <Check size={16} /> : 1}</span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-semibold">Run one command</h2>
                <div role="tablist" aria-label="Operating system" className="flex gap-1">
                  {(Object.keys(COMMANDS) as OS[]).map((k) => (
                    <button key={k} role="tab" aria-selected={os === k} className="tab !px-2.5 !py-1 !text-xs" onClick={() => setOs(k)}>{COMMANDS[k].label}</button>
                  ))}
                </div>
              </div>
              <p className="mb-2 mt-1 text-sm text-mist">Run this from your project folder — no install needed:</p>
              <div className="space-y-2.5">
                <CopyBlock label={`${cmd.shell} · one-liner`} command={connectCmd} />
              </div>
              <p className="my-2 text-center text-xs text-mist">or, if you want to run the server yourself</p>
              <div className="space-y-2">
                <CopyBlock label={`${cmd.shell} · cd into backend first`} command={cmd.first} />
                <CopyBlock label={`${cmd.shell} · first run installs everything`} command={cmd.run} />
              </div>
              <p className="my-2 text-center text-xs text-mist">or, if you installed it as a command</p>
              <CopyBlock label="After pip install" command={PIP_COMMAND} />
            </div>
          </li>

          <li className="flex gap-4">
            <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-sm font-semibold ${online ? 'bg-plankton text-abyss' : 'bg-white/10 text-mist'}`}>{online ? <Check size={16} /> : 2}</span>
            <div className="min-w-0 flex-1">
              <h2 className="font-semibold">{online ? 'Server found' : 'Waiting for the server'}</h2>
              <div className="mt-2 flex items-center gap-3 rounded-xl border hair bg-black/35 px-4 py-3" aria-live="polite">
                <span className={`pulse-dot ${online ? '' : status === 'checking' ? '' : 'off'}`} />
                <div className="min-w-0 text-sm">
                  {online ? (<><div className="font-medium text-plankton">Connected to NexMind {health?.version}</div><div className="mono truncate text-xs text-mist">{base}</div></>) : (<><div className="font-medium">Listening for server…</div><div className="text-xs text-mist">Checking {base.replace(/^https?:\/\//, '')} every second{attempts > 6 ? ' — still nothing, see help below' : ''}</div></>)}
                </div>
              </div>
            </div>
          </li>

          <li className="flex gap-4 opacity-80">
            <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/10 text-sm font-semibold text-mist">3</span>
            <div><h2 className="font-semibold">Pick a repo or drop in documents</h2><p className="text-sm text-mist">Connects automatically and opens your workspaces.</p></div>
          </li>
        </ol>

        <div className="mt-7 border-t hair pt-4">
          <p className="mb-2 text-sm font-medium">Not working?</p>
          {FIXES.map((f, i) => (
            <div key={f.q} className="border-b hair last:border-0">
              <button className="flex w-full items-center justify-between gap-3 py-2.5 text-left text-sm text-mist hover:text-ink" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
                {f.q}<ChevronDown size={16} className={`shrink-0 transition-transform ${open === i ? 'rotate-180' : ''}`} />
              </button>
              <AnimatePresence initial={false}>
                {open === i && (<motion.p initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden pb-3 text-sm leading-relaxed text-mist">{f.a}</motion.p>)}
              </AnimatePresence>
            </div>
          ))}
          <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (custom) void connectCustom() }}>
            <input className="field" placeholder="Server on another port? http://127.0.0.1:8001" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Server address" />
            <button className="btn btn-ghost" disabled={!custom || busy} type="submit"><Plug size={16} /> Connect</button>
          </form>
        </div>
        <p className="mt-5 text-center text-xs text-mist">Needs Python 3.10+ · default address 127.0.0.1:8000</p>
      </motion.div>
    </div>
  )
}
