import * as THREE from 'three'
import { HEX_RADIUS } from '@shared/map/hex'
import { tileRng, type MapData, type MapTile } from '@shared/map/MapGenerator'
import {
  BANK_COLOR,
  BANK_HEIGHT,
  GATE_COLOR,
  WALL_COLOR,
  getTerrainLevel,
} from '@shared/map/terrainLevels'

interface DecorInstance {
  x: number
  y: number
  z: number
  rotY: number
  scale: number
  color: number
}

interface DecorSpec {
  geometry: THREE.BufferGeometry
  material: THREE.MeshStandardMaterial
  items: DecorInstance[]
}

/**
 * 地形层：所有六边形地块合成一个 InstancedMesh，
 * 装饰物按类型各合成一个 InstancedMesh，整张地图只有个位数 draw call。
 */
export class TerrainLayer {
  readonly group = new THREE.Group()
  readonly pickMesh: THREE.InstancedMesh

  constructor(map: MapData) {
    this.pickMesh = this.buildTiles(map)
    this.group.add(this.pickMesh)
    this.buildDecorations(map)
  }

  private buildTiles(map: MapData): THREE.InstancedMesh {
    const geometry = new THREE.CylinderGeometry(HEX_RADIUS, HEX_RADIUS, 1, 6, 1, false)
    geometry.translate(0, 0.5, 0)
    paintFaceColors(geometry)

    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.96,
      metalness: 0,
    })

    const mesh = new THREE.InstancedMesh(geometry, material, map.tiles.length)
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)

    const dummy = new THREE.Object3D()
    const color = new THREE.Color()

    map.tiles.forEach((tile, index) => {
      dummy.position.set(tile.x, 0, tile.z)
      dummy.scale.set(1, tile.height, 1)
      dummy.rotation.set(0, 0, 0)
      dummy.updateMatrix()
      mesh.setMatrixAt(index, dummy.matrix)

      const baseColor = tile.isWall
        ? WALL_COLOR
        : tile.isGate
          ? GATE_COLOR
          : tile.isBank
            ? BANK_COLOR
            : getTerrainLevel(tile.level).color
      const shade = 0.94 + tileRng(map.seed, tile.q, tile.r)() * 0.1
      color.setHex(baseColor).multiplyScalar(shade)
      mesh.setColorAt(index, color)
    })

    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.computeBoundingSphere()
    return mesh
  }

  private buildDecorations(map: MapData): void {
    const tufts: DecorInstance[] = []
    const bushes: DecorInstance[] = []
    const trunks: DecorInstance[] = []
    const canopies: DecorInstance[] = []
    const rocks: DecorInstance[] = []
    const peaks: DecorInstance[] = []
    const tallPeaks: DecorInstance[] = []
    const snowCaps: DecorInstance[] = []
    const merlons: DecorInstance[] = []
    const gatePosts: DecorInstance[] = []
    const gateLintels: DecorInstance[] = []

    const tint = (hex: number, rand: () => number, amount = 0.1) =>
      new THREE.Color(hex).offsetHSL(0, (rand() - 0.5) * 0.03, (rand() - 0.5) * amount).getHex()

    for (const tile of map.tiles) {
      const rand = tileRng(map.seed, tile.q, tile.r)
      const top = tile.height

      if (tile.isBank && !tile.isWall && !tile.isGate) continue

      const scatter = (radius: number): DecorInstance => {
        const angle = rand() * Math.PI * 2
        const distance = Math.sqrt(rand()) * radius * HEX_RADIUS
        return {
          x: tile.x + Math.cos(angle) * distance,
          y: top,
          z: tile.z + Math.sin(angle) * distance,
          rotY: rand() * Math.PI * 2,
          scale: 0.8 + rand() * 0.5,
          color: 0xffffff,
        }
      }

      const addTufts = (count: number, hex: number) => {
        for (let i = 0; i < count; i++) {
          const item = scatter(0.6)
          item.color = tint(hex, rand)
          tufts.push(item)
        }
      }

      const addBushes = (count: number) => {
        for (let i = 0; i < count; i++) {
          const item = scatter(0.58)
          item.color = tint(0x3f6a2d, rand, 0.12)
          bushes.push(item)
        }
      }

      const addTrees = (count: number) => {
        for (let i = 0; i < count; i++) {
          const item = scatter(0.52)
          trunks.push({ ...item, color: tint(0x5a4630, rand, 0.08) })
          canopies.push({ ...item, y: top, color: tint(0x2f5a2a, rand, 0.14) })
        }
      }

      const addRocks = (count: number) => {
        for (let i = 0; i < count; i++) {
          const item = scatter(0.6)
          item.color = tint(0x8a8578, rand, 0.16)
          rocks.push(item)
        }
      }

      if (tile.isWall) {
        // 城墙顶部的垛口
        for (let i = 0; i < 3; i++) {
          const item = scatter(0.55)
          item.scale = 1.05 + rand() * 0.2
          item.color = tint(0x7c8088, rand, 0.1)
          merlons.push(item)
        }
        continue
      }

      if (tile.isGate) {
        // 关口两侧的门柱与横梁，朝向地图中心
        const facing = Math.atan2(-tile.z, -tile.x)
        const sideways = facing + Math.PI / 2
        for (const side of [-1, 1]) {
          gatePosts.push({
            x: tile.x + Math.cos(sideways) * 0.24 * side,
            y: top,
            z: tile.z + Math.sin(sideways) * 0.24 * side,
            rotY: 0,
            scale: 1,
            color: tint(0x8b6f3e, rand, 0.08),
          })
        }
        gateLintels.push({
          x: tile.x,
          y: top + 0.26,
          z: tile.z,
          rotY: -sideways,
          scale: 1,
          color: GATE_COLOR,
        })
        continue
      }

      switch (tile.level) {
        case 0:
          addTufts(2 + Math.floor(rand() * 2), 0x8f8c52)
          break
        case 1:
          addTufts(5 + Math.floor(rand() * 3), 0x5f8a30)
          break
        case 2:
          addTufts(3 + Math.floor(rand() * 2), 0x5f8a30)
          addBushes(1 + Math.floor(rand() * 2))
          addTrees(1 + Math.floor(rand() * 2))
          break
        case 3:
          addTrees(2 + Math.floor(rand() * 2))
          addRocks(2 + Math.floor(rand() * 2))
          addBushes(1)
          break
        case 4: {
          const item = scatter(0.12)
          item.scale = 0.85 + rand() * 0.3
          item.color = tint(0x6e6a61, rand, 0.1)
          peaks.push(item)
          addRocks(2 + Math.floor(rand() * 3))
          if (rand() > 0.55) addTrees(1)
          break
        }
        case 5: {
          const item = scatter(0.1)
          item.scale = 0.9 + rand() * 0.25
          item.color = tint(0x757a80, rand, 0.08)
          tallPeaks.push(item)
          snowCaps.push({ ...item, color: 0xf2f6f8 })
          addRocks(2 + Math.floor(rand() * 2))
          break
        }
      }
    }

    const specs: DecorSpec[] = [
      {
        geometry: coneGeometry(0.07, 0.26, 4, 0),
        material: decorMaterial(false),
        items: tufts,
      },
      {
        geometry: new THREE.IcosahedronGeometry(0.15, 0).translate(0, 0.1, 0),
        material: decorMaterial(false),
        items: bushes,
      },
      {
        geometry: new THREE.CylinderGeometry(0.03, 0.045, 0.2, 5).translate(0, 0.1, 0),
        material: decorMaterial(false),
        items: trunks,
      },
      {
        geometry: coneGeometry(0.19, 0.5, 6, 0.16),
        material: decorMaterial(false),
        items: canopies,
      },
      {
        geometry: new THREE.DodecahedronGeometry(0.12, 0).translate(0, 0.09, 0),
        material: decorMaterial(true),
        items: rocks,
      },
      {
        geometry: coneGeometry(0.42, 1.1, 6, 0),
        material: decorMaterial(true),
        items: peaks,
      },
      {
        geometry: coneGeometry(0.5, 1.6, 6, 0),
        material: decorMaterial(true),
        items: tallPeaks,
      },
      {
        geometry: coneGeometry(0.18, 0.45, 6, 1.15),
        material: decorMaterial(false),
        items: snowCaps,
      },
      {
        geometry: new THREE.BoxGeometry(0.13, 0.18, 0.13).translate(0, 0.09, 0),
        material: decorMaterial(false),
        items: merlons,
      },
      {
        geometry: new THREE.CylinderGeometry(0.045, 0.06, 0.3, 6).translate(0, 0.15, 0),
        material: decorMaterial(false),
        items: gatePosts,
      },
      {
        geometry: new THREE.BoxGeometry(0.52, 0.1, 0.14),
        material: decorMaterial(false),
        items: gateLintels,
      },
    ]

    const dummy = new THREE.Object3D()
    const color = new THREE.Color()

    for (const spec of specs) {
      if (spec.items.length === 0) {
        spec.geometry.dispose()
        spec.material.dispose()
        continue
      }

      const mesh = new THREE.InstancedMesh(spec.geometry, spec.material, spec.items.length)
      spec.items.forEach((item, index) => {
        dummy.position.set(item.x, item.y, item.z)
        dummy.rotation.set(0, item.rotY, 0)
        dummy.scale.setScalar(item.scale)
        dummy.updateMatrix()
        mesh.setMatrixAt(index, dummy.matrix)
        color.setHex(item.color)
        mesh.setColorAt(index, color)
      })
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.computeBoundingSphere()
      this.group.add(mesh)
    }
  }

  dispose(): void {
    this.group.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.InstancedMesh) {
        object.geometry.dispose()
        const materials = Array.isArray(object.material) ? object.material : [object.material]
        for (const material of materials) material.dispose()
      }
    })
    this.group.clear()
  }
}

function decorMaterial(flat: boolean): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.95,
    metalness: 0,
    flatShading: flat,
  })
}

function coneGeometry(radius: number, height: number, segments: number, baseOffset: number): THREE.BufferGeometry {
  return new THREE.ConeGeometry(radius, height, segments).translate(0, baseOffset + height / 2, 0)
}

/**
 * 给六棱柱的侧面/顶面/底面写入不同的明暗系数，
 * 这样单色 instanceColor 也能得到清晰的地块立体感。
 */
function paintFaceColors(geometry: THREE.BufferGeometry): void {
  const index = geometry.getIndex()
  const position = geometry.getAttribute('position')
  if (!index) return

  const colors = new Float32Array(position.count * 3).fill(1)
  for (const group of geometry.groups) {
    const factor = group.materialIndex === 1 ? 1 : group.materialIndex === 0 ? 0.72 : 0.45
    for (let i = group.start; i < group.start + group.count; i++) {
      const vertex = index.getX(i)
      colors[vertex * 3] = factor
      colors[vertex * 3 + 1] = factor
      colors[vertex * 3 + 2] = factor
    }
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
}

export function tileTopY(tile: MapTile): number {
  return tile.isBank ? BANK_HEIGHT : tile.height
}
