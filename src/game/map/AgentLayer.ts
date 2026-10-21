/**
 * 3D presentation layer for the march simulation: general tokens, march routes,
 * target rings and occupation overlays.
 * It only consumes simulation snapshots and contains no simulation logic.
 */
import * as THREE from 'three'
import { FACTION_COLORS, type Faction, type GeneralState } from '../bot/types'
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
  phase: number
}

export class AgentLayer {
  readonly group = new THREE.Group()
  private readonly toWorld: (q: number, r: number) => WorldPosition
  private readonly tokens = new Map<string, AgentToken>()
  private occupationMesh: THREE.InstancedMesh | null = null
  private elapsed = 0

  constructor(toWorld: (q: number, r: number) => WorldPosition) {
    this.toWorld = toWorld
  }

  setAgents(generals: GeneralState[]): void {
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
      this.updateToken(token, general)
    }
  }

  /** Occupation overlays are rebuilt as a whole on ownership change; tile count is bounded */
  setOccupations(occupation: Map<string, Faction>): void {
    this.destroyOccupationMesh()
    if (occupation.size === 0) return

    const corners = hexCornerPoints(0.92)
    const shape = new THREE.Shape()
    const first = corners[0]!
    shape.moveTo(first.x, first.z)
    for (let i = 1; i < corners.length; i++) shape.lineTo(corners[i]!.x, corners[i]!.z)
    shape.closePath()

    const geometry = new THREE.ShapeGeometry(shape)
    geometry.rotateX(-Math.PI / 2)

    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.58,
      side: THREE.DoubleSide,
      depthWrite: false,
    })

    const mesh = new THREE.InstancedMesh(geometry, material, occupation.size)
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)

    const dummy = new THREE.Object3D()
    const color = new THREE.Color()
    let index = 0

    for (const [key, faction] of occupation) {
      const [q, r] = key.split(',').map(Number)
      if (q === undefined || r === undefined || Number.isNaN(q) || Number.isNaN(r)) continue

      const position = this.toWorld(q, r)
      dummy.position.set(position.x, position.y + 0.035, position.z)
      dummy.updateMatrix()
      mesh.setMatrixAt(index, dummy.matrix)
      mesh.setColorAt(index, color.setHex(FACTION_COLORS[faction]))
      index += 1
    }

    mesh.count = index
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.computeBoundingSphere()
    mesh.renderOrder = 3

    this.group.add(mesh)
    this.occupationMesh = mesh
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
    this.destroyOccupationMesh()
  }

  dispose(): void {
    this.clear()
    this.group.clear()
  }

  /* ------------------------------------------------------------------ */

  private createToken(general: GeneralState): AgentToken {
    const color = FACTION_COLORS[general.faction]
    const root = new THREE.Group()

    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.25, 0.29, 0.07, 6),
      new THREE.MeshStandardMaterial({ color: 0x14212a, roughness: 0.8, metalness: 0.2 }),
    )
    base.position.y = 0.035

    const body = new THREE.Mesh(
      new THREE.ConeGeometry(0.17, 0.52, 6),
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.35,
        roughness: 0.55,
        metalness: 0.15,
      }),
    )
    body.position.y = 0.32

    const bead = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 12, 8),
      new THREE.MeshStandardMaterial({ color: 0xf2ead6, emissive: 0xf2ead6, emissiveIntensity: 0.4 }),
    )
    bead.position.y = 0.6

    root.add(base, body, bead)

    const position = this.toWorld(general.coord.q, general.coord.r)
    root.position.set(position.x, position.y + 0.05, position.z)

    const pathLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 }),
    )
    pathLine.visible = false

    const targetRing = new THREE.Mesh(
      new THREE.RingGeometry(0.3, 0.42, 6).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.7,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    )
    targetRing.visible = false
    targetRing.renderOrder = 4

    this.group.add(root, pathLine, targetRing)

    return {
      root,
      pathLine,
      targetRing,
      targetPosition: root.position.clone(),
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

  private destroyOccupationMesh(): void {
    if (!this.occupationMesh) return
    this.group.remove(this.occupationMesh)
    this.occupationMesh.geometry.dispose()
    ;(this.occupationMesh.material as THREE.Material).dispose()
    this.occupationMesh.dispose()
    this.occupationMesh = null
  }
}
