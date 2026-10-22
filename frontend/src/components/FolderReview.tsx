import { useState, useMemo, useRef, useCallback, useEffect } from 'react'
import {
  Folder,
  FolderOpen,
  File as FileIcon,
  ChevronRight,
  ChevronDown,
  Search,
  AlertTriangle,
  RotateCcw,
} from 'lucide-react'
import { isDefaultExcluded, getRelativePath } from '@/lib/folderUpload'

export interface FolderReviewProps {
  files: File[]
  mode: 'code' | 'docs' | 'live'
  folderName: string
  onConfirm: (selectedFiles: File[]) => void
  onChangeFolder: () => void
  onCancel?: () => void
  actionLabel?: string
  disabled?: boolean
}

interface FileItem {
  file: File
  path: string
  size: number
}

interface TreeNode {
  id: string
  name: string
  path: string
  isDir: boolean
  depth: number
  size: number
  file?: File
  children: TreeNode[]
}

interface FlatItem {
  id: string
  name: string
  path: string
  isDir: boolean
  depth: number
  size: number
  file?: File
  collapsed?: boolean
  checkedState: 'checked' | 'unchecked' | 'indeterminate'
  fileCount: number
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

export function FolderReview({
  files,
  mode,
  folderName,
  onConfirm,
  onChangeFolder,
  actionLabel,
  disabled = false,
}: FolderReviewProps) {
  const [search, setSearch] = useState('')
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set())

  // Initial selection: all files that are NOT default-excluded
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => {
    const set = new Set<string>()
    for (const f of files) {
      const rel = getRelativePath(f)
      if (!isDefaultExcluded(rel, f.size, mode)) {
        set.add(rel)
      }
    }
    return set
  })

  // Normalize files list
  const fileItems: FileItem[] = useMemo(() => {
    return files.map((f) => ({
      file: f,
      path: getRelativePath(f),
      size: f.size,
    }))
  }, [files])

  // Map of path -> FileItem for fast lookups
  const pathToFileMap = useMemo(() => {
    const map = new Map<string, FileItem>()
    for (const item of fileItems) {
      map.set(item.path, item)
    }
    return map
  }, [fileItems])

  // Build hierarchical tree
  const rootNode = useMemo(() => {
    const root: TreeNode = {
      id: '',
      name: folderName || 'root',
      path: '',
      isDir: true,
      depth: 0,
      size: 0,
      children: [],
    }

    const dirMap = new Map<string, TreeNode>()
    dirMap.set('', root)

    for (const item of fileItems) {
      const parts = item.path.split('/')
      let curPath = ''
      let parent = root

      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i]
        curPath = curPath ? `${curPath}/${seg}` : seg
        let dirNode = dirMap.get(curPath)
        if (!dirNode) {
          dirNode = {
            id: curPath,
            name: seg,
            path: curPath,
            isDir: true,
            depth: i + 1,
            size: 0,
            children: [],
          }
          dirMap.set(curPath, dirNode)
          parent.children.push(dirNode)
        }
        parent = dirNode
      }

      const fileName = parts[parts.length - 1]
      const fileNode: TreeNode = {
        id: item.path,
        name: fileName,
        path: item.path,
        isDir: false,
        depth: parts.length,
        size: item.size,
        file: item.file,
        children: [],
      }
      parent.children.push(fileNode)
    }

    // Compute sizes and sort children (directories first, then alphabetically)
    function finalize(node: TreeNode): number {
      let total = 0
      for (const child of node.children) {
        if (child.isDir) {
          total += finalize(child)
        } else {
          total += child.size
        }
      }
      node.size = node.isDir ? total : node.size
      node.children.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      return total
    }

    finalize(root)
    return root
  }, [fileItems, folderName])

  // All descendant file paths per directory for fast checking
  const dirDescendantsMap = useMemo(() => {
    const map = new Map<string, string[]>()
    function collect(node: TreeNode): string[] {
      const acc: string[] = []
      for (const child of node.children) {
        if (child.isDir) {
          acc.push(...collect(child))
        } else {
          acc.push(child.path)
        }
      }
      if (node.isDir) {
        map.set(node.path, acc)
      }
      return acc
    }
    collect(rootNode)
    return map
  }, [rootNode])

  // Flatten tree based on collapse state and search filter
  const flatItems: FlatItem[] = useMemo(() => {
    const result: FlatItem[] = []
    const query = search.trim().toLowerCase()

    function traverse(node: TreeNode) {
      for (const child of node.children) {
        const matchesSearch =
          !query || child.name.toLowerCase().includes(query) || child.path.toLowerCase().includes(query)

        if (child.isDir) {
          const descPaths = dirDescendantsMap.get(child.path) || []
          const hasMatchingChild = query
            ? descPaths.some((p) => p.toLowerCase().includes(query))
            : true

          if (matchesSearch || hasMatchingChild) {
            let checkedCount = 0
            for (const p of descPaths) {
              if (selectedPaths.has(p)) checkedCount++
            }
            const checkedState: 'checked' | 'unchecked' | 'indeterminate' =
              descPaths.length === 0
                ? 'unchecked'
                : checkedCount === descPaths.length
                  ? 'checked'
                  : checkedCount > 0
                    ? 'indeterminate'
                    : 'unchecked'

            const isCollapsed = collapsedDirs.has(child.path)
            result.push({
              id: child.id,
              name: child.name,
              path: child.path,
              isDir: true,
              depth: child.depth,
              size: child.size,
              collapsed: isCollapsed,
              checkedState,
              fileCount: descPaths.length,
            })

            if (!isCollapsed || query) {
              traverse(child)
            }
          }
        } else {
          if (matchesSearch) {
            const isChecked = selectedPaths.has(child.path)
            result.push({
              id: child.id,
              name: child.name,
              path: child.path,
              isDir: false,
              depth: child.depth,
              size: child.size,
              file: child.file,
              checkedState: isChecked ? 'checked' : 'unchecked',
              fileCount: 1,
            })
          }
        }
      }
    }

    traverse(rootNode)
    return result
  }, [rootNode, collapsedDirs, search, selectedPaths, dirDescendantsMap])

  // Selected totals
  const { selectedCount, selectedBytes } = useMemo(() => {
    let count = 0
    let bytes = 0
    for (const p of selectedPaths) {
      const item = pathToFileMap.get(p)
      if (item) {
        count++
        bytes += item.size
      }
    }
    return { selectedCount: count, selectedBytes: bytes }
  }, [selectedPaths, pathToFileMap])

  const totalFilesCount = fileItems.length
  const isOverFilesLimit = selectedCount > 30000
  const isOverSizeLimit = selectedBytes > 120 * 1024 * 1024
  const isTooMuch = isOverFilesLimit || isOverSizeLimit

  // Toggle directory collapse
  const toggleCollapse = useCallback((dirPath: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(dirPath)) next.delete(dirPath)
      else next.add(dirPath)
      return next
    })
  }, [])

  // Toggle directory selection
  const toggleDirChecked = useCallback(
    (dirPath: string, currentState: 'checked' | 'unchecked' | 'indeterminate') => {
      const descendants = dirDescendantsMap.get(dirPath) || []
      const shouldCheck = currentState !== 'checked'

      setSelectedPaths((prev) => {
        const next = new Set(prev)
        for (const p of descendants) {
          if (shouldCheck) next.add(p)
          else next.delete(p)
        }
        return next
      })
    },
    [dirDescendantsMap]
  )

  // Toggle single file selection
  const toggleFileChecked = useCallback((filePath: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(filePath)) next.delete(filePath)
      else next.add(filePath)
      return next
    })
  }, [])

  // Action: Select All
  const handleSelectAll = useCallback(() => {
    const next = new Set<string>()
    for (const item of fileItems) {
      next.add(item.path)
    }
    setSelectedPaths(next)
  }, [fileItems])

  // Action: Only source files
  const handleOnlySourceFiles = useCallback(() => {
    const next = new Set<string>()
    for (const item of fileItems) {
      if (!isDefaultExcluded(item.path, item.size, mode)) {
        next.add(item.path)
      }
    }
    setSelectedPaths(next)
  }, [fileItems, mode])

  // Primary action button handler
  const handleConfirm = () => {
    if (selectedCount === 0 || isTooMuch || disabled) return
    const chosenFiles: File[] = []
    for (const p of selectedPaths) {
      const item = pathToFileMap.get(p)
      if (item) chosenFiles.push(item.file)
    }
    onConfirm(chosenFiles)
  }

  // Virtualized list calculation
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const ITEM_HEIGHT = 28
  const VIEWPORT_HEIGHT = 280
  const BUFFER = 8

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop)
  }

  const totalHeight = flatItems.length * ITEM_HEIGHT
  const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER)
  const endIndex = Math.min(
    flatItems.length,
    Math.ceil((scrollTop + VIEWPORT_HEIGHT) / ITEM_HEIGHT) + BUFFER
  )
  const visibleItems = flatItems.slice(startIndex, endIndex)
  const topSpacer = startIndex * ITEM_HEIGHT

  const buttonText =
    actionLabel ||
    (mode === 'live'
      ? `Connect ${selectedCount.toLocaleString()} files`
      : `Analyze ${selectedCount.toLocaleString()} files`)

  return (
    <div className="space-y-3 rounded-2xl border border-line bg-surface/80 p-4 text-xs">
      {/* Header with folder name */}
      <div className="flex items-center justify-between pb-2 border-b border-line/40">
        <div className="flex items-center gap-2">
          <FolderOpen size={18} className="text-plankton" />
          <span className="text-sm font-semibold text-ink">
            Packed {selectedCount} files · {formatBytes(selectedBytes)} from {folderName}
          </span>
        </div>
      </div>

      {/* Top hints */}
      <div className="space-y-1 text-xs text-mist leading-relaxed">
        <p>
          Windows only shows folders in the picker; your files are listed here. To pick a whole
          drive, open This PC → Local Disk (C:) in the window.
        </p>
        <p className="text-mist/80">Your browser may ask to confirm the upload; choose Upload.</p>
      </div>

      {/* Search and Quick Filters */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-line/40">
        <div className="relative flex-1 min-w-[180px]">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-mist" />
          <input
            type="text"
            placeholder="Search files…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-line bg-surface-2 pl-8 pr-3 py-1 text-xs text-ink placeholder:text-mist/60 focus:border-plankton focus:outline-none"
          />
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn btn-ghost btn-sm !h-7 !px-2.5 text-[0.72rem] text-ink hover:text-plankton"
            onClick={handleOnlySourceFiles}
          >
            Only source files
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm !h-7 !px-2.5 text-[0.72rem] text-ink hover:text-plankton"
            onClick={handleSelectAll}
          >
            Select all
          </button>
        </div>
      </div>

      {/* Virtualized Tree */}
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="relative h-[280px] overflow-y-auto rounded-xl border border-line/60 bg-surface-2/60 p-1 font-mono text-[0.75rem]"
        tabIndex={0}
      >
        <div style={{ height: `${totalHeight}px`, position: 'relative' }}>
          <div style={{ transform: `translateY(${topSpacer}px)` }}>
            {visibleItems.map((item) => {
              const isChecked = item.checkedState === 'checked'
              const isIndeterminate = item.checkedState === 'indeterminate'

              return (
                <div
                  key={item.id}
                  style={{
                    height: `${ITEM_HEIGHT}px`,
                    paddingLeft: `${Math.max(4, (item.depth - 1) * 16 + 4)}px`,
                  }}
                  className="flex items-center gap-1.5 hover:bg-surface-3/60 rounded px-1 group select-none text-ink"
                >
                  {/* Indeterminate / Checked Checkbox */}
                  <input
                    type="checkbox"
                    checked={isChecked}
                    ref={(el) => {
                      if (el) el.indeterminate = isIndeterminate
                    }}
                    onChange={() => {
                      if (item.isDir) {
                        toggleDirChecked(item.path, item.checkedState)
                      } else {
                        toggleFileChecked(item.path)
                      }
                    }}
                    className="h-3.5 w-3.5 rounded border-line text-plankton focus:ring-0 cursor-pointer shrink-0"
                  />

                  {/* Directory expand / collapse or file icon */}
                  {item.isDir ? (
                    <button
                      type="button"
                      onClick={() => toggleCollapse(item.path)}
                      className="flex items-center gap-1 text-mist hover:text-ink cursor-pointer shrink-0"
                    >
                      {item.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                      {item.collapsed ? (
                        <Folder size={13} className="text-amber" />
                      ) : (
                        <FolderOpen size={13} className="text-amber" />
                      )}
                    </button>
                  ) : (
                    <span className="shrink-0 text-mist pl-3.5">
                      <FileIcon size={12} />
                    </span>
                  )}

                  {/* Name */}
                  <span
                    className={`truncate cursor-pointer ${
                      item.isDir ? 'font-medium text-ink' : 'text-ink/80'
                    }`}
                    onClick={() => {
                      if (item.isDir) toggleCollapse(item.path)
                      else toggleFileChecked(item.path)
                    }}
                    title={item.path}
                  >
                    {item.name}
                  </span>

                  {/* Size */}
                  <span className="ml-auto pr-2 text-[0.68rem] text-mist/60 shrink-0 font-sans">
                    {formatBytes(item.size)}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Summary line */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs">
        <span className="text-mist font-medium">
          Selected {selectedCount.toLocaleString()} of {totalFilesCount.toLocaleString()} files ·{' '}
          {formatBytes(selectedBytes)}
        </span>

        <button
          type="button"
          onClick={onChangeFolder}
          className="text-mist hover:text-ink underline text-[0.75rem]"
        >
          Change folder
        </button>
      </div>

      {/* Hard limit warning message if exceeded */}
      {isTooMuch && (
        <div className="rounded-xl border border-coral/40 bg-coral/10 p-2.5 text-xs text-coral flex items-center gap-2">
          <AlertTriangle size={15} className="shrink-0" />
          <span>Too much for one upload: choose a sub-folder such as src or uncheck large folders.</span>
        </div>
      )}

      {selectedCount === 0 && (
        <p className="text-xs text-amber">This folder has no source files we can analyze</p>
      )}

      {/* Action buttons */}
      <div className="flex items-center justify-end gap-2 pt-2 border-t border-line/40">
        <button
          type="button"
          onClick={handleConfirm}
          aria-label={
            mode === 'live'
              ? `Connect folder · ${buttonText}`
              : `Analyze project · ${buttonText}`
          }
          disabled={selectedCount === 0 || isTooMuch || disabled}
          className="btn btn-primary btn-sm !h-8 !px-4 text-xs font-semibold"
        >
          {buttonText}
        </button>
      </div>
    </div>
  )
}
