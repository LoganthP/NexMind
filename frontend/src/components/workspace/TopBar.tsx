import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Download, Focus, Orbit, Search, Settings2, Workflow, Zap, Crosshair, Compass, Pencil, Check } from 'lucide-react'
import { api } from '@/lib/api'
import { toast, useSettings, useView, type Mode } from '@/lib/store'
import type { SearchResult, Workspace } from '@/lib/types'
import { Logo, Spinner, Switch } from '@/components/ui'
import { eng, selectNode, setMode } from '@/workspace/actions'

const MODES: { id: Mode; label: string; icon: typeof Compass; hint: string }[] = [
  { id: 'explore', label: 'Explore', icon: Compass, hint: 'Hover and click to inspect' },
  { id: 'impact', label: 'Impact', icon: Zap, hint: 'Click a node to see what depends on it' },
  { id: 'trace', label: 'Trace', icon: Crosshair, hint: 'Click two nodes to find how they connect' },
  { id: 'flow', label: 'Flows', icon: Workflow, hint: 'Play an execution flow (left panel)' },
]

export function TopBar({ ws }: { ws: Workspace | null }) {
  const mode = useView((s) => s.mode)
  const kind = useView((s) => s.kind)
  const settings = useSettings()
  const [q, setQ] = useState('')
  const [res, setRes] = useState<SearchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState<'settings' | 'export' | null>(null)
  const [editingName, setEditingName] = useState(false)
  const [newName, setNewName] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const isDocs = kind === 'docs' || ws?.kind === 'docs'
  const visibleModes = isDocs ? MODES.filter((m) => m.id === 'explore') : MODES

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (/INPUT|TEXTAREA/.test(t.tagName)) return
      if (e.key === '/') {
        e.preventDefault()
        input.current?.focus()
      } else if (e.key === 'f') {
        try { eng.current?.fit(900, 60) } catch { toast.error('Fit failed') }
      } else if (e.key === ' ') {
        e.preventDefault()
        try { settings.set({ autoRotate: !settings.autoRotate }) } catch { toast.error('Failed to toggle auto-rotate') }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settings])

  useEffect(() => {
    if (!menu) return
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenu(null)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menu])

  useEffect(() => {
    if (q.trim().length < 2) { setRes(null); return }
    setBusy(true)
    const t = setTimeout(() => {
      api.search(eng.wsId, q.trim()).then(setRes).catch(() => setRes(null)).finally(() => setBusy(false))
    }, 240)
    return () => clearTimeout(t)
  }, [q])

  const handleExport = async (format: 'json' | 'graphml' | 'cypher') => {
    try {
      const wsId = eng.wsId || ws?.id
      if (!wsId) throw new Error('No active workspace to export')
      const url = api.exportUrl(wsId, format)
      const resp = await fetch(url)
      if (!resp.ok) throw new Error(`Export failed with status ${resp.status}`)
      const blob = await resp.blob()
      const objectUrl = URL.createObjectURL(blob)
      const safeName = (ws?.name || 'workspace').toLowerCase().replace(/[^a-z0-9_-]/g, '_')
      const ext = format === 'json' ? 'json' : format === 'graphml' ? 'graphml' : 'cypher'
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = `nexmind-${safeName}.${ext}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(objectUrl)
      toast.success(`Exported graph as ${format.toUpperCase()}`)
      setMenu(null)
    } catch (e) {
      toast.error((e as Error).message || 'Export failed')
    }
  }

  const handleFit = () => {
    try {
      eng.current?.fit(900, 60)
    } catch (e) {
      toast.error('Fit failed')
    }
  }

  const handleToggleAutoRotate = () => {
    try {
      settings.set({ autoRotate: !settings.autoRotate })
    } catch (e) {
      toast.error('Failed to toggle auto-rotate')
    }
  }

  const handleRename = async () => {
    if (newName.trim() && ws && newName.trim() !== ws.name) {
      try {
        await api.renameWorkspace(ws.id, newName.trim())
        ws.name = newName.trim()
      } catch { toast.error('Rename failed') }
    }
    setEditingName(false)
  }

  return (
    <>
      <header className="glass absolute inset-x-3 top-3 z-40 flex h-[3.4rem] items-center gap-2 rounded-2xl px-2.5">
        <Link to="/app" className="icon-btn" aria-label="Back to workspaces"><ArrowLeft size={18} /></Link>
        <Link to="/" className="hidden md:block"><Logo size={22} text={false} /></Link>
        
        {editingName ? (
          <form className="flex gap-1 items-center" onSubmit={(e) => { e.preventDefault(); void handleRename() }}>
            <input autoFocus className="field !h-8 !text-sm max-w-[14rem]" value={newName} onChange={(e) => setNewName(e.target.value)} onBlur={() => void handleRename()} />
          </form>
        ) : (
          <div className="group flex items-center gap-1 min-w-0 max-w-[16rem] cursor-pointer" onClick={() => { if (ws) { setEditingName(true); setNewName(ws.name) } }}>
            <div className="truncate px-1 font-semibold">{ws?.name ?? '…'}</div>
            <Pencil size={12} className="opacity-0 transition-opacity group-hover:opacity-100 text-mist hover:text-ink" />
          </div>
        )}

        <div className="relative mx-auto w-full max-w-md">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-mist" />
          <input ref={input} className="field !h-10 !pl-9 !pr-14" placeholder="Search symbols, files, ideas…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { setQ(''); input.current?.blur() } }} aria-label="Search the graph" />
          <kbd className="mono absolute right-3 top-1/2 -translate-y-1/2 rounded border hair px-1.5 text-[0.7rem] text-mist">{busy ? <Spinner size={11} /> : '/'}</kbd>
          {res && (
            <div className="glass absolute left-0 right-0 top-12 max-h-[60vh] overflow-auto rounded-xl p-1.5">
              {!res.nodes.length && !res.passages.length && <p className="p-3 text-sm text-mist">Nothing matched “{q}”.</p>}
              {res.nodes.map((n) => (
                <button key={n.id} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-white/8" onClick={() => { selectNode(n.id); setQ(''); setRes(null) }}>
                  <span className="chip shrink-0">{n.type}</span><span className="truncate text-sm">{n.label}</span><span className="mono ml-auto truncate text-[0.7rem] text-mist">{n.path}</span>
                </button>
              ))}
              {res.passages.slice(0, 4).map((p, i) => (
                <button key={i} className="block w-full rounded-lg px-3 py-2 text-left hover:bg-white/8" onClick={() => { selectNode(p.node.id); setQ(''); setRes(null) }}>
                  <div className="text-xs text-plankton">{p.node.label}</div><div className="line-clamp-2 text-xs text-mist">{p.snippet}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div role="tablist" aria-label="Mode" className="flex items-center gap-0.5 rounded-xl bg-black/25 p-0.5">
          {visibleModes.map((m) => (
            <button
              key={m.id}
              role="tab"
              aria-selected={mode === m.id}
              title={m.hint}
              onClick={() => {
                try {
                  setMode(m.id)
                } catch {
                  toast.error('Failed to switch mode')
                }
              }}
              className={`tab flex items-center gap-1.5 !px-2 md:!px-3 !py-1.5 ${mode === m.id ? '!border-plankton/50 !bg-plankton/15 !text-ink' : ''}`}
            >
              <m.icon size={15} />
              <span className="hidden md:inline">{m.label}</span>
            </button>
          ))}
        </div>

        <div className="relative flex items-center" ref={menuRef}>
          <button className="icon-btn" aria-label="Fit graph to screen (F)" title="Fit (F)" onClick={handleFit}><Focus size={18} /></button>
          <button className={`icon-btn ${settings.autoRotate ? 'on' : ''}`} aria-pressed={settings.autoRotate} aria-label="Auto-rotate (Space)" title="Auto-rotate (Space)" onClick={handleToggleAutoRotate}><Orbit size={18} /></button>
          <button className={`icon-btn ${menu === 'export' ? 'on' : ''}`} aria-expanded={menu === 'export'} aria-label="Export" title="Export" onClick={() => { try { setMenu(menu === 'export' ? null : 'export') } catch { toast.error('Failed to open export menu') } }}><Download size={18} /></button>
          <button className={`icon-btn ${menu === 'settings' ? 'on' : ''}`} aria-expanded={menu === 'settings'} aria-label="Display settings" title="Display settings" onClick={() => { try { setMenu(menu === 'settings' ? null : 'settings') } catch { toast.error('Failed to open settings menu') } }}><Settings2 size={18} /></button>
          {menu && (
            <div className="glass absolute right-0 top-12 z-50 w-72 rounded-xl p-3">
              {menu === 'settings' && (
                <>
                  <Switch
                    label="Solid surfaces (no blur)"
                    checked={settings.solid}
                    onChange={(v) => {
                      try { settings.set({ solid: v }) } catch { toast.error('Failed to update setting') }
                    }}
                  />
                  <Switch
                    label="Performance mode"
                    checked={settings.perf}
                    onChange={(v) => {
                      try { settings.set({ perf: v }) } catch { toast.error('Failed to update setting') }
                    }}
                  />
                  <Switch
                    label="Auto-rotate"
                    checked={settings.autoRotate}
                    onChange={(v) => {
                      try { settings.set({ autoRotate: v }) } catch { toast.error('Failed to update setting') }
                    }}
                  />
                  <p className="mt-2 text-xs text-mist">Solid surfaces replace frosted glass with opaque, higher-contrast panels.</p>
                </>
              )}
              {menu === 'export' && (
                <div className="flex flex-col gap-1 text-sm">
                  {(['json', 'graphml', 'cypher'] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      className="rounded-lg px-3 py-2 text-left hover:bg-white/8 transition-colors"
                      onClick={() => void handleExport(f)}
                    >
                      {f === 'json' ? 'JSON (nodes + edges)' : f === 'graphml' ? 'GraphML (Gephi, yEd)' : 'Cypher (Neo4j import)'}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      {(mode === 'impact' || mode === 'trace') && !isDocs && (
        <div className="pointer-events-none absolute left-0 right-0 top-[4.2rem] z-30 flex justify-center">
          <div className="glass pointer-events-auto flex items-center gap-2 rounded-full border border-plankton/40 px-3.5 py-1 text-xs text-ink shadow-lg">
            <span className="pulse-dot !h-1.5 !w-1.5" />
            <span>
              {mode === 'impact'
                ? 'Impact: click a node to see what depends on it'
                : 'Trace: click a start node, then an end node'}
            </span>
          </div>
        </div>
      )}
    </>
  )
}
