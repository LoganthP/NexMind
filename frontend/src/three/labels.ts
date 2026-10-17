import * as THREE from 'three'
import type { GNode, Cluster } from '@/lib/types'
import { displayName } from '@/lib/names'

/**
 * Converts a cluster hex color to a pastel of the same hue
 * with lightness forced to 84% and saturation capped at 70%.
 */
export function pastelClusterColor(hex: string): string {
  const col = new THREE.Color(hex)
  const hsl = { h: 0, s: 0, l: 0 }
  col.getHSL(hsl)
  col.setHSL(hsl.h, Math.min(0.70, hsl.s), 0.84)
  return '#' + col.getHexString()
}

export class DOMLabels {
  private container: HTMLElement
  private svg: SVGSVGElement
  private labels: Map<string, SVGTextElement> = new Map()
  private clusters: Map<number, SVGTextElement> = new Map()
  private vector = new THREE.Vector3()

  constructor(container: HTMLElement) {
    this.container = container
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    this.svg.style.position = 'absolute'
    this.svg.style.top = '0'
    this.svg.style.left = '0'
    this.svg.style.width = '100%'
    this.svg.style.height = '100%'
    this.svg.style.pointerEvents = 'none'
    this.svg.style.overflow = 'visible'
    this.svg.style.zIndex = '10'
    this.container.appendChild(this.svg)
  }

  dispose() {
    this.svg.remove()
    this.labels.clear()
    this.clusters.clear()
  }

  update(
    nodes: GNode[],
    clusterData: Cluster[],
    camera: THREE.Camera,
    width: number,
    height: number,
    hoverId: string | null,
    selectedId: string | null,
    neighbors: Set<string>,
    maxDegree: number
  ) {
    const camPos = camera.position

    // Sort nodes by degree desc so high degree gets priority in collision
    const sorted = [...nodes].sort((a, b) => ((b as any).degree || 0) - ((a as any).degree || 0))
    const boxes: { l: number; r: number; t: number; b: number }[] = []

    // Map DOM elements
    const currentNodes = new Set<string>()
    for (const n of sorted) {
      if ((n as any).x === undefined) continue
      
      this.vector.set((n as any).x, (n as any).y, (n as any).z)
      const dist = this.vector.distanceTo(camPos)
      
      const isHover = n.id === hoverId
      const isSel = n.id === selectedId
      const isNeigh = neighbors.has(n.id)
      const top10 = ((n as any).degree || 0) >= maxDegree * 0.9 && maxDegree > 0
      const degGt2 = ((n as any).degree || 0) > 2

      let show = false
      if (isHover || isSel || isNeigh) show = true
      else if (top10 && dist < 800) show = true
      else if (degGt2 && dist < 400) show = true
      else if (dist < 150) show = true

      if (!show) continue

      const name = displayName(n)
      if (!name) continue

      this.vector.project(camera)
      if (this.vector.z > 1) continue // behind camera

      const px = (this.vector.x * 0.5 + 0.5) * width
      const py = (-(this.vector.y * 0.5) + 0.5) * height

      // Collision check (approx 6.5px per char width, 14px height)
      const w = name.length * 6.5
      const h = 14
      const l = px - w / 2, r = px + w / 2, t = py - h - 4, b = py - 4

      let collides = false
      if (!isHover && !isSel) {
        for (const box of boxes) {
          if (l < box.r && r > box.l && t < box.b && b > box.t) {
            collides = true
            break
          }
        }
      }

      if (!collides) {
        boxes.push({ l, r, t, b })
        currentNodes.add(n.id)

        let el = this.labels.get(n.id)
        if (!el) {
          el = document.createElementNS('http://www.w3.org/2000/svg', 'text')
          el.setAttribute('text-anchor', 'middle')
          el.setAttribute('fill', '#F4F7FF')
          el.style.fontSize = '12px'
          el.style.fontWeight = '600'
          el.style.textShadow = '0 1px 2px rgba(0,0,0,0.9)'
          el.textContent = name
          this.svg.appendChild(el)
          this.labels.set(n.id, el)
        }
        el.setAttribute('x', String(px))
        el.setAttribute('y', String(py - 12)) // above node
      }
    }

    // Remove old nodes
    for (const [id, el] of this.labels.entries()) {
      if (!currentNodes.has(id)) {
        el.remove()
        this.labels.delete(id)
      }
    }

    // Clusters
    const currentClusters = new Set<number>()
    if (clusterData) {
      for (const c of clusterData) {
        this.vector.set((c as any).x, (c as any).y, (c as any).z)
        const dist = this.vector.distanceTo(camPos)
        if (dist < 300) continue // fade out if close

        this.vector.project(camera)
        if (this.vector.z > 1) continue
        
        const px = (this.vector.x * 0.5 + 0.5) * width
        const py = (-(this.vector.y * 0.5) + 0.5) * height

        currentClusters.add(c.id)
        let el = this.clusters.get(c.id)
        if (!el) {
          el = document.createElementNS('http://www.w3.org/2000/svg', 'text')
          el.setAttribute('text-anchor', 'middle')
          el.setAttribute('fill', pastelClusterColor(c.color))
          el.style.fontSize = '13px'
          el.style.fontWeight = '600'
          el.style.textShadow = '0 1px 2px rgba(0,0,0,0.9)'
          el.textContent = c.label
          this.svg.appendChild(el)
          this.clusters.set(c.id, el)
        }
        el.setAttribute('x', String(px))
        el.setAttribute('y', String(py))
        el.setAttribute('opacity', String(Math.min(1, (dist - 300) / 200)))
      }
    }

    // Remove old clusters
    for (const [id, el] of this.clusters.entries()) {
      if (!currentClusters.has(id)) {
        el.remove()
        this.clusters.delete(id)
      }
    }
  }
}
