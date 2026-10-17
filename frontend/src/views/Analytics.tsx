import { useView, useSettings } from '@/lib/store'
import { displayName } from '@/lib/names'
import { selectNode, setView } from '@/workspace/actions'
import type { Cluster } from '@/lib/types'

export function Analytics() {
  const nodes = useView((s) => s.nodes)
  const links = useView((s) => s.links)
  const clusters = useView((s) => s.clusters)
  const totalDocs = nodes.filter((n) => n.type === 'Document' || n.type === 'Source').length
  const theme = useSettings((s) => s.theme)

  const hubs = [...nodes].sort((a, b) => (b.degree || 0) - (a.degree || 0)).slice(0, 10)
  const connectors = [...nodes].sort((a, b) => (b.betweenness || 0) - (a.betweenness || 0)).slice(0, 10)
  
  const typeCount: Record<string, number> = {}
  nodes.forEach(n => typeCount[n.type] = (typeCount[n.type] || 0) + 1)
  const sortedTypes = Object.entries(typeCount).sort((a,b) => b[1] - a[1])

  const isolated = nodes.filter(n => !n.degree || n.degree === 0).length

  // Histogram
  const maxDeg = Math.max(...nodes.map(n => n.degree || 0), 1)
  const bins = new Array(10).fill(0)
  nodes.forEach(n => {
    const b = Math.min(9, Math.floor(((n.degree || 0) / maxDeg) * 10))
    bins[b]++
  })
  const maxBin = Math.max(...bins, 1)

  const gotoNode = (id: string) => {
    selectNode(id)
    setView('graph')
  }

  const bg = theme === 'dark' ? 'bg-[#1e1e1e]' : 'bg-white'
  const text = theme === 'dark' ? 'text-white' : 'text-gray-900'
  const textMuted = theme === 'dark' ? 'text-gray-400' : 'text-gray-500'
  const border = theme === 'dark' ? 'border-gray-800' : 'border-gray-200'

  // Cluster sizes
  const clusterCounts: Record<number, number> = {}
  nodes.forEach(n => { clusterCounts[n.cluster] = (clusterCounts[n.cluster] || 0) + 1 })
  const sortedClusters = [...clusters].sort((a, b) => (clusterCounts[b.id] || 0) - (clusterCounts[a.id] || 0))

  return (
    <div className="absolute inset-0 z-10 overflow-auto bg-black/40 backdrop-blur-sm p-8 pt-24">
      <div className={`max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 ${text}`}>
        
        {/* Totals */}
        <div className={`p-5 rounded-xl border ${border} ${bg} col-span-full flex gap-8`}>
          <div><div className={`text-xs uppercase tracking-wider ${textMuted}`}>Nodes</div><div className="text-3xl font-light">{nodes.length}</div></div>
          <div><div className={`text-xs uppercase tracking-wider ${textMuted}`}>Links</div><div className="text-3xl font-light">{links.length}</div></div>
          <div><div className={`text-xs uppercase tracking-wider ${textMuted}`}>Clusters</div><div className="text-3xl font-light">{clusters.length}</div></div>
          <div><div className={`text-xs uppercase tracking-wider ${textMuted}`}>Documents/Sources</div><div className="text-3xl font-light">{totalDocs}</div></div>
          <div><div className={`text-xs uppercase tracking-wider ${textMuted}`}>Isolated</div><div className="text-3xl font-light">{isolated}</div></div>
        </div>

        {/* Hubs */}
        <div className={`p-5 rounded-xl border ${border} ${bg}`}>
          <h3 className={`text-sm font-medium mb-4 ${textMuted}`}>Top 10 Hubs (Degree)</h3>
          <div className="space-y-2">
            {hubs.map(n => (
              <div key={n.id} className="flex items-center gap-2 cursor-pointer hover:opacity-80" onClick={() => gotoNode(n.id)}>
                <div className="w-16 text-right text-xs mono">{n.degree || 0}</div>
                <div className="flex-1 bg-gray-200 dark:bg-gray-800 h-1.5 rounded-full overflow-hidden">
                  <div className="bg-blue-500 h-full" style={{ width: `${((n.degree||0)/maxDeg)*100}%` }} />
                </div>
                <div className="w-24 truncate text-xs">{displayName(n)}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Connectors */}
        <div className={`p-5 rounded-xl border ${border} ${bg}`}>
          <h3 className={`text-sm font-medium mb-4 ${textMuted}`}>Top 10 Connectors (Betweenness)</h3>
          <div className="space-y-2">
            {connectors.map(n => (
              <div key={n.id} className="flex items-center gap-2 cursor-pointer hover:opacity-80" onClick={() => gotoNode(n.id)}>
                <div className="w-16 text-right text-xs mono">{(n.betweenness||0).toFixed(2)}</div>
                <div className="flex-1 bg-gray-200 dark:bg-gray-800 h-1.5 rounded-full overflow-hidden">
                  <div className="bg-purple-500 h-full" style={{ width: `${(n.betweenness||0)*100}%` }} />
                </div>
                <div className="w-24 truncate text-xs">{displayName(n)}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Cluster sizes */}
        <div className={`p-5 rounded-xl border ${border} ${bg}`}>
          <h3 className={`text-sm font-medium mb-4 ${textMuted}`}>Clusters</h3>
          <div className="space-y-2 max-h-60 overflow-auto">
            {sortedClusters.map((c: Cluster) => (
              <div key={c.id} className="flex items-center gap-2">
                <div className="w-6 h-2 rounded-full" style={{ background: c.color || '#fff' }} />
                <div className="flex-1 text-xs truncate">{c.label}</div>
                <div className="text-xs mono text-right">{clusterCounts[c.id] || 0}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Type Dist */}
        <div className={`p-5 rounded-xl border ${border} ${bg} col-span-full md:col-span-2 lg:col-span-1`}>
          <h3 className={`text-sm font-medium mb-4 ${textMuted}`}>Types</h3>
          <div className="flex h-4 rounded-full overflow-hidden mb-4">
            {sortedTypes.map(([t, count], i) => (
              <div key={t} style={{ width: `${(count/nodes.length)*100}%`, background: `hsl(${i*40}, 70%, 50%)` }} title={`${t}: ${count}`} />
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {sortedTypes.map(([t, count], i) => (
              <div key={t} className="text-xs flex items-center gap-1">
                <div className="w-2 h-2 rounded-full" style={{ background: `hsl(${i*40}, 70%, 50%)` }} />
                <span>{t} ({count})</span>
              </div>
            ))}
          </div>
        </div>

        {/* Degree Histogram */}
        <div className={`p-5 rounded-xl border ${border} ${bg} col-span-full md:col-span-1 lg:col-span-2`}>
          <h3 className={`text-sm font-medium mb-4 ${textMuted}`}>Degree Distribution</h3>
          <div className="flex items-end h-32 gap-1">
            {bins.map((count, i) => (
              <div key={i} className="flex-1 bg-blue-500/50 hover:bg-blue-500 transition-colors" style={{ height: `${(count/maxBin)*100}%` }} title={`Degree range ${i*maxDeg/10} - ${(i+1)*maxDeg/10}: ${count} nodes`} />
            ))}
          </div>
          <div className="flex justify-between text-xs mt-2 text-mist">
            <span>1</span>
            <span>{maxDeg}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
