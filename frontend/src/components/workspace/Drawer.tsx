import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowDownLeft, ArrowUpRight, ExternalLink, MessageCircleQuestion, Network, Orbit, Radar, Sparkles, X, Zap } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { toast, useView } from '@/lib/store'
import type { EdgeDetail, NodeDetail } from '@/lib/types'
import { Spinner } from '@/components/ui'
import { clearAll, eng, expandNeighbors, focusEgo, playProcess, runImpact, selectEdge, selectNode } from '@/workspace/actions'

type Tab = 'overview' | 'content' | 'relations' | 'flows' | 'explain'

export function Drawer() {
  const open = useView((s) => s.drawerOpen)
  const nodeId = useView((s) => s.selectedId)
  const edgeId = useView((s) => s.selectedEdgeId)
  const close = () => { eng.current?.setSelected(null); useView.getState().patch({ drawerOpen: false, selectedEdgeId: null }) }
  return (
    <AnimatePresence>
      {open && (nodeId || edgeId) && (
        <motion.aside key="drawer" initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }} transition={{ type: 'spring', stiffness: 280, damping: 30 }}
          className="glass absolute bottom-3 right-3 top-[4.9rem] z-30 flex w-[min(25rem,calc(100vw-1.5rem))] flex-col rounded-2xl" aria-label="Details">
          <button className="icon-btn absolute right-2 top-2 z-10" aria-label="Close details" onClick={close}><X size={17} /></button>
          {edgeId ? <EdgePane id={edgeId} /> : nodeId ? <NodePane id={nodeId} /> : null}
        </motion.aside>
      )}
    </AnimatePresence>
  )
}

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null)
  const [err, setErr] = useState('')
  const [n, setN] = useState(0)
  useEffect(() => {
    let live = true
    setData(null); setErr('')
    fn().then((d) => live && setData(d)).catch((e) => live && setErr(e instanceof ApiError ? e.message : 'Could not load details'))
    return () => { live = false }
  }, [...deps, n]) // eslint-disable-line react-hooks/exhaustive-deps
  return { data, err, retry: () => setN(n + 1) }
}

function NodePane({ id }: { id: string }) {
  const { data: d, err, retry } = useLoad<NodeDetail>(() => api.node(eng.wsId, id), [id])
  const [tab, setTab] = useState<Tab>('overview')
  const colors = useView((s) => s.legend.node)
  const kind = useView((s) => s.kind)
  useEffect(() => setTab('overview'), [id])
  if (err) return <div className="p-6 pt-12 text-sm"><p className="text-coral">{err}</p><button className="btn btn-ghost btn-sm mt-3" onClick={retry}>Try again</button></div>
  if (!d) return <div className="space-y-3 p-5 pt-12">{[60, 100, 80, 90].map((w, i) => <div key={i} className="shimmer h-4 rounded" style={{ width: `${w}%` }} />)}</div>
  const isDocs = kind === 'docs'
  const color = colors[d.type] ?? d.color ?? '#5cf2d6'
  const isSymbol = ['Function', 'Method', 'Class', 'File'].includes(d.type)
  const relCount = Object.values(d.relations ?? {}).reduce((a, r) => a + r.in.length + r.out.length, 0)
  const allTabs: [Tab, string][] = [['overview', 'Overview'], ['content', d.code ? 'Code' : 'Text'], ['relations', `Links ${relCount}`], ['flows', 'Flows'], ['explain', 'Explain']]
  const tabs = isDocs ? allTabs.filter(([k]) => k !== 'flows') : allTabs
  return (
    <>
      <div className="border-b hair px-5 pb-3 pt-4 pr-12">
        <div className="flex items-center gap-2"><i className="h-3 w-3 shrink-0 rounded-full" style={{ background: color, boxShadow: `0 0 12px ${color}` }} /><span className="chip">{d.type}</span>{d.language && <span className="chip">{d.language}</span>}</div>
        <h2 className="mt-2 break-words text-xl font-bold leading-tight">{d.label}</h2>
        {d.path && <p className="mono mt-1 truncate text-xs text-mist" title={d.path}>{d.path}{d.code ? `:${d.code.start}-${d.code.end}` : ''}</p>}
      </div>
      <div role="tablist" className="flex gap-0.5 overflow-x-auto border-b hair px-3 py-1.5">
        {tabs.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} className="tab !px-2.5 !py-1 !text-xs whitespace-nowrap" onClick={() => setTab(k)}>{label}</button>)}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {tab === 'overview' && (
          <div className="space-y-4">
            {d.breadcrumb && d.breadcrumb.length > 0 && <div className="flex flex-wrap items-center gap-1 text-xs text-mist">{d.breadcrumb.map((b, i) => <span key={b.id} className="flex items-center gap-1"><button className="hover:text-ink" onClick={() => selectNode(b.id)}>{b.label}</button>{i < d.breadcrumb!.length - 1 && '/'}</span>)}</div>}
            <p className="text-[0.92rem] leading-relaxed text-[#cfe0f2]">{d.summary || 'No description available.'}</p>
            <div className="grid grid-cols-3 gap-2 text-center">
              <Metric label="Importance" value={`${Math.round(d.score * 100)}%`} />
              <Metric label="Used by" value={String(d.degree.in)} />
              <Metric label="Uses" value={String(d.degree.out)} />
            </div>
            {d.cluster && <button className="chip !px-3 !py-1.5 text-sm" style={{ color: d.cluster.color, borderColor: d.cluster.color + '66' }} onClick={() => useView.getState().patch({ panel: 'filters', railOpen: true })}>{d.cluster.label} · {d.cluster.size} nodes</button>}
            <div className="grid grid-cols-2 gap-2 pt-1">
              <button className="btn btn-ghost btn-sm" onClick={() => runImpact(d.id, 'upstream')}><Zap size={14} className="text-coral" /> What depends on it</button>
              <button className="btn btn-ghost btn-sm" onClick={() => runImpact(d.id, 'downstream')}><Radar size={14} className="text-amber" /> What it depends on</button>
              <button className="btn btn-ghost btn-sm" onClick={() => expandNeighbors(d.id)}><Network size={14} /> Reveal connections</button>
              <button className="btn btn-ghost btn-sm" onClick={() => focusEgo(d.id)}><Orbit size={14} /> Focus around</button>
              <button className="btn btn-primary btn-sm col-span-2" onClick={() => { useView.getState().patch({ askDraft: `Explain \`${d.label}\` and how it connects to the rest of the project.`, chatOpen: true }) }}><MessageCircleQuestion size={15} /> Ask about this</button>
            </div>
          </div>
        )}
        {tab === 'content' && (
          d.code ? (
            <div>
              <pre className="mono overflow-x-auto rounded-xl bg-black/50 p-3 text-[0.74rem] leading-relaxed">{d.code.text.split('\n').map((l, i) => (<div key={i} className="flex"><span className="w-9 shrink-0 select-none pr-3 text-right text-[#4d6580]">{d.code!.start + i}</span><span className="whitespace-pre">{l || ' '}</span></div>))}</pre>
              {d.code.truncated && <p className="mt-2 text-xs text-mist">Showing the first {d.code.end - d.code.start + 1} lines.</p>}
            </div>
          ) : d.text ? (<div><p className="whitespace-pre-wrap text-sm leading-relaxed text-[#cfe0f2]">{d.text}</p>{d.source_id && d.path && <a className="btn btn-ghost btn-sm mt-4 inline-flex" target="_blank" rel="noreferrer" href={api.rawUrl(eng.wsId, d.source_id, d.path)}><ExternalLink size={14} /> Open original file</a>}</div>)
          : d.passages && d.passages.length ? (<div className="space-y-3">{d.passages.map((p) => <p key={p.id} className="whitespace-pre-wrap rounded-xl bg-black/30 p-3 text-sm text-[#cfe0f2]">{p.text}</p>)}</div>)
          : <p className="text-sm text-mist">{isSymbol ? 'The source file is no longer available on disk.' : 'This node has no text of its own. Look at its links.'}</p>
        )}
        {tab === 'relations' && <Relations d={d} />}
        {tab === 'flows' && <NodeFlows d={d} />}
        {tab === 'explain' && <Explain id={d.id} />}
      </div>
    </>
  )
}

const Metric = ({ label, value }: { label: string; value: string }) => (<div className="rounded-xl border hair bg-black/25 py-2"><div className="mono text-lg">{value}</div><div className="text-[0.7rem] text-mist">{label}</div></div>)

function Relations({ d }: { d: NodeDetail }) {
  const rel = Object.entries(d.relations ?? {}).filter(([t]) => t !== 'CONTAINS' || true)
  if (!rel.length) return <p className="text-sm text-mist">No connections.</p>
  return (
    <div className="space-y-4">
      {rel.map(([type, sides]) => (
        <div key={type}>
          <h4 className="mb-1.5 text-xs font-semibold text-mist">{type.replace('_', ' ').toLowerCase()} · {sides.in.length + sides.out.length}</h4>
          {[...sides.out.map((r) => ({ r, dir: 'out' as const })), ...sides.in.map((r) => ({ r, dir: 'in' as const }))].slice(0, 30).map(({ r, dir }) => (
            <div key={r.edge_id + dir} className="group flex items-center gap-1 rounded-lg hover:bg-white/6" onMouseEnter={() => eng.current?.flash(r.node.id, 0.9)}>
              <button className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm" onClick={() => selectNode(r.node.id)}>
                {dir === 'out' ? <ArrowUpRight size={14} className="shrink-0 text-plankton" aria-label="outgoing" /> : <ArrowDownLeft size={14} className="shrink-0 text-amber" aria-label="incoming" />}
                <span className="truncate">{r.node.label}</span><span className="chip ml-auto shrink-0 !text-[0.65rem]">{r.node.type}</span>
              </button>
              <button className="icon-btn !h-7 !w-7 opacity-0 focus:opacity-100 group-hover:opacity-100" aria-label="Inspect this connection" title="Why are these connected?" onClick={() => selectEdge(r.edge_id)}><Sparkles size={13} /></button>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function NodeFlows({ d }: { d: NodeDetail }) {
  const procs = d.processes ?? []
  if (!procs.length) return <p className="text-sm text-mist">This node is not part of a detected execution flow.</p>
  const play = async (id: string) => { try { const all = await api.processes(eng.wsId); const p = all.find((x) => x.id === id); if (p) playProcess(p) } catch { toast.error('Could not load the flow') } }
  return <div className="space-y-2">{procs.map((p) => <button key={p.id} className="spot block w-full p-3 text-left" onClick={() => play(p.id)}><span className="relative z-10 text-sm font-medium">{p.label}</span><span className="relative z-10 ml-2 text-xs text-mist">{p.step_count} steps · play</span></button>)}</div>
}

function Explain({ id }: { id: string }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => setText(''), [id])
  const go = async () => { setBusy(true); try { setText((await api.explain(eng.wsId, id)).explanation) } catch (e) { toast.error(e instanceof ApiError ? e.message : 'Explanation failed') } finally { setBusy(false) } }
  return (
    <div>
      {!text && <button className="btn btn-primary btn-sm" disabled={busy} onClick={go}>{busy ? <Spinner size={14} /> : <Sparkles size={14} />} Explain this</button>}
      {text && <p className="whitespace-pre-wrap text-sm leading-relaxed text-[#cfe0f2]">{text}</p>}
      <p className="mt-3 text-xs text-mist">Uses your chosen answer engine; offline mode returns the built-in summary.</p>
    </div>
  )
}

function EdgePane({ id }: { id: string }) {
  const { data: e, err, retry } = useLoad<EdgeDetail>(() => api.edge(eng.wsId, id), [id])
  if (err) return <div className="p-6 pt-12 text-sm"><p className="text-coral">{err}</p><button className="btn btn-ghost btn-sm mt-3" onClick={retry}>Try again</button></div>
  if (!e) return <div className="space-y-3 p-5 pt-12">{[70, 100, 60].map((w, i) => <div key={i} className="shimmer h-4 rounded" style={{ width: `${w}%` }} />)}</div>
  return (
    <div className="overflow-auto p-5 pr-12 pt-4">
      <span className="chip" style={{ color: e.color }}>{e.type.replace('_', ' ').toLowerCase()}</span>
      <h2 className="mt-2 text-lg font-bold leading-snug">{e.explanation}</h2>
      <div className="mt-4 grid grid-cols-2 gap-2">
        {[e.source, e.target].map((n, i) => <button key={n.id} className="spot p-3 text-left" onClick={() => { useView.getState().patch({ selectedEdgeId: null }); selectNode(n.id) }}><div className="relative z-10 text-[0.7rem] text-mist">{i === 0 ? 'From' : 'To'}</div><div className="relative z-10 truncate text-sm font-medium">{n.label}</div><div className="relative z-10 text-[0.7rem] text-mist">{n.type}</div></button>)}
      </div>
      <h3 className="mb-2 mt-5 text-sm font-semibold">Evidence</h3>
      {e.evidence.length === 0 && <p className="text-sm text-mist">This link comes from the project structure itself.</p>}
      {e.evidence.map((ev, i) => (<div key={i} className="mb-2 rounded-xl bg-black/35 p-3">{(ev.path || ev.title) && <div className="mono mb-1 truncate text-[0.7rem] text-mist">{ev.title ?? ev.path}{ev.line ? `:${ev.line}` : ''}</div>}<p className={`text-sm ${ev.kind === 'code' ? 'mono text-[0.78rem]' : ''}`}>{ev.text}</p></div>))}
      <p className="mono mt-4 text-xs text-mist">strength {e.weight}</p>
      <button className="btn btn-ghost btn-sm mt-4" onClick={clearAll}>Done</button>
    </div>
  )
}
