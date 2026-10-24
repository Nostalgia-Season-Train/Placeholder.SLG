/**
 * 3D presentation layer for minion lanes: a small cone per minion with a hp bar.
 * Consumes simulation snapshots only and contains no simulation logic.
 * 移动沿用角色的单格线性动画：一段播完即停，等下个 Tick 再走下一格。
 */
import * as THREE from 'three'
import { FACTION_COLORS, type Faction, type MinionState } from '@shared/types'
import { diplomacySignature, relationStyleOf, type Diplomacy } from '../bot/diplomacy'
import { hpColor, type WorldPosition } from './AgentLayer'

/** 默认一个 Tick 的时长（毫秒），实际值由后端状态驱动 */
const DEFAULT_TICK_MS = 650

/** 移动动画占用的 Tick 比例：走完即停，排队等下个 Tick */
const MOVE_ANIMATION_RATIO = 0.7

/** 同格堆叠时的小幅错位 */
const STACK_OFFSET = 0.13

const BODY_HEIGHT = 0.26
const BODY_RADIUS = 0.09
const BAR_WIDTH = 0.32
const BAR_HEIGHT = 0.062
const BAR_PX = { width: 64, height: 12 }

interface MoveTween {
  fromX: number
  fromY: number
  fromZ: number
  toX: number
  toY: number
  toZ: number
  elapsed: number
  duration: number
}

interface MinionToken {
  root: THREE.Group
  bodyMaterial: THREE.MeshStandardMaterial
  bar: THREE.Sprite
  barCanvas: HTMLCanvasElement
  barTexture: THREE.CanvasTexture
  hpRatio: number
  faction: Faction
  tileKey: string
  baseY: number
  phase: number
  /** 同格堆叠的固定错位量 */
  offsetX: number
  offsetZ: number
  move: MoveTween | null
}

export class MinionLayer {
  readonly group = new THREE.Group()
  private readonly toWorld: (q: number, r: number) => WorldPosition
  private readonly tokens = new Map<string, MinionToken>()
  private diplomacy: Diplomacy | null = null
  private diplomacySignature = ''
  private elapsed = 0
  private tickSeconds = DEFAULT_TICK_MS / 1000

  constructor(toWorld: (q: number, r: number) => WorldPosition) {
    this.toWorld = toWorld
  }

  setMinions(minions: MinionState[], diplomacy?: Diplomacy, tickMs?: number): void {
    if (tickMs && Number.isFinite(tickMs)) this.tickSeconds = Math.max(0.1, tickMs / 1000)
    if (diplomacy && this.diplomacySignature !== diplomacySignature(diplomacy)) {
      this.diplomacy = diplomacy
      this.diplomacySignature = diplomacySignature(diplomacy)
    }

    const present = new Set(minions.map((minion) => minion.id))

    for (const [id, token] of this.tokens) {
      if (present.has(id)) continue
      this.destroyToken(token)
      this.tokens.delete(id)
    }

    minions.forEach((minion, index) => {
      let token = this.tokens.get(minion.id)
      if (!token) {
        token = this.createToken(minion, index)
        this.tokens.set(minion.id, token)
      }
      this.applyColor(token, minion.faction)
      this.updateToken(token, minion)
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
      const move = token.move
      if (move) {
        move.elapsed += dt
        const t = Math.min(1, move.elapsed / move.duration)
        token.root.position.x = THREE.MathUtils.lerp(move.fromX, move.toX, t)
        token.root.position.z = THREE.MathUtils.lerp(move.fromZ, move.toZ, t)
        token.baseY = THREE.MathUtils.lerp(move.fromY, move.toY, t)

        if (t >= 1) {
          token.root.position.x = move.toX
          token.root.position.z = move.toZ
          token.baseY = move.toY
          token.move = null
        }
      }

      token.root.position.y = token.baseY + Math.sin(this.elapsed * 3 + token.phase) * 0.015
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

  private createToken(minion: MinionState, index: number): MinionToken {
    const color = this.styleFor(minion.faction)
    const root = new THREE.Group()

    const bodyMaterial = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.3,
      roughness: 0.6,
      metalness: 0.12,
    })
    const body = new THREE.Mesh(new THREE.ConeGeometry(BODY_RADIUS, BODY_HEIGHT, 5), bodyMaterial)
    body.position.y = BODY_HEIGHT / 2

    const barCanvas = document.createElement('canvas')
    const barTexture = new THREE.CanvasTexture(barCanvas)
    barTexture.colorSpace = THREE.SRGBColorSpace
    const bar = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: barTexture, transparent: true, depthWrite: false }),
    )
    bar.scale.set(BAR_WIDTH, BAR_HEIGHT, 1)
    bar.position.y = BODY_HEIGHT + 0.11
    bar.renderOrder = 7

    const position = this.toWorld(minion.coord.q, minion.coord.r)
    // 同格多个小兵按序错位，避免完全重叠
    const offsetIndex = index % 4
    const dx = ((offsetIndex % 2) - 0.5) * STACK_OFFSET
    const dz = (Math.floor(offsetIndex / 2) - 0.5) * STACK_OFFSET
    root.position.set(position.x + dx, position.y + 0.03, position.z + dz)

    root.add(body, bar)
    this.group.add(root)

    const token: MinionToken = {
      root,
      bodyMaterial,
      bar,
      barCanvas,
      barTexture,
      hpRatio: -1,
      faction: minion.faction,
      tileKey: `${minion.coord.q},${minion.coord.r}`,
      baseY: position.y + 0.03,
      phase: this.tokens.size * 1.3,
      offsetX: dx,
      offsetZ: dz,
      move: null,
    }
    this.refreshBar(token, minion)
    return token
  }

  private updateToken(token: MinionToken, minion: MinionState): void {
    this.refreshBar(token, minion)

    const position = this.toWorld(minion.coord.q, minion.coord.r)
    const tileKey = `${minion.coord.q},${minion.coord.r}`
    if (tileKey !== token.tileKey) {
      token.tileKey = tileKey
      // 一格一段线性动画：时长小于一个 Tick，播完停住等下个 Tick
      token.move = {
        fromX: token.root.position.x,
        fromY: token.baseY,
        fromZ: token.root.position.z,
        toX: position.x + token.offsetX,
        toY: position.y + 0.03,
        toZ: position.z + token.offsetZ,
        elapsed: 0,
        duration: Math.max(0.06, this.tickSeconds * MOVE_ANIMATION_RATIO),
      }
    }
  }

  private refreshBar(token: MinionToken, minion: MinionState): void {
    const ratio =
      minion.maxHp > 0 ? Math.round(Math.min(1, Math.max(0, minion.hp / minion.maxHp)) * 100) / 100 : 1
    if (ratio === token.hpRatio) return
    token.hpRatio = ratio
    this.drawBar(token, ratio)
  }

  private drawBar(token: MinionToken, ratio: number): void {
    const canvas = token.barCanvas
    canvas.width = BAR_PX.width
    canvas.height = BAR_PX.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, BAR_PX.width, BAR_PX.height)
    ctx.fillStyle = 'rgba(6, 12, 16, 0.82)'
    ctx.fillRect(0, 0, BAR_PX.width, BAR_PX.height)
    ctx.fillStyle = hpColor(ratio)
    ctx.fillRect(1, 1, Math.max(1, (BAR_PX.width - 2) * ratio), BAR_PX.height - 2)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)'
    ctx.lineWidth = 1
    ctx.strokeRect(0.5, 0.5, BAR_PX.width - 1, BAR_PX.height - 1)
    token.barTexture.needsUpdate = true
  }

  private styleFor(faction: Faction): number {
    if (!this.diplomacy) return FACTION_COLORS[faction]
    return relationStyleOf(this.diplomacy, faction).fill
  }

  private applyColor(token: MinionToken, faction: Faction): void {
    token.faction = faction
    const color = this.styleFor(faction)
    token.bodyMaterial.color.setHex(color)
    token.bodyMaterial.emissive.setHex(color)
  }

  private destroyToken(token: MinionToken): void {
    this.group.remove(token.root)
    token.root.traverse((child) => {
      if (!(child instanceof THREE.Mesh) && !(child instanceof THREE.Sprite)) return
      if (child instanceof THREE.Mesh) child.geometry.dispose()
      const materials = Array.isArray(child.material) ? child.material : [child.material]
      for (const material of materials) material.dispose()
    })
    token.barTexture.dispose()
  }
}
