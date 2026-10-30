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
 * 预制大地图：地形斑块、分界城墙链、关口、山脊与河流全部写死在下面，
 * 出生点之外的随机性只来自固定的 PRESET_SEED（装饰物抖动与推演随机数）。
 */

const COLS = 68
const ROWS = 68
/** 轴向坐标原点：q 与 r 都从 -34 到 33 */
const ORIGIN = -34
const PRESET_SEED = 20261021

const CENTER: Coord = { q: 0, r: 0 }

/**
 * 草地基底上的固定地形斑块，按数组顺序覆盖。
 * 0 荒原 / 2 林地 / 3 丘陵；三者都可通行，只改变地形外观与价值。
 */
const TERRAIN_PATCHES: { level: number; radius: number; center: Coord }[] = [
  // 东北区域
  { level: 2, radius: 5, center: { q: 24, r: -18 } },
  { level: 2, radius: 4, center: { q: 16, r: -24 } },
  { level: 2, radius: 4, center: { q: 28, r: -6 } },
  { level: 3, radius: 3, center: { q: 10, r: -30 } },
  // 西北区域
  { level: 3, radius: 4, center: { q: 0, r: -14 } },
  { level: 3, radius: 5, center: { q: -10, r: -18 } },
  { level: 0, radius: 3, center: { q: 12, r: -14 } },
  { level: 2, radius: 4, center: { q: 4, r: -28 } },
  // 西南区域
  { level: 0, radius: 5, center: { q: -24, r: -2 } },
  { level: 0, radius: 4, center: { q: -16, r: 10 } },
  { level: 3, radius: 4, center: { q: -28, r: 12 } },
  { level: 2, radius: 4, center: { q: -26, r: 4 } },
  // 东南区域
  { level: 2, radius: 5, center: { q: 10, r: 18 } },
  { level: 2, radius: 4, center: { q: -4, r: 28 } },
  { level: 3, radius: 3, center: { q: 0, r: 26 } },
  { level: 0, radius: 4, center: { q: -12, r: 26 } },
  // 中央腹地
  { level: 0, radius: 2, center: { q: 0, r: 8 } },
  { level: 0, radius: 2, center: { q: -8, r: 2 } },
  { level: 2, radius: 2, center: { q: 8, r: -2 } },
  { level: 3, radius: 2, center: { q: -2, r: -8 } },
  { level: 2, radius: 2, center: { q: 6, r: 4 } },
]

/**
 * 四条分界线把地图切成四块：内段城墙链、链上留一座关口、外段三格宽山脊直达地图角落。
 * 相邻两个 60° 方向交替使用，使这条链的走向落在两个方向之间（30° / 210°）；
 * steps 只有一个方向时为沿该方向的直线（120° / 300°）。
 */
interface BoundarySpec {
  steps: Coord[]
  /** 城墙链半径 */
  wallRadius: number
  /** 关口距中心的格数 */
  gateRadius: number
  /** 山脊终点，取地图角落，保证四块区域除关口外完全隔开 */
  ridgeTo: Coord
}

const BOUNDARIES: BoundarySpec[] = [
  {
    steps: [
      { q: 1, r: 0 },
      { q: 0, r: 1 },
    ],
    wallRadius: 12,
    gateRadius: 8,
    ridgeTo: { q: 33, r: 33 },
  },
  {
    steps: [{ q: -1, r: 1 }],
    wallRadius: 12,
    gateRadius: 8,
    ridgeTo: { q: -33, r: 33 },
  },
  {
    steps: [
      { q: -1, r: 0 },
      { q: 0, r: -1 },
    ],
    wallRadius: 12,
    gateRadius: 8,
    ridgeTo: { q: -34, r: -34 },
  },
  {
    steps: [{ q: 1, r: -1 }],
    wallRadius: 12,
    gateRadius: 8,
    ridgeTo: { q: 33, r: -33 },
  },
]

/** 三处出生点，顺序与同盟顺序一致；东南区域暂作中立区，不设主城 */
const SPAWNS: Coord[] = [
  { q: 6, r: -20 },
  { q: 19, r: -6 },
  { q: -19, r: 6 },
]

/** 每处出生点所在区域相邻的两个关口；道路按此配对从出生点铺到关口 */
const SPAWN_GATES: number[][] = [
  [2, 3],
  [3, 0],
  [1, 2],
]

/** 四个区域各自的两座关口，两两铺一条路，保证没有主城的区域也有路网 */
const REGION_GATE_PAIRS: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
]

/** 两条河自地图外侧流入腹地，末端积成小湖；河面不可通行，沿岸为河滩 */
const RIVER_CONTROLS: Coord[][] = [
  [
    { q: -14, r: -34 },
    { q: -12, r: -30 },
    { q: -10, r: -26 },
    { q: -8, r: -24 },
  ],
  [
    { q: 33, r: -16 },
    { q: 30, r: -15 },
    { q: 27, r: -14 },
    { q: 24, r: -12 },
  ],
]

/** 河末端的湖泊，与河道连成一片水面 */
const LAKES: Coord[] = [
  { q: -8, r: -24 },
  { q: 24, r: -12 },
]
const LAKE_RADIUS = 2

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

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const coord = { q: col + ORIGIN, r: row + ORIGIN }
      const { x, z } = axialToWorld(coord.q, coord.r)
      const level = patchLevelAt(coord)
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

  const gates = buildGates()
  const rivers = stampRivers(tiles, tileMap)
  stampWalls(tileMap, gates)
  stampRidges(tileMap)
  for (const spawn of SPAWNS) flattenPocket(tileMap, spawn)
  stampRoads(tileMap, gates)

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

/** 斑块按配置顺序叠加，默认草地 */
function patchLevelAt(coord: Coord): number {
  let level = 1
  for (const patch of TERRAIN_PATCHES) {
    if (hexDistance(coord, patch.center) <= patch.radius) level = patch.level
  }
  return level
}

/** 沿每条分界线走到 gateRadius 的那一格作为关口 */
function buildGates(): Coord[] {
  return BOUNDARIES.map((spec) => {
    const chain = boundaryChain(spec, spec.gateRadius)
    return chain[chain.length - 1]!
  })
}

/** 从中心按交替方向走出阶梯状（或直线）分界线 */
function boundaryChain(spec: BoundarySpec, radius: number): Coord[] {
  const chain: Coord[] = []
  let current = { ...CENTER }

  while (hexDistance(current, CENTER) < radius && chain.length < radius * 2 + 4) {
    const step = spec.steps[chain.length % spec.steps.length]!
    current = { q: current.q + step.q, r: current.r + step.r }
    chain.push(current)
  }

  return chain
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
function stampWalls(tileMap: Map<string, MapTile>, gates: Coord[]): void {
  const gateKeys = new Set(gates.map((gate) => tileKey(gate.q, gate.r)))
  const center = tileAt(tileMap, CENTER)
  if (center) paintWall(center, false)

  for (const spec of BOUNDARIES) {
    for (const coord of boundaryChain(spec, spec.wallRadius)) {
      const tile = tileAt(tileMap, coord)
      if (!tile) continue
      paintWall(tile, gateKeys.has(tileKey(coord.q, coord.r)))
    }
  }
}

function paintWall(tile: MapTile, isGateTile: boolean): void {
  tile.isWall = !isGateTile
  tile.isGate = isGateTile
  tile.isWater = false
  tile.isBank = false
  tile.isRoad = false
  tile.level = 1
  tile.height = isGateTile ? GATE_HEIGHT : WALL_HEIGHT
}

/** 城墙链外侧的山脊：三格宽连续高山，直达地图角落，避免贴着城墙绕行 */
function stampRidges(tileMap: Map<string, MapTile>): void {
  for (const spec of BOUNDARIES) {
    const chain = boundaryChain(spec, spec.wallRadius)
    const start = chain[chain.length - 1] ?? CENTER
    for (const coord of hexLine(start, spec.ridgeTo)) {
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
 * 道路在地形定案后二次生成：从每处出生点沿可通行地块找到最短路线铺到相邻的两座关口，
 * 再给每个区域的两座关口之间补一条路；关口瓦片自身不铺路面。
 */
function stampRoads(tileMap: Map<string, MapTile>, gates: Coord[]): void {
  SPAWNS.forEach((spawn, index) => {
    for (const gateIndex of SPAWN_GATES[index] ?? []) {
      const gate = gates[gateIndex]
      if (!gate) continue
      paintRoad(tileMap, shortestPath(spawn, gate, tileMap))
    }
  })

  for (const [from, to] of REGION_GATE_PAIRS) {
    const start = gates[from]
    const goal = gates[to]
    if (!start || !goal) continue
    paintRoad(tileMap, shortestPath(start, goal, tileMap))
  }
}

function paintRoad(tileMap: Map<string, MapTile>, path: Coord[] | null): void {
  if (!path) return
  for (const coord of path) {
    const tile = tileAt(tileMap, coord)
    if (!tile || tile.isGate) continue
    tile.isRoad = true
  }
}

/** 可通行判定：水面、城墙与山地高山不可通行，河滩与关口可通行 */
function isPassable(tile: MapTile): boolean {
  return !tile.isWater && !tile.isWall && tile.level < 4
}

/**
 * 固定邻域顺序的广度优先寻路，保证同一份配置每次得到同一条道路。
 * 除目标关口外不穿越其它关口，路线不会绕到相邻区域。
 */
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
      if (tile.isGate && key !== goalKey) continue
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
