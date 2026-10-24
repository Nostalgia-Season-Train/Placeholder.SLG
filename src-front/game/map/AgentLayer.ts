/**
 * 3D presentation layer for the march simulation: general tokens, march routes,
 * target rings and occupation overlays.
 * It only consumes simulation snapshots and contains no simulation logic.
 */
import * as THREE from 'three'
import { FACTION_COLORS, formatUnitName, type Faction, type GeneralState } from '@shared/types'
import {
  relationStyleOf,
  type Diplomacy,
  type RelationStyle,
} from '../bot/diplomacy'
import { hexCornerPoints } from '@shared/map/hex'

/** 名称标签高度（世界单位） */
const LABEL_HEIGHT = 0.3

/** 名称文字的像素高度，用于保持字体大小不随兵力条加高而缩小 */
const LABEL_TEXT_PX = 56

/** 兵力条与名称之间的间距、兵力条本身的高度（像素） */
const BAR_GAP_PX = 8
const BAR_HEIGHT_PX = 16

/** 交战标记（交叉双剑）的贴图边长与世界高度 */
const FIGHT_MARK_PX = 96
const FIGHT_MARK_HEIGHT = 0.38

/** 交战标记在棋子头上的高度 */
const FIGHT_MARK_Y = 1.35

/** 默认一个 Tick 的时长（毫秒），实际值由后端状态驱动 */
const DEFAULT_TICK_MS = 650

/** 移动动画占用的 Tick 比例：走完即停，排队等下个 Tick */
const MOVE_ANIMATION_RATIO = 0.7

export interface WorldPosition {
  x: number
  z: number
  y: number
}

/** 单个地块的短距离移动动画，结束后棋子停在原地 */
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

interface AgentToken {
  root: THREE.Group
  pathLine: THREE.Line
  targetRing: THREE.Mesh
  bodyMaterial: THREE.MeshStandardMaterial
  lineMaterial: THREE.LineBasicMaterial
  ringMaterial: THREE.MeshBasicMaterial
  /** 头顶名称标签（与世界频道作者名同格式） */
  label: THREE.Sprite
  labelCanvas: HTMLCanvasElement
  labelTexture: THREE.CanvasTexture
  labelText: string
  labelColor: number
  /** 已绘制的兵力比，用于避免每帧重绘贴图 */
  labelHpRatio: number
  /** 交战标记（交叉双剑），交战中才显示 */
  fightMark: THREE.Sprite
  fightTexture: THREE.CanvasTexture
  tileKey: string
  baseY: number
  phase: number
  /** 当前这一格的动画；同一时间只允许存在一段 */
  move: MoveTween | null
}

export class AgentLayer {
  readonly group = new THREE.Group()
  private readonly toWorld: (q: number, r: number) => WorldPosition
  private readonly tokens = new Map<string, AgentToken>()
  private occupationMesh: THREE.InstancedMesh | null = null
  private borderMesh: THREE.InstancedMesh | null = null
  private occupation: Map<string, Faction> | null = null
  private diplomacy: Diplomacy | null = null
  private elapsed = 0
  /** 一个 Tick 的时长（秒），由后端推演节拍驱动 */
  private tickSeconds = DEFAULT_TICK_MS / 1000

  constructor(toWorld: (q: number, r: number) => WorldPosition) {
    this.toWorld = toWorld
  }

  setAgents(generals: GeneralState[], diplomacy?: Diplomacy, tickMs?: number): void {
    if (tickMs && Number.isFinite(tickMs)) this.tickSeconds = Math.max(0.1, tickMs / 1000)
    if (diplomacy && this.diplomacy?.playerFaction !== diplomacy.playerFaction) {
      this.diplomacy = diplomacy
      this.rebuildOccupation()
    }

    const present = new Set(generals.map((general) => general.id))

    for (const [id, token] of this.tokens) {
      if (present.has(id)) continue
      this.destroyToken(token)
      this.tokens.delete(id)
    }

    for (const general of generals) {
      let token = this.tokens.get(general.id)
      if (!token) {
        token = this.createToken(general)
        this.tokens.set(general.id, token)
      }
      this.applyTokenColor(token, general.faction)
      this.updateToken(token, general)
    }
  }

  setDiplomacy(diplomacy: Diplomacy): void {
    if (this.diplomacy?.playerFaction === diplomacy.playerFaction) return
    this.diplomacy = diplomacy
    this.rebuildOccupation()
  }

  /** Occupation overlays are rebuilt as a whole on ownership or diplomacy change */
  setOccupations(occupation: Map<string, Faction>, diplomacy: Diplomacy): void {
    this.occupation = new Map(occupation)
    this.diplomacy = diplomacy
    this.rebuildOccupation()
  }

  update(dt: number): void {
    this.elapsed += dt

    for (const token of this.tokens.values()) {
      // 每次只推进当前这一格的动画：走完就停住，等下个 Tick 再走下一格
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

      token.root.position.y =
        token.baseY + Math.sin(this.elapsed * 2.4 + token.phase) * 0.03

      if (token.targetRing.visible) {
        token.targetRing.scale.setScalar(1 + Math.sin(this.elapsed * 3 + token.phase) * 0.08)
      }

      if (token.fightMark.visible) {
        const scale = FIGHT_MARK_HEIGHT * (1 + Math.sin(this.elapsed * 6 + token.phase) * 0.08)
        token.fightMark.scale.set(scale, scale, 1)
        token.fightMark.position.y = FIGHT_MARK_Y + Math.sin(this.elapsed * 4 + token.phase) * 0.04
      }
    }
  }

  clear(): void {
    for (const token of this.tokens.values()) this.destroyToken(token)
    this.tokens.clear()
    this.destroyOccupationMeshes()
    this.occupation = null
  }

  dispose(): void {
    this.clear()
    this.group.clear()
  }

  /* ------------------------------------------------------------------ */

  private createToken(general: GeneralState): AgentToken {
    const color = this.styleFor(general.faction).fill
    const root = new THREE.Group()

    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.25, 0.29, 0.07, 6),
      new THREE.MeshStandardMaterial({ color: 0x14212a, roughness: 0.8, metalness: 0.2 }),
    )
    base.position.y = 0.035

    const bodyMaterial = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.35,
      roughness: 0.55,
      metalness: 0.15,
    })
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.52, 6), bodyMaterial)
    body.position.y = 0.32

    const bead = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 12, 8),
      new THREE.MeshStandardMaterial({ color: 0xf2ead6, emissive: 0xf2ead6, emissiveIntensity: 0.4 }),
    )
    bead.position.y = 0.6

    const labelCanvas = document.createElement('canvas')
    const labelTexture = new THREE.CanvasTexture(labelCanvas)
    labelTexture.colorSpace = THREE.SRGBColorSpace
    const label = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: labelTexture, transparent: true, depthWrite: false }),
    )
    label.position.y = 0.9
    label.renderOrder = 7

    root.add(base, body, bead, label)

    const position = this.toWorld(general.coord.q, general.coord.r)
    root.position.set(position.x, position.y + 0.05, position.z)

    const lineMaterial = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 })
    const pathLine = new THREE.Line(new THREE.BufferGeometry(), lineMaterial)
    pathLine.visible = false

    const ringMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    const targetRing = new THREE.Mesh(
      new THREE.RingGeometry(0.3, 0.42, 6).rotateX(-Math.PI / 2),
      ringMaterial,
    )
    targetRing.visible = false
    targetRing.renderOrder = 4

    // 交战标记：头上交叉双剑，只在交战时显示
    const fightCanvas = document.createElement('canvas')
    drawFightMark(fightCanvas)
    const fightTexture = new THREE.CanvasTexture(fightCanvas)
    fightTexture.colorSpace = THREE.SRGBColorSpace
    const fightMark = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: fightTexture, transparent: true, depthWrite: false }),
    )
    fightMark.scale.set(FIGHT_MARK_HEIGHT, FIGHT_MARK_HEIGHT, 1)
    fightMark.visible = false
    fightMark.renderOrder = 8

    this.group.add(root, pathLine, targetRing, fightMark)

    const token: AgentToken = {
      root,
      pathLine,
      targetRing,
      bodyMaterial,
      lineMaterial,
      ringMaterial,
      label,
      labelCanvas,
      labelTexture,
      labelText: '',
      labelColor: -1,
      labelHpRatio: -1,
      fightMark,
      fightTexture,
      tileKey: `${general.coord.q},${general.coord.r}`,
      baseY: position.y + 0.05,
      phase: this.tokens.size * 1.7,
      move: null,
    }
    this.refreshLabel(token, general)
    return token
  }

  private updateToken(token: AgentToken, general: GeneralState): void {
    this.refreshLabel(token, general)
    const position = this.toWorld(general.coord.q, general.coord.r)

    const tileKey = `${general.coord.q},${general.coord.r}`
    if (tileKey !== token.tileKey) {
      token.tileKey = tileKey
      // 一格一段线性动画：时长小于一个 Tick，播完停住等下个 Tick
      token.move = {
        fromX: token.root.position.x,
        fromY: token.baseY,
        fromZ: token.root.position.z,
        toX: position.x,
        toY: position.y + 0.05,
        toZ: position.z,
        elapsed: 0,
        duration: Math.max(0.06, this.tickSeconds * MOVE_ANIMATION_RATIO),
      }
    }

    const points: THREE.Vector3[] = [new THREE.Vector3(position.x, position.y + 0.32, position.z)]
    for (const step of general.path) {
      const stepPosition = this.toWorld(step.q, step.r)
      points.push(new THREE.Vector3(stepPosition.x, stepPosition.y + 0.32, stepPosition.z))
    }

    token.pathLine.geometry.dispose()
    if (points.length > 1) {
      token.pathLine.geometry = new THREE.BufferGeometry().setFromPoints(points)
      token.pathLine.visible = true
    } else {
      token.pathLine.geometry = new THREE.BufferGeometry()
      token.pathLine.visible = false
    }

    if (general.target) {
      const targetPosition = this.toWorld(general.target.q, general.target.r)
      token.targetRing.position.set(targetPosition.x, targetPosition.y + 0.06, targetPosition.z)
      token.targetRing.visible = true
    } else {
      token.targetRing.visible = false
    }

    if (general.status === 'fighting') {
      token.fightMark.position.set(position.x, position.y + FIGHT_MARK_Y, position.z)
      token.fightMark.visible = true
    } else {
      token.fightMark.visible = false
    }
  }

  private destroyToken(token: AgentToken): void {
    this.group.remove(token.root, token.pathLine, token.targetRing, token.fightMark)

    token.root.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose()
        const materials = Array.isArray(object.material) ? object.material : [object.material]
        for (const material of materials) material.dispose()
      }
    })
    token.pathLine.geometry.dispose()
    ;(token.pathLine.material as THREE.Material).dispose()
    token.targetRing.geometry.dispose()
    ;(token.targetRing.material as THREE.Material).dispose()
    token.fightTexture.dispose()
    ;(token.fightMark.material as THREE.Material).dispose()
    token.labelTexture.dispose()
    ;(token.label.material as THREE.Material).dispose()
  }

  private rebuildOccupation(): void {
    this.destroyOccupationMeshes()
    const occupation = this.occupation
    if (!occupation || occupation.size === 0) return

    const entries: { q: number; r: number; fill: number; border: number | null }[] = []
    for (const [key, faction] of occupation) {
      const [q, r] = key.split(',').map(Number)
      if (q === undefined || r === undefined || Number.isNaN(q) || Number.isNaN(r)) continue
      const style = this.styleFor(faction)
      entries.push({ q, r, fill: style.fill, border: style.border })
    }
    if (entries.length === 0) return

    const dummy = new THREE.Object3D()
    const color = new THREE.Color()

    const fillGeometry = new THREE.ShapeGeometry(hexShape(0.92)).rotateX(-Math.PI / 2)
    const fillMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.58,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    const fillMesh = new THREE.InstancedMesh(fillGeometry, fillMaterial, entries.length)
    fillMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)

    entries.forEach((entry, index) => {
      const position = this.toWorld(entry.q, entry.r)
      dummy.position.set(position.x, position.y + 0.035, position.z)
      dummy.updateMatrix()
      fillMesh.setMatrixAt(index, dummy.matrix)
      fillMesh.setColorAt(index, color.setHex(entry.fill))
    })

    fillMesh.count = entries.length
    if (fillMesh.instanceColor) fillMesh.instanceColor.needsUpdate = true
    fillMesh.computeBoundingSphere()
    fillMesh.renderOrder = 3
    this.group.add(fillMesh)
    this.occupationMesh = fillMesh

    const bordered = entries.filter((entry) => entry.border !== null)
    if (bordered.length === 0) return

    const borderGeometry = new THREE.ShapeGeometry(hexRingShape(0.99, 0.85)).rotateX(-Math.PI / 2)
    const borderMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    const borderMesh = new THREE.InstancedMesh(borderGeometry, borderMaterial, bordered.length)
    borderMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)

    bordered.forEach((entry, index) => {
      const position = this.toWorld(entry.q, entry.r)
      dummy.position.set(position.x, position.y + 0.045, position.z)
      dummy.updateMatrix()
      borderMesh.setMatrixAt(index, dummy.matrix)
      borderMesh.setColorAt(index, color.setHex(entry.border!))
    })

    borderMesh.count = bordered.length
    if (borderMesh.instanceColor) borderMesh.instanceColor.needsUpdate = true
    borderMesh.computeBoundingSphere()
    borderMesh.renderOrder = 4
    this.group.add(borderMesh)
    this.borderMesh = borderMesh
  }

  private styleFor(faction: Faction): RelationStyle {
    if (!this.diplomacy) return { fill: FACTION_COLORS[faction], border: null }
    return relationStyleOf(this.diplomacy, faction)
  }

  private applyTokenColor(token: AgentToken, faction: Faction): void {
    const style = this.styleFor(faction)
    token.bodyMaterial.color.setHex(style.fill)
    token.bodyMaterial.emissive.setHex(style.fill)
    token.lineMaterial.color.setHex(style.fill)
    token.ringMaterial.color.setHex(style.fill)
  }

  /** 头顶名称与世界频道作者名同格式、同配色；下方附兵力条 */
  private refreshLabel(token: AgentToken, general: GeneralState): void {
    const text = formatUnitName(general.faction, general.position ?? '无', general.name)
    const color = this.styleFor(general.faction).fill
    const maxHp = general.maxHp ?? 0
    const ratio = maxHp > 0 ? Math.round(((general.hp ?? maxHp) / maxHp) * 100) / 100 : 1
    if (text === token.labelText && color === token.labelColor && ratio === token.labelHpRatio) {
      return
    }
    token.labelText = text
    token.labelColor = color
    token.labelHpRatio = ratio
    drawLabelSprite(token.labelCanvas, token.labelTexture, token.label, text, color, ratio)
  }

  private destroyOccupationMeshes(): void {
    for (const mesh of [this.occupationMesh, this.borderMesh]) {
      if (!mesh) continue
      this.group.remove(mesh)
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
      mesh.dispose()
    }
    this.occupationMesh = null
    this.borderMesh = null
  }
}

function hexShape(radius: number): THREE.Shape {
  const corners = hexCornerPoints(radius)
  const shape = new THREE.Shape()
  const first = corners[0]!
  shape.moveTo(first.x, first.z)
  for (let i = 1; i < corners.length; i++) shape.lineTo(corners[i]!.x, corners[i]!.z)
  shape.closePath()
  return shape
}

function hexRingShape(outerRadius: number, innerRadius: number): THREE.Shape {
  const shape = hexShape(outerRadius)
  const corners = hexCornerPoints(innerRadius)
  const hole = new THREE.Path()
  const first = corners[0]!
  hole.moveTo(first.x, first.z)
  for (let i = 1; i < corners.length; i++) hole.lineTo(corners[i]!.x, corners[i]!.z)
  hole.closePath()
  shape.holes.push(hole)
  return shape
}

/** 把名称与兵力条绘成 Canvas 贴图；正交相机下 Sprite 始终面向镜头 */
function drawLabelSprite(
  canvas: HTMLCanvasElement,
  texture: THREE.CanvasTexture,
  sprite: THREE.Sprite,
  text: string,
  color: number,
  hpRatio: number,
): void {
  const font = 'bold 40px "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif'
  const probe = canvas.getContext('2d')
  if (!probe) return
  probe.font = font
  const width = Math.ceil(probe.measureText(text).width) + 28
  const height = LABEL_TEXT_PX + BAR_GAP_PX + BAR_HEIGHT_PX

  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.font = font
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 6
  ctx.strokeStyle = 'rgba(4, 8, 12, 0.85)'
  ctx.strokeText(text, width / 2, LABEL_TEXT_PX / 2)
  ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`
  ctx.fillText(text, width / 2, LABEL_TEXT_PX / 2)

  // 兵力条：深色底 + 按比例填充，低于三成转为红色
  const barWidth = width - 24
  const barX = 12
  const barY = LABEL_TEXT_PX + BAR_GAP_PX / 2
  const ratio = Math.min(1, Math.max(0, hpRatio))

  ctx.fillStyle = 'rgba(6, 12, 16, 0.82)'
  ctx.fillRect(barX, barY, barWidth, BAR_HEIGHT_PX)
  ctx.fillStyle = hpColor(ratio)
  ctx.fillRect(barX + 1, barY + 1, Math.max(1, (barWidth - 2) * ratio), BAR_HEIGHT_PX - 2)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)'
  ctx.lineWidth = 2
  ctx.strokeRect(barX, barY, barWidth, BAR_HEIGHT_PX)

  texture.needsUpdate = true
  sprite.scale.set(
    (LABEL_HEIGHT * width) / LABEL_TEXT_PX,
    (LABEL_HEIGHT * height) / LABEL_TEXT_PX,
    1,
  )
}

function hpColor(ratio: number): string {
  if (ratio < 0.3) return '#e04b3a'
  if (ratio < 0.6) return '#e8b23a'
  return '#5ad06a'
}

/** 交叉双剑贴图：两把剑左右交叉，带深色描边，保证在任意地形上都能辨识 */
function drawFightMark(canvas: HTMLCanvasElement): void {
  canvas.width = FIGHT_MARK_PX
  canvas.height = FIGHT_MARK_PX
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, FIGHT_MARK_PX, FIGHT_MARK_PX)
  ctx.translate(FIGHT_MARK_PX / 2, FIGHT_MARK_PX / 2)
  ctx.scale(1.2, 1.2)
  for (const angle of [-Math.PI / 4, Math.PI / 4]) {
    ctx.save()
    ctx.rotate(angle)
    drawSword(ctx)
    ctx.restore()
  }
}

/** 单把剑：剑尖朝上，由上到下依次为剑身、护手、剑柄与剑首 */
function drawSword(ctx: CanvasRenderingContext2D): void {
  ctx.lineJoin = 'round'
  ctx.lineWidth = 3
  ctx.strokeStyle = 'rgba(8, 14, 18, 0.9)'
  ctx.fillStyle = '#f4ede0'

  ctx.beginPath()
  ctx.moveTo(0, -34)
  ctx.lineTo(5, 4)
  ctx.lineTo(0, 8)
  ctx.lineTo(-5, 4)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  ctx.beginPath()
  ctx.rect(-11, 7, 22, 6)
  ctx.fill()
  ctx.stroke()

  ctx.beginPath()
  ctx.rect(-3.5, 13, 7, 12)
  ctx.fill()
  ctx.stroke()

  ctx.beginPath()
  ctx.arc(0, 27, 4.5, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
}
