import ForceGraph3D from '3d-force-graph'
import * as THREE from 'three'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import type { Cluster, GLink, GNode } from '@/lib/types'
import { EdgeRenderer, type EdgeRendererColors } from './edges'
import { relax } from './relax'
import { pastelClusterColor } from './labels'
import { releasePivot, clampTarget, CameraGuard, shouldRunMove, shouldRestore, type Vec3 } from './cameraPivot'

import { NODE_COLORS, typeColor } from '@/lib/palette'
export { NODE_COLORS }

// Brightness tuning
export const DEFAULT_GLOW = 0
export const MAX_GLOW_STRENGTH = 0.35
export const GLOW_THRESHOLD = 0.8
export const GLOW_RADIUS = 0.3
export const RENDERER_TONE_MAPPING_EXPOSURE = 0.9
export const NODE_CORE_OPACITY = 0.92
export const NODE_HALO_RADIUS_MULT = 1.2
export const NODE_HALO_MAX_ALPHA = 0.12
export const NODE_HIGHLIGHT_WHITE_LERP = 0.25
export const EDGE_REST_OPACITY = 0.16
export const EDGE_REST_OPACITY_DENSE = 0.12
export const EDGE_DENSE_THRESHOLD = 3000
export const EDGE_BG_MIX = 0.45
export const CLUSTER_HAZE_OPACITY = 0.02
export const DUST_OPACITY = 0.08

/* eslint-disable @typescript-eslint/no-explicit-any */
type FG = any

export const BG = '#040a12'
export const EDGE_COLORS: Record<string, string> = {
  CONTAINS: '#3d546d', DEFINES: '#4d6a88', IMPORTS: '#5aa9ff', CALLS: '#5cf2d6', INHERITS: '#b79bff', REFERENCES: '#ffc857',
  MENTIONS: '#e0b84f', RELATED_TO: '#ff7c93', SIMILAR_TO: '#ff9a4d', RELATION: '#ff5c8a', HAS_STEP: '#38e8ff',
}
const TYPE_SIZE: Record<string, number> = {
  Source: 1.6, Folder: 0.8, File: 1.0, Document: 1.3, Section: 0.8, Class: 1.15, Function: 0.85, Method: 0.65,
  Module: 0.9, Concept: 0.9, Entity: 1.0, Process: 1.1,
}
const IMPORTANT = new Set(['Source', 'Document', 'Class', 'Process'])

export interface EngineEvents {
  onHover?: (id: string | null, pos: { x: number; y: number } | null) => void
  onClick?: (id: string) => void
  onEdgeHover?: (id: string | null) => void
  onEdgeClick?: (id: string) => void
  onBackground?: () => void
  onLowFps?: () => void
}
export interface EngineOptions {
  interactive?: boolean
  quality?: 'high' | 'low'
  autoRotate?: boolean
  labels?: boolean
  ambient?: boolean
  events?: EngineEvents
  glow?: number
}
export interface Emphasis { nodes: Set<string>; edges: Set<string> }
interface Ring { sprite: THREE.Sprite; t0: number; dur: number; max: number }

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const easeOutBack = (t: number) => { const c1 = 1.4, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2) }

function nodeTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const g = c.getContext('2d')!
  const cx = 128, cy = 128
  const rCore = 68 // about 55% of the radius
  const rHalo = Math.round(rCore * NODE_HALO_RADIUS_MULT) // at most 1.2x core radius

  // 1. Soft halo (alpha at most 0.12 down to 0)
  const haloGrad = g.createRadialGradient(cx, cy, rCore, cx, cy, rHalo)
  haloGrad.addColorStop(0, `rgba(255,255,255,${NODE_HALO_MAX_ALPHA})`)
  haloGrad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = haloGrad
  g.beginPath()
  g.arc(cx, cy, rHalo, 0, Math.PI * 2)
  g.fill()

  // 2. Solid core (opacity 0.92)
  g.fillStyle = `rgba(255,255,255,${NODE_CORE_OPACITY})`
  g.beginPath()
  g.arc(cx, cy, rCore, 0, Math.PI * 2)
  g.fill()

  // 3. 1 px outline ring in the scene background colour at the edge of the core
  g.strokeStyle = BG
  g.lineWidth = 3
  g.beginPath()
  g.arc(cx, cy, rCore, 0, Math.PI * 2)
  g.stroke()

  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function ringTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = c.height = 256
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(128, 128, 90, 128, 128, 126)
  grad.addColorStop(0, 'rgba(255,255,255,0)'); grad.addColorStop(0.7, 'rgba(255,255,255,0.9)'); grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256)
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
  return t
}

function nebulaTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64)
  grad.addColorStop(0, 'rgba(255,255,255,0.6)')
  grad.addColorStop(0.3, 'rgba(255,255,255,0.2)')
  grad.addColorStop(0.7, 'rgba(255,255,255,0.03)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 128, 128)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function labelSprite(text: string, color: string, big: boolean): THREE.Sprite {
  const c = document.createElement('canvas')
  const g0 = c.getContext('2d')!
  const fs = big ? 26 : 24
  const font = `600 ${fs}px "Bricolage Grotesque", system-ui, sans-serif`
  g0.font = font
  const label = text.length > 34 ? text.slice(0, 33) + '…' : text

  const padX = Math.round(21 * (fs / 24))
  const textW = Math.ceil(g0.measureText(label).width)
  const w = textW + padX * 2
  const h = fs + 26
  c.width = w
  c.height = h

  const g = c.getContext('2d')!
  g.font = font
  const r = h / 2

  // Dark pill behind text with opacity 0.62
  g.fillStyle = 'rgba(5,10,18,0.62)'
  g.beginPath()
  g.moveTo(r, 0)
  g.arc(w - r, r, r, -Math.PI / 2, Math.PI / 2)
  g.arc(r, r, r, Math.PI / 2, Math.PI * 1.5)
  g.closePath()
  g.fill()

  // 1px border in rgba(255,255,255,0.10)
  g.strokeStyle = 'rgba(255,255,255,0.10)'
  g.lineWidth = Math.max(1, Math.round(fs / 24))
  g.stroke()

  // 3px dark stroke before filling text
  g.strokeStyle = 'rgba(4,10,18,0.95)'
  g.lineWidth = Math.max(2, Math.round(3 * (fs / 12)))
  g.lineJoin = 'round'
  g.miterLimit = 2
  g.textBaseline = 'middle'
  g.strokeText(label, padX, r + 1)

  // Crisp text fill
  g.fillStyle = color
  g.fillText(label, padX, r + 1)

  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  const m = new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, depthTest: false, opacity: 0 })
  const s = new THREE.Sprite(m)
  const worldH = big ? 9 : 6.2
  s.scale.set((worldH * w) / h, worldH, 1)
  s.renderOrder = 10
  return s
}

export class BrainEngine {
  private fg: FG
  private el: HTMLElement
  private opts: Required<Omit<EngineOptions, 'events'>>
  private ev: EngineEvents
  private nodes: GNode[] = []
  private links: GLink[] = []
  private byId = new Map<string, GNode>()
  private linkById = new Map<string, GLink>()
  private pair = new Map<string, string>()
  private adj = new Map<string, Set<string>>()
  private incident = new Map<string, string[]>()
  private clusters: Cluster[] = []
  private colors = { node: { ...NODE_COLORS }, edge: { ...EDGE_COLORS } }
  private hoverId: string | null = null
  private selectedId: string | null = null
  private focus: Emphasis | null = null
  private emph: Emphasis | null = null
  private hidden = { types: new Set<string>(), clusters: new Set<number>(), minScore: 0 }
  private ambient = new Set<string>()
  private rings: Ring[] = []
  private decor: THREE.Object3D[] = []
  private labels = new Map<string, THREE.Sprite>()
  private clusterLabels: { sprite: THREE.Sprite; pos: THREE.Vector3 }[] = []
  private nodeTex: THREE.CanvasTexture
  private ringTex: THREE.CanvasTexture
  private nebulaTex: THREE.CanvasTexture
  private dust: THREE.Points | null = null
  private bloom: UnrealBloomPass | null = null
  private outputPass: OutputPass | null = null
  private raf = 0
  private disposed = false
  private last = performance.now()
  private frames: number[] = []
  private lowFpsFired = false
  private pointer = { x: 0, y: 0 }
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private fitTimer: ReturnType<typeof setTimeout> | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private pathCancel: (() => void) | null = null
  private ro: ResizeObserver
  private onMove: (e: PointerEvent) => void
  private onUserActivity: () => void
  private guard = new CameraGuard()
  // Camera position+target saved just before the last programmatic flyTo.
  // Used to restore the view when the user deselects a node without navigating away.
  private viewMemory: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null

  private edgeRenderer: EdgeRenderer
  private isRelaxed = false
  private maxDegree = 1
  private hubDegreeThreshold = 1

  // Hover and interaction state
  private isInteracting = false
  private userMovedCamera = false
  private lastCenter = new THREE.Vector3(0, 0, 0)
  private lastBoundingRadius = 100
  private _tempVec = new THREE.Vector3()

  // Focus fade transition (160 ms ease)
  private focusAmount = 0
  private targetFocusAmount = 0

  private hoverInTimer: ReturnType<typeof setTimeout> | null = null
  private hoverOutTimer: ReturnType<typeof setTimeout> | null = null
  private pickThrottleTimer: ReturnType<typeof setTimeout> | null = null
  private pendingHoverNode: GNode | null = null
  private pendingHoverPos: { x: number; y: number } | null = null

  private layoutTween: {
    start: number
    dur: number
    oldPos: Map<string, { x: number; y: number; z: number }>
    targetPos: Map<string, { x: number; y: number; z: number }>
    midpointFired: boolean
  } | null = null

  constructor(el: HTMLElement, options: EngineOptions = {}) {
    this.el = el
    this.ev = options.events ?? {}
    this.opts = {
      interactive: options.interactive ?? true, quality: options.quality ?? 'high', autoRotate: options.autoRotate ?? true,
      labels: options.labels ?? true, ambient: options.ambient ?? true, glow: options.glow ?? DEFAULT_GLOW,
    }
    this.nodeTex = nodeTexture()
    this.ringTex = ringTexture()
    this.nebulaTex = nebulaTexture()
    const low = this.opts.quality === 'low'
    this.fg = new (ForceGraph3D as any)(el, { controlType: 'orbit', rendererConfig: { antialias: !low, alpha: false, powerPreference: 'high-performance' } })
    const fg = this.fg
    fg.backgroundColor(BG).showNavInfo(false).numDimensions(3).cooldownTicks(0).warmupTicks(0)
      .nodeLabel(() => '').linkLabel(() => '').enableNodeDrag(false)
      .nodeThreeObjectExtend(false).nodeThreeObject((n: GNode) => this.makeNode(n))
      .linkVisibility(() => false) // Hide library's own links; EdgeRenderer draws edges with 2 LineSegments
      .linkDirectionalParticles(() => 0) // No directional particles at rest
      .linkHoverPrecision(5)

    // Distance fog: FogExp2 density set to 0.00025 to keep far nodes and edges clear
    fg.scene().fog = new THREE.FogExp2(new THREE.Color(BG).getHex(), 0.00025)
    const renderer = fg.renderer() as THREE.WebGLRenderer
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = RENDERER_TONE_MAPPING_EXPOSURE
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, low ? 1.25 : 2))
    fg.camera().far = 6000; fg.camera().updateProjectionMatrix()
    fg.cameraPosition({ x: 0, y: 60, z: 520 })

    this.edgeRenderer = new EdgeRenderer(fg.scene(), BG)

    if (!this.opts.interactive) {
      fg.enableNavigationControls(false).enablePointerInteraction(false)
    } else {
      fg.onNodeHover((n: GNode | null) => this.handleNodeHover(n))
        .onNodeClick((n: GNode) => this.ev.onClick?.(n.id))
        .onLinkHover((l: GLink | null) => this.ev.onEdgeHover?.(l ? l.id : null))
        .onLinkClick((l: GLink) => this.ev.onEdgeClick?.(l.id))
        .onBackgroundClick(() => {
          this.clearFocusState()
          this.ev.onBackground?.()
        })
    }
    const controls = fg.controls()
    if (controls) {
      controls.zoomToCursor = true
      controls.screenSpacePanning = true
      controls.enablePan = true
      controls.panSpeed = 0.9
      controls.zoomSpeed = 0.9
      controls.enableDamping = true
      controls.dampingFactor = 0.1
      controls.autoRotate = this.opts.autoRotate
      controls.autoRotateSpeed = 0.35
      controls.minDistance = 15
      controls.maxDistance = Math.max(2600, this.lastBoundingRadius * 6)

      controls.addEventListener?.('change', () => {
        if (controls.target) {
          const clamped = clampTarget(controls.target, this.lastCenter, this.lastBoundingRadius)
          controls.target.set(clamped.x, clamped.y, clamped.z)
        }
      })

      controls.addEventListener?.('start', () => {
        this.handleUserInteraction()
      })
      controls.addEventListener?.('end', () => {
        this.isInteracting = false
        this.pauseRotate()
      })
    }
    try {
      const composer = fg.postProcessingComposer()
      if (this.opts.glow > 0 && !low) {
        this.bloom = new UnrealBloomPass(
          new THREE.Vector2(el.clientWidth || 800, el.clientHeight || 600),
          Math.min(this.opts.glow, MAX_GLOW_STRENGTH),
          GLOW_RADIUS,
          GLOW_THRESHOLD
        )
        composer.addPass(this.bloom)
      } else {
        this.bloom = null
      }
      this.outputPass = new OutputPass()
      composer.addPass(this.outputPass)
    } catch {
      this.bloom = null
      this.outputPass = null
    }
    this.addDust()
    this.onMove = (e) => { const r = el.getBoundingClientRect(); this.pointer = { x: e.clientX - r.left, y: e.clientY - r.top } }
    el.addEventListener('pointermove', this.onMove)
    this.onUserActivity = () => this.handleUserInteraction()
    el.addEventListener('wheel', this.onUserActivity, { passive: true })
    el.addEventListener('pointerdown', this.onUserActivity)
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(el)
    this.resize()
    this.raf = requestAnimationFrame(this.tick)
  }

  // ------------------------------------------------------------------ hover
  private handleNodeHover(n: GNode | null) {
    if (this.isInteracting) return

    this.pendingHoverNode = n
    this.pendingHoverPos = n ? { ...this.pointer } : null

    // Throttle picking to 50 ms
    if (this.pickThrottleTimer) return
    this.pickThrottleTimer = setTimeout(() => {
      this.pickThrottleTimer = null
      this.processHover(this.pendingHoverNode)
    }, 50)
  }

  private processHover(n: GNode | null) {
    if (n) {
      if (this.hoverOutTimer) {
        clearTimeout(this.hoverOutTimer)
        this.hoverOutTimer = null
      }

      const id = n.id
      if (this.hoverId === id) return

      // If cursor moves directly onto a highlighted neighbour, cancel fade-out and switch immediately
      const isNeighbour = this.emph && this.emph.nodes.has(id)
      if (isNeighbour) {
        if (this.hoverInTimer) {
          clearTimeout(this.hoverInTimer)
          this.hoverInTimer = null
        }
        this.hoverId = id
        this.refreshEmphasis()
        this.ev.onHover?.(this.hoverId, this.pendingHoverPos)
        return
      }

      // Otherwise hover-in delay 40 ms
      if (this.hoverInTimer) clearTimeout(this.hoverInTimer)
      this.hoverInTimer = setTimeout(() => {
        this.hoverInTimer = null
        this.hoverId = id
        this.refreshEmphasis()
        this.ev.onHover?.(this.hoverId, this.pendingHoverPos)
      }, 40)
    } else {
      // Hover-out delay 120 ms
      if (this.hoverInTimer) {
        clearTimeout(this.hoverInTimer)
        this.hoverInTimer = null
      }
      if (this.hoverOutTimer) clearTimeout(this.hoverOutTimer)
      this.hoverOutTimer = setTimeout(() => {
        this.hoverOutTimer = null
        this.hoverId = null
        this.refreshEmphasis()
        this.ev.onHover?.(null, null)
      }, 120)
    }
  }

  // ------------------------------------------------------------------ data
  setColors(node?: Record<string, string>, edge?: Record<string, string>) {
    if (node) this.colors.node = { ...NODE_COLORS, ...node }
    if (edge) this.colors.edge = { ...EDGE_COLORS, ...edge }
    this.edgeRenderer.setBgColor(BG)
    this.updateEdgeBase()
  }

  private updateHubThreshold() {
    const degrees = this.nodes.map((n) => this.adj.get(n.id)?.size ?? 0).sort((a, b) => a - b)
    if (degrees.length > 0) {
      const idx = Math.min(degrees.length - 1, Math.floor(degrees.length * 0.95))
      this.hubDegreeThreshold = Math.max(2, degrees[idx])
    }
  }

  setData(nodes: GNode[], links: GLink[], clusters: Cluster[]) {
    this.clear(false)
    this.clusters = clusters

    // One-time relaxation before first render
    relax(nodes, links, { getNodeRadius: (n) => this.sizeOf(n) })
    this.isRelaxed = true

    const now = performance.now()
    const sorted = [...nodes].sort((a, b) => b.score - a.score)
    sorted.forEach((n, i) => this.register(n, now + Math.min(i * 2, 1400)))
    links.forEach((l) => this.registerLink(l))

    this.updateHubThreshold()

    // Recompute sizes with degrees populated
    for (const n of this.nodes) {
      const o = (n as any).__threeObj as THREE.Sprite | undefined
      if (o) o.userData.base = this.sizeOf(n)
    }

    this.commit()
    this.updateEdgeBase()
    this.rebuildDecor()
    this.updateGraphBounds()

    // Reset emphasis so graph rest state is clear
    this.applyFocus(null)
    this.frameGraph(700, { force: false })
  }

  /** Streaming growth: each batch blooms in at the server-computed position. */
  addBatch(nodes: GNode[], links: GLink[]) {
    this.isRelaxed = false
    const now = performance.now()
    nodes.forEach((n) => { if (!this.byId.has(n.id)) this.register(n, now) })
    links.forEach((l) => { if (!this.linkById.has(l.id)) this.registerLink(l) })
    this.updateHubThreshold()
    this.commit()
    this.updateEdgeBase()
    this.updateGraphBounds()
    this.scheduleFit(700)
  }

  setClusters(clusters: Cluster[]) {
    this.clusters = clusters
    this.rebuildDecor()
    if (!this.isRelaxed && this.nodes.length > 0) {
      this.relaxAndTween(700)
    }
  }

  relaxAndTween(ms = 700) {
    if (this.nodes.length === 0 || this.nodes.length > 3500) return
    this.isRelaxed = true
    const oldPos = new Map<string, { x: number; y: number; z: number }>()
    for (const n of this.nodes) {
      oldPos.set(n.id, { x: n.x, y: n.y, z: n.z })
    }

    relax(this.nodes, this.links, { getNodeRadius: (n) => this.sizeOf(n) })

    const targetPos = new Map<string, { x: number; y: number; z: number }>()
    for (const n of this.nodes) {
      targetPos.set(n.id, { x: n.x, y: n.y, z: n.z })
      const o = oldPos.get(n.id)!
      n.x = o.x; n.y = o.y; n.z = o.z
      n.fx = o.x; n.fy = o.y; n.fz = o.z
      const obj = (n as any).__threeObj as THREE.Object3D | undefined
      if (obj) obj.position.set(n.x, n.y, n.z)
    }

    this.layoutTween = {
      start: performance.now(),
      dur: ms,
      oldPos,
      targetPos,
      midpointFired: false,
    }
  }

  clear(resetCamera = true) {
    this.cancelPath()
    this.layoutTween = null
    this.isRelaxed = false
    this.hoverId = null
    this.selectedId = null
    this.focus = null
    this.userMovedCamera = false
    this.viewMemory = null
    this.guard.cancelAll()
    if (this.fitTimer) { clearTimeout(this.fitTimer); this.fitTimer = undefined }
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined }
    if (this.hoverInTimer) { clearTimeout(this.hoverInTimer); this.hoverInTimer = null }
    if (this.hoverOutTimer) { clearTimeout(this.hoverOutTimer); this.hoverOutTimer = null }
    this.applyFocus(null)
    this.labels.forEach((s) => { this.fg.scene().remove(s) }); this.labels.clear()
    this.nodes = []; this.links = []; this.byId.clear(); this.linkById.clear(); this.pair.clear(); this.adj.clear(); this.incident.clear()
    this.ambient.clear()
    this.maxDegree = 1
    this.hubDegreeThreshold = 1
    this.clearDecor()
    this.edgeRenderer.updateBase([], new Map(), new Map(), () => false, this.colorConfig())
    this.edgeRenderer.updateHighlight(null, new Map(), new Map(), this.colorConfig())
    this.fg.graphData({ nodes: [], links: [] })
    if (resetCamera) this.moveCamera('clear', { x: 0, y: 60, z: 520 }, { x: 0, y: 0, z: 0 }, 0, { force: true })
  }

  private register(n: GNode, born: number) {
    n.fx = n.x; n.fy = n.y; n.fz = n.z
    ;(n as any).__born = born
    this.nodes.push(n); this.byId.set(n.id, n)
    if (!this.adj.has(n.id)) this.adj.set(n.id, new Set())
    if (!this.incident.has(n.id)) this.incident.set(n.id, [])
  }
  private registerLink(l: GLink) {
    const s = typeof l.source === 'string' ? l.source : l.source.id
    const t = typeof l.target === 'string' ? l.target : l.target.id
    if (!this.byId.has(s) || !this.byId.has(t)) return
    this.links.push(l); this.linkById.set(l.id, l)
    this.pair.set(`${s}|${t}`, l.id); this.pair.set(`${t}|${s}`, l.id)
    this.adj.get(s)!.add(t); this.adj.get(t)!.add(s)
    this.incident.get(s)!.push(l.id); this.incident.get(t)!.push(l.id)

    const degS = this.adj.get(s)!.size
    const degT = this.adj.get(t)!.size
    if (degS > this.maxDegree) this.maxDegree = degS
    if (degT > this.maxDegree) this.maxDegree = degT

    if (this.opts.ambient && this.opts.quality === 'high' && (l.type === 'CALLS' || l.type === 'IMPORTS') && this.ambient.size < 36 && Math.random() < 0.25) this.ambient.add(l.id)
  }
  private commit() { this.fg.graphData({ nodes: this.nodes, links: this.links }) }

  // ------------------------------------------------------------------ appearance
  private nodeColor(n: GNode) { return this.colors.node[n.type] ?? typeColor(n.type) }
  private sizeOf(n: GNode) {
    const base = (3 + 15 * Math.sqrt(Math.max(n.score, 0))) * (TYPE_SIZE[n.type] ?? 1) * 1.3
    let s = Math.max(3.6, base)
    const deg = this.adj.get(n.id)?.size ?? 0
    const maxDeg = this.maxDegree || 1
    s *= 1 + 0.15 * (deg / maxDeg)
    return s
  }

  private makeNode(n: GNode): THREE.Object3D {
    const mat = new THREE.SpriteMaterial({
      map: this.nodeTex,
      color: this.nodeColor(n),
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      opacity: 0,
      fog: false, // Node material exempt from distance fog
    })
    const s = new THREE.Sprite(mat)
    s.scale.setScalar(0.001)
    s.userData = {
      base: this.sizeOf(n),
      col: new THREE.Color(this.nodeColor(n)),
      alpha: 0,
      flash: 0,
      important: IMPORTANT.has(n.type) || n.score > 0.38,
    }
    return s
  }

  private isHidden(n: GNode) {
    return this.hidden.types.has(n.type) || this.hidden.clusters.has(n.cluster) || (n.type !== 'Source' && n.score < this.hidden.minScore)
  }

  private colorConfig(): EdgeRendererColors {
    return {
      getNodeColor: (t: string) => this.colors.node[t] ?? typeColor(t),
      getEdgeColor: (t: string) => this.colors.edge[t] ?? '#4d6a88',
      bgColor: BG,
    }
  }

  private updateEdgeBase() {
    this.edgeRenderer.updateBase(
      this.links,
      this.byId,
      this.adj,
      (n) => this.isHidden(n),
      this.colorConfig(),
      this.emph ? this.emph.edges : undefined
    )
    this.edgeRenderer.updateHighlight(
      this.emph ? this.emph.edges : null,
      this.linkById,
      this.byId,
      this.colorConfig()
    )
  }

  // ------------------------------------------------------------------ emphasis & focus
  private neighborhood(id: string): Emphasis {
    const nodes = new Set<string>([id]); this.adj.get(id)?.forEach((x) => nodes.add(x))
    return { nodes, edges: new Set(this.incident.get(id) ?? []) }
  }

  applyFocus(emphasis: Emphasis | null) {
    // Guard: if no hover, no selection and no focus exist, force emphasis = null
    if (!this.hoverId && !this.selectedId && !this.focus) {
      emphasis = null
    }

    const prev = this.emph
    this.emph = emphasis

    if (emphasis === null) {
      this.targetFocusAmount = 0
      this.edgeRenderer.updateHighlight(null, this.linkById, this.byId, this.colorConfig())
    } else {
      this.targetFocusAmount = 1
      this.edgeRenderer.updateHighlight(emphasis.edges, this.linkById, this.byId, this.colorConfig())
    }

    if (prev !== this.emph) {
      this.logVisDebug('emphasis-change')
    }
  }

  private refreshEmphasis() {
    if (this.hoverId) {
      this.applyFocus(this.neighborhood(this.hoverId))
    } else if (this.focus) {
      this.applyFocus(this.focus)
    } else if (this.selectedId) {
      this.applyFocus(this.neighborhood(this.selectedId))
    } else {
      this.applyFocus(null)
    }
  }

  setSelected(id: string | null) {
    this.selectedId = id
    if (id === null) {
      // Cancel any in-flight programmatic camera move so it cannot re-set target
      this.guard.cancelAll()
      this.restoreViewOrReleasePivot()
      this.pauseRotate()
    } else {
      // Mark that we are about to move the camera programmatically
      this.userMovedCamera = false
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
      const c = this.fg.controls()
      if (c) c.autoRotate = false
    }
    this.refreshEmphasis()
  }

  setFocus(f: { nodes: Iterable<string>; edges: Iterable<string> } | null) {
    this.focus = f ? { nodes: new Set(f.nodes), edges: new Set(f.edges) } : null
    if (this.focus === null && this.selectedId === null) {
      this.releasePivot()
      this.pauseRotate()
    } else {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
      const c = this.fg.controls()
      if (c) c.autoRotate = false
    }
    this.refreshEmphasis()
  }

  clearFocusState() {
    this.hoverId = null
    this.selectedId = null
    this.focus = null
    this.guard.cancelAll()
    this.viewMemory = null
    if (this.hoverInTimer) { clearTimeout(this.hoverInTimer); this.hoverInTimer = null }
    if (this.hoverOutTimer) { clearTimeout(this.hoverOutTimer); this.hoverOutTimer = null }
    this.releasePivot()
    this.pauseRotate()
    this.applyFocus(null)
  }

  setFilters(types: Set<string>, clusters: Set<number>, minScore: number) {
    this.hidden = { types, clusters, minScore }
    if (this.selectedId) {
      const selNode = this.byId.get(this.selectedId)
      if (!selNode || this.isHidden(selNode)) {
        this.setSelected(null)
      }
    }
    this.updateGraphBounds()
    this.updateEdgeBase()
  }
  edgeBetween(a: string, b: string) { return this.pair.get(`${a}|${b}`) }
  hasNode(id: string) { return this.byId.has(id) }

  // ------------------------------------------------------------------ camera
  private handleUserInteraction() {
    this.isInteracting = true
    this.userMovedCamera = true
    this.viewMemory = null  // user navigated manually — don't restore on deselect
    this.guard.markUserInput()
    this.guard.cancelAll()
    if (this.fitTimer) {
      clearTimeout(this.fitTimer)
      this.fitTimer = undefined
    }

    const cam = this.fg.camera()
    const controls = this.fg.controls()
    if (cam && controls?.target) {
      this.fg.cameraPosition(
        { x: cam.position.x, y: cam.position.y, z: cam.position.z },
        { x: controls.target.x, y: controls.target.y, z: controls.target.z },
        0
      )
    }

    if (controls) {
      controls.autoRotate = false
    }
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  private pauseRotate() {
    const c = this.fg.controls(); if (!c) return
    c.autoRotate = false
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined

    if (!this.opts.autoRotate) return
    if (this.selectedId !== null || this.focus !== null) return

    this.idleTimer = setTimeout(() => {
      if (this.disposed) return
      const controls = this.fg.controls()
      if (!controls) return
      if (this.selectedId === null && this.focus === null && this.opts.autoRotate) {
        if (!this.guard.userActiveWithin(7000)) {
          controls.autoRotate = true
        }
      }
    }, 7000)
  }

  setAutoRotate(on: boolean) {
    this.opts.autoRotate = on
    const c = this.fg.controls()
    if (!on) {
      if (c) c.autoRotate = false
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    } else {
      this.pauseRotate()
    }
  }

  moveCamera(
    reason: string,
    toPos: Vec3,
    lookAt: Vec3,
    ms = 700,
    opts: { force?: boolean } = {}
  ) {
    const force = opts.force ?? false
    const userActiveMs = this.guard.getUserActiveMs()
    const userActive = this.guard.userActiveWithin(1500)

    if (!shouldRunMove(userActiveMs, force, true)) {
      this.logCamDebug('moveCamera skipped (user active)', { reason, force, userActiveMs })
      return
    }

    const token = this.guard.begin()
    this.pauseRotate()

    const cam = this.fg.camera() as THREE.PerspectiveCamera
    this.logCamDebug('moveCamera start', {
      reason,
      forced: force,
      token,
      userActiveWithin: userActive,
      from: cam ? { x: cam.position.x, y: cam.position.y, z: cam.position.z } : null,
      to: toPos,
      lookAt,
      ms,
    })

    if (!this.guard.isCurrent(token)) return

    this.fg.cameraPosition(toPos, lookAt, ms)

    if (ms > 0) {
      setTimeout(() => {
        if (!this.guard.isCurrent(token)) {
          this.logCamDebug('moveCamera cancelled in flight', { reason, token })
          return
        }
        this.logCamDebug('moveCamera completed', { reason, token })
      }, ms)
    }
  }

  flyTo(id: string, dist = 120, ms = 1100, opts: { force?: boolean } = { force: true }) {
    const n = this.byId.get(id); if (!n) return

    // Save the current camera state before flying — used to restore on deselect
    // only if the user hasn't manually navigated away in the meantime.
    const cam = this.fg.camera() as THREE.PerspectiveCamera
    const controls = this.fg.controls()
    if (cam && controls?.target && !this.userMovedCamera) {
      this.viewMemory = {
        pos: cam.position.clone(),
        target: controls.target.clone(),
      }
    }

    const v = new THREE.Vector3(n.x, n.y, n.z)
    const dir = v.lengthSq() < 1 ? new THREE.Vector3(0, 0, 1) : v.clone().normalize()
    this.moveCamera(
      `flyTo:${id}`,
      { x: n.x + dir.x * dist, y: n.y + dir.y * dist + 12, z: n.z + dir.z * dist },
      { x: n.x, y: n.y, z: n.z },
      ms,
      opts
    )
  }

  fitTo(ids: string[], ms = 1100, opts: { force?: boolean } = { force: false }) {
    const pts = ids.map((i) => this.byId.get(i)).filter(Boolean) as GNode[]
    if (!pts.length) return
    const c = new THREE.Vector3()
    pts.forEach((p) => c.add(new THREE.Vector3(p.x, p.y, p.z))); c.divideScalar(pts.length)
    let r = 0; pts.forEach((p) => { r = Math.max(r, c.distanceTo(new THREE.Vector3(p.x, p.y, p.z))) })
    const dir = c.lengthSq() < 1 ? new THREE.Vector3(0, 0, 1) : c.clone().normalize()
    const d = Math.max(90, r * 2.4 + 60)
    this.moveCamera(
      `fitTo:${ids.length}nodes`,
      { x: c.x + dir.x * d, y: c.y + dir.y * d + 14, z: c.z + dir.z * d },
      { x: c.x, y: c.y, z: c.z },
      ms,
      opts
    )
  }

  private updateGraphBounds() {
    const visibleNodes = this.nodes.filter((n) => !this.isHidden(n))
    if (visibleNodes.length === 0) {
      this.lastCenter.set(0, 0, 0)
      this.lastBoundingRadius = 100
      return
    }
    const center = new THREE.Vector3()
    visibleNodes.forEach((n) => center.add(new THREE.Vector3(n.x, n.y, n.z)))
    center.divideScalar(visibleNodes.length)
    this.lastCenter.copy(center)

    let radius = 0
    visibleNodes.forEach((n) => {
      const d = center.distanceTo(new THREE.Vector3(n.x, n.y, n.z))
      if (d > radius) radius = d
    })
    this.lastBoundingRadius = Math.max(radius, 25)

    const controls = this.fg.controls()
    if (controls) {
      controls.maxDistance = Math.max(2600, this.lastBoundingRadius * 6)
    }
  }

  /**
   * On deselect: if the user has NOT manually moved the camera since flyTo was called,
   * smoothly fly back to the saved view. Otherwise just release the pivot in-place.
   */
  private restoreViewOrReleasePivot() {
    const mem = this.viewMemory
    const doRestore = shouldRestore(
      mem !== null,
      this.userMovedCamera,
      this.guard.getUserActiveMs(),
      2000
    )
    if (doRestore && mem) {
      // Fly back to saved camera position, restoring the original pivot too
      const token = this.guard.begin()
      const controls = this.fg.controls()
      if (controls) {
        // Restore target immediately so post-tween orbit pivots correctly
        controls.target.copy(mem.target)
        controls.update()
      }
      this.fg.cameraPosition(
        { x: mem.pos.x, y: mem.pos.y, z: mem.pos.z },
        { x: mem.target.x, y: mem.target.y, z: mem.target.z },
        700
      )
      setTimeout(() => {
        if (!this.guard.isCurrent(token)) return
        this.logCamDebug('restoreView completed', { token })
        this.viewMemory = null
      }, 710)
    } else {
      // User moved the camera — just fix the pivot in-place
      this.releasePivot()
      this.viewMemory = null
    }
  }

  releasePivot() {
    const controls = this.fg.controls()
    const cam = this.fg.camera() as THREE.PerspectiveCamera
    if (!controls || !cam) return

    const camPos = cam.position
    const forward = new THREE.Vector3()
    cam.getWorldDirection(forward)

    const minDist = controls.minDistance || 15
    const maxDist = controls.maxDistance || Math.max(2600, this.lastBoundingRadius * 6)

    const newTarget = releasePivot(
      { x: camPos.x, y: camPos.y, z: camPos.z },
      { x: forward.x, y: forward.y, z: forward.z },
      { x: this.lastCenter.x, y: this.lastCenter.y, z: this.lastCenter.z },
      minDist,
      maxDist
    )

    controls.target.set(newTarget.x, newTarget.y, newTarget.z)
    controls.update()
    this.logCamDebug('releasePivot', { newTarget, graphCenter: this.lastCenter })
  }

  resetPivotToCentre() {
    const controls = this.fg.controls()
    if (controls) {
      controls.target.copy(this.lastCenter)
      controls.update()
      this.logCamDebug('resetPivotToCentre', { center: this.lastCenter })
    }
  }

  restoreView() {
    this.clearFocusState()
    this.releasePivot()
    this.frameGraph(700, { force: true })
  }

  frameGraph(ms = 700, opts: { force?: boolean } = {}) {
    const force = opts.force ?? false
    if (!force && (this.emph !== null || this.hoverId !== null || this.selectedId !== null || this.focus !== null)) {
      return
    }

    const visibleNodes = this.nodes.filter((n) => !this.isHidden(n))
    if (visibleNodes.length === 0) return

    this.updateGraphBounds()
    const center = this.lastCenter.clone()
    const radius = this.lastBoundingRadius

    const cam = this.fg.camera() as THREE.PerspectiveCamera
    const fovRad = ((cam.fov || 50) * Math.PI) / 180
    const w = this.el.clientWidth || window.innerWidth || 800
    const h = this.el.clientHeight || window.innerHeight || 600
    const aspect = w / h
    const halfFov = aspect < 1 ? Math.atan(Math.tan(fovRad / 2) * aspect) : fovRad / 2
    const distance = (radius / Math.sin(halfFov)) * 1.15

    const currentPos = cam.position.clone()
    let dir = currentPos.clone().sub(center)
    if (dir.lengthSq() < 1) {
      dir = new THREE.Vector3(0, 60, 520)
    }
    dir.normalize()

    const targetPos = center.clone().add(dir.multiplyScalar(distance))
    this.moveCamera(
      'frameGraph',
      { x: targetPos.x, y: targetPos.y, z: targetPos.z },
      { x: center.x, y: center.y, z: center.z },
      ms,
      opts
    )
    this.userMovedCamera = false

    this.logVisDebug('fit')
  }

  fit(ms = 900, _pad = 50) {
    this.clearFocusState()
    this.resetPivotToCentre()
    this.frameGraph(ms, { force: true })
  }

  private scheduleFit(delay: number) {
    clearTimeout(this.fitTimer)
    this.fitTimer = setTimeout(() => {
      if (!this.disposed && this.nodes.length && !this.userMovedCamera) {
        this.frameGraph(700, { force: false })
      }
    }, delay)
  }

  private logCamDebug(action: string, details: Record<string, any>) {
    if (typeof window !== 'undefined' && window.location?.search?.includes('debug=cam')) {
      console.log(`[NexMind:cam ${action}]`, details)
    }
  }

  /** Place the camera on a sphere around the origin (used by the landing page's scroll-driven hero). */
  orbit(angle: number, elevation: number, dist: number) {
    this.fg.cameraPosition({ x: Math.sin(angle) * Math.cos(elevation) * dist, y: Math.sin(elevation) * dist, z: Math.cos(angle) * Math.cos(elevation) * dist }, { x: 0, y: 0, z: 0 }, 0)
  }
  pause() { try { this.fg.pauseAnimation() } catch { /* ignore */ } }
  resume() { try { this.fg.resumeAnimation() } catch { /* ignore */ } }
  getPointer() { return { ...this.pointer } }
  screenPos(id: string): { x: number; y: number } | null {
    const n = this.byId.get(id); if (!n) return null
    try { const p = this.fg.graph2ScreenCoords(n.x, n.y, n.z); return { x: p.x, y: p.y } } catch { return null }
  }

  // ------------------------------------------------------------------ diagnostics
  private logVisDebug(trigger: string) {
    if (typeof window === 'undefined' || !window.location.search.includes('debug=vis')) return
    const cam = this.fg.camera() as THREE.PerspectiveCamera
    const camDist = cam.position.distanceTo(this.lastCenter)
    const fogDensity = (this.fg.scene().fog as THREE.FogExp2)?.density ?? 0
    const emphSize = this.emph ? this.emph.nodes.size : 0
    const baseEdgeOp = this.edgeRenderer.getBaseOpacity()
    console.log(`[NexMind:vis ${trigger}]`, {
      cameraDistance: Number(camDist.toFixed(1)),
      graphBoundingRadius: Number(this.lastBoundingRadius.toFixed(1)),
      fogDensity,
      emphasisSize: emphSize,
      baseEdgeOpacity: Number(baseEdgeOp.toFixed(3)),
      minOnScreenNodePx: '6px (hubs: 9px)',
    })
  }

  // ------------------------------------------------------------------ effects
  flash(id: string, strength = 1) {
    const o = (this.byId.get(id) as any)?.__threeObj as THREE.Sprite | undefined
    if (o) o.userData.flash = Math.max(o.userData.flash, strength)
  }
  ring(id: string, max = 70, dur = 1100, color?: string) {
    const n = this.byId.get(id); if (!n) return
    const mat = new THREE.SpriteMaterial({ map: this.ringTex, color: color ?? this.nodeColor(n), transparent: true, depthWrite: false, blending: THREE.NormalBlending, opacity: 0.9 })
    const s = new THREE.Sprite(mat); s.position.set(n.x, n.y, n.z); s.scale.setScalar(1)
    this.fg.scene().add(s)
    this.rings.push({ sprite: s, t0: performance.now(), dur, max })
  }
  /** Neural activation: nodes fire in order, hits send out a shock ring. */
  ripple(items: { id: string; delay_ms: number; hit?: boolean }[]) {
    items.slice(0, 120).forEach((it) => this.later(it.delay_ms, () => { this.flash(it.id, 1); if (it.hit) this.ring(it.id, 55, 1000) }))
  }
  /** Concentric shock-wave rings by depth for impact analysis. */
  shockwave(originId: string, depthIds: string[][]) {
    this.ring(originId, 95, 1500, '#ff7c93')
    depthIds.forEach((ids, d) => ids.slice(0, 60).forEach((id) => this.later(260 * (d + 1), () => { this.flash(id, 1); if (d < 2) this.ring(id, 38, 900, '#ffc970') })))
  }
  /** A pulse that walks a list of nodes (trace and flow player). Returns a cancel function. */
  playPath(ids: string[], onStep?: (i: number, edgeId?: string) => void, stepMs = 700, onEnd?: () => void): () => void {
    this.cancelPath()
    let cancelled = false
    const done = new Set<string>(); const edges = new Set<string>()
    ids.forEach((id, i) => {
      const t = setTimeout(() => {
        if (cancelled || this.disposed) return
        done.add(id)
        const prev = ids[i - 1]
        const eid = prev ? this.edgeBetween(prev, id) : undefined
        if (eid) edges.add(eid)
        this.flash(id, 1.2); this.ring(id, 42, 800)
        this.setFocus({ nodes: done, edges })
        onStep?.(i, eid)
        if (i === ids.length - 1) { this.pathCancel = null; onEnd?.() }
      }, i * stepMs)
      this.timers.add(t)
    })
    this.pathCancel = () => { cancelled = true }
    return this.pathCancel
  }
  cancelPath() { this.pathCancel?.(); this.pathCancel = null }
  private later(ms: number, fn: () => void) {
    const t = setTimeout(() => { this.timers.delete(t); if (!this.disposed) fn() }, ms)
    this.timers.add(t)
  }

  setGlow(v: number) {
    this.opts.glow = v
    const low = this.opts.quality === 'low'
    if (v > 0 && !low) {
      const strength = Math.min(v, MAX_GLOW_STRENGTH)
      if (!this.bloom) {
        try {
          const composer = this.fg.postProcessingComposer()
          this.bloom = new UnrealBloomPass(
            new THREE.Vector2(this.el.clientWidth || 800, this.el.clientHeight || 600),
            strength,
            GLOW_RADIUS,
            GLOW_THRESHOLD
          )
          if (this.outputPass && composer.passes.includes(this.outputPass)) {
            const idx = composer.passes.indexOf(this.outputPass)
            composer.passes.splice(idx, 0, this.bloom)
          } else {
            composer.addPass(this.bloom)
          }
        } catch {
          this.bloom = null
        }
      } else {
        this.bloom.strength = strength
        this.bloom.radius = GLOW_RADIUS
        this.bloom.threshold = GLOW_THRESHOLD
        this.bloom.enabled = true
      }
    } else {
      if (this.bloom) {
        this.bloom.enabled = false
      }
    }
  }

  setQuality(q: 'high' | 'low') {
    this.opts.quality = q
    const low = q === 'low'
    if (this.bloom) this.bloom.enabled = !low && (this.opts.glow > 0)
    this.fg.renderer().setPixelRatio(Math.min(window.devicePixelRatio || 1, low ? 1.25 : 2))
    this.updateEdgeBase()
  }

  // ------------------------------------------------------------------ decor (nebulae, cluster names, dust)
  private addDust() {
    const n = this.opts.quality === 'low' ? 500 : 1600
    const pos = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const r = 250 + Math.random() * 900, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1)
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th); pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th); pos[i * 3 + 2] = r * Math.cos(ph)
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const m = new THREE.PointsMaterial({ map: this.nebulaTex, size: 5, color: '#7aa8d6', transparent: true, opacity: DUST_OPACITY, depthWrite: false, blending: THREE.NormalBlending, sizeAttenuation: true })
    this.dust = new THREE.Points(g, m)
    this.fg.scene().add(this.dust)
  }
  private clearDecor() {
    this.decor.forEach((o) => { this.fg.scene().remove(o) }); this.decor = []
    this.clusterLabels.forEach((c) => this.fg.scene().remove(c.sprite)); this.clusterLabels = []
  }
  private rebuildDecor() {
    this.clearDecor()
    const groups = new Map<number, GNode[]>()
    this.nodes.forEach((n) => { if (n.cluster && n.type !== 'Process') (groups.get(n.cluster) ?? groups.set(n.cluster, []).get(n.cluster)!).push(n) })
    for (const c of this.clusters) {
      const ms = groups.get(c.id); if (!ms || ms.length < 3) continue
      const ctr = new THREE.Vector3(); ms.forEach((m) => ctr.add(new THREE.Vector3(m.x, m.y, m.z))); ctr.divideScalar(ms.length)
      let rms = 0; ms.forEach((m) => { rms += ctr.distanceToSquared(new THREE.Vector3(m.x, m.y, m.z)) }); rms = Math.sqrt(rms / ms.length)
      const mat = new THREE.SpriteMaterial({ map: this.nebulaTex, color: c.color, transparent: true, opacity: CLUSTER_HAZE_OPACITY, depthWrite: false, blending: THREE.NormalBlending })
      const neb = new THREE.Sprite(mat); neb.position.copy(ctr); neb.scale.setScalar(Math.max(60, rms * 4.2)); neb.renderOrder = -1
      this.fg.scene().add(neb); this.decor.push(neb)
      if (this.opts.labels) {
        // Bright pastel cluster label
        const lab = labelSprite(c.label, pastelClusterColor(c.color), true)
        lab.position.copy(ctr).add(new THREE.Vector3(0, rms * 0.9 + 10, 0))
        this.fg.scene().add(lab); this.clusterLabels.push({ sprite: lab, pos: lab.position })
      }
    }
  }

  // ------------------------------------------------------------------ frame loop
  private tick = () => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.tick)
    const t = performance.now()
    const dt = Math.min(0.05, (t - this.last) / 1000); this.last = t
    this.watchFps(dt)

    // Advance edge opacity tween
    this.edgeRenderer.tick(dt)

    // Advance layout relaxation tween (streamed graph_ready 700ms tween)
    if (this.layoutTween) {
      const elapsed = t - this.layoutTween.start
      const p = clamp(elapsed / this.layoutTween.dur, 0, 1)
      const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2

      for (const n of this.nodes) {
        const o = this.layoutTween.oldPos.get(n.id)
        const tg = this.layoutTween.targetPos.get(n.id)
        if (!o || !tg) continue
        n.x = o.x + (tg.x - o.x) * ease
        n.y = o.y + (tg.y - o.y) * ease
        n.z = o.z + (tg.z - o.z) * ease
        n.fx = n.x; n.fy = n.y; n.fz = n.z
        const obj = (n as any).__threeObj as THREE.Object3D | undefined
        if (obj) obj.position.set(n.x, n.y, n.z)
      }

      if (p >= 0.5 && !this.layoutTween.midpointFired) {
        this.layoutTween.midpointFired = true
        this.updateEdgeBase()
      }

      if (p >= 1) {
        this.layoutTween = null
        this.updateEdgeBase()
        this.rebuildDecor()
        this.updateGraphBounds()
        // Reset emphasis guard after relayout/relax finishes
        if (!this.hoverId && !this.selectedId && !this.focus) {
          this.applyFocus(null)
        }
        if (!this.userMovedCamera && this.nodes.length > 0) {
          this.frameGraph(700, { force: false })
        }
      }
    }

    const cam = this.fg.camera() as THREE.PerspectiveCamera
    const camPos = cam.position as THREE.Vector3
    const fovRad = ((cam.fov || 50) * Math.PI) / 180
    const tanHalfFov = Math.tan(fovRad / 2)
    const vh = this.el.clientHeight || window.innerHeight || 600
    const k = (2 * tanHalfFov) / vh

    // 160 ms ease for focus fade
    const focusStep = dt / 0.16
    this.focusAmount += (this.targetFocusAmount - this.focusAmount) * Math.min(1, focusStep * 4)

    const emph = this.emph
    // Neighbour labels appear (max 12), everything else unlabelled
    let labelBudget = emph ? 12 : 4

    for (const n of this.nodes) {
      const o = (n as any).__threeObj as THREE.Sprite | undefined; if (!o) continue
      const ud = o.userData
      const hidden = this.isHidden(n)
      const age = (t - ((n as any).__born ?? 0)) / 1000
      const grow = age <= 0 ? 0 : easeOutBack(clamp(age / 0.75, 0, 1))
      ud.flash = Math.max(0, ud.flash - dt * 1.3)

      // Screen-space floor:
      // worldSize = max(baseWorldSize, cameraDistance * 2 * tan(fov/2) * minPx / viewportHeight)
      const deg = this.adj.get(n.id)?.size ?? 0
      const isHub = deg >= this.hubDegreeThreshold
      const minPx = isHub ? 9 : 6
      const camDist = this._tempVec.set(n.x, n.y, n.z).distanceTo(camPos)
      const minWorldSize = camDist * k * minPx
      const effBase = Math.max(ud.base, minWorldSize)

      // Node opacity:
      // Rest: solid core at opacity 0.92
      // Focused: hovered/selected node + direct neighbours stay 0.92; other nodes drop to 0.08
      const isFocusedNode = emph ? emph.nodes.has(n.id) : false
      const restAlpha = hidden ? 0 : NODE_CORE_OPACITY
      const focusedAlpha = hidden ? 0 : (isFocusedNode ? NODE_CORE_OPACITY : 0.08)
      const targetAlpha = restAlpha + (focusedAlpha - restAlpha) * this.focusAmount
      ud.alpha += (targetAlpha - ud.alpha) * Math.min(1, dt * 12)

      const lit = isFocusedNode
      const isSel = n.id === this.selectedId
      const isHov = n.id === this.hoverId
      // Hovered node scales 1.25x
      const boost = isHov ? 1.25 : (isSel ? 1.35 : (lit && emph!.nodes.size < 300 ? 1.15 : 1))
      const s = Math.max(0.001, effBase * grow * boost * (1 + ud.flash * 1.2))
      o.scale.set(s, s, 1)

      const mat = o.material as THREE.SpriteMaterial
      mat.opacity = ud.alpha * clamp(0.35 + grow, 0, 1)

      let whiteLerp = 0
      if (isHov || isSel) {
        whiteLerp = Math.max(whiteLerp, NODE_HIGHLIGHT_WHITE_LERP)
      }
      if (ud.flash > 0.02) {
        whiteLerp = Math.max(whiteLerp, Math.min(NODE_HIGHLIGHT_WHITE_LERP, ud.flash * NODE_HIGHLIGHT_WHITE_LERP))
      }
      mat.color.copy(ud.col)
      if (whiteLerp > 0) {
        mat.color.lerp(new THREE.Color('#ffffff'), whiteLerp)
      }
      o.visible = mat.opacity > 0.015

      // Labels:
      // When focused: neighbour labels appear (max 12), everything else unlabelled
      // When rest: important nodes within 300px
      if (this.opts.labels && o.visible) {
        const canLabel = emph ? isFocusedNode : (ud.important || isHov || isSel)
        if (canLabel) {
          const d = camDist
          let lab = this.labels.get(n.id)
          if (d < 450 && !lab && labelBudget > 0) {
            lab = labelSprite(n.label, '#F4F7FF', false)
            lab.position.set(n.x, n.y - (effBase * 0.75 + 5), n.z)
            this.fg.scene().add(lab); this.labels.set(n.id, lab); labelBudget--
          }
          if (lab) {
            const want = d < 450 ? clamp((450 - d) / 180, 0, 1) * ud.alpha : 0
            const m = lab.material as THREE.SpriteMaterial
            m.opacity += (want - m.opacity) * Math.min(1, dt * 8); lab.visible = m.opacity > 0.02
          }
        } else {
          const lab = this.labels.get(n.id)
          if (lab) { const m = lab.material as THREE.SpriteMaterial; m.opacity += (0 - m.opacity) * Math.min(1, dt * 10); lab.visible = m.opacity > 0.02 }
        }
      } else {
        const lab = this.labels.get(n.id)
        if (lab) { const m = lab.material as THREE.SpriteMaterial; m.opacity += (0 - m.opacity) * Math.min(1, dt * 10); lab.visible = m.opacity > 0.02 }
      }
    }

    // Fade cluster nebulae during focus
    for (const o of this.decor) {
      const m = (o as THREE.Sprite).material as THREE.SpriteMaterial
      const targetOp = this.emph ? 0.005 : CLUSTER_HAZE_OPACITY
      m.opacity += (targetOp - m.opacity) * Math.min(1, dt * 8)
    }

    // Cluster names: pastel of cluster hue
    for (const c of this.clusterLabels) {
      const d = cam.position.distanceTo(c.pos)
      const m = c.sprite.material as THREE.SpriteMaterial
      m.opacity = clamp((d - 140) / 220, 0, 0.8) * (this.emph ? 0.35 : 1)
      c.sprite.visible = m.opacity > 0.02
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i]; const p = (t - r.t0) / r.dur
      if (p >= 1) { this.fg.scene().remove(r.sprite); (r.sprite.material as THREE.Material).dispose(); this.rings.splice(i, 1); continue }
      r.sprite.scale.setScalar(4 + r.max * (1 - Math.pow(1 - p, 3)))
      ;(r.sprite.material as THREE.SpriteMaterial).opacity = 0.9 * (1 - p)
    }
    if (this.dust) this.dust.rotation.y += dt * 0.012
  }

  private watchFps(dt: number) {
    if (this.lowFpsFired || this.opts.quality === 'low') return
    this.frames.push(dt)
    if (this.frames.length > 120) {
      const avg = this.frames.reduce((a, b) => a + b, 0) / this.frames.length
      this.frames = []
      if (avg > 1 / 22 && document.visibilityState === 'visible') { this.lowFpsFired = true; this.ev.onLowFps?.() }
    }
  }

  private resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight
    if (w < 10 || h < 10) return
    this.fg.width(w).height(h)
    this.bloom?.setSize(w, h)
    this.edgeRenderer.setResolution(w, h)
    if (!this.userMovedCamera && this.nodes.length > 0) {
      this.frameGraph(700, { force: false })
    }
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    if (this.hoverInTimer) clearTimeout(this.hoverInTimer)
    if (this.hoverOutTimer) clearTimeout(this.hoverOutTimer)
    if (this.pickThrottleTimer) clearTimeout(this.pickThrottleTimer)
    if (this.fitTimer) clearTimeout(this.fitTimer)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.timers.forEach((t) => clearTimeout(t)); this.timers.clear()
    this.ro.disconnect()
    this.el.removeEventListener('pointermove', this.onMove)
    this.el.removeEventListener('wheel', this.onUserActivity)
    this.el.removeEventListener('pointerdown', this.onUserActivity)
    this.edgeRenderer.dispose(this.fg.scene())
    try { this.fg.pauseAnimation(); this.fg._destructor?.() } catch { /* already gone */ }
    this.outputPass?.dispose()
    this.bloom?.dispose()
    this.nodeTex.dispose(); this.ringTex.dispose(); this.nebulaTex.dispose()
    this.el.innerHTML = ''
  }
}
