/**
 * 3D presentation layer for the march simulation: general tokens, march routes,
 * target rings and occupation overlays.
 * It only consumes simulation snapshots and contains no simulation logic.
 */
import * as THREE from 'three'
import { FACTION_COLORS, type Faction, type GeneralState } from '../bot/types'
import {
  relationStyleOf,
  type Diplomacy,
  type RelationStyle,
} from '../bot/diplomacy'
import { hexCornerPoints } from './hex'

export interface WorldPosition {
  x: number
  z: number
  y: number
}

interface AgentToken {
  root: THREE.Group
  pathLine: THREE.Line
  targetRing: THREE.Mesh
  targetPosition: THREE.Vector3
  bodyMaterial: THREE.MeshStandardMaterial
  lineMaterial: THREE.LineBasicMaterial
  ringMaterial: THREE.MeshBasicMaterial
  phase: number
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

  constructor(toWorld: (q: number, r: number) => WorldPosition) {
    this.toWorld = toWorld
  }

  setAgents(generals: GeneralState[], diplomacy?: Diplomacy): void {
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
    const factor = Math.min(1, dt * 12)

    for (const token of this.tokens.values()) {
      token.root.position.x = THREE.MathUtils.lerp(token.root.position.x, token.targetPosition.x, factor)
      token.root.position.z = THREE.MathUtils.lerp(token.root.position.z, token.targetPosition.z, factor)
      token.root.position.y =
        THREE.MathUtils.lerp(token.root.position.y, token.targetPosition.y, factor) +
        Math.sin(this.elapsed * 2.4 + token.phase) * 0.03

      if (token.targetRing.visible) {
        token.targetRing.scale.setScalar(1 + Math.sin(this.elapsed * 3 + token.phase) * 0.08)
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

    root.add(base, body, bead)

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

    this.group.add(root, pathLine, targetRing)

    return {
      root,
      pathLine,
      targetRing,
      targetPosition: root.position.clone(),
      bodyMaterial,
      lineMaterial,
      ringMaterial,
      phase: this.tokens.size * 1.7,
    }
  }

  private updateToken(token: AgentToken, general: GeneralState): void {
    const position = this.toWorld(general.coord.q, general.coord.r)
    token.targetPosition.set(position.x, position.y + 0.05, position.z)

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
  }

  private destroyToken(token: AgentToken): void {
    this.group.remove(token.root, token.pathLine, token.targetRing)

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
