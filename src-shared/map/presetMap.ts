import { axialToWorld, tileKey, worldToAxial, type PlanePoint } from './hex'
import type { Coord } from '../types'
import { BANK_HEIGHT, GATE_HEIGHT, WALL_HEIGHT, getTerrainLevel } from './terrainLevels'
import {
  hexDistance,
  hexLine,
  sampleCatmullRom,
  type MapBounds,
  type MapData,
  type MapTile,
} from './MapGenerator'

/**
 * 预制大地图：地形、山脉、河流、城墙、关口与道路全部写死在下面，
 * 出生点之外的随机性只来自固定的 PRESET_SEED（装饰物抖动与推演随机数）。
 */

const COLS = 34
const ROWS = 34
/** 轴向坐标原点：q 与 r 都从 -17 到 16 */
const ORIGIN = -17
const PRESET_SEED = 20261021

/**
 * 地形基底，逐行对应 r = -17 → 16，逐列对应 q = -17 → 16。
 * 0 荒地 / 1 草地 / 2 林地 / 3 丘陵；山脉、河流与城墙由下方配置覆盖。
 */
const TERRAIN = `
1111111111111111110000011111111111
1111111111222221100000011111111111
1111111112222221000000011111111111
1111111122222221000000111111133331
1111111222222221000001111111333331
1111112222222221000011111113333331
1111112222222211111111111133333331
1111112222222111111111111133333311
1111112222221111111111111133333111
1111112222211111111111111133331111
1111111111111111111111111122221111
1111111111111111111111111222221111
1111111111111111111111112222221111
1111111111111111111111122222221111
1111111111111111111111122222211111
1111113333111111111111122222111111
1111133333111111111111122221111000
1111333333111111111111111111110000
1113333333111111111111111111100000
1000333331111111111111111111000000
0000333311111111111111111111000000
0000333111111111111111111112000001
0001111111111111111111111122000011
0011122221111111111111111222222111
1111222221111111111111112222222111
1112222221111111111111112222221111
1122222221111111111133332222211111
1122222211111111111333332222111111
1122222111111111113333331111111111
1122221111111111133333331111111111
1111111111111111133333311111111111
1111111111111111133333111111111111
1111111111111111133331111111111111
1111111111111111111111111111111111
`.trim()

/**
 * 三条分界线的内段城墙链，自中心向边缘延伸；链末接连续高山。
 * 出生点所在的三块区域只靠链上的关口互通。
 */
const WALL_CHAINS: Coord[][] = [
  [
    { q: 0, r: 0 },
    { q: -1, r: 0 },
    { q: -1, r: -1 },
    { q: -2, r: -1 },
    { q: -2, r: -2 },
    { q: -3, r: -2 },
    { q: -3, r: -3 },
  ],
  [
    { q: 1, r: -1 },
    { q: 2, r: -1 },
    { q: 3, r: -2 },
    { q: 4, r: -2 },
    { q: 5, r: -2 },
    { q: 6, r: -3 },
  ],
  [
    { q: 0, r: 1 },
    { q: -1, r: 2 },
    { q: -1, r: 3 },
    { q: -2, r: 4 },
    { q: -2, r: 5 },
    { q: -3, r: 6 },
  ],
]

/** 三座关口，分别位于三条城墙链上，隔开三块出生区域 */
const GATES: Coord[] = [
  { q: -2, r: -2 },
  { q: 4, r: -2 },
  { q: -2, r: 4 },
]

/** 城墙链末端继续向地图边缘堆起三格宽的高山，封死绕行 */
const RIDGES: { from: Coord; to: Coord }[] = [
  { from: { q: -4, r: -3 }, to: { q: -17, r: -17 } },
  { from: { q: 7, r: -3 }, to: { q: 16, r: -8 } },
  { from: { q: -3, r: 7 }, to: { q: -8, r: 16 } },
]

/** 两条河自地图边缘流入腹地，末端积成小湖；河面不可通行，沿岸为河滩 */
const RIVER_CONTROLS: Coord[][] = [
  [
    { q: -6, r: -17 },
    { q: -4, r: -14 },
    { q: -5, r: -11 },
    { q: -3, r: -8 },
  ],
  [
    { q: -17, r: 8 },
    { q: -14, r: 10 },
    { q: -11, r: 11 },
    { q: -10, r: 13 },
  ],
]

/** 河末端的湖泊，与河道连成一片水面 */
const LAKES: Coord[] = [
  { q: -3, r: -8 },
  { q: -10, r: 13 },
]
const LAKE_RADIUS = 1

/** 三处出生点，顺序与阵营顺序一致；只有出生点保留为可调整的配置项 */
const SPAWNS: Coord[] = [
  { q: 5, r: -10 },
  { q: 6, r: 6 },
  { q: -12, r: 6 },
]

/** 每处出生点所在区域相邻的两个关口；道路按此配对从出生点铺到关口 */
const SPAWN_GATES: number[][] = [
  [0, 1],
  [1, 2],
  [2, 0],
]

const NEIGHBOR_OFFSETS: Coord[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
]

export function loadPresetMap(): MapData {
  const tiles: MapTile[] = []
  const rows = TERRAIN.split('\n')

  for (let r = 0; r < ROWS; r++) {
    const row = rows[r] ?? ''
    for (let q = 0; q < COLS; q++) {
      const level = Number(row[q] ?? '1')
      const coord = { q: q + ORIGIN, r: r + ORIGIN }
      const { x, z } = axialToWorld(coord.q, coord.r)
      tiles.push({
        q: coord.q,
        r: coord.r,
        x,
        z,
        level,
        height: getTerrainLevel(level).height,
        isBank: false,
        isWater: false,
        isWall: false,
        isGate: false,
        isRoad: false,
      })
    }
  }

  const tileMap = new Map<string, MapTile>()
  for (const tile of tiles) tileMap.set(tileKey(tile.q, tile.r), tile)

  const rivers = stampRivers(tiles, tileMap)
  stampWalls(tileMap)
  stampRidges(tileMap)
  for (const spawn of SPAWNS) flattenPocket(tileMap, spawn)
  stampRoads(tileMap)

  return {
    seed: PRESET_SEED,
    cols: COLS,
    rows: ROWS,
    tiles,
    tileMap,
    rivers,
    bounds: computeBounds(tiles),
    spawns: SPAWNS.map((spawn) => ({ ...spawn })),
  }
}

/** 地块查找；造图阶段用它确认坐标是否落在地图内 */
function tileAt(tileMap: Map<string, MapTile>, coord: Coord): MapTile | undefined {
  return tileMap.get(tileKey(coord.q, coord.r))
}

/** 把河道的世界坐标折线落成连续的水面瓦片，再按邻接关系补一圈河滩 */
function stampRivers(tiles: MapTile[], tileMap: Map<string, MapTile>): PlanePoint[][] {
  const rivers: PlanePoint[][] = []
  const water = new Set<string>()

  for (const controls of RIVER_CONTROLS) {
    const points = sampleCatmullRom(
      controls.map((coord) => axialToWorld(coord.q, coord.r)),
      10,
    )
    rivers.push(points)

    let previous: Coord | null = null
    for (const point of points) {
      const coord = worldToAxial(point.x, point.z)
      if (previous) {
        for (const along of hexLine(previous, coord)) water.add(tileKey(along.q, along.r))
      }
      water.add(tileKey(coord.q, coord.r))
      previous = coord
    }
  }

  for (const lake of LAKES) {
    for (const tile of tiles) {
      if (hexDistance(tile, lake) <= LAKE_RADIUS) water.add(tileKey(tile.q, tile.r))
    }
  }

  for (const key of water) {
    const tile = tileMap.get(key)
    if (!tile) continue
    tile.isWater = true
    tile.isBank = false
    tile.level = 0
    tile.height = BANK_HEIGHT
  }

  for (const tile of tiles) {
    if (tile.isWater) continue
    const nearWater = NEIGHBOR_OFFSETS.some((offset) => {
      const neighbor = tileAt(tileMap, { q: tile.q + offset.q, r: tile.r + offset.r })
      return neighbor?.isWater
    })
    if (!nearWater) continue
    tile.isBank = true
    tile.level = 0
    tile.height = BANK_HEIGHT
  }

  return rivers
}

/** 按配置铺城墙链，链上的关口位置换成可通行的关口瓦片 */
function stampWalls(tileMap: Map<string, MapTile>): void {
  const gateKeys = new Set(GATES.map((gate) => tileKey(gate.q, gate.r)))
  for (const chain of WALL_CHAINS) {
    for (const coord of chain) {
      const tile = tileAt(tileMap, coord)
      if (!tile) continue
      const isGateTile = gateKeys.has(tileKey(coord.q, coord.r))
      tile.isWall = !isGateTile
      tile.isGate = isGateTile
      tile.isWater = false
      tile.isBank = false
      tile.isRoad = false
      tile.level = 1
      tile.height = isGateTile ? GATE_HEIGHT : WALL_HEIGHT
    }
  }
}

/** 城墙链外侧的山脊：三格宽连续高山，避免贴着城墙绕行 */
function stampRidges(tileMap: Map<string, MapTile>): void {
  for (const ridge of RIDGES) {
    for (const coord of hexLine(ridge.from, ridge.to)) {
      const tile = tileAt(tileMap, coord)
      if (tile) paintMountain(tile)
      for (const offset of NEIGHBOR_OFFSETS) {
        const side = tileAt(tileMap, { q: coord.q + offset.q, r: coord.r + offset.r })
        if (side) paintMountain(side)
      }
    }
  }
}

function paintMountain(tile: MapTile): void {
  if (tile.isGate || tile.isWall) return
  tile.isWater = false
  tile.isBank = false
  tile.isRoad = false
  tile.level = 5
  tile.height = getTerrainLevel(5).height
}

/** 出生点与周围一圈必须是可站立的草地 */
function flattenPocket(tileMap: Map<string, MapTile>, center: Coord): void {
  for (const coord of [center, ...NEIGHBOR_OFFSETS.map((offset) => ({ q: center.q + offset.q, r: center.r + offset.r }))]) {
    const tile = tileAt(tileMap, coord)
    if (!tile || tile.isWall || tile.isGate) continue
    tile.isWater = false
    tile.isBank = false
    tile.isRoad = false
    tile.level = 1
    tile.height = getTerrainLevel(1).height
  }
}

/**
 * 道路在地形定案后二次生成：从每处出生点沿可通行地块找到最短路线，
 * 一直铺到相邻的两座关口；关口瓦片自身不铺路面。
 */
function stampRoads(tileMap: Map<string, MapTile>): void {
  SPAWNS.forEach((spawn, index) => {
    for (const gateIndex of SPAWN_GATES[index] ?? []) {
      const gate = GATES[gateIndex]
      if (!gate) continue
      const path = shortestPath(spawn, gate, tileMap)
      if (!path) continue
      for (const coord of path) {
        const tile = tileAt(tileMap, coord)
        if (!tile || tile.isGate) continue
        tile.isRoad = true
      }
    }
  })
}

/** 可通行判定：水面、城墙与山地高山不可通行，河滩与关口可通行 */
function isPassable(tile: MapTile): boolean {
  return !tile.isWater && !tile.isWall && tile.level < 4
}

/** 固定邻域顺序的广度优先寻路，保证同一份配置每次得到同一条道路 */
function shortestPath(
  start: Coord,
  goal: Coord,
  tileMap: Map<string, MapTile>,
): Coord[] | null {
  const startKey = tileKey(start.q, start.r)
  const goalKey = tileKey(goal.q, goal.r)
  const previous = new Map<string, string | null>([[startKey, null]])
  const coordOf = new Map<string, Coord>([[startKey, start]])
  const queue: Coord[] = [start]

  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]!
    const currentKey = tileKey(current.q, current.r)
    if (currentKey === goalKey) break
    for (const offset of NEIGHBOR_OFFSETS) {
      const next = { q: current.q + offset.q, r: current.r + offset.r }
      const key = tileKey(next.q, next.r)
      if (previous.has(key)) continue
      const tile = tileAt(tileMap, next)
      if (!tile || !isPassable(tile)) continue
      previous.set(key, currentKey)
      coordOf.set(key, next)
      queue.push(next)
    }
  }

  if (!previous.has(goalKey)) return null
  const path: Coord[] = []
  let key: string | null = goalKey
  while (key !== null) {
    path.push(coordOf.get(key)!)
    key = previous.get(key) ?? null
  }
  return path.reverse()
}

function computeBounds(tiles: MapTile[]): MapBounds {
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const tile of tiles) {
    minX = Math.min(minX, tile.x)
    maxX = Math.max(maxX, tile.x)
    minZ = Math.min(minZ, tile.z)
    maxZ = Math.max(maxZ, tile.z)
  }
  return { minX, maxX, minZ, maxZ }
}
