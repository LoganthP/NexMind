import { useState, useMemo, useRef, useEffect } from 'react'
import { useView, useSettings } from '@/lib/store'
import { displayName } from '@/lib/names'
import { selectNode, setView } from '@/workspace/actions'

export function ListView() {
  const nodes = useView((s) => s.nodes)
  const clusters = useView((s) => s.clusters)
  const selectedId = useView((s) => s.selectedId)
  const theme = useSettings((s) => s.theme)
  const [filter, setFilter] = useState('')
  const [sortCol, setSortCol] = useState<'name'|'type'|'cluster'|'links'|'importance'|'path'>('importance')
  const [sortDesc, setSortDesc] = useState(true)

  const clusterMap = useMemo(() => {
    const m: Record<number, {name: string, color: string}> = {}
    clusters.forEach(c => { m[c.id] = { name: c.label, color: c.color } })
    return m
  }, [clusters])

  const filtered = useMemo(() => {
    let res = nodes
    if (filter) {
      const q = filter.toLowerCase()
      res = res.filter(n => displayName(n).toLowerCase().includes(q) || n.type.toLowerCase().includes(q) || (n.path && n.path.toLowerCase().includes(q)))
    }
    return res.sort((a, b) => {
      let cmp = 0
      if (sortCol === 'name') cmp = displayName(a).localeCompare(displayName(b))
      else if (sortCol === 'type') cmp = a.type.localeCompare(b.type)
      else if (sortCol === 'cluster') cmp = (clusterMap[a.cluster]?.name || '').localeCompare(clusterMap[b.cluster]?.name || '')
      else if (sortCol === 'links') cmp = (a.degree || 0) - (b.degree || 0)
      else if (sortCol === 'importance') cmp = (a.betweenness || 0) - (b.betweenness || 0)
      else if (sortCol === 'path') cmp = (a.path || '').localeCompare(b.path || '')
      return sortDesc ? -cmp : cmp
    })
  }, [nodes, filter, sortCol, sortDesc, clusterMap])

  // Virtualization
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const itemHeight = 40
  const containerHeight = window.innerHeight - 150 // approximate
  const startIdx = Math.max(0, Math.floor(scrollTop / itemHeight) - 5)
  const endIdx = Math.min(filtered.length, startIdx + Math.ceil(containerHeight / itemHeight) + 10)
  const visibleRows = filtered.slice(startIdx, endIdx)

  useEffect(() => {
    const onScroll = () => {
      if (containerRef.current) setScrollTop(containerRef.current.scrollTop)
    }
    const c = containerRef.current
    c?.addEventListener('scroll', onScroll)
    return () => c?.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selectedId) return
      const idx = filtered.findIndex(n => n.id === selectedId)
      if (idx === -1) return
      if (e.key === 'ArrowDown') { e.preventDefault(); selectNode(filtered[Math.min(filtered.length - 1, idx + 1)].id) }
      if (e.key === 'ArrowUp') { e.preventDefault(); selectNode(filtered[Math.max(0, idx - 1)].id) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, filtered])

  const exportCsv = () => {
    const header = 'Name,Type,Cluster,Links,Importance,Path\n'
    const csv = filtered.map(n => `"${displayName(n).replace(/"/g, '""')}","${n.type}","${clusterMap[n.cluster]?.name || ''}",${n.degree || 0},${(n.betweenness||0).toFixed(4)},"${(n.path||'').replace(/"/g, '""')}"`).join('\n')
    const blob = new Blob([header + csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'nexmind_list.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const toggleSort = (col: typeof sortCol) => {
    if (sortCol === col) setSortDesc(!sortDesc)
    else { setSortCol(col); setSortDesc(true) }
  }

  const bg = theme === 'dark' ? 'bg-[#1e1e1e]' : 'bg-white'
  const text = theme === 'dark' ? 'text-white' : 'text-gray-900'
  const textMuted = theme === 'dark' ? 'text-gray-400' : 'text-gray-500'
  const border = theme === 'dark' ? 'border-gray-800' : 'border-gray-200'

  return (
    <div className={`absolute inset-0 z-10 flex flex-col pt-16 ${bg} ${text}`}>
      <div className={`flex items-center justify-between p-4 border-b ${border}`}>
        <div className="flex gap-2">
          <input type="text" placeholder="Filter..." className="field !h-8 !w-64" value={filter} onChange={e => setFilter(e.target.value)} />
          <div className="text-xs flex items-center text-mist">{filtered.length} nodes</div>
        </div>
        <button className="btn btn-secondary !h-8 !px-3 !py-0 text-xs" onClick={exportCsv}>Export CSV</button>
      </div>

      <div className="flex-1 overflow-hidden flex flex-col">
        {/* Header */}
        <div className={`flex border-b ${border} text-xs uppercase tracking-wider font-semibold ${textMuted} pr-4`}>
          <div className="w-1/4 p-3 cursor-pointer hover:bg-black/5" onClick={() => toggleSort('name')}>Name {sortCol==='name'&&(sortDesc?'▼':'▲')}</div>
          <div className="w-32 p-3 cursor-pointer hover:bg-black/5" onClick={() => toggleSort('type')}>Type {sortCol==='type'&&(sortDesc?'▼':'▲')}</div>
          <div className="w-1/5 p-3 cursor-pointer hover:bg-black/5" onClick={() => toggleSort('cluster')}>Cluster {sortCol==='cluster'&&(sortDesc?'▼':'▲')}</div>
          <div className="w-20 p-3 text-right cursor-pointer hover:bg-black/5" onClick={() => toggleSort('links')}>Links {sortCol==='links'&&(sortDesc?'▼':'▲')}</div>
          <div className="w-32 p-3 cursor-pointer hover:bg-black/5" onClick={() => toggleSort('importance')}>Importance {sortCol==='importance'&&(sortDesc?'▼':'▲')}</div>
          <div className="flex-1 p-3 cursor-pointer hover:bg-black/5" onClick={() => toggleSort('path')}>Source {sortCol==='path'&&(sortDesc?'▼':'▲')}</div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto" ref={containerRef}>
          <div style={{ height: filtered.length * itemHeight, position: 'relative' }}>
            {visibleRows.map((n, i) => {
              const c = clusterMap[n.cluster]
              const idx = startIdx + i
              return (
                <div key={n.id} className={`absolute w-full flex items-center border-b ${border} text-sm hover:bg-black/5 cursor-pointer ${selectedId === n.id ? 'bg-blue-500/10' : ''}`} style={{ top: idx * itemHeight, height: itemHeight }} onClick={() => selectNode(n.id)} onDoubleClick={() => { selectNode(n.id); setView('graph') }}>
                  <div className="w-1/4 p-3 truncate font-medium">{displayName(n)}</div>
                  <div className="w-32 p-3"><span className="chip text-[10px]">{n.type}</span></div>
                  <div className="w-1/5 p-3 truncate flex items-center gap-2">
                    {c && <i className="w-2 h-2 rounded-full" style={{ background: c.color }} />}
                    <span className="text-xs">{c?.name || ''}</span>
                  </div>
                  <div className="w-20 p-3 text-right mono text-xs text-mist">{n.degree || 0}</div>
                  <div className="w-32 p-3 flex items-center">
                    <div className="flex-1 bg-gray-200 dark:bg-gray-800 h-1.5 rounded-full overflow-hidden">
                      <div className="bg-purple-500 h-full" style={{ width: `${(n.betweenness||0)*100}%` }} />
                    </div>
                  </div>
                  <div className="flex-1 p-3 truncate mono text-[10px] text-mist" title={n.path || ''}>{n.path || ''}</div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
