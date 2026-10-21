import * as THREE from 'three'
import type { PlanePoint } from './hex'
import { terrainHeightAt, type MapData } from './MapGenerator'
import { createRibbon } from './ribbon'

/** 沿路径取局部最高地形并做平滑，路面既不会悬空也不会被地形顶穿 */
function roadSurfaceHeights(map: MapData, road: PlanePoint[]): number[] {
  const base = road.map((p) => terrainHeightAt(map, p.x, p.z))

  const envelope = base.map((_, index) => {
    let max = 0
    for (let i = Math.max(0, index - 3); i <= Math.min(base.length - 1, index + 3); i++) {
      max = Math.max(max, base[i]!)
    }
    return max
  })

  return envelope.map((_, index) => {
    let sum = 0
    let count = 0
    for (let i = index - 4; i <= index + 4; i++) {
      if (i >= 0 && i < envelope.length) {
        sum += envelope[i]!
        count++
      }
    }
    return sum / count
  })
}

/** 道路层：贴地的土黄色路面 */
export class RoadLayer {
  readonly group = new THREE.Group()
  private readonly material: THREE.MeshStandardMaterial
  private readonly geometries: THREE.BufferGeometry[] = []

  constructor(roads: PlanePoint[][], map: MapData) {
    this.material = new THREE.MeshStandardMaterial({
      color: 0xb19468,
      roughness: 1,
      metalness: 0,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    })

    for (const road of roads) {
      const heights = roadSurfaceHeights(map, road)
      const points = road.map(
        (p, index) => new THREE.Vector3(p.x, Math.max(heights[index]!, 0.12) + 0.03, p.z),
      )
      const geometry = createRibbon(points, 0.48, 0.3)
      this.geometries.push(geometry)
      this.group.add(new THREE.Mesh(geometry, this.material))
    }
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose()
    this.material.dispose()
    this.group.clear()
  }
}
