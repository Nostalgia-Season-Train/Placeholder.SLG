/**
 * 3D presentation layer for faction home cities: hex base, walls, towers,
 * a faction-colored banner, a pulsing departure ring and a city defense bar.
 * It only consumes city data from the simulation snapshot.
 */
import * as THREE from 'three'
import { FACTION_COLORS, type BaseCity, type Faction } from '@shared/types'
import { diplomacySignature, relationStyleOf, type Diplomacy } from '../bot/diplomacy'
import { hpColor, type WorldPosition } from './AgentLayer'

/** 城防条在城头上的高度（世界单位） */
const BAR_Y = 0.95

/** 城防条贴图像素尺寸与世界高度 */
const BAR_PX = { width: 120, height: 16 }
const BAR_WORLD_HEIGHT = 0.11

/** 血量比变化小于该阈值时不重绘贴图 */
const BAR_REDRAW_EPSILON = 0.004

interface CityToken {
  root: THREE.Group
  ring: THREE.Mesh
  banner: THREE.Mesh
  /** 随归属变化的材质集合（屋顶、塔顶、旗帜、光环） */
  colorMaterials: (THREE.MeshStandardMaterial | THREE.MeshBasicMaterial)[]
  /** 当前染色依据：同盟关系签名 + 归属，用于避免重复染色 */
  colorKey: string
  /** 城防条 */
  bar: THREE.Sprite
  barCanvas: HTMLCanvasElement
  barTexture: THREE.CanvasTexture
  hpRatio: number
  phase: number
}

function cityKey(city: BaseCity): string {
  return `${city.coord.q},${city.coord.r}`
}

export class CityLayer {
  readonly group = new THREE.Group()
  private readonly toWorld: (q: number, r: number) => WorldPosition
  private readonly tokens = new Map<string, CityToken>()
  private readonly cityByKey = new Map<string, BaseCity>()
  private elapsed = 0
  private diplomacy: Diplomacy | null = null

  constructor(toWorld: (q: number, r: number) => WorldPosition) {
    this.toWorld = toWorld
  }

  setCities(cities: BaseCity[], diplomacy?: Diplomacy): void {
    if (diplomacy) this.diplomacy = diplomacy
    const signature = this.diplomacy ? diplomacySignature(this.diplomacy) : ''

    const present = new Set<string>()
    for (const city of cities) {
      const key = cityKey(city)
      present.add(key)

      let token = this.tokens.get(key)
      if (!token) {
        token = this.createToken(city, this.tokens.size)
        this.tokens.set(key, token)
        this.group.add(token.root)
      }

      // 城破只换色，不重建模型
      const colorKey = `${signature}|${city.owner}`
      if (token.colorKey !== colorKey) {
        token.colorKey = colorKey
        this.applyColor(token, this.colorOf(city.owner))
      }

      this.updateBar(token, city)
      this.cityByKey.set(key, city)
    }

    for (const [key, token] of this.tokens) {
      if (present.has(key)) continue
      this.destroyToken(token)
      this.tokens.delete(key)
      this.cityByKey.delete(key)
    }
  }

  setDiplomacy(diplomacy: Diplomacy): void {
    if (this.diplomacy && diplomacySignature(this.diplomacy) === diplomacySignature(diplomacy)) {
      return
    }
    this.diplomacy = diplomacy
    // 下次 setCities 强制重新染色
    for (const token of this.tokens.values()) token.colorKey = ''
  }

  /** Resolve a raycast hit back to the city it belongs to */
  resolvePick(object: THREE.Object3D): BaseCity | null {
    let current: THREE.Object3D | null = object
    while (current) {
      const key = current.userData.cityKey as string | undefined
      if (key) return this.cityByKey.get(key) ?? null
      current = current.parent
    }
    return null
  }

  update(dt: number): void {
    this.elapsed += dt

    for (const token of this.tokens.values()) {
      const wave = Math.sin(this.elapsed * 2.2 + token.phase)
      const ringMaterial = token.ring.material as THREE.MeshBasicMaterial
      ringMaterial.opacity = 0.34 + wave * 0.18
      token.ring.scale.setScalar(1 + wave * 0.035)
      token.banner.rotation.y = -0.4 + Math.sin(this.elapsed * 2.6 + token.phase) * 0.18
      token.banner.scale.x = 0.85 + Math.sin(this.elapsed * 3.1 + token.phase) * 0.12
    }
  }

  clear(): void {
    for (const token of this.tokens.values()) this.destroyToken(token)
    this.tokens.clear()
    this.cityByKey.clear()
  }

  dispose(): void {
    this.clear()
    this.group.clear()
  }

  /* ------------------------------------------------------------------ */

  private colorOf(faction: Faction): number {
    return this.diplomacy
      ? relationStyleOf(this.diplomacy, faction).fill
      : FACTION_COLORS[faction]
  }

  private applyColor(token: CityToken, color: number): void {
    for (const material of token.colorMaterials) {
      material.color.setHex(color)
      if (material instanceof THREE.MeshStandardMaterial) material.emissive.setHex(color)
    }
  }

  private createToken(city: BaseCity, index: number): CityToken {
    const color = this.colorOf(city.owner)
    const position = this.toWorld(city.coord.q, city.coord.r)
    const root = new THREE.Group()
    root.position.set(position.x, position.y, position.z)
    root.userData.cityKey = cityKey(city)

    const stone = new THREE.MeshStandardMaterial({ color: 0x6d6a60, roughness: 0.92 })
    const darkStone = new THREE.MeshStandardMaterial({ color: 0x4a4c50, roughness: 0.86 })
    const factionMaterial = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.28,
      roughness: 0.5,
      metalness: 0.15,
    })

    const platform = new THREE.Mesh(new THREE.CylinderGeometry(0.82, 0.9, 0.16, 6), darkStone)
    platform.position.y = 0.08

    const wall = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.66, 0.2, 6), stone)
    wall.position.y = 0.26

    const keep = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.36, 0.34), stone)
    keep.position.y = 0.34
    keep.rotation.y = Math.PI / 4

    const roof = new THREE.Mesh(new THREE.ConeGeometry(0.27, 0.26, 4), factionMaterial)
    roof.position.y = 0.65
    roof.rotation.y = Math.PI / 4

    root.add(platform, wall, keep, roof)

    for (let corner = 0; corner < 6; corner++) {
      const angle = Math.PI / 6 + (corner * Math.PI) / 3
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.1, 0.32, 6), stone)
      tower.position.set(Math.cos(angle) * 0.56, 0.32, Math.sin(angle) * 0.56)
      tower.rotation.y = angle

      const cap = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.16, 6), factionMaterial)
      cap.position.set(tower.position.x, 0.56, tower.position.z)

      root.add(tower, cap)
    }

    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.014, 0.014, 0.52, 6),
      new THREE.MeshStandardMaterial({ color: 0x2b2f34, roughness: 0.7 }),
    )
    pole.position.set(0.32, 0.42, 0)

    const bannerMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
    })
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.15), bannerMaterial)
    banner.position.set(0.45, 0.56, 0)

    const ringMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.86, 0.98, 6).rotateX(-Math.PI / 2), ringMaterial)
    ring.position.y = 0.02
    ring.renderOrder = 4

    // 城防条：始终显示，填充宽度随血量缩放
    const barCanvas = document.createElement('canvas')
    const barTexture = new THREE.CanvasTexture(barCanvas)
    barTexture.colorSpace = THREE.SRGBColorSpace
    const bar = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: barTexture, transparent: true, depthWrite: false }),
    )
    const barWidth = BAR_WORLD_HEIGHT * (BAR_PX.width / BAR_PX.height)
    bar.scale.set(barWidth, BAR_WORLD_HEIGHT, 1)
    bar.position.set(0, BAR_Y, 0)
    bar.renderOrder = 7

    root.add(pole, banner, ring, bar)

    const token: CityToken = {
      root,
      ring,
      banner,
      colorMaterials: [factionMaterial, bannerMaterial, ringMaterial],
      colorKey: '',
      bar,
      barCanvas,
      barTexture,
      hpRatio: -1,
      phase: index * 1.9,
    }
    // 立即应用一次配色与城防，避免首个 Tick 出现默认色
    token.colorKey = `${this.diplomacy ? diplomacySignature(this.diplomacy) : ''}|${city.owner}`
    this.updateBar(token, city)
    return token
  }

  private updateBar(token: CityToken, city: BaseCity): void {
    const ratio = city.maxHp > 0 ? Math.max(0, Math.min(1, city.hp / city.maxHp)) : 0
    if (Math.abs(ratio - token.hpRatio) < BAR_REDRAW_EPSILON) return
    token.hpRatio = ratio
    drawBar(token.barCanvas, ratio)
    token.barTexture.needsUpdate = true
  }

  private destroyToken(token: CityToken): void {
    this.group.remove(token.root)
    disposeObject(token.root)
    token.barTexture.dispose()
  }
}

/** 城防条：深色底槽 + 随血量变色的填充条 */
function drawBar(canvas: HTMLCanvasElement, ratio: number): void {
  canvas.width = BAR_PX.width
  canvas.height = BAR_PX.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, BAR_PX.width, BAR_PX.height)

  ctx.fillStyle = 'rgba(8, 14, 18, 0.82)'
  ctx.fillRect(0, 0, BAR_PX.width, BAR_PX.height)

  ctx.fillStyle = hpColor(ratio)
  ctx.fillRect(2, 2, Math.max(0, (BAR_PX.width - 4) * ratio), BAR_PX.height - 4)
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose()
      const materials = Array.isArray(child.material) ? child.material : [child.material]
      for (const material of materials) material.dispose()
      return
    }
    if (child instanceof THREE.Sprite) child.material.dispose()
  })
}
