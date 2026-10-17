import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useShallow } from 'zustand/react/shallow'
import { Check, ChevronRight, FileText, Filter, Folder, FolderTree, Lightbulb, MessageSquare, PanelLeftClose, PanelLeftOpen, Pencil, Plus, RefreshCw, Trash2, Workflow, X } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { toast, useView, type Panel } from '@/lib/store'
import type { Insight, ProcessItem, SourceItem, TreeNode } from '@/lib/types'
import { AnalyzePanel } from '@/components/AnalyzePanel'
import { Spinner } from '@/components/ui'
import { applyFocus, eng, playProcess, selectNode } from '@/workspace/actions'

const TABS: { id: Exclude<Panel, null>; label: string; icon: typeof Folder }[] = [
  { id: 'sources', label: 'Sources', icon: FolderTree },
  { id: 'threads', label: 'Chats', icon: MessageSquare },
  { id: 'insights', label: 'Insights', icon: Lightbulb },
  { id: 'flows', label: 'Flows', icon: Workflow },
  { id: 'filters', label: 'Filters', icon: Filter },
]

export function LeftRail() {
  const panel = useView((s) => s.panel)
  const open = useView((s) => s.railOpen)
  const kind = useView((s) => s.kind)
  const patch = useView.getState().patch

  const isDocs = kind === 'docs'
  const visibleTabs = TABS
    .filter((t) => !(isDocs && t.id === 'flows'))
    .map((t) => (t.id === 'sources' && isDocs ? { ...t, label: 'Documents' } : t))

  return (
    <>
      {!open && <button className="glass icon-btn absolute left-3 top-[4.9rem] z-30 !h-10 !w-10" aria-label="Open side panel" onClick={() => patch({ railOpen: true })}><PanelLeftOpen size={18} /></button>}
      <AnimatePresence>
        {open && (
          <motion.aside initial={{ x: -30, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -30, opacity: 0 }} transition={{ type: 'spring', stiffness: 280, damping: 30 }}
            className="glass absolute bottom-3 left-3 top-[4.9rem] z-30 flex w-[min(19.5rem,calc(100vw-1.5rem))] flex-col rounded-2xl" aria-label="Workspace panel">
            <div className="flex items-center gap-0.5 border-b hair p-1.5">
              {visibleTabs.map((t) => (
                <button key={t.id} className={`icon-btn !h-9 flex-1 ${panel === t.id ? 'on' : ''}`} aria-pressed={panel === t.id} aria-label={t.label} title={t.label} onClick={() => patch({ panel: t.id })}><t.icon size={17} /></button>
              ))}
              <button className="icon-btn !h-9" aria-label="Close side panel" onClick={() => patch({ railOpen: false })}><PanelLeftClose size={17} /></button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3">
              {panel === 'sources' && <SourcesPanel />}
              {panel === 'threads' && <ThreadsPanel />}
              {panel === 'insights' && <InsightsPanel />}
              {panel === 'flows' && !isDocs && <FlowsPanel />}
              {panel === 'filters' && <FiltersPanel />}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  )
}

const H = ({ children }: { children: React.ReactNode }) => <h3 className="mb-2 mt-1 text-sm font-semibold">{children}</h3>
const Empty = ({ children }: { children: React.ReactNode }) => <p className="rounded-xl border border-dashed hair p-4 text-center text-sm text-mist">{children}</p>

// ---------------------------------------------------------------- sources
function Tree({ node, depth = 0 }: { node: TreeNode; depth?: number }) {
  const [open, setOpen] = useState(depth < 1)
  const isDir = node.children.length > 0 || node.type === 'Folder' || node.type === 'Source'
  return (
    <div>
      <button className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[0.82rem] hover:bg-white/6" style={{ paddingLeft: depth * 12 + 4 }}
        onClick={() => { if (isDir) setOpen(!open); else selectNode(node.id) }} onDoubleClick={() => selectNode(node.id)}>
        {isDir ? <ChevronRight size={13} className={`shrink-0 text-mist transition-transform ${open ? 'rotate-90' : ''}`} /> : <span className="w-[13px] shrink-0" />}
        {isDir ? <Folder size={14} className="shrink-0 text-mist" /> : <FileText size={14} className="shrink-0 text-plankton" />}
        <span className="truncate">{node.label}</span>
      </button>
      {open && node.children.map((c) => <Tree key={c.id} node={c} depth={depth + 1} />)}
    </div>
  )
}

function SourcesPanel() {
  const version = useView((s) => s.version)
  const kind = useView((s) => s.kind)
  const isDocs = kind === 'docs'
  const [sources, setSources] = useState<SourceItem[] | null>(null)
  const [trees, setTrees] = useState<Record<string, TreeNode>>({})
  const [adding, setAdding] = useState(false)
  const [replacingId, setReplacingId] = useState<string | null>(null)
  const load = useCallback(() => {
    api.sources(eng.wsId).then(async (s) => {
      setSources(s)
      const entries = await Promise.all(s.map((x) => api.sourceTree(eng.wsId, x.id).then((t) => [x.id, t] as const).catch(() => null)))
      setTrees(Object.fromEntries(entries.filter(Boolean) as [string, TreeNode][]))
    }).catch(() => setSources([]))
  }, [])
  useEffect(load, [load, version])
  const remove = async (s: SourceItem) => {
    if (!confirm(`Remove “${s.name}” from this workspace? Your original files are never touched.`)) return
    try { await api.deleteSource(eng.wsId, s.id); toast.info('Removing and rebuilding…') } catch (e) { toast.error(e instanceof ApiError ? e.message : 'Could not remove') }
  }
  const reindex = async () => { try { await api.rebuild(eng.wsId); toast.info('Re-indexing…') } catch (e) { toast.error(e instanceof ApiError ? e.message : 'Could not re-index') } }
  return (
    <>
      <div className="mb-2 flex items-center justify-between"><H>{isDocs ? 'Documents' : 'Sources'}</H>
        <div className="flex gap-1"><button className="icon-btn !h-8 !w-8" aria-label={`Re-index all ${isDocs ? 'documents' : 'sources'}`} title="Re-index (picks up file changes)" onClick={reindex}><RefreshCw size={15} /></button>
          <button className={`icon-btn !h-8 !w-8 ${adding && !replacingId ? 'on' : ''}`} aria-label={`Add ${isDocs ? 'documents' : 'a source'}`} onClick={() => { setAdding(!adding); setReplacingId(null) }}>{adding && !replacingId ? <X size={16} /> : <Plus size={16} />}</button></div></div>
      {adding && !replacingId && <div className="mb-4 rounded-xl border hair bg-black/20 p-3"><AnalyzePanel workspaceId={eng.wsId} kind={kind} compact onStarted={() => setAdding(false)} /></div>}
      {sources === null ? <div className="grid h-24 place-items-center"><Spinner /></div> : sources.length === 0 ? <Empty>{isDocs ? 'No documents yet. Drop PDFs, notes or document archives.' : 'No sources yet. Add a repo, a folder or documents.'}</Empty> : sources.map((s) => (
        <div key={s.id} className="mb-3 rounded-xl border hair bg-black/15 p-2">
          <div className="flex items-center justify-between gap-2 px-1"><div className="min-w-0"><div className="truncate text-sm font-medium">{s.name}</div><div className="text-[0.7rem] text-mist">{s.kind} · {s.file_count} files</div></div>
            <div className="flex items-center gap-0.5">
              <button className="icon-btn !h-7 !w-7 hover:!text-ink" aria-label={`Replace ${s.name}`} title="Replace source" onClick={() => { setReplacingId(replacingId === s.id ? null : s.id); setAdding(false) }}><RefreshCw size={12} /></button>
              <button className="icon-btn !h-7 !w-7 hover:!text-coral" aria-label={`Remove ${s.name}`} title="Remove source" onClick={() => remove(s)}><Trash2 size={14} /></button>
            </div>
          </div>
          {replacingId === s.id && <div className="mt-2 mb-2 rounded-xl border hair bg-black/20 p-2"><AnalyzePanel workspaceId={eng.wsId} kind={kind} compact replaceSourceId={s.id} onStarted={() => setReplacingId(null)} /></div>}
          {trees[s.id] && <div className="mt-1 max-h-56 overflow-auto">{trees[s.id].children.map((c) => <Tree key={c.id} node={c} depth={0} />)}</div>}
        </div>
      ))}
    </>
  )
}

// ---------------------------------------------------------------- chats
function ThreadsPanel() {
  const { threads, threadId } = useView(useShallow((s) => ({ threads: s.threads, threadId: s.threadId })))
  const patch = useView.getState().patch
  const [edit, setEdit] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const create = async () => { try { const t = await api.createThread(eng.wsId); patch({ threads: [t, ...useView.getState().threads], threadId: t.id }) } catch (e) { toast.error(e instanceof ApiError ? e.message : 'Could not create chat') } }
  const rename = async (id: string) => { if (title.trim()) { try { const t = await api.renameThread(eng.wsId, id, title.trim()); patch({ threads: useView.getState().threads.map((x) => (x.id === id ? t : x)) }) } catch { toast.error('Rename failed') } } setEdit(null) }
  const remove = async (id: string) => {
    if (!confirm('Delete this chat?')) return
    try { await api.deleteThread(eng.wsId, id); const rest = useView.getState().threads.filter((t) => t.id !== id); patch({ threads: rest, threadId: threadId === id ? rest[0]?.id ?? null : threadId }) } catch { toast.error('Delete failed') }
  }
  return (
    <>
      <div className="mb-2 flex items-center justify-between"><H>Chats</H><button className="btn btn-ghost btn-sm" onClick={create}><Plus size={14} /> New chat</button></div>
      {threads.length === 0 ? <Empty>Each workspace keeps separate chats. Start one to ask your graph a question.</Empty> : threads.map((t) => (
        <div key={t.id} className={`group mb-1 flex items-center gap-1 rounded-xl border px-2.5 py-2 ${t.id === threadId ? 'border-plankton/40 bg-plankton/8' : 'border-transparent hover:bg-white/5'}`}>
          {edit === t.id ? (
            <form className="flex flex-1 gap-1" onSubmit={(e) => { e.preventDefault(); void rename(t.id) }}><input autoFocus className="field !h-8 !text-sm" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Chat title" /><button className="icon-btn !h-8 !w-8" aria-label="Save title"><Check size={15} /></button></form>
          ) : (<>
            <button className="min-w-0 flex-1 text-left" onClick={() => patch({ threadId: t.id, chatOpen: true })}><div className="truncate text-sm">{t.title}</div><div className="truncate text-[0.7rem] text-mist">{t.message_count} messages</div></button>
            <button className="icon-btn !h-7 !w-7 opacity-0 focus:opacity-100 group-hover:opacity-100" aria-label="Rename chat" onClick={() => { setEdit(t.id); setTitle(t.title) }}><Pencil size={13} /></button>
            <button className="icon-btn !h-7 !w-7 opacity-0 hover:!text-coral focus:opacity-100 group-hover:opacity-100" aria-label="Delete chat" onClick={() => remove(t.id)}><Trash2 size={13} /></button>
          </>)}
        </div>
      ))}
    </>
  )
}

// ---------------------------------------------------------------- insights / flows
const SEV: Record<string, string> = { high: 'text-coral border-coral/50', medium: 'text-amber border-amber/50', low: 'text-mist', info: 'text-plankton border-plankton/40' }
function InsightsPanel() {
  const version = useView((s) => s.version)
  const [items, setItems] = useState<Insight[] | null>(null)
  useEffect(() => { api.insights(eng.wsId).then(setItems).catch(() => setItems([])) }, [version])
  return (
    <>
      <H>Insights</H>
      {items === null ? <div className="grid h-24 place-items-center"><Spinner /></div> : items.length === 0 ? <Empty>Nothing notable found yet.</Empty> : items.map((i) => (
        <button key={i.id} className="spot mb-2 block w-full p-3 text-left" onClick={() => i.node_ids.length ? applyFocus(i.title, i.node_ids, []) : undefined}>
          <span className={`chip ${SEV[i.severity]}`}>{i.severity}</span>
          <div className="relative z-10 mt-1.5 text-sm font-medium leading-snug">{i.title}</div>
          <div className="relative z-10 mt-1 line-clamp-3 text-xs text-mist">{i.detail}</div>
        </button>
      ))}
    </>
  )
}

function FlowsPanel() {
  const version = useView((s) => s.version)
  const [items, setItems] = useState<ProcessItem[] | null>(null)
  useEffect(() => { api.processes(eng.wsId).then(setItems).catch(() => setItems([])) }, [version])
  return (
    <>
      <H>Execution flows</H>
      <p className="mb-3 text-xs text-mist">Follow how a call travels through your code, step by step.</p>
      {items === null ? <div className="grid h-24 place-items-center"><Spinner /></div> : items.length === 0 ? <Empty>No flows found. Flows appear for code with entry points like main() or request handlers.</Empty> : items.map((p) => (
        <button key={p.id} className="spot mb-2 block w-full p-3 text-left" onClick={() => playProcess(p)}>
          <div className="relative z-10 flex items-center justify-between gap-2"><span className="truncate text-sm font-medium">{p.label}</span><span className="chip shrink-0">{p.step_count} steps</span></div>
          <div className="relative z-10 mt-1 truncate text-xs text-mist">{p.steps.slice(0, 4).map((s) => s.label).join(' → ')}{p.steps.length > 4 ? ' …' : ''}</div>
        </button>
      ))}
    </>
  )
}

// ---------------------------------------------------------------- filters
function FiltersPanel() {
  const { nodes, clusters, legend, hiddenTypes, hiddenClusters, minScore } = useView(useShallow((s) => ({ nodes: s.nodes, clusters: s.clusters, legend: s.legend.node, hiddenTypes: s.hiddenTypes, hiddenClusters: s.hiddenClusters, minScore: s.minScore })))
  const patch = useView.getState().patch
  const counts = nodes.reduce<Record<string, number>>((a, n) => { a[n.type] = (a[n.type] ?? 0) + 1; return a }, {})
  const toggleType = (t: string) => { const s = new Set(hiddenTypes); s.has(t) ? s.delete(t) : s.add(t); patch({ hiddenTypes: s }) }
  const toggleCluster = (c: number) => { const s = new Set(hiddenClusters); s.has(c) ? s.delete(c) : s.add(c); patch({ hiddenClusters: s }) }
  const solo = (c: number) => patch({ hiddenClusters: new Set(clusters.filter((k) => k.id !== c).map((k) => k.id)) })
  return (
    <>
      <H>What to show</H>
      <div className="flex flex-wrap gap-1.5">
        {Object.keys(counts).sort().map((t) => (
          <button key={t} className={`chip hover:text-ink ${hiddenTypes.has(t) ? 'opacity-40 line-through' : ''}`} aria-pressed={!hiddenTypes.has(t)} onClick={() => toggleType(t)}>
            <i className="h-2 w-2 rounded-full" style={{ background: legend[t] ?? '#5cf2d6' }} />{t} <span className="text-[0.65rem]">{counts[t]}</span>
          </button>
        ))}
      </div>
      <H><span className="mt-3 block">Importance cut-off</span></H>
      <input type="range" min={0} max={0.6} step={0.02} value={minScore} className="w-full accent-[#5cf2d6]" onChange={(e) => patch({ minScore: Number(e.target.value) })} aria-label="Hide less important nodes" />
      <p className="text-xs text-mist">{minScore === 0 ? 'Showing everything' : `Hiding nodes below ${Math.round(minScore * 100)}% importance`}</p>
      <H><span className="mt-3 block">Clusters</span></H>
      {clusters.filter((c) => c.id !== 0).map((c) => (
        <div key={c.id} className={`mb-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-white/5 ${hiddenClusters.has(c.id) ? 'opacity-40' : ''}`}>
          <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => toggleCluster(c.id)} aria-pressed={!hiddenClusters.has(c.id)}><i className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: c.color, boxShadow: `0 0 8px ${c.color}` }} /><span className="truncate">{c.label}</span><span className="ml-auto text-xs text-mist">{c.size}</span></button>
          <button className="chip hover:text-ink" onClick={() => solo(c.id)}>solo</button>
        </div>
      ))}
      {(hiddenTypes.size > 0 || hiddenClusters.size > 0 || minScore > 0) && <button className="btn btn-ghost btn-sm mt-3" onClick={() => patch({ hiddenTypes: new Set(), hiddenClusters: new Set(), minScore: 0 })}>Reset filters</button>}
    </>
  )
}
