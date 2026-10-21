import * as THREE from 'three'
import { FACTION_NAMES, type BaseCity, type Faction, type GeneralState } from '../bot/types'
import { AgentLayer, type WorldPosition } from './AgentLayer'
import { CityLayer } from './CityLayer'
import { hexCornerPoints, tileKey } from './hex'
import { generateMap, type MapData } from './MapGenerator'
import { RiverLayer } from './RiverLayer'
import { RoadLayer } from './RoadLayer'
import { TerrainLayer } from './TerrainLayer'
import { getTerrainLevel } from './terrainLevels'

export interface HoverCity {
  name: string
  faction: Faction
  factionName: string
}

export interface HoverInfo {
  q: number
  r: number
  level: number
  name: string
  desc: string
  height: number
  isBank: boolean
  city?: HoverCity | null
}

export interface MapReadyStats {
  tiles: number
  seed: number
}

export interface MapRendererOptions {
  seed?: number
  onHover?: (info: HoverInfo | null) => void
  onReady?: (stats: MapReadyStats) => void
}

const CAMERA_OFFSET = new THREE.Vector3(0, 40, 28.5)
const VIEW_HEIGHT = 34
const MIN_ZOOM = 0.55
const MAX_ZOOM = 2.6

/**
 * Three.js 地图渲染器：正交俯视相机、拖拽平移、滚轮缩放、悬停高亮。
 * 所有 Three 对象都放在普通类字段里，不进入 Vue 响应式系统。
 */
export class MapRenderer {
  private readonly container: HTMLElement
  private readonly options: MapRendererOptions

  private readonly scene = new THREE.Scene()
  private readonly camera: THREE.OrthographicCamera
  private readonly renderer: THREE.WebGLRenderer
  private readonly mapGroup = new THREE.Group()
  private readonly highlight: THREE.Group
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()
  private readonly target = new THREE.Vector3()
  private readonly dragStartTarget = new THREE.Vector3()

  private map: MapData | null = null
  private terrainLayer: TerrainLayer | null = null
  private riverLayer: RiverLayer | null = null
  private roadLayer: RoadLayer | null = null
  private agentLayer: AgentLayer | null = null
  private cityLayer: CityLayer | null = null

  private resizeObserver: ResizeObserver | null = null
  private dragging = false
  private dragStartX = 0
  private dragStartY = 0
  private hoveredId = -1
  private hoveredCityKey: string | null = null
  private zoom = 1
  private targetZoom = 1
  private elapsed = 0
  private lastFrame = 0

  constructor(container: HTMLElement, options: MapRendererOptions = {}) {
    this.container = container
    this.options = options

    this.scene.background = new THREE.Color(0x0a1014)
    this.scene.fog = new THREE.Fog(0x0a1014, 96, 168)

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 300)
    this.camera.position.copy(CAMERA_OFFSET)
    this.camera.lookAt(0, 0, 0)

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.12
    this.renderer.domElement.className = 'map-webgl'
    container.appendChild(this.renderer.domElement)

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(600, 600),
      new THREE.MeshStandardMaterial({ color: 0x0b1318, roughness: 1, metalness: 0 }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.08
    this.scene.add(ground)

    this.scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x3b3320, 1.15))

    const sun = new THREE.DirectionalLight(0xfff0d2, 2.1)
    sun.position.set(28, 46, 20)
    this.scene.add(sun)

    const fill = new THREE.DirectionalLight(0x8fb4d8, 0.4)
    fill.position.set(-30, 18, -24)
    this.scene.add(fill)

    this.scene.add(this.mapGroup)

    this.highlight = this.createHighlight()
    this.scene.add(this.highlight)

    this.buildMap(options.seed ?? 20261021)

    const toWorld = (q: number, r: number): WorldPosition => {
      const tile = this.map?.tileMap.get(tileKey(q, r))
      return tile
        ? { x: tile.x, z: tile.z, y: tile.height }
        : { x: 0, z: 0, y: 0 }
    }

    this.agentLayer = new AgentLayer(toWorld)
    this.cityLayer = new CityLayer(toWorld)
    this.scene.add(this.agentLayer.group, this.cityLayer.group)

    this.renderer.domElement.addEventListener('pointerdown', this.handlePointerDown)
    this.renderer.domElement.addEventListener('pointermove', this.handlePointerMove)
    this.renderer.domElement.addEventListener('pointerup', this.handlePointerUp)
    this.renderer.domElement.addEventListener('pointercancel', this.handlePointerUp)
    this.renderer.domElement.addEventListener('pointerleave', this.handlePointerLeave)
    this.renderer.domElement.addEventListener('wheel', this.handleWheel, { passive: false })

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.resize()
  }

  start(): void {
    this.lastFrame = 0
    this.renderer.setAnimationLoop(this.tick)
  }

  regenerate(seed: number): void {
    this.hoveredId = -1
    this.hoveredCityKey = null
    this.highlight.visible = false
    this.options.onHover?.(null)
    this.buildMap(seed)
    this.target.set(0, 0, 0)
    this.zoom = 1
    this.targetZoom = 1
  }

  /** 当前地图数据，供推演层初始化使用 */
  getMap(): MapData | null {
    return this.map
  }

  /** Sync general positions, paths and targets */
  setAgents(generals: GeneralState[]): void {
    this.agentLayer?.setAgents(generals)
  }

  /** Sync faction home cities */
  setCities(cities: BaseCity[]): void {
    this.cityLayer?.setCities(cities)
  }

  /** Sync tile ownership */
  setOccupations(occupation: Map<string, Faction>): void {
    this.agentLayer?.setOccupations(occupation)
  }

  /** Clear the simulation presentation */
  clearArmy(): void {
    this.agentLayer?.clear()
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null)
    this.resizeObserver?.disconnect()
    this.resizeObserver = null

    const canvas = this.renderer.domElement
    canvas.removeEventListener('pointerdown', this.handlePointerDown)
    canvas.removeEventListener('pointermove', this.handlePointerMove)
    canvas.removeEventListener('pointerup', this.handlePointerUp)
    canvas.removeEventListener('pointercancel', this.handlePointerUp)
    canvas.removeEventListener('pointerleave', this.handlePointerLeave)
    canvas.removeEventListener('wheel', this.handleWheel)

    this.disposeMap()
    this.agentLayer?.dispose()
    this.agentLayer = null
    this.cityLayer?.dispose()
    this.cityLayer = null

    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose()
        if (Array.isArray(object.material)) object.material.forEach((m) => m.dispose())
        else object.material.dispose()
      }
      if (object instanceof THREE.Line) {
        object.geometry.dispose()
        object.material.dispose()
      }
    })
    this.scene.clear()

    this.renderer.dispose()
    canvas.remove()
  }

  /* ------------------------------------------------------------------ */

  private buildMap(seed: number): void {
    this.disposeMap()
    this.agentLayer?.clear()
    this.cityLayer?.clear()
    this.hoveredCityKey = null

    const map = generateMap(seed)
    this.map = map
    this.terrainLayer = new TerrainLayer(map)
    this.riverLayer = new RiverLayer(map.rivers)
    this.roadLayer = new RoadLayer(map.roads, map)

    this.mapGroup.add(this.terrainLayer.group, this.riverLayer.group, this.roadLayer.group)
    this.options.onReady?.({ tiles: map.tiles.length, seed })
  }

  private disposeMap(): void {
    if (this.terrainLayer) {
      this.mapGroup.remove(this.terrainLayer.group)
      this.terrainLayer.dispose()
    }
    if (this.riverLayer) {
      this.mapGroup.remove(this.riverLayer.group)
      this.riverLayer.dispose()
    }
    if (this.roadLayer) {
      this.mapGroup.remove(this.roadLayer.group)
      this.roadLayer.dispose()
    }
    this.terrainLayer = null
    this.riverLayer = null
    this.roadLayer = null
    this.map = null
  }

  private createHighlight(): THREE.Group {
    const corners = hexCornerPoints(0.97)
    const shape = new THREE.Shape()
    const first = corners[0]!
    shape.moveTo(first.x, first.z)
    for (let i = 1; i < corners.length; i++) {
      const corner = corners[i]!
      shape.lineTo(corner.x, corner.z)
    }
    shape.closePath()

    const fillGeometry = new THREE.ShapeGeometry(shape)
    fillGeometry.rotateX(-Math.PI / 2)
    const fill = new THREE.Mesh(
      fillGeometry,
      new THREE.MeshBasicMaterial({
        color: 0xffd873,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    )
    fill.renderOrder = 5

    const outlineGeometry = new THREE.BufferGeometry().setFromPoints(
      corners.map((p) => new THREE.Vector3(p.x, 0.015, p.z)),
    )
    const outline = new THREE.LineLoop(
      outlineGeometry,
      new THREE.LineBasicMaterial({
        color: 0xffe6a3,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
      }),
    )
    outline.renderOrder = 6

    const group = new THREE.Group()
    group.add(fill, outline)
    group.visible = false
    return group
  }

  private resize(): void {
    const width = this.container.clientWidth || 1
    const height = this.container.clientHeight || 1
    const aspect = width / height
    const halfHeight = VIEW_HEIGHT / 2

    this.camera.left = -halfHeight * aspect
    this.camera.right = halfHeight * aspect
    this.camera.top = halfHeight
    this.camera.bottom = -halfHeight
    this.camera.updateProjectionMatrix()

    this.renderer.setSize(width, height, false)
  }

  private tick = (timeMs: number): void => {
    const dt = this.lastFrame === 0 ? 0.016 : Math.min(0.05, (timeMs - this.lastFrame) / 1000)
    this.lastFrame = timeMs
    this.elapsed += dt

    this.zoom += (this.targetZoom - this.zoom) * Math.min(1, dt * 12)
    if (Math.abs(this.zoom - this.targetZoom) < 0.0005) this.zoom = this.targetZoom
    this.camera.zoom = this.zoom
    this.camera.updateProjectionMatrix()

    this.camera.position.set(
      this.target.x + CAMERA_OFFSET.x,
      this.target.y + CAMERA_OFFSET.y,
      this.target.z + CAMERA_OFFSET.z,
    )
    this.camera.lookAt(this.target)

    this.riverLayer?.update(this.elapsed)
    this.agentLayer?.update(dt)
    this.cityLayer?.update(dt)
    this.renderer.render(this.scene, this.camera)
  }

  /* ------------------------------------------------------------------ */

  private handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    this.dragging = true
    this.dragStartX = event.clientX
    this.dragStartY = event.clientY
    this.dragStartTarget.copy(this.target)
    this.renderer.domElement.setPointerCapture(event.pointerId)
    this.renderer.domElement.classList.add('is-dragging')
  }

  private handlePointerMove = (event: PointerEvent): void => {
    this.setPointer(event)

    if (this.dragging) {
      const rect = this.renderer.domElement.getBoundingClientRect()
      const worldPerPixel = VIEW_HEIGHT / this.zoom / Math.max(1, rect.height)
      const elevation = Math.atan2(CAMERA_OFFSET.y, CAMERA_OFFSET.z)
      const dx = event.clientX - this.dragStartX
      const dy = event.clientY - this.dragStartY

      this.target.x = this.dragStartTarget.x - dx * worldPerPixel
      this.target.z = this.dragStartTarget.z - (dy * worldPerPixel) / Math.sin(elevation)
      this.clampTarget()
      this.hideHover()
      return
    }

    this.updateHover()
  }

  private handlePointerUp = (event: PointerEvent): void => {
    this.dragging = false
    this.renderer.domElement.classList.remove('is-dragging')
    if (this.renderer.domElement.hasPointerCapture(event.pointerId)) {
      this.renderer.domElement.releasePointerCapture(event.pointerId)
    }
  }

  private handlePointerLeave = (): void => {
    if (!this.dragging) this.hideHover()
  }

  private handleWheel = (event: WheelEvent): void => {
    event.preventDefault()
    const factor = Math.exp(-event.deltaY * 0.0012)
    this.targetZoom = THREE.MathUtils.clamp(this.targetZoom * factor, MIN_ZOOM, MAX_ZOOM)
  }

  private setPointer(event: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
  }

  private clampTarget(): void {
    if (!this.map) return
    const margin = 4
    const { bounds } = this.map
    this.target.x = THREE.MathUtils.clamp(this.target.x, bounds.minX - margin, bounds.maxX + margin)
    this.target.z = THREE.MathUtils.clamp(this.target.z, bounds.minZ - margin, bounds.maxZ + margin)
  }

  private updateHover(): void {
    if (!this.map || !this.terrainLayer) return

    this.raycaster.setFromCamera(this.pointer, this.camera)

    const cityHit = this.cityLayer
      ? this.raycaster.intersectObject(this.cityLayer.group, true)[0]
      : undefined
    const city = cityHit ? this.cityLayer?.resolvePick(cityHit.object) ?? null : null

    if (city) {
      const key = `${city.faction}:${city.coord.q},${city.coord.r}`
      if (key === this.hoveredCityKey) return

      const tile = this.map.tileMap.get(tileKey(city.coord.q, city.coord.r))
      if (!tile) return

      this.hoveredCityKey = key
      this.hoveredId = -1
      this.highlight.position.set(tile.x, tile.height + 0.03, tile.z)
      this.highlight.visible = true

      this.options.onHover?.({
        q: city.coord.q,
        r: city.coord.r,
        level: tile.level,
        name: city.name,
        desc: `${FACTION_NAMES[city.faction]}小队出发地`,
        height: tile.height,
        isBank: false,
        city: {
          name: city.name,
          faction: city.faction,
          factionName: FACTION_NAMES[city.faction],
        },
      })
      return
    }

    const hits = this.raycaster.intersectObject(this.terrainLayer.pickMesh, false)
    const hit = hits[0]
    const instanceId = hit?.instanceId

    if (instanceId === undefined) {
      this.hideHover()
      return
    }
    if (instanceId === this.hoveredId) return

    const tile = this.map.tiles[instanceId]
    if (!tile) return

    this.hoveredCityKey = null
    this.hoveredId = instanceId
    this.highlight.position.set(tile.x, tile.height + 0.03, tile.z)
    this.highlight.visible = true

    if (tile.isBank) {
      this.options.onHover?.({
        q: tile.q,
        r: tile.r,
        level: 0,
        name: '河滩',
        desc: '河道两侧的滩涂，无法建造',
        height: tile.height,
        isBank: true,
      })
    } else {
      const def = getTerrainLevel(tile.level)
      this.options.onHover?.({
        q: tile.q,
        r: tile.r,
        level: def.level,
        name: def.name,
        desc: def.desc,
        height: tile.height,
        isBank: false,
      })
    }
  }

  private hideHover(): void {
    if (this.hoveredId === -1 && this.hoveredCityKey === null) return
    this.hoveredId = -1
    this.hoveredCityKey = null
    this.highlight.visible = false
    this.options.onHover?.(null)
  }
}
