/**
 * 3D presentation layer for faction home cities: hex base, walls, towers,
 * a faction-colored banner and a pulsing departure ring.
 * It only consumes city data from the simulation snapshot.
 */
import * as THREE from 'three'
import { FACTION_COLORS, type BaseCity } from '@shared/types'
import { relationStyleOf, type Diplomacy } from '../bot/diplomacy'
import type { WorldPosition } from './AgentLayer'

interface CityToken {
  root: THREE.Group
  ring: THREE.Mesh
  banner: THREE.Mesh
  phase: number
}

export class CityLayer {
  readonly group = new THREE.Group()
  private readonly toWorld: (q: number, r: number) => WorldPosition
  private readonly tokens = new Map<string, CityToken>()
  private readonly cityByKey = new Map<string, BaseCity>()
  private elapsed = 0
  private signature = ''
  private diplomacy: Diplomacy | null = null

  constructor(toWorld: (q: number, r: number) => WorldPosition) {
    this.toWorld = toWorld
  }

  setCities(cities: BaseCity[], diplomacy?: Diplomacy): void {
    if (diplomacy) this.diplomacy = diplomacy

    const signature = [
      this.diplomacy?.playerFaction ?? '',
      ...cities.map((city) => `${city.faction}:${city.coord.q},${city.coord.r}`),
    ].join('|')
    if (signature === this.signature) return

    this.clear()
    this.signature = signature
    cities.forEach((city, index) => this.addCity(city, index))
  }

  setDiplomacy(diplomacy: Diplomacy): void {
    if (this.diplomacy?.playerFaction === diplomacy.playerFaction) return
    this.diplomacy = diplomacy
    this.signature = ''
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
    for (const token of this.tokens.values()) {
      this.group.remove(token.root)
      disposeObject(token.root)
    }
    this.tokens.clear()
    this.cityByKey.clear()
    this.signature = ''
  }

  dispose(): void {
    this.clear()
    this.group.clear()
  }

  /* ------------------------------------------------------------------ */

  private addCity(city: BaseCity, index: number): void {
    const key = `${city.faction}:${city.coord.q},${city.coord.r}`
    if (this.cityByKey.has(key)) return

    const color = this.diplomacy
      ? relationStyleOf(this.diplomacy, city.faction).fill
      : FACTION_COLORS[city.faction]
    const position = this.toWorld(city.coord.q, city.coord.r)
    const root = new THREE.Group()
    root.position.set(position.x, position.y, position.z)
    root.userData.cityKey = key

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

    const banner = new THREE.Mesh(
      new THREE.PlaneGeometry(0.26, 0.15),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.95,
        side: THREE.DoubleSide,
      }),
    )
    banner.position.set(0.45, 0.56, 0)

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.86, 0.98, 6).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.4,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    )
    ring.position.y = 0.02
    ring.renderOrder = 4

    root.add(pole, banner, ring)

    this.tokens.set(key, { root, ring, banner, phase: index * 1.9 })
    this.cityByKey.set(key, city)
    this.group.add(root)
  }
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    child.geometry.dispose()
    const materials = Array.isArray(child.material) ? child.material : [child.material]
    for (const material of materials) material.dispose()
  })
}
