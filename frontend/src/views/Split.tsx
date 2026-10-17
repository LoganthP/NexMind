import { useState, useMemo, useEffect } from 'react'
import { useView, useSettings } from '@/lib/store'
import { displayName } from '@/lib/names'
import { selectNode } from '@/workspace/actions'
import { api } from '@/lib/api'
import { ChevronRight, ArrowLeft, Search } from 'lucide-react'
import type { GNode, GLink } from '@/lib/types'

export function Split() {
  const nodes = useView((s) => s.nodes)
  const links = useView((s) => s.links)
  const wsKind = useView((s) => s.wsKind)
  const selectedId = useView((s) => s.selectedId)
  const theme = useSettings((s) => s.theme)
  
  const [filter, setFilter] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [expandedEdge, setExpandedEdge] = useState<string | null>(null)
  const [edgeEvidence, setEdgeEvidence] = useState<Record<string, string>>({})

  // Update history when selection changes
  useEffect(() => {
    if (selectedId && history[history.length - 1] !== selectedId) {
      setHistory(h => [...h, selectedId])
    }
  }, [selectedId, history])

  const goBack = () => {
    if (history.length > 1) {
      const newH = history.slice(0, -1)
      setHistory(newH)
      selectNode(newH[newH.length - 1])
    }
  }

  const topics = useMemo(() => {
    let ts = nodes.filter(n => 
      wsKind === 'docs' 
        ? (n.type === 'Concept' || n.type === 'Document')
        : (n.type === 'Class' || n.type === 'File' || n.type === 'Module' || n.type === 'Entity')
    )
    if (filter) {
      const q = filter.toLowerCase()
      ts = ts.filter(n => displayName(n).toLowerCase().includes(q))
    }
    return ts.sort((a,b) => (b.degree||0) - (a.degree||0))
  }, [nodes, wsKind, filter])

  const selectedNode = nodes.find(n => n.id === selectedId)

  const connections = useMemo(() => {
    if (!selectedId) return {}
    const res: Record<string, { node: GNode, link: GLink }[]> = {}
    links.forEach(l => {
      const sId = typeof l.source === 'object' ? (l.source as any).id : l.source
      const tId = typeof l.target === 'object' ? (l.target as any).id : l.target
      
      let otherId = null
      if (sId === selectedId) { otherId = tId }
      else if (tId === selectedId) { otherId = sId }
      
      if (otherId) {
        const other = nodes.find(n => n.id === otherId)
        if (other) {
          const relGroup = l.type // e.g. CALLS, MENTIONS
          if (!res[relGroup]) res[relGroup] = []
          res[relGroup].push({ node: other, link: l })
        }
      }
    })
    return res
  }, [selectedId, links, nodes])

  const maxDeg = Math.max(1, ...topics.map(t => Math.max(1, t.degree || 0)))

  const loadEvidence = async (edgeId: string) => {
    if (expandedEdge === edgeId) { setExpandedEdge(null); return }
    setExpandedEdge(edgeId)
    if (!edgeEvidence[edgeId]) {
      try {
        const eng = (window as any).eng // from actions
        if (eng && eng.wsId) {
          const res = await api.edge(eng.wsId, edgeId)
          if (res.evidence && res.evidence.length > 0) setEdgeEvidence(prev => ({...prev, [edgeId]: res.evidence[0].text}))
          else setEdgeEvidence(prev => ({...prev, [edgeId]: 'No snippet available.'}))
        }
      } catch {
        setEdgeEvidence(prev => ({...prev, [edgeId]: 'Could not load evidence.'}))
      }
    }
  }

  const bg = theme === 'dark' ? 'bg-[#1e1e1e]' : 'bg-white'
  const text = theme === 'dark' ? 'text-white' : 'text-gray-900'
  const textMuted = theme === 'dark' ? 'text-gray-400' : 'text-gray-500'
  const border = theme === 'dark' ? 'border-gray-800' : 'border-gray-200'
  const bgHover = theme === 'dark' ? 'hover:bg-white/5' : 'hover:bg-black/5'
  const bgActive = theme === 'dark' ? 'bg-white/10' : 'bg-black/10'

  return (
    <div className={`absolute inset-0 z-10 flex pt-16 ${bg} ${text}`}>
      {/* Left Column */}
      <div className={`w-80 flex flex-col border-r ${border}`}>
        <div className={`p-4 border-b ${border}`}>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-mist" />
            <input type="text" placeholder="Search topics..." className="field !h-8 !pl-9 w-full" value={filter} onChange={e => setFilter(e.target.value)} />
          </div>
        </div>
        <div className="flex-1 overflow-auto">
          {topics.map(t => (
            <div key={t.id} className={`p-3 border-b ${border} cursor-pointer ${bgHover} ${selectedId === t.id ? bgActive : ''}`} onClick={() => selectNode(t.id)}>
              <div className="flex justify-between items-start mb-1">
                <div className="font-medium text-sm truncate pr-2">{displayName(t)}</div>
                <div className="text-xs text-mist mono">{t.degree || 0}</div>
              </div>
              <div className="flex items-center justify-between gap-2">
                <div className="flex-1 bg-gray-200 dark:bg-gray-800 h-1 rounded-full overflow-hidden">
                  <div className="bg-blue-500 h-full" style={{ width: `${((t.degree||0)/maxDeg)*100}%` }} />
                </div>
                <span className="chip text-[9px]">{t.type}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right Column */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedNode ? (
          <>
            {/* Header with Breadcrumbs */}
            <div className={`p-4 border-b ${border} flex items-center gap-3 bg-black/5 dark:bg-white/5`}>
              <button className="icon-btn" onClick={goBack} disabled={history.length <= 1}><ArrowLeft size={16} /></button>
              <div className="flex items-center flex-wrap gap-2 text-sm">
                {history.map((id, i) => {
                  const n = nodes.find(x => x.id === id)
                  return (
                    <div key={i} className="flex items-center gap-2">
                      {i > 0 && <ChevronRight size={14} className="text-mist" />}
                      <span className={`cursor-pointer hover:underline ${i === history.length - 1 ? 'font-bold' : textMuted}`} onClick={() => {
                        setHistory(history.slice(0, i + 1))
                        selectNode(id)
                      }}>{n ? displayName(n) : '...'}</span>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Connections */}
            <div className="flex-1 overflow-auto p-6">
              <h2 className="text-xl font-bold mb-6">{displayName(selectedNode)} <span className="chip text-xs align-middle ml-2">{selectedNode.type}</span></h2>
              
              {Object.keys(connections).length === 0 && (
                <div className="text-mist text-sm">No connections found.</div>
              )}

              {Object.entries(connections).sort().map(([rel, items]) => (
                <div key={rel} className="mb-8">
                  <h3 className={`text-sm font-semibold mb-3 tracking-wider uppercase ${textMuted}`}>{rel} ({items.length})</h3>
                  <div className="grid gap-2">
                    {items.map(({ node, link }) => (
                      <div key={node.id} className={`border ${border} rounded-lg overflow-hidden`}>
                        <div className={`p-3 flex items-center justify-between cursor-pointer ${bgHover}`} onClick={() => selectNode(node.id)}>
                          <div className="flex items-center gap-3 overflow-hidden">
                            <span className="font-medium truncate">{displayName(node)}</span>
                            <span className="chip text-[10px]">{node.type}</span>
                          </div>
                          <button className="text-xs text-blue-500 hover:underline" onClick={(e) => { e.stopPropagation(); loadEvidence(link.id) }}>
                            {expandedEdge === link.id ? 'Hide evidence' : 'Evidence'}
                          </button>
                        </div>
                        {expandedEdge === link.id && (
                          <div className={`p-3 text-xs bg-black/5 dark:bg-white/5 border-t ${border}`}>
                            {edgeEvidence[link.id] ? (
                              <div className="italic text-mist">"{edgeEvidence[link.id]}"</div>
                            ) : (
                              <div className="animate-pulse bg-gray-300 dark:bg-gray-700 h-4 w-1/2 rounded" />
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="flex-1 grid place-items-center text-mist text-sm">
            Select a topic on the left to see connections.
          </div>
        )}
      </div>
    </div>
  )
}
