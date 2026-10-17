import { useState, useMemo, useRef, useEffect, ReactNode } from 'react'
import { useView, useSettings } from '@/lib/store'
import { displayName } from '@/lib/names'
import { selectNode } from '@/workspace/actions'
import type { GNode, GLink } from '@/lib/types'
import { Maximize, Minimize, ZoomIn } from 'lucide-react'

interface TreeNode {
  id: string
  node: GNode
  children: TreeNode[]
  expanded: boolean
  x: number
  y: number
  height: number
}

function buildTree(nodes: GNode[], links: GLink[], wsKind: 'code' | 'docs' | 'live'): TreeNode[] {
  const nodeMap = new Map<string, GNode>()
  nodes.forEach(n => nodeMap.set(n.id, n))
  
  const childrenMap = new Map<string, string[]>()
  links.forEach(l => {
    if (l.type === 'CONTAINS' || l.type === 'DEFINES') {
      const sId = typeof l.source === 'object' ? (l.source as any).id : l.source
      const tId = typeof l.target === 'object' ? (l.target as any).id : l.target
      if (!childrenMap.has(sId)) childrenMap.set(sId, [])
      childrenMap.get(sId)!.push(tId)
    }
  })

  if (wsKind === 'docs') {
    // Docs: Section -> top 5 Concepts/Entities. We need to add those.
    links.forEach(l => {
      if (l.type === 'MENTIONS') {
        const sId = typeof l.source === 'object' ? (l.source as any).id : l.source
        const tId = typeof l.target === 'object' ? (l.target as any).id : l.target
        const src = nodeMap.get(sId)
        const tgt = nodeMap.get(tId)
        if (src?.type === 'Section' && (tgt?.type === 'Concept' || tgt?.type === 'Entity')) {
          if (!childrenMap.has(sId)) childrenMap.set(sId, [])
          childrenMap.get(sId)!.push(tId)
        }
      }
    })
  }

  // Find roots (Sources)
  const roots = nodes.filter(n => n.type === 'Source')
  
  const visited = new Set<string>()
  const build = (n: GNode, depth: number): TreeNode | null => {
    if (visited.has(n.id)) return null
    visited.add(n.id)
    
    let rawChildren = (childrenMap.get(n.id) || []).map(id => nodeMap.get(id)).filter(Boolean) as GNode[]
    if (wsKind === 'docs' && n.type === 'Section') {
      // top 5 by degree
      rawChildren = rawChildren.sort((a,b) => (b.degree||0) - (a.degree||0)).slice(0, 5)
    }

    const children = rawChildren.map(c => build(c, depth + 1)).filter(Boolean) as TreeNode[]
    return {
      id: n.id,
      node: n,
      children,
      expanded: depth < 1,
      x: 0, y: 0, height: 0
    }
  }

  return roots.map(r => build(r, 0)).filter(Boolean) as TreeNode[]
}

function layoutTree(nodes: TreeNode[]) {
  const ROW_H = 26
  const COL_W = 150
  
  let currentY = 0

  const traverse = (n: TreeNode, depth: number): number => {
    n.x = depth * COL_W
    if (!n.expanded || n.children.length === 0) {
      n.y = currentY
      currentY += ROW_H
      n.height = ROW_H
      return n.y
    }
    
    let minChildY = Infinity
    let maxChildY = -Infinity
    for (const c of n.children) {
      const cy = traverse(c, depth + 1)
      minChildY = Math.min(minChildY, cy)
      maxChildY = Math.max(maxChildY, cy)
    }
    n.y = (minChildY + maxChildY) / 2
    n.height = maxChildY - minChildY + ROW_H
    return n.y
  }

  nodes.forEach(n => traverse(n, 0))
}

export function MindMap() {
  const nodes = useView((s) => s.nodes)
  const links = useView((s) => s.links)
  const wsKind = useView((s) => s.wsKind)
  const selectedId = useView((s) => s.selectedId)
  const theme = useSettings((s) => s.theme)
  const [filter, setFilter] = useState('')
  
  const [treeData, setTreeData] = useState<TreeNode[]>([])
  
  // Transform data once
  const baseTree = useMemo(() => buildTree(nodes, links, wsKind || 'code'), [nodes, links, wsKind])
  
  // We need to keep expansion state locally to allow toggling without rebuilding the whole tree
  // But for simplicity, we initialize treeData from baseTree when baseTree changes.
  useEffect(() => {
    // deep clone base tree to keep expansion state mutable
    const clone = (n: TreeNode): TreeNode => ({ ...n, children: n.children.map(clone) })
    setTreeData(baseTree.map(clone))
  }, [baseTree])

  // Filter effect (auto-expand path)
  useEffect(() => {
    if (!filter) return
    const q = filter.toLowerCase()
    
    const dfsFilter = (n: TreeNode): boolean => {
      let keep = displayName(n.node).toLowerCase().includes(q)
      let childKept = false
      n.children.forEach(c => {
        if (dfsFilter(c)) childKept = true
      })
      if (childKept) n.expanded = true
      return keep || childKept
    }

    setTreeData(td => {
      const nw = td.map(n => ({...n})) // shallow copy is not enough, but dfs mutates expanded. It's dirty but fast.
      nw.forEach(dfsFilter)
      return nw
    })
  }, [filter])

  useMemo(() => layoutTree(treeData), [treeData])

  // SVG Pan/Zoom
  const svgRef = useRef<SVGSVGElement>(null)
  const [transform, setTransform] = useState({ x: 50, y: 50, k: 1 })
  const [isDragging, setIsDragging] = useState(false)
  const lastPos = useRef({ x: 0, y: 0 })

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const zoomIntensity = 0.1
    const delta = e.deltaY > 0 ? -zoomIntensity : zoomIntensity
    const newK = Math.max(0.1, Math.min(3, transform.k + delta))
    
    // Zoom towards center (simplified)
    setTransform(t => ({ ...t, k: newK }))
  }

  const onMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true)
    lastPos.current = { x: e.clientX, y: e.clientY }
  }
  
  const onMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return
    const dx = e.clientX - lastPos.current.x
    const dy = e.clientY - lastPos.current.y
    setTransform(t => ({ ...t, x: t.x + dx, y: t.y + dy }))
    lastPos.current = { x: e.clientX, y: e.clientY }
  }

  const toggleExpand = (e: React.MouseEvent, node: TreeNode) => {
    e.stopPropagation()
    const toggle = (n: TreeNode): TreeNode => {
      if (n.id === node.id) return { ...n, expanded: !n.expanded }
      return { ...n, children: n.children.map(toggle) }
    }
    setTreeData(td => td.map(toggle))
  }

  const setAllExpanded = (exp: boolean) => {
    const setExp = (n: TreeNode): TreeNode => ({ ...n, expanded: exp, children: n.children.map(setExp) })
    setTreeData(td => td.map(setExp))
  }

  const renderTree = (n: TreeNode): ReactNode[] => {
    const res: ReactNode[] = []
    
    // Link to children
    if (n.expanded && n.children.length > 0) {
      n.children.forEach(c => {
        const path = `M ${n.x + 8} ${n.y} C ${n.x + 75} ${n.y}, ${c.x - 75} ${c.y}, ${c.x} ${c.y}`
        res.push(<path key={`link-${n.id}-${c.id}`} d={path} fill="none" stroke="var(--line)" strokeWidth="1.5" className="opacity-50" />)
        res.push(...renderTree(c))
      })
    }

    // Node itself
    const isSelected = selectedId === n.id
    const hasChildren = n.children.length > 0

    res.push(
      <g key={n.id} transform={`translate(${n.x},${n.y})`} onClick={() => selectNode(n.id)} className="cursor-pointer" style={{ opacity: isSelected ? 1 : 0.8 }}>
        <circle r={4} fill={isSelected ? '#3B82F6' : 'var(--text)'} className={isSelected ? 'animate-pulse' : ''} />
        
        <text x={12} y={4} fontSize={12} fill="var(--text)" className={`select-none ${isSelected ? 'font-bold' : ''}`}>
          {displayName(n.node)}
        </text>

        {hasChildren && (
          <g transform="translate(0, 0)" onClick={(e) => toggleExpand(e, n)}>
            {n.expanded ? (
              <circle r={6} fill="transparent" stroke="var(--text)" strokeWidth={1} cx={-10} cy={0} />
            ) : (
              <g transform="translate(-14, 0)">
                <rect x={-8} y={-7} width={16} height={14} rx={7} fill="var(--surface)" stroke="var(--border)" />
                <text x={0} y={4} fontSize={9} fill="var(--text)" textAnchor="middle">+{n.children.length}</text>
              </g>
            )}
          </g>
        )}
      </g>
    )
    return res
  }

  const bg = theme === 'dark' ? 'bg-[#1e1e1e]' : 'bg-[#f8f9fa]'

  return (
    <div className={`absolute inset-0 z-10 ${bg}`}>
      {/* Controls */}
      <div className="absolute top-16 left-4 z-20 flex gap-2">
        <button className="icon-btn bg-black/10 dark:bg-white/10 backdrop-blur" onClick={() => setAllExpanded(true)} title="Expand all"><Maximize size={16} /></button>
        <button className="icon-btn bg-black/10 dark:bg-white/10 backdrop-blur" onClick={() => setAllExpanded(false)} title="Collapse all"><Minimize size={16} /></button>
        <button className="icon-btn bg-black/10 dark:bg-white/10 backdrop-blur" onClick={() => setTransform({x:50,y:50,k:1})} title="Fit"><ZoomIn size={16} /></button>
        <input type="text" placeholder="Search mind map..." className="field !h-8 ml-4 w-64 bg-black/10 dark:bg-white/10 backdrop-blur" value={filter} onChange={e => setFilter(e.target.value)} />
      </div>

      {/* SVG Canvas */}
      <svg 
        ref={svgRef}
        className="w-full h-full cursor-grab active:cursor-grabbing"
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={() => setIsDragging(false)}
        onMouseLeave={() => setIsDragging(false)}
      >
        <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
          {treeData.map(t => renderTree(t))}
        </g>
      </svg>
    </div>
  )
}
