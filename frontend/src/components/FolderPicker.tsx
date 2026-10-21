import { useEffect, useRef, useState, useCallback } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  File,
  HardDrive,
  Home,
  Clock,
  Check,
  RotateCcw,
  AlertCircle,
} from 'lucide-react'
import { api, formatApiError } from '@/lib/api'
import type { FsEntry, FsListing, FsCheckResult } from '@/lib/types'
import { Modal } from './Modal'
import { Spinner } from './ui'

const RECENT_KEY = 'nexmind.recent_folders'

function getRecentFolders(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveRecentFolder(path: string) {
  try {
    const list = getRecentFolders().filter((p) => p !== path)
    list.unshift(path)
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 5)))
  } catch {
    /* ignore private mode */
  }
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

interface Props {
  onPick: (path: string) => void
  onClose: () => void
  initialPath?: string
}

export function FolderPicker({ onPick, onClose, initialPath }: Props) {
  const [data, setData] = useState<FsListing | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const [typedPath, setTypedPath] = useState('')
  const [selectedPath, setSelectedPath] = useState<string>('')
  const [checkInfo, setCheckInfo] = useState<FsCheckResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [recentFolders, setRecentFolders] = useState<string[]>([])

  // Inline expanded children tracking
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [childrenMap, setChildrenMap] = useState<Record<string, FsEntry[]>>({})
  const [loadingChildren, setLoadingChildren] = useState<Set<string>>(new Set())

  // Keyboard navigation focus index
  const [focusedIndex, setFocusedIndex] = useState<number>(0)
  const treeContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setRecentFolders(getRecentFolders())
  }, [])

  const load = useCallback((targetPath?: string) => {
    setLoading(true)
    setErr('')
    api
      .fsList(targetPath, 1)
      .then((res) => {
        setData(res)
        setTypedPath(res.path)
        setSelectedPath(res.path)
      })
      .catch((e) => {
        setErr(formatApiError(e))
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load(initialPath)
  }, [load, initialPath])

  // Run live check when selectedPath changes
  useEffect(() => {
    if (!selectedPath) {
      setCheckInfo(null)
      return
    }
    let active = true
    setChecking(true)
    api
      .fsCheck(selectedPath)
      .then((res) => {
        if (active) setCheckInfo(res)
      })
      .catch((e) => {
        if (active) {
          setCheckInfo({
            ok: false,
            exists: true,
            is_dir: true,
            readable: false,
            markers: [],
            supported_files: 0,
            has_code: false,
            has_docs: false,
            message: formatApiError(e),
          })
        }
      })
      .finally(() => {
        if (active) setChecking(false)
      })
    return () => {
      active = false
    }
  }, [selectedPath])

  const toggleExpand = async (folderPath: string) => {
    if (expanded.has(folderPath)) {
      setExpanded((prev) => {
        const next = new Set(prev)
        next.delete(folderPath)
        return next
      })
      return
    }

    setExpanded((prev) => new Set(prev).add(folderPath))

    if (!childrenMap[folderPath]) {
      setLoadingChildren((prev) => new Set(prev).add(folderPath))
      try {
        const res = await api.fsList(folderPath, 1)
        setChildrenMap((prev) => ({ ...prev, [folderPath]: res.entries }))
      } catch (e) {
        // failed to load children
      } finally {
        setLoadingChildren((prev) => {
          const next = new Set(prev)
          next.delete(folderPath)
          return next
        })
      }
    }
  }

  const handleSelect = (target = selectedPath) => {
    if (!target) return
    saveRecentFolder(target)
    onPick(target)
    onClose()
  }

  const handlePathSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (typedPath.trim()) {
      load(typedPath.trim())
    }
  }

  // Flatten visible entries for keyboard navigation
  const buildVisibleList = () => {
    if (!data) return []
    const list: { path: string; name: string; isDir: boolean }[] = []
    const walk = (entries: FsEntry[]) => {
      for (const e of entries) {
        list.push({ path: e.path, name: e.name, isDir: e.kind === 'dir' })
        if (e.kind === 'dir' && expanded.has(e.path) && childrenMap[e.path]) {
          walk(childrenMap[e.path])
        }
      }
    }
    walk(data.entries)
    return list
  }

  const visibleList = buildVisibleList()

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (visibleList.length === 0) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setFocusedIndex((prev) => Math.min(prev + 1, visibleList.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFocusedIndex((prev) => Math.max(prev - 1, 0))
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      const item = visibleList[focusedIndex]
      if (item && item.isDir && !expanded.has(item.path)) {
        void toggleExpand(item.path)
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      const item = visibleList[focusedIndex]
      if (item && item.isDir && expanded.has(item.path)) {
        void toggleExpand(item.path)
      }
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = visibleList[focusedIndex]
      if (item) {
        setSelectedPath(item.path)
      }
    }
  }

  // Render a single entry in tree
  const renderEntry = (entry: FsEntry, depth = 0) => {
    const isDir = entry.kind === 'dir'
    const isExpanded = expanded.has(entry.path)
    const isLoadingChildren = loadingChildren.has(entry.path)
    const isSelected = selectedPath === entry.path
    const children = childrenMap[entry.path]

    if (!isDir) {
      return (
        <div
          key={entry.path}
          style={{ paddingLeft: `${depth * 20 + 24}px` }}
          className="flex items-center gap-2 py-1 text-xs text-mist/70 hover:text-mist"
        >
          <File size={13} className="shrink-0 text-mist/50" />
          <span className="truncate">{entry.name}</span>
          {entry.size !== undefined && (
            <span className="mono shrink-0 text-[0.65rem] text-mist/40">{formatBytes(entry.size)}</span>
          )}
        </div>
      )
    }

    return (
      <div key={entry.path}>
        <div
          className={`group flex items-center gap-2 rounded-lg py-1.5 px-2 text-sm transition-colors cursor-pointer select-none ${
            isSelected
              ? 'bg-plankton/15 text-plankton font-medium'
              : 'hover:bg-white/5 text-ink'
          }`}
          style={{ paddingLeft: `${depth * 20 + 6}px` }}
          onDoubleClick={() => void toggleExpand(entry.path)}
        >
          <button
            type="button"
            className="grid h-5 w-5 place-items-center rounded text-mist hover:text-ink shrink-0"
            onClick={(e) => {
              e.stopPropagation()
              void toggleExpand(entry.path)
            }}
            aria-label={isExpanded ? `Collapse ${entry.name}` : `Expand ${entry.name}`}
          >
            {isLoadingChildren ? (
              <Spinner size={12} />
            ) : isExpanded ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )}
          </button>

          <div
            className="flex flex-1 items-center gap-2 truncate"
            onClick={() => setSelectedPath(entry.path)}
          >
            {isExpanded ? (
              <FolderOpen size={16} className={isSelected ? 'text-plankton' : 'text-plankton/80 shrink-0'} />
            ) : (
              <Folder size={16} className={isSelected ? 'text-plankton' : 'text-plankton/70 shrink-0'} />
            )}
            <span className="truncate">{entry.name}</span>

            {entry.is_project && (
              <span
                className="chip !px-1.5 !py-0.5 text-[0.65rem] font-semibold tracking-wide uppercase border-plankton/40 bg-plankton/10 text-plankton"
                title={entry.markers && entry.markers.length > 0 ? entry.markers.join(', ') : 'Project'}
              >
                Project
              </span>
            )}
          </div>

          {isSelected && <Check size={14} className="text-plankton shrink-0 mr-1" />}
        </div>

        {isExpanded && (
          <div>
            {isLoadingChildren ? (
              <div
                style={{ paddingLeft: `${(depth + 1) * 20 + 24}px` }}
                className="py-1.5 text-xs text-mist flex items-center gap-2"
              >
                <Spinner size={12} />
                <span>Loading folder contents…</span>
              </div>
            ) : children && children.length > 0 ? (
              children.map((child) => renderEntry(child, depth + 1))
            ) : (
              <div
                style={{ paddingLeft: `${(depth + 1) * 20 + 24}px` }}
                className="py-1 text-xs text-mist/60 italic"
              >
                Empty folder
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="relative z-[60]">
      <Modal
        open={true}
      onClose={onClose}
      maxWidth="min(680px, calc(100vw - 2rem))"
      title="Choose a project folder"
      subtitle="Select a folder from your local disk to index or connect"
      footer={
        <div className="flex w-full flex-col gap-3">
          <div className="flex items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 truncate text-mist">
              <span className="shrink-0 font-medium text-ink">Selected:</span>
              <span className="mono truncate text-ink/90" title={selectedPath}>
                {selectedPath || 'None'}
              </span>
            </div>
            {typedPath && typedPath !== selectedPath && (
              <button
                type="button"
                className="btn btn-ghost btn-sm shrink-0 !text-xs !h-6 !px-2"
                onClick={() => {
                  setSelectedPath(typedPath)
                  load(typedPath)
                }}
              >
                Use typed path
              </button>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-line/50 pt-3">
            <div className="text-xs text-mist truncate">
              {checking ? (
                <span className="flex items-center gap-1.5">
                  <Spinner size={12} /> Checking folder…
                </span>
              ) : checkInfo ? (
                <span className={checkInfo.ok ? 'text-ink/80' : 'text-amber'}>
                  {checkInfo.message}
                </span>
              ) : (
                'Select a folder'
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button type="button" className="btn btn-ghost btn-sm !h-8" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm !h-8"
                disabled={!selectedPath || loading}
                onClick={() => handleSelect()}
              >
                Select this folder
              </button>
            </div>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-3" onKeyDown={handleKeyDown} tabIndex={0}>
        {/* Quick locations & Recent */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line pb-3">
          {data?.roots?.map((r) => (
            <button
              key={r.path}
              type="button"
              className="chip hover:text-ink cursor-pointer"
              onClick={() => load(r.path)}
            >
              {r.name === 'Home' ? (
                <Home size={12} className="text-plankton shrink-0" />
              ) : (
                <HardDrive size={12} className="text-mist shrink-0" />
              )}
              <span>{r.name}</span>
            </button>
          ))}

          {recentFolders.length > 0 && (
            <div className="flex items-center gap-1 ml-auto">
              <Clock size={12} className="text-mist shrink-0" />
              {recentFolders.slice(0, 3).map((rf) => {
                const label = rf.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || rf
                return (
                  <button
                    key={rf}
                    type="button"
                    className="chip hover:text-ink text-[0.7rem] cursor-pointer"
                    title={rf}
                    onClick={() => load(rf)}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Path field & Breadcrumbs */}
        <div className="space-y-2">
          <form onSubmit={handlePathSubmit} className="flex gap-2">
            <input
              type="text"
              className="field !h-8 !text-xs mono flex-1"
              value={typedPath}
              placeholder="Paste or type path and press Enter…"
              onChange={(e) => setTypedPath(e.target.value)}
            />
            <button type="submit" className="btn btn-ghost btn-sm !h-8 !text-xs shrink-0">
              Jump
            </button>
          </form>

          {data?.crumbs && data.crumbs.length > 0 && (
            <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-xs text-mist">
              {data.crumbs.map((c, i) => (
                <span key={c.path} className="flex items-center gap-1">
                  {i > 0 && <span className="text-line">/</span>}
                  <button
                    type="button"
                    className="hover:text-ink transition-colors max-w-[140px] truncate"
                    onClick={() => load(c.path)}
                    title={c.path}
                  >
                    {c.name}
                  </button>
                </span>
              ))}
            </nav>
          )}
        </div>

        {/* Tree contents */}
        <div
          ref={treeContainerRef}
          style={{ minHeight: '260px', maxHeight: '420px' }}
          className="overflow-y-auto rounded-xl border border-line bg-black/30 p-2"
        >
          {loading ? (
            <div className="grid h-48 place-items-center">
              <Spinner size={24} />
            </div>
          ) : err ? (
            <div className="flex flex-col items-center justify-center gap-2 p-8 text-center">
              <AlertCircle size={24} className="text-coral" />
              <p className="text-sm text-coral max-w-sm">{err}</p>
              <button
                type="button"
                className="btn btn-ghost btn-sm mt-2 flex items-center gap-1.5"
                onClick={() => load(data?.path || initialPath)}
              >
                <RotateCcw size={14} /> Retry
              </button>
            </div>
          ) : data && data.entries.length > 0 ? (
            <div className="space-y-0.5">
              {data.entries.map((entry) => renderEntry(entry, 0))}
              {data.truncated && (
                <p className="py-2 text-center text-xs text-mist/60 italic">
                  Showing first 400 entries. Use sub-folders or direct path.
                </p>
              )}
            </div>
          ) : (
            <div className="grid h-40 place-items-center text-xs text-mist">
              This folder has no sub-folders
            </div>
          )}
        </div>
      </div>
    </Modal>
    </div>
  )
}
