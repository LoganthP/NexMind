import { Pause, Play, Route, X, Zap } from 'lucide-react'
import { motion } from 'framer-motion'
import { useShallow } from 'zustand/react/shallow'
import { useView } from '@/lib/store'
import { clearAll, eng, pauseFlow, playProcess, playTrace, seekFlow, selectNode } from '@/workspace/actions'

const RISK: Record<string, string> = { LOW: 'text-plankton border-plankton/50', MEDIUM: 'text-amber border-amber/50', HIGH: 'text-[#ff9a6c] border-[#ff9a6c]/50', CRITICAL: 'text-coral border-coral/60' }

export function ImpactCard() {
  const r = useView((s) => s.impact)
  if (!r) return null
  return (
    <motion.section initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="glass absolute left-1/2 top-[4.9rem] z-30 w-[min(520px,calc(100vw-1.5rem))] -translate-x-1/2 rounded-2xl p-4" aria-label="Impact analysis">
      <div className="flex items-start justify-between gap-3">
        <div><div className="flex items-center gap-2 text-sm text-mist"><Zap size={15} className="text-coral" /> If you change</div><h3 className="text-lg font-semibold">{r.target.label}</h3></div>
        <div className="flex items-center gap-2"><span className={`chip !px-3 !py-1 text-sm font-semibold ${RISK[r.risk.level]}`}>{r.risk.level}</span><button className="icon-btn" aria-label="Close" onClick={clearAll}><X size={16} /></button></div>
      </div>
      <p className="mt-1 text-sm text-mist">{r.total} dependents · {r.files_affected.length} files · {r.clusters_affected.length} clusters · {r.processes_affected.length} flows</p>
      <div className="mt-3 max-h-48 space-y-2 overflow-auto">
        {r.levels.length === 0 && <p className="text-sm text-mist">Nothing depends on this. It is safe to change.</p>}
        {r.levels.map((lvl) => (
          <div key={lvl.depth}>
            <div className="mb-1 text-xs text-mist">{lvl.depth === 1 ? 'Directly depends on it' : `${lvl.depth} steps away`}</div>
            <div className="flex flex-wrap gap-1.5">
              {lvl.nodes.slice(0, 14).map((n) => (
                <button key={n.id} className="chip hover:!border-plankton/60 hover:text-ink" style={{ opacity: 0.55 + n.confidence * 0.45 }} onClick={() => eng.current?.flyTo(n.id)} onDoubleClick={() => selectNode(n.id)} title={`${n.type} · confidence ${n.confidence}`}>{n.label}</button>
              ))}
              {lvl.nodes.length > 14 && <span className="chip">+{lvl.nodes.length - 14}</span>}
            </div>
          </div>
        ))}
      </div>
    </motion.section>
  )
}

export function TraceCard() {
  const { trace, traceFrom, mode, nodes } = useView(useShallow((s) => ({ trace: s.trace, traceFrom: s.traceFrom, mode: s.mode, nodes: s.nodes })))
  if (mode !== 'trace' && !trace) return null
  const from = nodes.find((n) => n.id === traceFrom)
  return (
    <motion.section initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="glass absolute left-1/2 top-[4.9rem] z-30 w-[min(520px,calc(100vw-1.5rem))] -translate-x-1/2 rounded-2xl p-4" aria-label="Trace">
      <div className="flex items-center justify-between"><div className="flex items-center gap-2 font-semibold"><Route size={16} className="text-plankton" /> Connection path</div><button className="icon-btn" aria-label="Close" onClick={clearAll}><X size={16} /></button></div>
      {!trace && <p className="mt-2 text-sm text-mist">{from ? <>Start: <b className="text-ink">{from.label}</b>. Now click where you want to end up.</> : 'Click the first node.'}</p>}
      {trace && !trace.found && <p className="mt-2 text-sm text-coral">These two nodes are not connected.</p>}
      {trace?.found && (
        <>
          <p className="mt-1 text-sm text-mist">{trace.length} hop{trace.length === 1 ? '' : 's'} · {trace.mode === 'directed-dependency' ? 'follows dependencies' : 'any relationship'}</p>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {trace.nodes.map((n, i) => (<span key={n.id} className="flex items-center gap-1.5"><button className="chip hover:!border-plankton/60 hover:text-ink" onClick={() => eng.current?.flyTo(n.id)}>{n.label}</button>{i < trace.nodes.length - 1 && <span className="text-mist">→</span>}</span>))}
          </div>
          <button className="btn btn-ghost btn-sm mt-3" onClick={() => playTrace(trace.nodes.map((n) => n.id))}><Play size={14} /> Replay</button>
        </>
      )}
    </motion.section>
  )
}

export function FlowPlayer() {
  const { p, step, playing } = useView(useShallow((s) => ({ p: s.flowProc, step: s.flowStep, playing: s.flowPlaying })))
  if (!p) return null
  const cur = p.steps[Math.max(0, step)]
  return (
    <motion.section initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="glass absolute left-1/2 top-[4.9rem] z-30 w-[min(520px,calc(100vw-1.5rem))] -translate-x-1/2 rounded-2xl p-4" aria-label="Flow player">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0"><div className="text-xs text-mist">Execution flow · {p.step_count} steps</div><h3 className="truncate font-semibold">{p.label}</h3></div>
        <div className="flex items-center gap-1">
          <button className="icon-btn on" aria-label={playing ? 'Pause' : 'Play'} onClick={() => (playing ? pauseFlow() : playProcess(p, step >= p.steps.length - 1 ? 0 : Math.max(0, step)))}>{playing ? <Pause size={18} /> : <Play size={18} />}</button>
          <button className="icon-btn" aria-label="Close" onClick={clearAll}><X size={16} /></button>
        </div>
      </div>
      <input type="range" className="mt-3 w-full accent-[#5cf2d6]" min={0} max={p.steps.length - 1} value={Math.max(0, step)} onChange={(e) => seekFlow(Number(e.target.value))} aria-label="Flow step" />
      <p className="mt-1 text-sm"><span className="mono text-plankton">{Math.max(0, step) + 1}.</span> <b>{cur?.label}</b> <span className="text-mist">{cur?.path ? `· ${cur.path}` : ''}</span></p>
    </motion.section>
  )
}
