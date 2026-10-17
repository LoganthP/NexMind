import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useView } from '@/lib/store'
import type { EdgeDetail, NodeDetail } from '@/lib/types'
import { eng } from '@/workspace/actions'

const nodeCache = new Map<string, NodeDetail>()
const edgeCache = new Map<string, EdgeDetail>()

export function Tooltip() {
  const hoverId = useView((s) => s.hoverId)
  const edgeId = useView((s) => s.hoverEdgeId)
  const pos = useView((s) => s.hoverPos)
  const colors = useView((s) => s.legend.node)
  const [node, setNode] = useState<NodeDetail | null>(null)
  const [edge, setEdge] = useState<EdgeDetail | null>(null)

  useEffect(() => {
    if (!hoverId) { setNode(null); return }
    const key = eng.wsId + hoverId
    if (nodeCache.has(key)) { setNode(nodeCache.get(key)!); return }
    let live = true
    const t = setTimeout(() => api.nodeBrief(eng.wsId, hoverId).then((d) => { nodeCache.set(key, d); if (live) setNode(d) }).catch(() => {}), 110)
    return () => { live = false; clearTimeout(t) }
  }, [hoverId])

  useEffect(() => {
    if (!edgeId || hoverId) { setEdge(null); return }
    const key = eng.wsId + edgeId
    if (edgeCache.has(key)) { setEdge(edgeCache.get(key)!); return }
    let live = true
    const t = setTimeout(() => api.edge(eng.wsId, edgeId).then((d) => { edgeCache.set(key, d); if (live) setEdge(d) }).catch(() => {}), 140)
    return () => { live = false; clearTimeout(t) }
  }, [edgeId, hoverId])

  if (!pos || (!node && !edge)) return null
  const x = Math.min(pos.x + 18, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 330)
  const y = Math.max(70, pos.y + 14)
  return (
    <div className="glass pointer-events-none absolute z-30 w-[300px] rounded-xl p-3.5" style={{ left: x, top: y }} role="tooltip">
      {node && node.id === hoverId && (
        <>
          <div className="flex items-center gap-2">
            <i className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colors[node.type] ?? node.color ?? '#5cf2d6', boxShadow: `0 0 10px ${colors[node.type] ?? '#5cf2d6'}` }} />
            <span className="truncate font-semibold">{node.label}</span>
            <span className="chip ml-auto shrink-0">{node.type}</span>
          </div>
          {node.path && <div className="mono mt-1 truncate text-[0.7rem] text-mist">{node.path}</div>}
          <p className="mt-2 line-clamp-3 text-[0.82rem] leading-snug text-[#c4d6ea]">{node.summary || 'No description yet.'}</p>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[0.7rem] text-mist">
            <span className="chip">{node.degree.in} in · {node.degree.out} out</span>
            {node.cluster && <span className="chip" style={{ borderColor: node.cluster.color + '66', color: node.cluster.color }}>{node.cluster.label}</span>}
          </div>
        </>
      )}
      {edge && !hoverId && (
        <>
          <div className="chip mb-1.5" style={{ color: edge.color }}>{edge.type.replace('_', ' ').toLowerCase()}</div>
          <p className="text-sm">{edge.explanation}</p>
          {edge.evidence[0] && <p className="mono mt-2 line-clamp-2 rounded-md bg-black/40 px-2 py-1 text-[0.7rem] text-mist">{edge.evidence[0].line ? `L${edge.evidence[0].line}  ` : ''}{edge.evidence[0].text}</p>}
          <p className="mt-2 text-[0.7rem] text-mist">Click for details</p>
        </>
      )}
    </div>
  )
}
