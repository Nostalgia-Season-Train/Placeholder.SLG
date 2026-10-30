import * as THREE from 'three'
import type { View } from './scene'
import type { Cluster, World } from './world'

/**
 * 输入层：把鼠标与键盘翻译成「选中集群」「下达订单」「移动镜头」。
 * 只改动 Cluster.order，不直接改坦克。
 */
export class Controls {
  readonly selected = new Set<Cluster>()

  private ray = new THREE.Raycaster()
  private ndc = new THREE.Vector2()
  private keys = new Set<string>()

  constructor(private view: View, private world: World) {
    const dom = view.renderer.domElement
    dom.addEventListener('contextmenu', (e) => e.preventDefault())
    dom.addEventListener('pointerdown', (e) => this.onDown(e))
    dom.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        this.view.zoom(e.deltaY)
      },
      { passive: false },
    )
    addEventListener('keydown', (e) => this.keys.add(e.key.toLowerCase()))
    addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()))
  }

  update(dt: number) {
    const speed = 45 * dt
    let dx = 0
    let dz = 0
    if (this.keys.has('a') || this.keys.has('arrowleft')) dx -= 1
    if (this.keys.has('d') || this.keys.has('arrowright')) dx += 1
    if (this.keys.has('w') || this.keys.has('arrowup')) dz -= 1
    if (this.keys.has('s') || this.keys.has('arrowdown')) dz += 1
    if (dx !== 0 || dz !== 0) this.view.pan(dx * speed, dz * speed)
  }

  private onDown(e: PointerEvent) {
    if (e.button === 0) {
      const tank = this.pickTank(e)
      if (!tank || tank.side !== 'blue') {
        if (!e.shiftKey) this.selected.clear()
        return
      }
      const cluster = this.world.clusters.find((c) => c.side === tank.side && c.index === tank.cluster)
      if (!cluster) return
      if (e.shiftKey) {
        if (this.selected.has(cluster)) this.selected.delete(cluster)
        else this.selected.add(cluster)
      } else {
        this.selected.clear()
        this.selected.add(cluster)
      }
    } else if (e.button === 2) {
      const p = this.groundPoint(e)
      if (!p) return
      for (const c of this.selected) c.order = { x: p.x, z: p.z }
    }
  }

  private aim(e: PointerEvent) {
    this.ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1)
    this.ray.setFromCamera(this.ndc, this.view.camera)
  }

  private pickTank(e: PointerEvent) {
    this.aim(e)
    const hits = this.ray.intersectObjects(this.view.pickables, true)
    const hit = hits.find((h) => h.object.userData.tankId !== undefined)
    if (!hit) return null
    return this.world.tanks[hit.object.userData.tankId as number]
  }

  private groundPoint(e: PointerEvent) {
    this.aim(e)
    const hit = this.ray.intersectObject(this.view.ground)[0]
    return hit ? { x: hit.point.x, z: hit.point.z } : null
  }
}
