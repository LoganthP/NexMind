import * as THREE from 'three'
import type { GLink, GNode } from '@/lib/types'

// Pre-computed quadratic Bezier weights for 5 segments (t = 0, 0.2, 0.4, 0.6, 0.8, 1.0)
const W = [
  [1.0, 0.0, 0.0],
  [0.64, 0.32, 0.04],
  [0.36, 0.48, 0.16],
  [0.16, 0.48, 0.36],
  [0.04, 0.32, 0.64],
  [0.0, 0.0, 1.0],
]

function hashEdgeId(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export interface EdgeRendererColors {
  getNodeColor: (type: string) => string
  getEdgeColor: (type: string) => string
  bgColor: string
}

export class EdgeRenderer {
  baseMesh: THREE.LineSegments
  highlightMesh: THREE.LineSegments
  private baseMat: THREE.LineBasicMaterial
  private hlMat: THREE.LineBasicMaterial

  private basePositions: Float32Array = new Float32Array(0)
  private baseColors: Float32Array = new Float32Array(0)
  private hlPositions: Float32Array = new Float32Array(0)
  private hlColors: Float32Array = new Float32Array(0)

  private currentBaseOpacity = 0.32
  private targetBaseOpacity = 0.32
  private restBaseOpacity = 0.32
  private baseEdgeCount = 0

  private bgCol = new THREE.Color('#040a12')
  private cachedNodeColors = new Map<string, THREE.Color>()
  private cachedEdgeColors = new Map<string, THREE.Color>()

  constructor(scene: THREE.Scene, bgColor = '#040a12') {
    this.bgCol.set(bgColor)

    // 1. BASE group (quiet, base opacity 0.32, vertexColors enabled)
    const baseGeo = new THREE.BufferGeometry()
    baseGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3))
    baseGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3))
    this.baseMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      fog: false,
    })
    this.baseMesh = new THREE.LineSegments(baseGeo, this.baseMat)
    this.baseMesh.renderOrder = 1
    scene.add(this.baseMesh)

    // 2. HIGHLIGHT group (opacity 1.0)
    const hlGeo = new THREE.BufferGeometry()
    hlGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3))
    hlGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3))
    this.hlMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 1.0,
      depthWrite: false,
      fog: false,
    })
    this.highlightMesh = new THREE.LineSegments(hlGeo, this.hlMat)
    this.highlightMesh.renderOrder = 2
    this.highlightMesh.visible = false
    scene.add(this.highlightMesh)
  }

  setResolution(_w: number, _h: number): void {
    // Supported for interface consistency
  }

  getBaseOpacity(): number {
    return this.currentBaseOpacity
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.baseMesh)
    scene.remove(this.highlightMesh)
    this.baseMesh.geometry.dispose()
    this.baseMat.dispose()
    this.highlightMesh.geometry.dispose()
    this.hlMat.dispose()
  }

  setBgColor(hex: string): void {
    this.bgCol.set(hex)
    this.cachedNodeColors.clear()
  }

  /**
   * Rebuild the BASE edges group. Never called during hover.
   */
  updateBase(
    links: GLink[],
    nodesById: Map<string, GNode>,
    adj: Map<string, Set<string>>,
    isHidden: (n: GNode) => boolean,
    colors: EdgeRendererColors,
    emphEdges?: Set<string>
  ): void {
    this.baseEdgeCount = links.length
    // Base opacity 0.32 (0.24 when edges > 3000)
    this.restBaseOpacity = links.length > 3000 ? 0.24 : 0.32
    if (this.targetBaseOpacity !== 0.03) {
      this.targetBaseOpacity = this.restBaseOpacity
    }

    const capEdges = links.length > 2500
    // Filter visible links
    const visibleLinks: GLink[] = []
    for (const l of links) {
      const sId = typeof l.source === 'string' ? l.source : (l.source as any).id
      const tId = typeof l.target === 'string' ? l.target : (l.target as any).id
      const sNode = nodesById.get(sId)
      const tNode = nodesById.get(tId)
      if (!sNode || !tNode) continue
      if (isHidden(sNode) || isHidden(tNode)) continue

      if (capEdges) {
        const isStructural = l.type === 'CONTAINS' || l.type === 'DEFINES'
        if (isStructural) {
          const sDeg = adj.get(sId)?.size ?? 0
          const tDeg = adj.get(tId)?.size ?? 0
          const isEmph = emphEdges && emphEdges.has(l.id)
          if (!isEmph && (sDeg < 3 || tDeg < 3)) {
            continue
          }
        }
      }
      visibleLinks.push(l)
    }

    // Allocate 30 floats pos, 30 floats col per edge (5 segments x 2 vertices x 3 coordinates)
    const neededFloats = visibleLinks.length * 30
    if (this.basePositions.length < neededFloats) {
      this.basePositions = new Float32Array(Math.max(neededFloats, Math.floor(neededFloats * 1.3)))
      this.baseColors = new Float32Array(Math.max(neededFloats, Math.floor(neededFloats * 1.3)))
    }

    let ptr = 0
    for (const l of visibleLinks) {
      const sId = typeof l.source === 'string' ? l.source : (l.source as any).id
      const tId = typeof l.target === 'string' ? l.target : (l.target as any).id
      const sNode = nodesById.get(sId)!
      const tNode = nodesById.get(tId)!

      // Colour = source node type colour mixed only 20% toward background,
      // then clamp HSL lightness to at least 55%
      let c = this.cachedNodeColors.get(sNode.type)
      if (!c) {
        c = new THREE.Color(colors.getNodeColor(sNode.type)).lerp(this.bgCol, 0.20)
        const hsl = { h: 0, s: 0, l: 0 }
        c.getHSL(hsl)
        if (hsl.l < 0.55) {
          hsl.l = 0.55
          c.setHSL(hsl.h, hsl.s, hsl.l)
        }
        this.cachedNodeColors.set(sNode.type, c)
      }

      // Structural edges (CONTAINS, DEFINES) at 60% of that opacity,
      // relationship edges at 100%
      const isStructural = l.type === 'CONTAINS' || l.type === 'DEFINES'
      const factor = isStructural ? 0.6 : 1.0

      this.tessellateEdge(l.id, sNode, tNode, c.r * factor, c.g * factor, c.b * factor, this.basePositions, this.baseColors, ptr)
      ptr += 30
    }

    const geo = this.baseMesh.geometry
    geo.setAttribute('position', new THREE.BufferAttribute(this.basePositions.subarray(0, ptr), 3))
    geo.setAttribute('color', new THREE.BufferAttribute(this.baseColors.subarray(0, ptr), 3))
    geo.attributes.position.needsUpdate = true
    geo.attributes.color.needsUpdate = true
    geo.computeBoundingSphere()
  }

  /**
   * Rebuild the HIGHLIGHT edges group when emphasis changes.
   */
  updateHighlight(
    emphEdgeIds: Set<string> | null,
    linksById: Map<string, GLink>,
    nodesById: Map<string, GNode>,
    colors: EdgeRendererColors
  ): void {
    if (!emphEdgeIds || emphEdgeIds.size === 0) {
      this.highlightMesh.visible = false
      this.targetBaseOpacity = this.restBaseOpacity
      return
    }

    this.highlightMesh.visible = true
    // When focused, all other edges drop to opacity 0.03
    this.targetBaseOpacity = 0.03

    const neededFloats = emphEdgeIds.size * 30
    if (this.hlPositions.length < neededFloats) {
      this.hlPositions = new Float32Array(Math.max(neededFloats, Math.floor(neededFloats * 1.3)))
      this.hlColors = new Float32Array(Math.max(neededFloats, Math.floor(neededFloats * 1.3)))
    }

    let ptr = 0
    for (const edgeId of emphEdgeIds) {
      const l = linksById.get(edgeId)
      if (!l) continue
      const sId = typeof l.source === 'string' ? l.source : (l.source as any).id
      const tId = typeof l.target === 'string' ? l.target : (l.target as any).id
      const sNode = nodesById.get(sId)
      const tNode = nodesById.get(tId)
      if (!sNode || !tNode) continue

      let c = this.cachedEdgeColors.get(l.type)
      if (!c) {
        c = new THREE.Color(colors.getEdgeColor(l.type))
        this.cachedEdgeColors.set(l.type, c)
      }

      this.tessellateEdge(l.id, sNode, tNode, c.r, c.g, c.b, this.hlPositions, this.hlColors, ptr)
      ptr += 30
    }

    const geo = this.highlightMesh.geometry
    geo.setAttribute('position', new THREE.BufferAttribute(this.hlPositions.subarray(0, ptr), 3))
    geo.setAttribute('color', new THREE.BufferAttribute(this.hlColors.subarray(0, ptr), 3))
    geo.attributes.position.needsUpdate = true
    geo.attributes.color.needsUpdate = true
    geo.computeBoundingSphere()
  }

  /**
   * Quadratic Bezier tessellation into 5 segments.
   */
  private tessellateEdge(
    edgeId: string,
    sNode: GNode,
    tNode: GNode,
    cr: number,
    cg: number,
    cb: number,
    posBuf: Float32Array,
    colBuf: Float32Array,
    offset: number
  ): void {
    const x0 = sNode.x || 0, y0 = sNode.y || 0, z0 = sNode.z || 0
    const x2 = tNode.x || 0, y2 = tNode.y || 0, z2 = tNode.z || 0

    const dx = x2 - x0
    const dy = y2 - y0
    const dz = z2 - z0
    const lenSq = dx * dx + dy * dy + dz * dz
    const len = Math.sqrt(lenSq)

    let x1 = (x0 + x2) * 0.5
    let y1 = (y0 + y2) * 0.5
    let z1 = (z0 + z2) * 0.5

    if (len >= 12) {
      // Pick perpendicular direction deterministically from hash
      const h = hashEdgeId(edgeId)
      // Pick reference vector A not collinear with D
      let ax = 1, ay = 0, az = 0
      if (Math.abs(dx) > 0.9 * len) {
        ax = 0; ay = 1; az = 0
      }

      // U = D x A
      let ux = dy * az - dz * ay
      let uy = dz * ax - dx * az
      let uz = dx * ay - dy * ax
      const uLen = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1
      ux /= uLen; uy /= uLen; uz /= uLen

      // V = D x U
      let vx = dy * uz - dz * uy
      let vy = dz * ux - dx * uz
      let vz = dx * uy - dy * ux
      const vLen = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1
      vx /= vLen; vy /= vLen; vz /= vLen

      const angle = ((h % 6283) / 1000)
      const cosA = Math.cos(angle)
      const sinA = Math.sin(angle)
      const nx = cosA * ux + sinA * vx
      const ny = cosA * uy + sinA * vy
      const nz = cosA * uz + sinA * vz

      const dist = 0.12 * len
      x1 += nx * dist
      y1 += ny * dist
      z1 += nz * dist
    }

    // 6 points for 5 segments:
    // pt_k = W[k][0]*P0 + W[k][1]*P1 + W[k][2]*P2
    let prevX = x0, prevY = y0, prevZ = z0
    let p = offset

    for (let k = 1; k <= 5; k++) {
      const w0 = W[k][0], w1 = W[k][1], w2 = W[k][2]
      const currX = w0 * x0 + w1 * x1 + w2 * x2
      const currY = w0 * y0 + w1 * y1 + w2 * y2
      const currZ = w0 * z0 + w1 * z1 + w2 * z2

      // Segment start
      posBuf[p + 0] = prevX
      posBuf[p + 1] = prevY
      posBuf[p + 2] = prevZ
      colBuf[p + 0] = cr
      colBuf[p + 1] = cg
      colBuf[p + 2] = cb

      // Segment end
      posBuf[p + 3] = currX
      posBuf[p + 4] = currY
      posBuf[p + 5] = currZ
      colBuf[p + 3] = cr
      colBuf[p + 4] = cg
      colBuf[p + 5] = cb

      prevX = currX
      prevY = currY
      prevZ = currZ
      p += 6
    }
  }

  /**
   * Animation tick: smoothly tween BASE opacity (160 ms ease).
   */
  tick(dt: number): void {
    if (Math.abs(this.currentBaseOpacity - this.targetBaseOpacity) > 0.001) {
      const step = dt / 0.16 // 160 ms duration
      this.currentBaseOpacity += (this.targetBaseOpacity - this.currentBaseOpacity) * Math.min(1, step * 4)
      this.baseMat.opacity = this.currentBaseOpacity
      this.baseMesh.visible = this.currentBaseOpacity > 0.005
    }
  }
}
