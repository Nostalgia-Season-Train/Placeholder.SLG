/**
 * Map query layer: converts rendered tile data into movement costs, tile values
 * and the capturable tile list used by the march simulation.
 * Built once at initialization, then treated as read-only.
 */
import { tileKey } from '../../../src-shared/map/hex'
import type { MapData } from '../../../src-shared/map/MapGenerator'
import { getTerrainLevel } from '../../../src-shared/map/terrainLevels'
import type { Coord } from '../../../src-shared/types'

export interface TileInfo {
  coord: Coord
  name: string
  x: number
  z: number
  height: number
  level: number
  moveCost: number
  value: number
  passable: boolean
}

export interface WorldTerrain {
  tiles: Map<string, TileInfo>
  capturable: TileInfo[]
  maxLevel: number
}

const NEIGHBOR_OFFSETS: Coord[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
]

/** All six adjacent tiles of a hex cell */
export function neighbors(coord: Coord): Coord[] {
  return NEIGHBOR_OFFSETS.map((offset) => ({ q: coord.q + offset.q, r: coord.r + offset.r }))
}

export function coordKey(coord: Coord): string {
  return tileKey(coord.q, coord.r)
}

/** Hex distance in axial coordinates */
export function hexDistance(a: Coord, b: Coord): number {
  const dq = a.q - b.q
  const dr = a.r - b.r
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2
}

/**
 * 每个地块占用的 Tick 数。移动按 Tick 一格推进，因此代价必须是整数：
 * 普通地形 1，丘陵与河滩 2，山地与高山不可通行。
 */
const BASE_MOVE_COST = [1, 1, 1, 2, Infinity, Infinity]

export function buildTerrain(map: MapData): WorldTerrain {
  const tiles = new Map<string, TileInfo>()
  const capturable: TileInfo[] = []
  let maxLevel = 0

  for (const tile of map.tiles) {
    const base = BASE_MOVE_COST[Math.max(0, Math.min(5, tile.level))] ?? 1
    // 河滩与丘陵同为慢地形：占 2 个 Tick；关口作为唯一通道同样需要 2 个 Tick
    let moveCost = tile.isBank ? 2 : base
    if (tile.isGate && Number.isFinite(moveCost)) moveCost = Math.max(moveCost, 2)

    const onRoad = tile.isRoad
    const passable = !tile.isWater && !tile.isWall && Number.isFinite(moveCost)
    const value = passable
      ? tile.isGate
        ? 40
        : Math.round((tile.level + 1) * 8 + (onRoad ? 6 : 0) + (tile.isBank ? -4 : 0))
      : 0

    const info: TileInfo = {
      coord: { q: tile.q, r: tile.r },
      name: tile.isWall
        ? '城墙'
        : tile.isGate
          ? '关口'
          : tile.isBank
            ? '河滩'
            : getTerrainLevel(tile.level).name,
      x: tile.x,
      z: tile.z,
      height: tile.height,
      level: tile.level,
      moveCost,
      value,
      passable,
    }

    tiles.set(coordKey(info.coord), info)
    if (passable) capturable.push(info)
    maxLevel = Math.max(maxLevel, info.level)
  }

  return { tiles, capturable, maxLevel }
}

export function getTile(terrain: WorldTerrain, coord: Coord): TileInfo | undefined {
  return terrain.tiles.get(coordKey(coord))
}

/** Nearest passable tile that is not in the excluded set */
export function nearestCapturable(
  terrain: WorldTerrain,
  coord: Coord,
  excluded: Set<string> = new Set(),
): Coord | null {
  let best: Coord | null = null
  let bestDistance = Infinity

  for (const info of terrain.capturable) {
    const key = coordKey(info.coord)
    if (excluded.has(key)) continue
    const distance = hexDistance(coord, info.coord)
    if (distance < bestDistance) {
      bestDistance = distance
      best = info.coord
    }
  }

  return best
}
