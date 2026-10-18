import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ApiError, api } from '@/lib/api'
import { connectWorkspaceSocket } from '@/lib/socket'
import { toast, useSettings, useView } from '@/lib/store'
import { typeColor } from '@/lib/palette'
import type { Workspace as Ws } from '@/lib/types'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Aurora, Spinner } from '@/components/ui'
import { GraphCanvas } from '@/components/workspace/GraphCanvas'
import { TopBar } from '@/components/workspace/TopBar'
import { LeftRail } from '@/components/workspace/LeftRail'
import { Drawer } from '@/components/workspace/Drawer'
import { ChatDock } from '@/components/workspace/ChatDock'
import { Tooltip } from '@/components/workspace/Tooltip'
import { IngestTheatre } from '@/components/workspace/IngestTheatre'
import { FlowPlayer, ImpactCard, TraceCard } from '@/components/workspace/Cards'
import { clearAll, eng, handleSocketEvent, loadGraph, runImpact } from '@/workspace/actions'

export default function Workspace() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const [ws, setWs] = useState<Ws | null>(null)
  const [fatal, setFatal] = useState('')
  const [graphState, setGraphState] = useState<'loading' | 'ready' | 'empty'>('loading')
  const nodesCount = useView((s) => s.nodes.length)
  const building = useView((s) => s.ingest.active)
  const totalNodes = useView((s) => s.totalNodes)
  const truncated = useView((s) => s.truncated)
  const legend = useView((s) => s.legend.node)
  const nodes = useView((s) => s.nodes)
  const drawerOpen = useView((s) => s.drawerOpen)
  const theme = useSettings((s) => s.theme)

  useEffect(() => {
    if (nodesCount > 0 && graphState !== 'ready') {
      setGraphState('ready')
    }
  }, [nodesCount, graphState])

  useEffect(() => {
    const patch = useView.getState().patch
    useView.getState().reset()
    eng.wsId = id
    setWs(null); setFatal('')
    setGraphState('loading')
    let live = true
    const sock = connectWorkspaceSocket(id, handleSocketEvent, (c) => { if (c) sock.send({ type: 'ping' }) })

    let poll: ReturnType<typeof setInterval> | null = null
    ;(async () => {
      try {
        const w = await api.workspace(id)
        if (!live) return
        setWs(w)
        patch({ kind: w.kind || 'code', wsKind: w.kind || 'code' })
        const threads = await api.threads(id).catch(() => [])
        if (!live) return
        patch({ threads, threadId: threads[0]?.id ?? null })
        if (w.status === 'ready') {
          await loadGraph(id)
          if (live) {
            setGraphState(useView.getState().nodes.length > 0 ? 'ready' : 'empty')
            if (useView.getState().nodes.length > 0 && !useView.getState().ingest.active) {
              if (poll) clearInterval(poll)
            }
          }
        } else if (w.status === 'building') {
          patch({ ingest: { ...useView.getState().ingest, active: true, message: 'Working…' } })
        } else {
          if (live) setGraphState('empty')
        }
      } catch (e) {
        if (live) setFatal(e instanceof ApiError && e.status === 404 ? 'This workspace no longer exists.' : e instanceof ApiError ? e.message : 'Could not open this workspace')
      }
    })()

    // Safety net: if the live socket missed the end of a build, poll until the workspace is ready.
    poll = setInterval(async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      const v = useView.getState()
      if (v.nodes.length > 0 && !v.ingest.active) {
        if (poll) clearInterval(poll)
        return
      }
      try {
        const w = await api.workspace(id)
        if (!live) return
        setWs(w)
        patch({ kind: w.kind || 'code', wsKind: w.kind || 'code' })
        const vNow = useView.getState()
        if (w.status === 'ready' && vNow.nodes.length === 0 && !vNow.ingest.active) {
          setGraphState('loading')
          await loadGraph(id)
          if (live) setGraphState(useView.getState().nodes.length > 0 ? 'ready' : 'empty')
        }
        if (w.status === 'ready' && vNow.ingest.active && vNow.ingest.phase !== 'stream' && vNow.ingest.percent < 100 && vNow.ingest.streamTotal === 0 && vNow.nodes.length === 0) {
          patch({ ingest: { ...vNow.ingest, active: false } })
          setGraphState('loading')
          await loadGraph(id)
          if (live) setGraphState(useView.getState().nodes.length > 0 ? 'ready' : 'empty')
        }
        if (w.status === 'error' && vNow.ingest.active) {
          patch({ ingest: { ...vNow.ingest, active: false, error: 'The build failed' } })
          if (live) setGraphState('empty')
        }
        if (useView.getState().nodes.length > 0 && !useView.getState().ingest.active) {
          if (poll) clearInterval(poll)
        }
      } catch { /* server hiccup: the shell shows its own banner */ }
    }, 3000)

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (/INPUT|TEXTAREA|SELECT/.test(t.tagName)) return
      if (e.key === 'Escape') clearAll()
      if (e.key === 'i') { const s = useView.getState().selectedId; if (s) void runImpact(s) }
    }
    window.addEventListener('keydown', onKey)
    return () => { live = false; if (poll) clearInterval(poll); sock.close(); window.removeEventListener('keydown', onKey); clearAll(); useView.getState().reset() }
  }, [id])

  const counts = nodes.reduce<Record<string, number>>((a, n) => { a[n.type] = (a[n.type] ?? 0) + 1; return a }, {})

  if (fatal) return (
    <div className="grid min-h-screen place-items-center bg-abyss p-6"><div className="glass max-w-md rounded-2xl p-6 text-center"><h2 className="text-lg font-semibold">{fatal}</h2><button className="btn btn-primary mt-4" onClick={() => nav('/app')}>Back to workspaces</button></div></div>
  )

  const loadingText = typeof ws?.stats?.nodes === 'number' && ws.stats.nodes > 0
    ? `Loading ${ws.stats.nodes.toLocaleString()} nodes…`
    : 'Loading graph…'

  const showEmpty = graphState === 'empty' && !building && ws && ws.status !== 'building'

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-abyss">
      <Aurora />
      <ErrorBoundary label="The 3D view hit a problem">
        <GraphCanvas />
      </ErrorBoundary>
      {graphState === 'loading' && (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center">
          <div className="flex items-center gap-3 rounded-full border hair bg-black/40 px-4 py-2 text-sm text-mist shadow-lg backdrop-blur">
            <Spinner size={16} />
            <span>{loadingText}</span>
          </div>
        </div>
      )}
      <ErrorBoundary label="The controls hit a problem">
        <TopBar ws={ws} />
        <LeftRail />
        <Tooltip />
        <ImpactCard /><TraceCard /><FlowPlayer />
        <IngestTheatre />
        <Drawer />
        <ChatDock />
      </ErrorBoundary>

      {showEmpty && (
        <div className="absolute inset-0 z-20 grid place-items-center p-4 pt-24">
          <div className="glass w-full max-w-md rounded-3xl p-7 text-center">
            {ws.source_count > 0 ? (
              <>
                <h2 className="text-xl font-bold">Nothing could be analyzed</h2>
                <p className="mb-6 mt-2 text-sm text-mist">Nothing could be analyzed from this source. Check that it contains supported files.</p>
                <div className="flex justify-center gap-3">
                  <button
                    className="btn btn-ghost"
                    onClick={async () => {
                      try {
                        setGraphState('loading')
                        await api.rebuild(id)
                        toast.info('Re-indexing…')
                      } catch (e) {
                        toast.error(e instanceof ApiError ? e.message : 'Re-index failed')
                      }
                    }}
                  >
                    Re-index
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={() => useView.getState().patch({ panel: 'sources', railOpen: true })}
                  >
                    Add a source
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 className="text-xl font-bold">No data yet</h2>
                <p className="mb-6 mt-2 text-sm text-mist">Add a repository, a folder or documents to start building the graph.</p>
                <div className="flex justify-center">
                  <button
                    className="btn btn-primary"
                    onClick={() => useView.getState().patch({ panel: 'sources', railOpen: true })}
                  >
                    Add a source
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {nodesCount > 0 && !drawerOpen && (
        <div className="glass pointer-events-none absolute right-3 top-[4.9rem] z-20 hidden w-44 rounded-2xl p-3 text-xs xl:block" aria-label="Legend">
          <div className="mono mb-2 text-mist">{nodesCount.toLocaleString()} nodes · {useView.getState().links.length.toLocaleString()} links</div>
          {Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 9).map((t) => {
            const col = typeColor(t, theme === 'light' ? 'light' : 'dark')
            return (
              <div key={t} className="flex items-center gap-2 py-0.5" data-testid={`legend-${t}`}>
                <i className="h-2 w-2 rounded-full" style={{ background: col, boxShadow: `0 0 6px ${col}` }} data-testid={`legend-dot-${t}`} />
                <span>{t}</span>
                <span className="ml-auto text-mist">{counts[t]}</span>
              </div>
            )
          })}
          {truncated && <div className="mt-2 text-amber">Showing the {nodesCount.toLocaleString()} most important of {totalNodes.toLocaleString()}</div>}
        </div>
      )}
    </div>
  )
}
