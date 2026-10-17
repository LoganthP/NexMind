import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
} from 'd3-force-3d'
import type { GLink, GNode } from '@/lib/types'

// ============================================================================
// Tunable layout parameters for one-time relaxation
// ============================================================================
export const CHARGE = -55
export const LINK_DISTANCE = 34
export const LINK_STRENGTH = 0.02
export const CLUSTER_PULL = 0.05
export const CLUSTER_0_PULL = 0.02
export const COLLIDE_PAD = 2
export const COLLIDE_STRENGTH = 0.8
export const MAX_MS = 900

export interface RelaxOptions {
  getNodeRadius?: (n: GNode) => number
}

/**
 * Custom cluster force pulling each node toward its cluster centroid.
 * Centroids are recomputed every 20 ticks so groups stay coherent.
 */
function forceCluster() {
  let simNodes: any[] = []
  const centroids = new Map<number, { x: number; y: number; z: number }>()
  let tickCount = 0

  function updateCentroids() {
    const sums = new Map<number, { x: number; y: number; z: number; count: number }>()
    for (const n of simNodes) {
      const cId = n.cluster ?? 0
      let s = sums.get(cId)
      if (!s) {
        s = { x: 0, y: 0, z: 0, count: 0 }
        sums.set(cId, s)
      }
      s.x += n.x || 0
      s.y += n.y || 0
      s.z += n.z || 0
      s.count++
    }
    centroids.clear()
    for (const [cId, s] of sums.entries()) {
      if (s.count > 0) {
        centroids.set(cId, { x: s.x / s.count, y: s.y / s.count, z: s.z / s.count })
      }
    }
  }

  function force(alpha: number) {
    if (tickCount % 20 === 0) {
      updateCentroids()
    }
    tickCount++

    for (const n of simNodes) {
      const cId = n.cluster ?? 0
      const cen = centroids.get(cId)
      if (!cen) continue
      const pull = (cId === 0 ? CLUSTER_0_PULL : CLUSTER_PULL) * alpha
      n.vx = (n.vx || 0) + (cen.x - (n.x || 0)) * pull
      n.vy = (n.vy || 0) + (cen.y - (n.y || 0)) * pull
      n.vz = (n.vz || 0) + (cen.z - (n.z || 0)) * pull
    }
  }

  force.initialize = (initNodes: any[]) => {
    simNodes = initNodes
    tickCount = 0
    updateCentroids()
  }

  return force
}

/**
 * One-time relaxation that runs for both Projects and Documents workspaces
 * so dense groups spread out while maintaining cluster cohesion and bounding framing.
 */
export function relax(nodes: GNode[], links: GLink[], opts?: RelaxOptions): void {
  const nodeCount = nodes.length
  if (nodeCount === 0 || nodeCount > 3500) return

  // 1. Calculate original bounding-sphere radius to preserve camera framing
  let origCentroidX = 0, origCentroidY = 0, origCentroidZ = 0
  for (const n of nodes) {
    origCentroidX += n.x || 0
    origCentroidY += n.y || 0
    origCentroidZ += n.z || 0
  }
  origCentroidX /= nodeCount
  origCentroidY /= nodeCount
  origCentroidZ /= nodeCount

  let origRadius = 0
  for (const n of nodes) {
    const dx = (n.x || 0) - origCentroidX
    const dy = (n.y || 0) - origCentroidY
    const dz = (n.z || 0) - origCentroidZ
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (r > origRadius) origRadius = r
  }

  // 2. Clear fixed coordinates so simulation can move nodes
  for (const n of nodes) {
    n.fx = undefined
    n.fy = undefined
    n.fz = undefined
    n.vx = 0
    n.vy = 0
    n.vz = 0
  }

  // 3. Filter links: only non-structural edges (skip CONTAINS and DEFINES)
  const relaxedLinks = links
    .filter((l) => l.type !== 'CONTAINS' && l.type !== 'DEFINES')
    .map((l) => ({
      source: typeof l.source === 'string' ? l.source : (l.source as any).id,
      target: typeof l.target === 'string' ? l.target : (l.target as any).id,
    }))

  // 4. Set up d3-force-3d simulation
  const sim = forceSimulation(nodes, 3).stop()

  sim.force(
    'charge',
    forceManyBody().strength(CHARGE).distanceMax(260).theta(0.9)
  )

  if (relaxedLinks.length > 0) {
    sim.force(
      'link',
      forceLink(relaxedLinks)
        .id((d: any) => d.id)
        .strength(LINK_STRENGTH)
        .distance(LINK_DISTANCE)
    )
  }

  sim.force('cluster', forceCluster())

  sim.force(
    'collide',
    forceCollide((d: any) => {
      const baseR = opts?.getNodeRadius ? opts.getNodeRadius(d) : (d.score ? 3 + 15 * Math.sqrt(Math.max(d.score, 0)) : 3)
      return baseR * 1.6 + COLLIDE_PAD
    }).strength(COLLIDE_STRENGTH)
  )

  // 5. Run synchronously
  const totalTicks = Math.min(150, Math.floor(40 + 60000 / nodeCount))
  const alphaStart = 0.6
  const alphaEnd = 0.02
  const t0 = performance.now()

  for (let k = 0; k < totalTicks; k++) {
    if (k % 10 === 0 && performance.now() - t0 > MAX_MS) {
      break
    }
    const a = alphaStart + (alphaEnd - alphaStart) * (k / totalTicks)
    sim.alpha(a)
    sim.tick()
  }

  sim.stop()

  // 6. Calculate new bounding-sphere radius
  let newCentroidX = 0, newCentroidY = 0, newCentroidZ = 0
  for (const n of nodes) {
    newCentroidX += n.x || 0
    newCentroidY += n.y || 0
    newCentroidZ += n.z || 0
  }
  newCentroidX /= nodeCount
  newCentroidY /= nodeCount
  newCentroidZ /= nodeCount

  let newRadius = 0
  for (const n of nodes) {
    const dx = (n.x || 0) - newCentroidX
    const dy = (n.y || 0) - newCentroidY
    const dz = (n.z || 0) - newCentroidZ
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (r > newRadius) newRadius = r
  }

  // 7. Scale so bounding-sphere radius equals original radius * 1.15
  const scale = origRadius > 0 && newRadius > 0 ? (origRadius * 1.15) / newRadius : 1.0

  for (const n of nodes) {
    n.x = newCentroidX + ((n.x || 0) - newCentroidX) * scale
    n.y = newCentroidY + ((n.y || 0) - newCentroidY) * scale
    n.z = newCentroidZ + ((n.z || 0) - newCentroidZ) * scale
    // Freeze positions again
    n.fx = n.x
    n.fy = n.y
    n.fz = n.z
  }
}
