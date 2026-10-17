import { useCallback, useState, type ReactNode, type PointerEvent as RPE } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, Copy, X } from 'lucide-react'
import { useToasts } from '@/lib/store'

export function Logo({ size = 28, text = true }: { size?: number; text?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
        <defs><radialGradient id="lg"><stop offset="0" stopColor="#5cf2d6" /><stop offset="1" stopColor="#9b8cff" /></radialGradient></defs>
        <g stroke="#5cf2d6" strokeOpacity=".65" strokeWidth="3"><path d="M16 42 32 14 48 40M16 42 48 40M32 14 32 52M16 42 32 52 48 40" fill="none" /></g>
        <g fill="url(#lg)"><circle cx="16" cy="42" r="7" /><circle cx="32" cy="14" r="8" /><circle cx="48" cy="40" r="7" /><circle cx="32" cy="52" r="6" /></g>
      </svg>
      {text && <span className="text-[1.15rem] font-bold tracking-tight">NexMind</span>}
    </span>
  )
}

export function Aurora() {
  return <div className="aurora" aria-hidden><i /><i /><i /></div>
}

/** Card with a pointer-following light. */
export function Spot({ children, className = '' }: { children: ReactNode; className?: string }) {
  const move = useCallback((e: RPE<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`)
    e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`)
  }, [])
  return <div className={`spot ${className}`} onPointerMove={move}>{children}</div>
}

export function CopyBlock({ label, command }: { label: string; command: string }) {
  const [done, setDone] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(command) } catch {
      const t = document.createElement('textarea'); t.value = command; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove()
    }
    setDone(true); setTimeout(() => setDone(false), 1600)
  }
  return (
    <div className="overflow-hidden rounded-xl border hair bg-black/45">
      <div className="flex items-center justify-between border-b hair px-3 py-1.5">
        <span className="flex items-center gap-1.5 text-xs text-mist"><i className="h-2 w-2 rounded-full bg-coral/80" /><i className="h-2 w-2 rounded-full bg-amber/80" /><i className="h-2 w-2 rounded-full bg-plankton/80" /><span className="ml-2">{label}</span></span>
        <button className="icon-btn !h-7 !w-7" onClick={copy} aria-label={`Copy command: ${command}`}>
          {done ? <Check size={15} className="text-plankton" /> : <Copy size={15} />}
        </button>
      </div>
      <pre className="mono overflow-x-auto px-3 py-3 text-[0.82rem] text-ink"><span className="select-none text-plankton">$ </span>{command}</pre>
    </div>
  )
}

export function Toasts() {
  const { items, dismiss } = useToasts()
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-[100] flex -translate-x-1/2 flex-col items-center gap-2" role="status" aria-live="polite">
      <AnimatePresence>
        {items.map((t) => (
          <motion.div key={t.id} initial={{ opacity: 0, y: 14, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8 }}
            className={`glass pointer-events-auto flex max-w-[90vw] items-center gap-3 rounded-xl px-4 py-2.5 text-sm ${t.kind === 'error' ? '!border-coral/50' : t.kind === 'success' ? '!border-plankton/50' : ''}`}>
            <span>{t.text}</span>
            <button className="text-mist hover:text-ink" onClick={() => dismiss(t.id)} aria-label="Dismiss"><X size={14} /></button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="flex w-full items-center justify-between gap-3 rounded-lg px-1 py-1.5 text-left text-sm hover:bg-white/5">
      <span>{label}</span>
      <span className={`relative h-5 w-9 rounded-full transition-colors ${checked ? 'bg-plankton' : 'bg-white/15'}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? 'left-[1.15rem]' : 'left-0.5'}`} />
      </span>
    </button>
  )
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="inline-block animate-spin rounded-full border-2 border-white/20 border-t-plankton" style={{ width: size, height: size }} aria-label="Loading" />
}

export const typeDot = (color: string) => <i className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
