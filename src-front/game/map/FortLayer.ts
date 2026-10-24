/**
 * 要塞渲染层：六棱石垒底座 + 短塔身 + 归属色旗。
 * 建造中显示建造进度条、塔身半透明；建成后显示血量条。
 * 只消费快照，不含任何推演逻辑。
 */
import * as THREE from 'three'
import type { Faction, FortState } from '@shared/types'
import { diplomacySignature, relationStyleOf, type Diplomacy } from '../bot/diplomacy'
import { hpColor, type WorldPosition } from './AgentLayer'

const BASE_RADIUS = 0.22
const BASE_HEIGHT = 0.08
const TOWER_RADIUS = 0.13
const TOWER_HEIGHT = 0.3
const FLAG_WIDTH = 0.16
const FLAG_HEIGHT = 0.1
const BAR_WIDTH = 0.42
const BAR_HEIGHT = 0.07
const BAR_PX = { width: 72, height: 12 }

/** 建造中的进度条配色 */
const BUILDING_COLOR = '#e0b34c'

interface FortToken {
  root: THREE.Group
  stoneMaterial: THREE.MeshStandardMaterial
  flagMaterial: THREE.MeshStandardMaterial
  flag: THREE.Mesh
  bar: THREE.Sprite
  barCanvas: HTMLCanvasElement
  barTexture: THREE.CanvasTexture
  /** 条内容签名，避免每帧重绘 Canvas */
  barKey: string
  faction: Faction
  phase: number
}

export class FortLayer {
  readonly group = new THREE.Group()
  private readonly toWorld: (q: number, r: number) => WorldPosition
  private readonly tokens = new Map<string, FortToken>()
  private diplomacy: Diplomacy | null = null
  private diplomacySignature = ''
  private elapsed = 0

  constructor(toWorld: (q: number, r: number) => WorldPosition) {
    this.toWorld = toWorld
  }

  setForts(forts: FortState[], diplomacy?: Diplomacy): void {
    if (diplomacy && this.diplomacySignature !== diplomacySignature(diplomacy)) {
      this.diplomacy = diplomacy
      this.diplomacySignature = diplomacySignature(diplomacy)
    }

    const present = new Set(forts.map((fort) => fort.id))
    for (const [id, token] of this.tokens) {
      if (present.has(id)) continue
      this.destroyToken(token)
      this.tokens.delete(id)
    }

    forts.forEach((fort, index) => {
      let token = this.tokens.get(fort.id)
      if (!token) {
        token = this.createToken(fort, index)
        this.tokens.set(fort.id, token)
      }
      this.applyColor(token, fort.faction)
      this.applyState(token, fort)
    })
  }

  setDiplomacy(diplomacy: Diplomacy): void {
    const signature = diplomacySignature(diplomacy)
    if (this.diplomacySignature === signature) return
    this.diplomacy = diplomacy
    this.diplomacySignature = signature
    for (const token of this.tokens.values()) this.applyColor(token, token.faction)
  }

  update(dt: number): void {
    this.elapsed += dt
    for (const token of this.tokens.values()) {
      // 旗帜轻微摆动，静态建筑也有生命感
      token.flag.rotation.y = Math.sin(this.elapsed * 1.6 + token.phase) * 0.18
    }
  }

  clear(): void {
    for (const token of this.tokens.values()) this.destroyToken(token)
    this.tokens.clear()
  }

  dispose(): void {
    this.clear()
    this.group.clear()
  }

  /* ------------------------------------------------------------------ */

  private createToken(fort: FortState, index: number): FortToken {
    const color = this.styleFor(fort.faction)
    const root = new THREE.Group()

    const stoneMaterial = new THREE.MeshStandardMaterial({
      color: 0x9aa4ac,
      emissive: 0x20262a,
      roughness: 0.85,
      metalness: 0.05,
      transparent: true,
      opacity: 1,
    })
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(BASE_RADIUS, BASE_RADIUS * 1.12, BASE_HEIGHT, 6),
      stoneMaterial,
    )
    base.position.y = BASE_HEIGHT / 2

    const tower = new THREE.Mesh(
      new THREE.CylinderGeometry(TOWER_RADIUS, TOWER_RADIUS * 1.18, TOWER_HEIGHT, 6),
      stoneMaterial,
    )
    tower.position.y = BASE_HEIGHT + TOWER_HEIGHT / 2

    const flagMaterial = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.35,
      roughness: 0.6,
      metalness: 0.1,
    })
    const flag = new THREE.Mesh(new THREE.BoxGeometry(FLAG_WIDTH, FLAG_HEIGHT, 0.02), flagMaterial)
    flag.position.set(FLAG_WIDTH / 2 + 0.02, BASE_HEIGHT + TOWER_HEIGHT + 0.04, 0)

    const barCanvas = document.createElement('canvas')
    const barTexture = new THREE.CanvasTexture(barCanvas)
    barTexture.colorSpace = THREE.SRGBColorSpace
    const bar = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: barTexture, transparent: true, depthWrite: false }),
    )
    bar.scale.set(BAR_WIDTH, BAR_HEIGHT, 1)
    bar.position.y = BASE_HEIGHT + TOWER_HEIGHT + 0.2
    bar.renderOrder = 7

    const position = this.toWorld(fort.coord.q, fort.coord.r)
    root.position.set(position.x, position.y, position.z)

    root.add(base, tower, flag, bar)
    this.group.add(root)

    const token: FortToken = {
      root,
      stoneMaterial,
      flagMaterial,
      flag,
      bar,
      barCanvas,
      barTexture,
      barKey: '',
      faction: fort.faction,
      phase: index * 1.7,
    }
    this.applyState(token, fort)
    return token
  }

  private applyState(token: FortToken, fort: FortState): void {
    const building = fort.status === 'building'
    token.stoneMaterial.opacity = building ? 0.55 : 1
    token.stoneMaterial.depthWrite = !building
    token.stoneMaterial.needsUpdate = true
    token.bar.visible = true

    const ratio = building
      ? fort.buildCost > 0
        ? Math.min(1, Math.max(0, fort.progress / fort.buildCost))
        : 0
      : fort.maxHp > 0
        ? Math.min(1, Math.max(0, fort.hp / fort.maxHp))
        : 1
    const rounded = Math.round(ratio * 100) / 100
    const key = `${building ? 'build' : 'hp'}:${rounded}`
    if (key === token.barKey) return
    token.barKey = key
    this.drawBar(token, rounded, building)
  }

  private drawBar(token: FortToken, ratio: number, building: boolean): void {
    const canvas = token.barCanvas
    canvas.width = BAR_PX.width
    canvas.height = BAR_PX.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, BAR_PX.width, BAR_PX.height)
    ctx.fillStyle = 'rgba(6, 12, 16, 0.82)'
    ctx.fillRect(0, 0, BAR_PX.width, BAR_PX.height)
    ctx.fillStyle = building ? BUILDING_COLOR : hpColor(ratio)
    ctx.fillRect(1, 1, Math.max(1, (BAR_PX.width - 2) * ratio), BAR_PX.height - 2)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)'
    ctx.lineWidth = 1
    ctx.strokeRect(0.5, 0.5, BAR_PX.width - 1, BAR_PX.height - 1)
    token.barTexture.needsUpdate = true
  }

  private styleFor(faction: Faction): number {
    if (!this.diplomacy) return 0xcfd8df
    return relationStyleOf(this.diplomacy, faction).fill
  }

  private applyColor(token: FortToken, faction: Faction): void {
    token.faction = faction
    const color = this.styleFor(faction)
    token.flagMaterial.color.setHex(color)
    token.flagMaterial.emissive.setHex(color)
  }

  private destroyToken(token: FortToken): void {
    this.group.remove(token.root)
    token.root.traverse((child) => {
      if (child instanceof THREE.Mesh) child.geometry.dispose()
      if (child instanceof THREE.Sprite) child.material.dispose()
    })
    token.stoneMaterial.dispose()
    token.flagMaterial.dispose()
    token.barTexture.dispose()
  }
}
