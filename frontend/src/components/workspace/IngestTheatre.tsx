import { AnimatePresence, motion } from 'framer-motion'
import { Check } from 'lucide-react'
import { useView } from '@/lib/store'

const PHASES: [string, string][] = [
  ['clone', 'Fetch'], ['extract', 'Unpack'], ['scan', 'Scan'], ['parse', 'Read'], ['symbols', 'Symbols'], ['links', 'Links'],
  ['knowledge', 'Ideas'], ['analyze', 'Clusters'], ['layout', 'Shape'], ['flows', 'Flows'], ['save', 'Save'], ['stream', 'Grow'],
]

/** Live build progress: phase trail, progress bar, node counter and a terminal feed. */
export function IngestTheatre() {
  const g = useView((s) => s.ingest)
  const idx = Math.max(0, PHASES.findIndex(([k]) => k === g.phase))
  const done = g.phase === 'done'
  return (
    <AnimatePresence>
      {g.active && (
        <motion.section initial={{ opacity: 0, y: 24, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16 }} transition={{ type: 'spring', stiffness: 260, damping: 28 }}
          className="glass pointer-events-auto absolute bottom-24 left-3 z-30 w-[min(420px,calc(100vw-1.5rem))] rounded-2xl p-4 md:left-[20.75rem]" aria-live="polite" aria-label="Graph build progress">
          <div className="flex items-baseline justify-between">
            <h3 className="font-semibold">{done ? 'Your graph is ready' : 'Growing your graph'}</h3>
            <span className="mono text-sm text-plankton">{Math.round(g.percent)}%</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"><motion.div className="h-full rounded-full bg-gradient-to-r from-plankton via-cyan-300 to-jelly" animate={{ width: `${g.percent}%` }} transition={{ ease: 'easeOut', duration: 0.4 }} /></div>
          <p className="mt-2 truncate text-sm text-mist">{g.message}</p>
          <ol className="mt-3 flex flex-wrap gap-1.5">
            {PHASES.map(([k, label], i) => {
              const state = done || i < idx ? 'done' : i === idx ? 'now' : 'todo'
              return (<li key={k} className={`chip ${state === 'done' ? '!border-plankton/40 text-plankton' : state === 'now' ? '!border-white/40 text-ink' : 'opacity-50'}`}>{state === 'done' && <Check size={10} />}{label}</li>)
            })}
          </ol>
          {g.streamTotal > 0 && <p className="mono mt-3 text-xs text-mist">{g.streamed} / {g.streamTotal} nodes placed</p>}
          {g.logs.length > 0 && (
            <div className="mono mt-3 max-h-20 overflow-hidden rounded-lg bg-black/40 p-2 text-[0.68rem] leading-relaxed text-mist">
              {g.logs.slice(-4).map((l, i) => <div key={i} className={l.level === 'warn' ? 'text-amber' : ''}>› {l.message}</div>)}
            </div>
          )}
        </motion.section>
      )}
    </AnimatePresence>
  )
}
