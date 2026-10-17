import { useEffect, useRef, useState } from 'react'
import { BrainEngine } from '@/three/engine'
import { toast, useSettings, useView } from '@/lib/store'
import { applyFilters, clearAll, eng, selectEdge, selectNode } from '@/workspace/actions'

export function GraphCanvas() {
  const ref = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState('')
  const { perf, autoRotate, set } = useSettings()
  const hiddenTypes = useView((s) => s.hiddenTypes)
  const hiddenClusters = useView((s) => s.hiddenClusters)
  const minScore = useView((s) => s.minScore)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const patch = useView.getState().patch
    let engine: BrainEngine
    try {
      engine = new BrainEngine(el, {
        quality: useSettings.getState().perf ? 'low' : 'high', autoRotate: useSettings.getState().autoRotate,
        events: {
          onHover: (id, pos) => patch({ hoverId: id, hoverPos: pos }),
          onClick: (id) => selectNode(id),
          onEdgeHover: (id) => patch({ hoverEdgeId: id, hoverPos: id ? eng.current?.getPointer() ?? null : null }),
          onEdgeClick: (id) => selectEdge(id),
          onBackground: () => {
            clearAll()
            eng.current?.clearFocusState()
          },
          onLowFps: () => { toast.info('Switched to performance mode to keep things smooth'); set({ perf: true }) },
        },
      })
    } catch (e) {
      console.error(e)
      setFailed((e as Error).message || 'WebGL is not available')
      return
    }
    eng.current = engine
    patch({ connected: true })
    return () => { engine.dispose(); if (eng.current === engine) eng.current = null; patch({ connected: false }) }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        clearAll()
        eng.current?.clearFocusState()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => { eng.current?.setQuality(perf ? 'low' : 'high') }, [perf])
  useEffect(() => { eng.current?.setAutoRotate(autoRotate) }, [autoRotate])
  useEffect(() => { applyFilters() }, [hiddenTypes, hiddenClusters, minScore])

  if (failed) {
    return (
      <div className="absolute inset-0 grid place-items-center p-6">
        <div className="glass max-w-md rounded-2xl p-6 text-center">
          <h2 className="text-lg font-semibold">The 3D view needs WebGL</h2>
          <p className="mt-2 text-sm text-mist">Your browser could not start WebGL ({failed}). Turn on hardware acceleration in the browser settings, or try Chrome, Edge or Firefox. Search, details and chat still work.</p>
        </div>
      </div>
    )
  }
  return <div ref={ref} className="absolute inset-0 touch-none" onDoubleClick={() => clearAll()} aria-label="3D knowledge graph" role="application" />
}
