import type { Cluster, GLink, GNode, NodeType } from '@/lib/types'

/** A believable fake knowledge graph for the landing hero (generated in the browser; no server needed). */
export function makeDemoGraph(count = 520, k = 7, seed = 11): { nodes: GNode[]; links: GLink[]; clusters: Cluster[] } {
  let s = seed
  const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296 }
  const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 1.2
  const palette = ['#5cf2d6', '#9b8cff', '#ff7c93', '#ffc970', '#4cc9f0', '#ff7eb6', '#8ff7a8']
  const types: NodeType[] = ['Function', 'Function', 'Method', 'Method', 'Class', 'File', 'Concept', 'Section', 'Document', 'Entity']
  const names = ['auth', 'orders', 'payments', 'graph', 'parser', 'search', 'chat']
  const clusters: Cluster[] = Array.from({ length: k }, (_, i) => ({ id: i + 1, label: names[i % names.length], size: 0, color: palette[i % palette.length], summary: '' }))
  const nodes: GNode[] = []
  const R = 150
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let c = 0; c < k; c++) {
    const y = 1 - (2 * (c + 0.5)) / k, r = Math.sqrt(1 - y * y), th = golden * c
    const cx = Math.cos(th) * r * R, cy = y * R * 0.8, cz = Math.sin(th) * r * R
    const n = Math.floor(count / k)
    for (let i = 0; i < n; i++) {
      const score = Math.pow(rnd(), 3.2)
      const type = i === 0 ? 'Source' : types[Math.floor(rnd() * types.length)]
      nodes.push({ id: `d${c}_${i}`, type, label: `${names[c]}_${i}`, x: cx + gauss() * 38, y: cy + gauss() * 38, z: cz + gauss() * 38, cluster: c + 1, score: i === 0 ? 1 : score })
    }
    clusters[c].size = n
  }
  const links: GLink[] = []
  let id = 0
  const byCluster = (c: number) => nodes.filter((n) => n.cluster === c)
  for (let c = 1; c <= k; c++) {
    const ms = byCluster(c)
    ms.forEach((m, i) => {
      if (i === 0) return
      const hub = ms[Math.floor(Math.pow(rnd(), 2) * i)]
      links.push({ id: `e${id++}`, source: hub.id, target: m.id, type: rnd() < 0.5 ? 'CALLS' : 'DEFINES', weight: 1 })
      if (rnd() < 0.3) links.push({ id: `e${id++}`, source: ms[Math.floor(rnd() * ms.length)].id, target: m.id, type: 'CALLS', weight: 1 })
    })
  }
  for (let i = 0; i < 60; i++) {
    const a = nodes[Math.floor(rnd() * nodes.length)], b = nodes[Math.floor(rnd() * nodes.length)]
    if (a.cluster !== b.cluster) links.push({ id: `e${id++}`, source: a.id, target: b.id, type: rnd() < 0.5 ? 'IMPORTS' : 'REFERENCES', weight: 1 })
  }
  return { nodes, links, clusters }
}
