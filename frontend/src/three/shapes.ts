import * as THREE from 'three'
import type { GNode } from '@/lib/types'

export class BatchedNodes {
  mesh: THREE.InstancedMesh
  private dummy = new THREE.Object3D()
  private color = new THREE.Color()

  constructor(scene: THREE.Scene, capacity: number) {
    const geo = new THREE.SphereGeometry(1, capacity > 1500 ? 12 : 16, capacity > 1500 ? 8 : 12)
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.05 })
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    if (this.mesh.instanceColor) this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
    scene.add(this.mesh)
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.mesh)
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
    this.mesh.dispose()
  }

  update(nodes: GNode[], getScale: (n: GNode) => number, getColor: (n: GNode) => string, getOpacity: (n: GNode) => number) {
    this.mesh.count = nodes.length
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      const s = getScale(n)
      this.dummy.position.set((n as any).x || 0, (n as any).y || 0, (n as any).z || 0)
      this.dummy.scale.set(s, s, s)
      this.dummy.updateMatrix()
      this.mesh.setMatrixAt(i, this.dummy.matrix)
      
      const col = getColor(n)
      this.color.set(col)
      // fake opacity by lerping toward background, since instanced mesh standard mat is typically opaque
      // or we can just let engine set transparent: true on mat if needed. Let's lerp to bg.
      const bg = new THREE.Color(document.documentElement.dataset.theme === 'light' ? '#F4F5F8' : '#07090D')
      const op = getOpacity(n)
      if (op < 1) {
        this.color.lerp(bg, 1 - op)
      }
      this.mesh.setColorAt(i, this.color)
    }
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }
}
