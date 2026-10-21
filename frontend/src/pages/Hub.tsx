import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { BookOpen, Code2, FileText, FolderGit2, Plus, Settings2, Terminal, Trash2 } from 'lucide-react'
import { Aurora, Logo, Spinner, Spot, Switch } from '@/components/ui'
import { NewWorkspaceDialog, type WorkspaceMode } from '@/components/NewWorkspaceDialog'
import { ApiError, api, formatApiError } from '@/lib/api'
import { toast, useSettings } from '@/lib/store'
import { useServer } from '@/lib/server'
import type { Workspace } from '@/lib/types'

const STATUS: Record<Workspace['status'], { label: string; cls: string }> = {
  ready: { label: 'Ready', cls: 'text-plankton border-plankton/40' },
  building: { label: 'Building', cls: 'text-amber border-amber/40' },
  empty: { label: 'Empty', cls: 'text-mist' },
  error: { label: 'Error', cls: 'text-coral border-coral/40' },
}

export default function Hub() {
  const nav = useNavigate()
  const [items, setItems] = useState<Workspace[] | null>(null)
  const [tab, setTab] = useState<WorkspaceMode>('code')
  const [dialog, setDialog] = useState<{ open: boolean; mode: WorkspaceMode | null }>({
    open: false,
    mode: null,
  })
  const [menu, setMenu] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const health = useServer((s) => s.health)
  const settings = useSettings()

  const openDialog = (mode?: WorkspaceMode) => {
    setDialog({ open: true, mode: mode ?? null })
  }

  const closeDialog = () => {
    setDialog({ open: false, mode: null })
  }

  const load = () =>
    api
      .workspaces()
      .then(setItems)
      .catch((e) => {
        setItems([])
        toast.error(formatApiError(e))
      })

  useEffect(() => {
    void load()
    let timer: ReturnType<typeof setInterval> | undefined

    const start = () => {
      if (timer) clearInterval(timer)
      timer = setInterval(() => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        void load()
      }, 10000)
    }

    const onVisChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        void load()
        start()
      } else {
        if (timer) clearInterval(timer)
        timer = undefined
      }
    }

    start()
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisChange)
    }
    return () => {
      if (timer) clearInterval(timer)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisChange)
      }
    }
  }, [])

  const remove = async (w: Workspace) => {
    if (!confirm(`Delete “${w.name}” and everything built from it? This cannot be undone.`)) return
    try {
      await api.deleteWorkspace(w.id)
      toast.success('Workspace deleted')
      void load()
    } catch (e) {
      toast.error(formatApiError(e))
    }
  }

  const rename = async (id: string) => {
    if (editName.trim()) {
      try {
        await api.renameWorkspace(id, editName.trim())
        void load()
      } catch (e) {
        toast.error(formatApiError(e))
      }
    }
    setEditingId(null)
  }

  const first = items !== null && items.length === 0

  const codeItems = items?.filter((w) => (w.kind || 'code') === 'code') ?? []
  const docsItems = items?.filter((w) => w.kind === 'docs') ?? []
  const liveItems = items?.filter((w) => w.kind === 'live') ?? []
  const activeItems = tab === 'code' ? codeItems : tab === 'docs' ? docsItems : liveItems

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-abyss">
      <Aurora />
      <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
        <Link to="/">
          <Logo />
        </Link>
        <div className="flex items-center gap-3">
          <span className="chip">
            <i className="pulse-dot !h-1.5 !w-1.5" /> Server {health?.version} ·{' '}
            {health?.llm.available ? health.llm.provider : 'offline answers'}
          </span>
          <div className="relative">
            <button className="icon-btn" aria-label="Display settings" onClick={() => setMenu(!menu)}>
              <Settings2 size={18} />
            </button>
            {menu && (
              <div className="glass absolute right-0 top-11 z-20 w-64 rounded-xl p-3">
                <Switch
                  label="Solid surfaces (no blur)"
                  checked={settings.solid}
                  onChange={(v) => settings.set({ solid: v })}
                />
                <Switch
                  label="Performance mode"
                  checked={settings.perf}
                  onChange={(v) => settings.set({ perf: v })}
                />
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-6xl px-5 pb-20">
        {items === null ? (
          <div className="grid h-64 place-items-center">
            <Spinner size={26} />
          </div>
        ) : first ? (
          <div className="mx-auto max-w-2xl pt-8">
            <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
              <div className="text-center">
                <h1 className="text-3xl font-bold tracking-tight">Create your first workspace</h1>
                <p className="mx-auto mt-2 max-w-[48ch] text-sm text-mist">
                  Choose what you want to analyze. NexMind builds the knowledge graph right on your machine.
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <Spot className="cursor-pointer transition-all hover:scale-[1.02]">
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => openDialog('code')}
                    onKeyDown={(e) => e.key === 'Enter' && openDialog('code')}
                    className="p-7 h-full flex flex-col"
                  >
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-plankton/10 text-plankton">
                      <Code2 size={26} />
                    </div>
                    <h2 className="mt-5 text-xl font-bold">Analyze a project</h2>
                    <p className="mt-2 text-xs text-mist leading-relaxed flex-1">
                      GitHub, GitLab, Azure DevOps links, local folders, and repository archives. Full code features: impact analysis, call traces, and execution flows.
                    </p>
                    <button
                      className="btn btn-primary btn-sm mt-6 w-full"
                      type="button"
                      onClick={() => openDialog('code')}
                    >
                      New workspace
                    </button>
                  </div>
                </Spot>

                <Spot className="cursor-pointer transition-all hover:scale-[1.02]">
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => openDialog('docs')}
                    onKeyDown={(e) => e.key === 'Enter' && openDialog('docs')}
                    className="p-7 h-full flex flex-col"
                  >
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber/10 text-amber">
                      <BookOpen size={26} />
                    </div>
                    <h2 className="mt-5 text-xl font-bold">Study from documents</h2>
                    <p className="mt-2 text-xs text-mist leading-relaxed flex-1">
                      Upload PDFs, Word files, Markdown, text, and document archives. Extract concepts, connect shared themes, and query across files.
                    </p>
                    <button
                      className="btn btn-ghost btn-sm mt-6 w-full !border-amber/40 !text-amber hover:!bg-amber/10"
                      type="button"
                      onClick={() => openDialog('docs')}
                    >
                      New workspace
                    </button>
                  </div>
                </Spot>

                <Spot className="cursor-pointer transition-all hover:scale-[1.02]">
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => openDialog('live')}
                    onKeyDown={(e) => e.key === 'Enter' && openDialog('live')}
                    className="p-7 h-full flex flex-col"
                  >
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-coral/10 text-coral">
                      <Terminal size={26} />
                    </div>
                    <h2 className="mt-5 text-xl font-bold">Live connect</h2>
                    <p className="mt-2 text-xs text-mist leading-relaxed flex-1">
                      Connect directly from VS Code. The graph rebuilds live as you write code and edit documents.
                    </p>
                    <button
                      className="btn btn-ghost btn-sm mt-6 w-full !border-coral/40 !text-coral hover:!bg-coral/10"
                      type="button"
                      onClick={() => openDialog('live')}
                    >
                      New workspace
                    </button>
                  </div>
                </Spot>
              </div>
            </motion.div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-4 pt-4">
              <div>
                <h1 className="text-3xl font-bold tracking-tight">Workspaces</h1>
                <p className="mt-1 text-sm text-mist">Switch between your project codebases and document study sets.</p>
              </div>

              <div className="flex items-center gap-2">
                <div role="tablist" aria-label="Workspace kind" className="flex items-center gap-1 rounded-xl bg-black/25 p-1 border hair">
                  <button
                    role="tab"
                    aria-selected={tab === 'code'}
                    onClick={() => setTab('code')}
                    className={`tab flex items-center gap-1.5 !px-3 !py-1.5 text-xs ${tab === 'code' ? 'on' : ''}`}
                  >
                    <FolderGit2 size={14} /> Projects ({codeItems.length})
                  </button>
                  <button
                    role="tab"
                    aria-selected={tab === 'docs'}
                    onClick={() => setTab('docs')}
                    className={`tab flex items-center gap-1.5 !px-3 !py-1.5 text-xs ${tab === 'docs' ? 'on' : ''}`}
                  >
                    <FileText size={14} /> Documents ({docsItems.length})
                  </button>
                  <button
                    role="tab"
                    aria-selected={tab === 'live'}
                    onClick={() => setTab('live')}
                    className={`tab flex items-center gap-1.5 !px-3 !py-1.5 text-xs ${tab === 'live' ? 'on' : ''}`}
                  >
                    <Terminal size={14} /> Live connect ({liveItems.length})
                  </button>
                </div>

                <button
                  className="btn btn-primary btn-sm !h-9"
                  onClick={() => openDialog()}
                >
                  <Plus size={16} /> New workspace
                </button>
              </div>
            </div>

            {activeItems.length === 0 ? (
              <div className="mt-12 rounded-2xl border border-dashed hair p-10 text-center">
                <p className="text-sm text-mist">
                  {tab === 'code'
                    ? 'No project workspaces yet.'
                    : tab === 'docs'
                      ? 'No document study workspaces yet.'
                      : 'No live connect workspaces yet.'}
                </p>
                <button
                  className="btn btn-ghost btn-sm mt-3"
                  onClick={() => openDialog(tab)}
                >
                  <Plus size={14} /> New workspace
                </button>
              </div>
            ) : (
              <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {activeItems.map((w, i) => (
                  <motion.div key={w.id} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
                    <Spot className="group h-full">
                      <div
                        role="link"
                        tabIndex={0}
                        className="relative z-10 h-full cursor-pointer p-5"
                        onClick={() => nav(`/app/w/${w.id}`)}
                        onKeyDown={(e) => e.key === 'Enter' && nav(`/app/w/${w.id}`)}
                      >
                        <div className="flex items-start justify-between gap-2">
                          {editingId === w.id ? (
                            <form
                              className="flex-1"
                              onSubmit={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                void rename(w.id)
                              }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <input
                                autoFocus
                                className="field !h-8 !text-sm"
                                value={editName}
                                onChange={(e) => setEditName(e.target.value)}
                                onBlur={() => void rename(w.id)}
                              />
                            </form>
                          ) : (
                            <h2
                              className="line-clamp-2 text-lg font-semibold leading-snug group-hover:text-plankton"
                              onClick={(e) => {
                                e.stopPropagation()
                                setEditingId(w.id)
                                setEditName(w.name)
                              }}
                            >
                              {w.name}
                            </h2>
                          )}
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span className="chip uppercase text-[0.62rem] tracking-wider text-mist border-white/10">
                              {w.kind === 'docs' ? 'Docs' : w.kind === 'live' ? 'Live' : 'Project'}
                            </span>
                            <span className={`chip shrink-0 ${STATUS[w.status].cls}`}>
                              {w.status === 'building' && <Spinner size={10} />}
                              {STATUS[w.status].label}
                            </span>
                          </div>
                        </div>
                        <dl className="mono mt-5 grid grid-cols-3 gap-2 text-xs">
                          <div>
                            <dt className="text-mist">nodes</dt>
                            <dd className="mt-0.5 text-base text-ink">{w.stats.nodes ?? '–'}</dd>
                          </div>
                          <div>
                            <dt className="text-mist">links</dt>
                            <dd className="mt-0.5 text-base text-ink">{w.stats.edges ?? '–'}</dd>
                          </div>
                          <div>
                            <dt className="text-mist">chats</dt>
                            <dd className="mt-0.5 text-base text-ink">{w.thread_count}</dd>
                          </div>
                        </dl>
                        <div className="mt-5 flex items-center justify-between text-xs text-mist">
                          <span>
                            {w.source_count} source{w.source_count === 1 ? '' : 's'} ·{' '}
                            {new Date(w.updated_at * 1000).toLocaleDateString()}
                          </span>
                          <button
                            className="icon-btn !h-8 !w-8 opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100 hover:!text-coral"
                            aria-label={`Delete ${w.name}`}
                            onClick={(e) => {
                              e.stopPropagation()
                              void remove(w)
                            }}
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>
                    </Spot>
                  </motion.div>
                ))}
              </div>
            )}
          </>
        )}
      </main>

      {dialog.open && (
        <NewWorkspaceDialog
          initialMode={dialog.mode}
          onClose={closeDialog}
        />
      )}
    </div>
  )
}
