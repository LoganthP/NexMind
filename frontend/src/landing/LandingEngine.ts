/* eslint-disable @typescript-eslint/no-explicit-any */
import ForceGraph3D from '3d-force-graph'
import * as THREE from 'three'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'

type FG = any

// Landing-page look: do not change when tuning the in-app graph
export const BG = '#040a12'
export const FOG_DENSITY = 0.0012

export const NODE_COLORS: Record<string, string> = {
  Source: '#f4f8ff',
  Folder: '#7f93ad',
  File: '#4cc9f0',
  Document: '#ffb35c',
  Section: '#ffd199',
  Class: '#a99bff',
  Function: '#5cf2d6',
  Method: '#8ff7e4',
  Module: '#ff7eb6',
  Concept: '#ffd666',
  Entity: '#ff8a8a',
  Process: '#38e8ff',
}

export const EDGE_COLORS: Record<string, string> = {
  CONTAINS: '#3d546d',
  DEFINES: '#4d6a88',
  IMPORTS: '#5aa9ff',
  CALLS: '#5cf2d6',
  INHERITS: '#b79bff',
  REFERENCES: '#ffc857',
  MENTIONS: '#e0b84f',
  RELATED_TO: '#ff7c93',
  SIMILAR_TO: '#ff9a4d',
  RELATION: '#ff5c8a',
  HAS_STEP: '#38e8ff',
}

export const TYPE_SIZE: Record<string, number> = {
  Source: 1.6,
  Folder: 0.8,
  File: 1.0,
  Document: 1.3,
  Section: 0.8,
  Class: 1.15,
  Function: 0.85,
  Method: 0.65,
  Module: 0.9,
  Concept: 0.9,
  Entity: 1.0,
  Process: 1.1,
}

export const EDGE_BLEND_RATIOS: Record<string, number> = {
  CONTAINS: 0.72,
  DEFINES: 0.60,
  DEFAULT: 0.42,
}

export const BLOOM_CONFIG = {
  strength: 0.9,
  radius: 0.55,
  threshold: 0.04,
}

export const DUST_CONFIG = {
  countHigh: 1600,
  countLow: 500,
  minRadius: 250,
  radiusSpan: 900,
  size: 5,
  color: '#7aa8d6',
  opacity: 0.32,
  rotSpeed: 0.012,
}

export const PARTICLE_CONFIG = {
  maxAmbient: 36,
  speed: 0.007,
  width: 1.7,
}

export const NEBULA_CONFIG = {
  opacity: 0.085,
  scaleMultiplier: 4.2,
  minScale: 60,
}

export interface Cluster {
  id: number
  label: string
  size: number
  color: string
  summary?: string
}

export interface GNode {
  id: string
  type: string
  label: string
  x: number
  y: number
  z: number
  cluster?: number
  score: number
  fx?: number
  fy?: number
  fz?: number
  [key: string]: any
}

export interface GLink {
  id: string
  source: string | GNode
  target: string | GNode
  type: string
  weight?: number
  [key: string]: any
}

export interface LandingEngineOptions {
  interactive?: boolean
  quality?: 'high' | 'low'
  autoRotate?: boolean
  labels?: boolean
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const easeOutBack = (t: number) => {
  const c1 = 1.4
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}

function createRadialTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.16, 'rgba(255,255,255,0.95)')
  grad.addColorStop(0.24, 'rgba(255,255,255,0.5)')
  grad.addColorStop(0.5, 'rgba(255,255,255,0.14)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 128, 128)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

const blendedEdgeColorCache = new Map<string, string>()
function getBlendedEdgeColor(type: string): string {
  let cached = blendedEdgeColorCache.get(type)
  if (!cached) {
    const raw = EDGE_COLORS[type] ?? '#4d6a88'
    const ratio = EDGE_BLEND_RATIOS[type] ?? EDGE_BLEND_RATIOS.DEFAULT
    const col = new THREE.Color(raw)
    col.lerp(new THREE.Color(BG), ratio)
    cached = `#${col.getHexString()}`
    blendedEdgeColorCache.set(type, cached)
  }
  return cached
}

export class LandingEngine {
  private fg: FG
  private el: HTMLElement
  private opts: Required<LandingEngineOptions>
  private nodes: GNode[] = []
  private links: GLink[] = []
  private byId = new Map<string, GNode>()
  private linkById = new Map<string, GLink>()
  private clusters: Cluster[] = []
  private ambient = new Set<string>()
  private decor: THREE.Object3D[] = []
  private nodeTex: THREE.CanvasTexture
  private dust: THREE.Points | null = null
  private bloom: UnrealBloomPass | null = null
  private raf = 0
  private disposed = false
  private last = performance.now()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private fitTimer: ReturnType<typeof setTimeout> | undefined
  private ro: ResizeObserver

  constructor(el: HTMLElement, options: LandingEngineOptions = {}) {
    this.el = el
    this.opts = {
      interactive: options.interactive ?? false,
      quality: options.quality ?? 'high',
      autoRotate: options.autoRotate ?? false,
      labels: options.labels ?? false,
    }
    this.nodeTex = createRadialTexture()
    const low = this.opts.quality === 'low'
    this.fg = new (ForceGraph3D as any)(el, {
      controlType: 'orbit',
      rendererConfig: { antialias: !low, alpha: false, powerPreference: 'high-performance' },
    })
    const fg = this.fg
    fg.backgroundColor(BG)
      .showNavInfo(false)
      .numDimensions(3)
      .cooldownTicks(0)
      .warmupTicks(0)
      .nodeLabel(() => '')
      .linkLabel(() => '')
      .enableNodeDrag(false)
      .nodeThreeObjectExtend(false)
      .nodeThreeObject((n: GNode) => this.makeNode(n))
      .linkColor((l: GLink) => getBlendedEdgeColor(l.type))
      .linkOpacity(0.6)
      .linkCurvature(low ? 0 : 0.1)
      .linkWidth(0)
      .linkDirectionalParticles((l: GLink) => (this.ambient.has(l.id) ? 1 : 0))
      .linkDirectionalParticleSpeed(PARTICLE_CONFIG.speed)
      .linkDirectionalParticleWidth(PARTICLE_CONFIG.width)
      .linkDirectionalParticleColor((l: GLink) => getBlendedEdgeColor(l.type))
      .linkVisibility((l: GLink) => this.isLinkVisible(l))

    fg.scene().fog = new THREE.FogExp2(new THREE.Color(BG).getHex(), FOG_DENSITY)
    fg.renderer().setPixelRatio(Math.min(window.devicePixelRatio || 1, low ? 1.25 : 2))
    fg.camera().far = 6000
    fg.camera().updateProjectionMatrix()
    fg.cameraPosition({ x: 0, y: 60, z: 520 })

    if (!this.opts.interactive) {
      fg.enableNavigationControls(false).enablePointerInteraction(false)
    }

    if (!low) {
      try {
        this.bloom = new UnrealBloomPass(
          new THREE.Vector2(el.clientWidth || 800, el.clientHeight || 600),
          BLOOM_CONFIG.strength,
          BLOOM_CONFIG.radius,
          BLOOM_CONFIG.threshold
        )
        fg.postProcessingComposer().addPass(this.bloom)
      } catch {
        this.bloom = null
      }
    }

    this.addDust()
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(el)
    this.resize()
    this.raf = requestAnimationFrame(this.tick)
  }

  setClusters(clusters: Cluster[]) {
    this.clusters = clusters
    this.rebuildDecor()
  }

  addBatch(nodes: GNode[], links: GLink[]) {
    const now = performance.now()
    nodes.forEach((n) => {
      if (!this.byId.has(n.id)) {
        this.register(n, now)
      }
    })
    links.forEach((l) => {
      if (!this.linkById.has(l.id)) {
        this.registerLink(l)
      }
    })
    this.commit()
    this.later(420, () => {
      try {
        this.fg.refresh()
      } catch {
        /* ignore */
      }
    })
    this.scheduleFit(700)
  }

  orbit(angle: number, elevation: number, dist: number) {
    this.fg.cameraPosition(
      {
        x: Math.sin(angle) * Math.cos(elevation) * dist,
        y: Math.sin(elevation) * dist,
        z: Math.cos(angle) * Math.cos(elevation) * dist,
      },
      { x: 0, y: 0, z: 0 },
      0
    )
  }

  pause() {
    try {
      this.fg.pauseAnimation()
    } catch {
      /* ignore */
    }
  }

  resume() {
    try {
      this.fg.resumeAnimation()
    } catch {
      /* ignore */
    }
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    clearTimeout(this.fitTimer)
    this.timers.forEach((t) => clearTimeout(t))
    this.timers.clear()
    this.ro.disconnect()
    this.clearDecor()
    if (this.dust) {
      this.fg.scene().remove(this.dust)
      this.dust.geometry.dispose()
      ;(this.dust.material as THREE.Material).dispose()
      this.dust = null
    }
    try {
      this.fg.pauseAnimation()
      this.fg._destructor?.()
    } catch {
      /* already gone */
    }
    this.nodeTex.dispose()
    this.el.innerHTML = ''
  }

  private register(n: GNode, born: number) {
    n.fx = n.x
    n.fy = n.y
    n.fz = n.z
    ;(n as any).__born = born
    this.nodes.push(n)
    this.byId.set(n.id, n)
  }

  private registerLink(l: GLink) {
    const s = typeof l.source === 'string' ? l.source : (l.source as any)?.id
    const t = typeof l.target === 'string' ? l.target : (l.target as any)?.id
    if (!this.byId.has(s) || !this.byId.has(t)) return
    this.links.push(l)
    this.linkById.set(l.id, l)
    if (
      this.opts.quality === 'high' &&
      (l.type === 'CALLS' || l.type === 'IMPORTS') &&
      this.ambient.size < PARTICLE_CONFIG.maxAmbient &&
      Math.random() < 0.25
    ) {
      this.ambient.add(l.id)
    }
  }

  private commit() {
    this.fg.graphData({ nodes: this.nodes, links: this.links })
  }

  private nodeColor(n: GNode): string {
    return NODE_COLORS[n.type] ?? '#9fb3c8'
  }

  private sizeOf(n: GNode): number {
    const base = (3 + 15 * Math.sqrt(Math.max(n.score ?? 0, 0))) * (TYPE_SIZE[n.type] ?? 1)
    return Math.max(2.6, base)
  }

  private makeNode(n: GNode): THREE.Object3D {
    const mat = new THREE.SpriteMaterial({
      map: this.nodeTex,
      color: this.nodeColor(n),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
    })
    const s = new THREE.Sprite(mat)
    s.scale.setScalar(0.001)
    s.userData = {
      base: this.sizeOf(n),
      col: new THREE.Color(this.nodeColor(n)),
      alpha: 0,
    }
    return s
  }

  private isLinkVisible(l: GLink): boolean {
    const s = typeof l.source === 'string' ? l.source : (l.source as any)?.id
    const t = typeof l.target === 'string' ? l.target : (l.target as any)?.id
    const sn = this.byId.get(s)
    const tn = this.byId.get(t)
    if (!sn || !tn) return false
    const now = performance.now()
    const sb = (sn as any).__born ?? 0
    const tb = (tn as any).__born ?? 0
    return now - sb >= 420 && now - tb >= 420
  }

  private addDust() {
    const low = this.opts.quality === 'low'
    const n = low ? DUST_CONFIG.countLow : DUST_CONFIG.countHigh
    const pos = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const r = DUST_CONFIG.minRadius + Math.random() * DUST_CONFIG.radiusSpan
      const th = Math.random() * Math.PI * 2
      const ph = Math.acos(2 * Math.random() - 1)
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th)
      pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th)
      pos[i * 3 + 2] = r * Math.cos(ph)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const m = new THREE.PointsMaterial({
      map: this.nodeTex,
      size: DUST_CONFIG.size,
      color: DUST_CONFIG.color,
      transparent: true,
      opacity: DUST_CONFIG.opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    })
    this.dust = new THREE.Points(g, m)
    this.fg.scene().add(this.dust)
  }

  private clearDecor() {
    this.decor.forEach((o) => {
      this.fg.scene().remove(o)
    })
    this.decor = []
  }

  private rebuildDecor() {
    this.clearDecor()
    const groups = new Map<number, GNode[]>()
    this.nodes.forEach((n) => {
      if (n.cluster && n.type !== 'Process') {
        const list = groups.get(n.cluster) ?? []
        list.push(n)
        groups.set(n.cluster, list)
      }
    })
    for (const c of this.clusters) {
      const ms = groups.get(c.id)
      if (!ms || ms.length < 3) continue
      const ctr = new THREE.Vector3()
      ms.forEach((m) => ctr.add(new THREE.Vector3(m.x, m.y, m.z)))
      ctr.divideScalar(ms.length)
      let rms = 0
      ms.forEach((m) => {
        rms += ctr.distanceToSquared(new THREE.Vector3(m.x, m.y, m.z))
      })
      rms = Math.sqrt(rms / ms.length)
      const mat = new THREE.SpriteMaterial({
        map: this.nodeTex,
        color: c.color,
        transparent: true,
        opacity: NEBULA_CONFIG.opacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
      const neb = new THREE.Sprite(mat)
      neb.position.copy(ctr)
      neb.scale.setScalar(Math.max(NEBULA_CONFIG.minScale, rms * NEBULA_CONFIG.scaleMultiplier))
      neb.renderOrder = -1
      this.fg.scene().add(neb)
      this.decor.push(neb)
    }
  }

  private scheduleFit(delay: number) {
    clearTimeout(this.fitTimer)
    this.fitTimer = setTimeout(() => {
      if (!this.disposed && this.nodes.length) {
        try {
          this.fg.zoomToFit(900, 60)
        } catch {
          /* empty graph */
        }
      }
    }, delay)
  }

  private later(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.timers.delete(t)
      if (!this.disposed) fn()
    }, ms)
    this.timers.add(t)
  }

  private resize() {
    const w = this.el.clientWidth
    const h = this.el.clientHeight
    if (w < 10 || h < 10) return
    this.fg.width(w).height(h)
    this.bloom?.setSize(w, h)
  }

  private tick = () => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.tick)
    const t = performance.now()
    const dt = Math.min(0.05, (t - this.last) / 1000)
    this.last = t

    for (const n of this.nodes) {
      const o = (n as any).__threeObj as THREE.Sprite | undefined
      if (!o) continue
      const ud = o.userData
      const age = (t - ((n as any).__born ?? t)) / 1000
      const grow = age <= 0 ? 0 : easeOutBack(clamp(age / 0.75, 0, 1))
      ud.alpha += (1 - ud.alpha) * Math.min(1, dt * 9)
      const s = Math.max(0.001, ud.base * grow)
      o.scale.set(s, s, 1)
      const mat = o.material as THREE.SpriteMaterial
      mat.opacity = ud.alpha * clamp(0.35 + grow, 0, 1)
      o.visible = mat.opacity > 0.015
    }

    if (this.dust) {
      this.dust.rotation.y += dt * DUST_CONFIG.rotSpeed
    }
  }
}
