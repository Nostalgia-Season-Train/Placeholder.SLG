import * as THREE from 'three'
import { MAP } from './config'
import type { Cluster, Tank, World } from './world'

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/**
 * 渲染层：只读取 World 做呈现，不写任何游戏状态。
 * 换渲染方案时只改这个文件。
 */
export class View {
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly renderer: THREE.WebGLRenderer
  readonly ground: THREE.Mesh
  /** 供拾取使用的坦克对象 */
  readonly pickables: THREE.Object3D[] = []

  private units = new Map<number, THREE.Group>()
  private rings: THREE.Mesh[] = []
  private tracers: THREE.LineSegments
  private tracerPos: Float32Array
  private camDir = new THREE.Vector3(0, 0.95, 0.85).normalize()
  private camTarget = new THREE.Vector3(0, 0, 0)
  private camDist = 112

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.setSize(innerWidth, innerHeight)
    this.renderer.setClearColor(0x0b0e11)
    container.appendChild(this.renderer.domElement)

    this.scene.fog = new THREE.Fog(0x0b0e11, 170, 280)
    this.camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 1, 600)

    this.scene.add(new THREE.HemisphereLight(0xdff0ff, 0x1a1f24, 1.1))
    const sun = new THREE.DirectionalLight(0xffffff, 1.5)
    sun.position.set(40, 90, 50)
    this.scene.add(sun)

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(MAP, MAP),
      new THREE.MeshStandardMaterial({ color: 0x161c22, roughness: 1 }),
    )
    this.ground.rotation.x = -Math.PI / 2
    this.scene.add(this.ground)

    const grid = new THREE.GridHelper(MAP, MAP / 10, 0x2c3742, 0x1d252d)
    grid.position.y = 0.02
    this.scene.add(grid)

    const ringGeo = new THREE.RingGeometry(5.2, 5.8, 40)
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x7fe3ff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
    })
    for (let i = 0; i < 6; i++) {
      const ring = new THREE.Mesh(ringGeo, ringMat)
      ring.rotation.x = -Math.PI / 2
      ring.position.y = 0.05
      ring.visible = false
      this.scene.add(ring)
      this.rings.push(ring)
    }

    const cap = 600
    this.tracerPos = new Float32Array(cap * 3)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.tracerPos, 3))
    this.tracers = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9 }),
    )
    this.tracers.frustumCulled = false
    this.scene.add(this.tracers)

    addEventListener('resize', () => this.resize())
    this.resize()
    this.updateCamera()
  }

  private makeUnit(tank: Tank) {
    const g = new THREE.Group()
    const bodyColor = tank.side === 'red' ? 0xb8484e : 0x3f76c9
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(2.6, 1.1, 3.6),
      new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.65 }),
    )
    body.position.y = 0.55

    const turret = new THREE.Mesh(
      new THREE.BoxGeometry(1.7, 0.7, 1.7),
      new THREE.MeshStandardMaterial({ color: 0x2b3238, roughness: 0.55 }),
    )
    turret.position.set(0, 1.35, 0.1)

    const barrel = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.34, 2.5),
      new THREE.MeshStandardMaterial({ color: 0x1c2126, roughness: 0.5 }),
    )
    barrel.position.set(0, 1.35, 2.1)

    g.add(body, turret, barrel)
    g.traverse((o) => (o.userData.tankId = tank.id))
    return g
  }

  /** 把 World 的当前状态同步到场景 */
  sync(world: World, selected: Set<Cluster>) {
    for (const t of world.tanks) {
      let g = this.units.get(t.id)
      if (!g) {
        g = this.makeUnit(t)
        this.scene.add(g)
        this.units.set(t.id, g)
        this.pickables.push(g)
      }
      g.visible = t.alive
      g.position.set(t.x, 0, t.z)
      g.rotation.y = t.dir
    }

    for (const ring of this.rings) ring.visible = false
    let ri = 0
    for (const c of selected) {
      if (ri >= this.rings.length) break
      const center = world.centroid(c)
      if (!center) continue
      const ring = this.rings[ri++]
      ring.position.set(center.x, 0.05, center.z)
      ring.visible = true
    }

    let n = 0
    for (const s of world.shots) {
      if (n + 6 > this.tracerPos.length) break
      this.tracerPos[n++] = s.x1
      this.tracerPos[n++] = 1.3
      this.tracerPos[n++] = s.z1
      this.tracerPos[n++] = s.x2
      this.tracerPos[n++] = 1.3
      this.tracerPos[n++] = s.z2
    }
    const attr = this.tracers.geometry.getAttribute('position') as THREE.BufferAttribute
    attr.needsUpdate = true
    this.tracers.geometry.setDrawRange(0, n / 3)
  }

  render() {
    this.updateCamera()
    this.renderer.render(this.scene, this.camera)
  }

  zoom(deltaY: number) {
    this.camDist = clamp(this.camDist + deltaY * 0.08, 60, 220)
  }

  pan(dx: number, dz: number) {
    const limit = MAP / 2
    this.camTarget.x = clamp(this.camTarget.x + dx, -limit, limit)
    this.camTarget.z = clamp(this.camTarget.z + dz, -limit, limit)
  }

  private updateCamera() {
    this.camera.position.copy(this.camTarget).addScaledVector(this.camDir, this.camDist)
    this.camera.lookAt(this.camTarget)
  }

  private resize() {
    this.camera.aspect = innerWidth / innerHeight
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(innerWidth, innerHeight)
  }
}
