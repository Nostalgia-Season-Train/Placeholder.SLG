import { HEX_WIDTH, HEX_ROW_HEIGHT, axialToWorld, tileKey, worldToAxial, type PlanePoint } from './hex'
import type { Coord } from '../types'
import { BANK_HEIGHT, GATE_HEIGHT, WALL_HEIGHT, getTerrainLevel } from './terrainLevels'

export interface MapTile {
  q: number
  r: number
  x: number
  z: number
  level: number
  height: number
  /** 河道两侧的滩涂 */
  isBank: boolean
  /** 完全位于水面之下 */
  isWater: boolean
  /** 分区边界上的城墙，不可通行 */
  isWall: boolean
  /** 分区边界上的关口，可通行 */
  isGate: boolean
}

export interface MapBounds {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

export interface MapData {
  seed: number
  cols: number
  rows: number
  tiles: MapTile[]
  tileMap: Map<string, MapTile>
  rivers: PlanePoint[][]
  roads: PlanePoint[][]
  bounds: MapBounds
  /** 三处出生点，顺序与阵营顺序一致 */
  spawns: Coord[]
}

/* ------------------------------------------------------------------ */
/* 随机数与噪声                                                        */
/* ------------------------------------------------------------------ */

export interface SeedRandom {
  /** Internal counter; serializable so a save can resume the exact sequence */
  state: number
  next(): number
}

/** Deterministic random source whose state can be captured in a save */
export function createSeedRandom(seed: number): SeedRandom {
  const rng: SeedRandom = {
    state: seed >>> 0,
    next() {
      rng.state = (rng.state + 0x6d2b79f5) | 0
      let t = Math.imul(rng.state ^ (rng.state >>> 15), 1 | rng.state)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
  }
  return rng
}

export function mulberry32(seed: number): () => number {
  const rng = createSeedRandom(seed)
  return () => rng.next()
}

/** 每个地块独立的确定性随机源，保证装饰物布局稳定 */
export function tileRng(seed: number, q: number, r: number): () => number {
  const h = Math.imul(q, 73856093) ^ Math.imul(r, 19349663) ^ Math.imul(seed, 83492791)
  return mulberry32(h >>> 0)
}

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1274126177)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t)
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const tx = smooth(x - xi)
  const ty = smooth(y - yi)

  const a = hash2(xi, yi, seed)
  const b = hash2(xi + 1, yi, seed)
  const c = hash2(xi, yi + 1, seed)
  const d = hash2(xi + 1, yi + 1, seed)

  const top = a + (b - a) * tx
  const bottom = c + (d - c) * tx
  return top + (bottom - top) * ty
}

function fbm(x: number, y: number, seed: number): number {
  let value = 0
  let amplitude = 0.5
  let frequency = 1
  let total = 0
  for (let octave = 0; octave < 4; octave++) {
    value += valueNoise(x * frequency, y * frequency, seed + octave * 1013) * amplitude
    total += amplitude
    amplitude *= 0.5
    frequency *= 2
  }
  return value / total
}

/* ------------------------------------------------------------------ */
/* 路径                                                                */
/* ------------------------------------------------------------------ */

function catmullRom(p0: PlanePoint, p1: PlanePoint, p2: PlanePoint, p3: PlanePoint, t: number): PlanePoint {
  const t2 = t * t
  const t3 = t2 * t
  return {
    x:
      0.5 *
      (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    z:
      0.5 *
      (2 * p1.z + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 +
        (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
  }
}

export function sampleCatmullRom(points: PlanePoint[], samplesPerSegment: number): PlanePoint[] {
  if (points.length < 2) return points.slice()

  const at = (index: number) => points[Math.max(0, Math.min(points.length - 1, index))]!
  const result: PlanePoint[] = []

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = at(i - 1)
    const p1 = at(i)
    const p2 = at(i + 1)
    const p3 = at(i + 2)
    for (let s = 0; s < samplesPerSegment; s++) {
      result.push(catmullRom(p0, p1, p2, p3, s / samplesPerSegment))
    }
  }
  result.push(points[points.length - 1]!)
  return result
}

function distanceToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax
  const abz = bz - az
  const lengthSq = abx * abx + abz * abz
  let t = lengthSq === 0 ? 0 : ((px - ax) * abx + (pz - az) * abz) / lengthSq
  t = Math.max(0, Math.min(1, t))
  const dx = px - (ax + abx * t)
  const dz = pz - (az + abz * t)
  return Math.hypot(dx, dz)
}

function distanceToPath(px: number, pz: number, path: PlanePoint[]): number {
  let min = Infinity
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!
    const b = path[i + 1]!
    const d = distanceToSegment(px, pz, a.x, a.z, b.x, b.z)
    if (d < min) min = d
  }
  return min
}

/* ------------------------------------------------------------------ */
/* 地图生成                                                            */
/* ------------------------------------------------------------------ */

/** Noise only produces 0~3 级地；山地与高山只沿连续山脊生成 */
const LEVEL_WEIGHTS = [0.36, 0.3, 0.2, 0.14]

export function generateMap(seed: number): MapData {
  const cols = 34
  const rows = 34
  const rng = mulberry32(seed)

  const noiseOffsetX = rng() * 512
  const noiseOffsetZ = rng() * 512

  interface RawTile {
    q: number
    r: number
    x: number
    z: number
    noise: number
  }

  const raw: RawTile[] = []
  const noises: number[] = []
  // 轴向坐标以地图中心为原点，保证 worldToAxial 的结果能直接用于 tileMap 查询
  const origin = Math.floor(cols / 2)

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const q = col - origin
      const r = row - origin
      const { x, z } = axialToWorld(q, r)
      const noise = fbm(col * 0.16 + noiseOffsetX, row * 0.16 + noiseOffsetZ, seed)
      raw.push({ q, r, x, z, noise })
      noises.push(noise)
    }
  }

  // 按分位数切等级，噪声只产生 0~3 级地
  const sorted = noises.slice().sort((a, b) => a - b)
  const cuts: number[] = []
  let cumulative = 0
  for (let i = 0; i < LEVEL_WEIGHTS.length - 1; i++) {
    cumulative += LEVEL_WEIGHTS[i]!
    cuts.push(sorted[Math.min(sorted.length - 1, Math.floor(cumulative * (sorted.length - 1)))]!)
  }

  const tiles: MapTile[] = raw.map((item) => {
    let level = 0
    while (level < cuts.length && item.noise > cuts[level]!) level++

    const def = getTerrainLevel(level)
    return {
      q: item.q,
      r: item.r,
      x: item.x,
      z: item.z,
      level,
      height: def.height + (rng() - 0.5) * 0.04,
      isBank: false,
      isWater: false,
      isWall: false,
      isGate: false,
    }
  })

  const bounds = computeBounds(tiles)

  // 河流：两条横向蜿蜒的水系
  const rivers: PlanePoint[][] = [
    createHorizontalRiver(bounds, rng, 0.3, (bounds.maxZ - bounds.minZ) * 0.13, rng() * Math.PI * 2),
    createHorizontalRiver(bounds, rng, 0.72, (bounds.maxZ - bounds.minZ) * 0.09, rng() * Math.PI * 2),
  ]

  // 河流两侧压平成滩涂，避免地形把水面顶穿
  for (const tile of tiles) {
    let distance = Infinity
    for (const river of rivers) {
      distance = Math.min(distance, distanceToPath(tile.x, tile.z, river))
    }
    if (distance < 1.3) {
      tile.isBank = true
      tile.height = BANK_HEIGHT
      tile.level = 0
      if (distance < 0.7) tile.isWater = true
    }
  }

  // 山脉：与河流同构的连续脊线，沿线抬升为山地与高山，两端留出绕行缺口
  const ridges: PlanePoint[][] = [
    createMountainRidge(
      bounds,
      rng,
      false,
      0.45,
      0.45,
      0.5,
      (bounds.maxX - bounds.minX) * 0.05,
      rng() * Math.PI * 2,
    ),
    createMountainRidge(
      bounds,
      rng,
      true,
      0.62,
      0.3,
      0.45,
      (bounds.maxX - bounds.minX) * 0.045,
      rng() * Math.PI * 2 + 1.7,
    ),
    createMountainRidge(
      bounds,
      rng,
      true,
      0.3,
      0.26,
      0.2,
      (bounds.maxX - bounds.minX) * 0.04,
      rng() * Math.PI * 2 + 3.1,
    ),
  ]

  for (const tile of tiles) {
    if (tile.isWater || tile.isBank) continue

    let distance = Infinity
    for (const ridge of ridges) {
      distance = Math.min(distance, distanceToPath(tile.x, tile.z, ridge))
    }
    if (distance > 1.75) continue

    const level = distance <= 1 ? 5 : 4
    const def = getTerrainLevel(level)
    tile.level = level
    tile.height = def.height + (rng() - 0.5) * 0.04
  }

  const tileMap = new Map<string, MapTile>()
  for (const tile of tiles) tileMap.set(tileKey(tile.q, tile.r), tile)

  // 道路：两条横向主路 + 一条纵向连接路，高度跟随地形
  const roads: PlanePoint[][] = [
    createHorizontalRoad(bounds, rng, 0.36, (bounds.maxZ - bounds.minZ) * 0.08, rng() * Math.PI * 2),
    createHorizontalRoad(bounds, rng, 0.64, (bounds.maxZ - bounds.minZ) * 0.07, rng() * Math.PI * 2 + 1.3),
    createVerticalRoad(bounds, rng, 0.52, (bounds.maxX - bounds.minX) * 0.06, rng() * Math.PI * 2),
  ]

  // 分区：三条分界线自地图中心延伸到边缘，用城墙、山脉与河流把地图切成三块
  const spawns = createRegions(tiles, tileMap, bounds)

  return {
    seed,
    cols,
    rows,
    tiles,
    tileMap,
    rivers,
    roads,
    bounds,
    spawns,
  }
}

/** 三处分区出生点的方向，和推演层保持一致 */
const SPAWN_ANGLES = [-Math.PI / 2, Math.PI / 6, (5 * Math.PI) / 6]

/** 三条分界线位于相邻出生点的正中方向 */
const BOUNDARY_ANGLES = [-Math.PI / 6, Math.PI / 2, (7 * Math.PI) / 6]

/** 出生点距地图中心的距离比例 */
const SPAWN_RADIUS_RATIO = 0.32

/** 分界线靠近中心的这一段用城墙，更外侧由连续山脉封住 */
const WALL_SEGMENT_RADIUS = 6

/** 每条分界线上的关口位置（以地块计） */
const GATE_RADIUS = 4

const NEIGHBOR_OFFSETS: Coord[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
]

function hexDistance(a: Coord, b: Coord): number {
  const dq = a.q - b.q
  const dr = a.r - b.r
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2
}

function nearestTile(tiles: MapTile[], coord: Coord): MapTile | null {
  let best: MapTile | null = null
  let bestDistance = Infinity
  for (const tile of tiles) {
    const distance = hexDistance(tile, coord)
    if (distance < bestDistance) {
      bestDistance = distance
      best = tile
    }
  }
  return best
}

function cubeRound(x: number, y: number, z: number): Coord {
  let rx = Math.round(x)
  let ry = Math.round(y)
  let rz = Math.round(z)
  const dx = Math.abs(rx - x)
  const dy = Math.abs(ry - y)
  const dz = Math.abs(rz - z)
  if (dx > dy && dx > dz) rx = -ry - rz
  else if (dy > dz) ry = -rx - rz
  else rz = -rx - ry
  return { q: rx, r: rz }
}

/** 两点之间的连续地块序列，保证分界线没有断口 */
function hexLine(a: Coord, b: Coord): Coord[] {
  const steps = hexDistance(a, b)
  const result: Coord[] = []
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps
    const ax = a.q
    const az = a.r
    const ay = -ax - az
    const bx = b.q
    const bz = b.r
    const by = -bx - bz
    result.push(
      cubeRound(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t),
    )
  }
  return result
}

/** 把出生点腹地压平，保证主城与小队有可站立的地块 */
function flattenPocket(tiles: MapTile[], center: Coord): void {
  for (const tile of tiles) {
    if (hexDistance(tile, center) > 1) continue
    tile.isWater = false
    tile.isBank = false
    tile.level = 1
    tile.height = getTerrainLevel(1).height
  }
}

/** 用分界线把地图切成三块，并在每块内部放置一处出生点 */
function createRegions(
  tiles: MapTile[],
  tileMap: Map<string, MapTile>,
  bounds: MapBounds,
): Coord[] {
  const centerX = (bounds.minX + bounds.maxX) / 2
  const centerZ = (bounds.minZ + bounds.maxZ) / 2
  const reach = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ)
  const center: Coord = { q: 0, r: 0 }

  for (const angle of BOUNDARY_ANGLES) {
    const far = worldToAxial(
      centerX + Math.cos(angle) * reach,
      centerZ + Math.sin(angle) * reach,
    )
    for (const coord of hexLine(center, far)) {
      const tile = tileMap.get(tileKey(coord.q, coord.r))
      if (!tile) continue

      const distance = hexDistance(coord, center)
      // 分界线穿过河流时由河流本身充当屏障，只在此处架设关口
      if (distance === GATE_RADIUS) {
        tile.isWater = false
        tile.isBank = false
        tile.isWall = false
        tile.isGate = true
        tile.level = 1
        tile.height = GATE_HEIGHT
        continue
      }
      if (tile.isWater) continue

      if (distance <= WALL_SEGMENT_RADIUS) {
        tile.isWall = true
        tile.isGate = false
        tile.height = WALL_HEIGHT
        continue
      }

      // 远离中心的一段由连续山脉封住
      tile.isWall = false
      tile.isGate = false
      tile.isBank = false
      tile.level = 5
      tile.height = getTerrainLevel(5).height
    }
  }

  // 关口两侧的邻格必须可通行，避免山脊或河滩把门堵死
  for (const tile of tiles) {
    if (!tile.isGate) continue
    for (const offset of NEIGHBOR_OFFSETS) {
      const neighbor = tileMap.get(tileKey(tile.q + offset.q, tile.r + offset.r))
      if (!neighbor || neighbor.isWall || neighbor.isGate) continue
      neighbor.isWater = false
      neighbor.isBank = false
      if (neighbor.level >= 4) {
        neighbor.level = 1
        neighbor.height = getTerrainLevel(1).height
      }
    }
  }

  const spawns: Coord[] = []
  const radius = Math.min(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) * SPAWN_RADIUS_RATIO

  for (const angle of SPAWN_ANGLES) {
    const seed = worldToAxial(centerX + Math.cos(angle) * radius, centerZ + Math.sin(angle) * radius)
    const anchor = tileMap.get(tileKey(seed.q, seed.r)) ?? nearestTile(tiles, seed)
    if (!anchor) continue

    flattenPocket(tiles, anchor)
    spawns.push({ q: anchor.q, r: anchor.r })
  }

  return spawns
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
  const padX = HEX_WIDTH * 0.5
  const padZ = HEX_ROW_HEIGHT * 0.5
  return { minX: minX - padX, maxX: maxX + padX, minZ: minZ - padZ, maxZ: maxZ + padZ }
}

function createHorizontalRiver(
  bounds: MapBounds,
  rng: () => number,
  baseRatio: number,
  amplitude: number,
  phase: number,
): PlanePoint[] {
  const controls: PlanePoint[] = []
  const steps = 16
  const minX = bounds.minX - 5
  const maxX = bounds.maxX + 5
  const baseZ = bounds.minZ + (bounds.maxZ - bounds.minZ) * baseRatio
  const amp = amplitude * (0.85 + rng() * 0.3)

  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1)
    controls.push({
      x: minX + (maxX - minX) * t,
      z:
        baseZ +
        Math.sin(t * Math.PI * 2.1 + phase) * amp +
        Math.sin(t * Math.PI * 5.4 + phase * 1.7) * amp * 0.28,
    })
  }
  return sampleCatmullRom(controls, 10)
}

/** 山脉脊线：与河流同构的连续折线，两端不触及地图边界以便绕行 */
function createMountainRidge(
  bounds: MapBounds,
  rng: () => number,
  vertical: boolean,
  baseRatio: number,
  spanRatio: number,
  spanCenter: number,
  amplitude: number,
  phase: number,
): PlanePoint[] {
  const controls: PlanePoint[] = []
  const steps = 12
  const spanMin = spanCenter - spanRatio / 2
  const spanMax = spanCenter + spanRatio / 2
  const amp = amplitude * (0.85 + rng() * 0.3)
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxZ - bounds.minZ

  for (let i = 0; i < steps; i++) {
    const t = spanMin + (spanMax - spanMin) * (i / (steps - 1))
    const wave =
      Math.sin(t * Math.PI * 2.4 + phase) * amp +
      Math.sin(t * Math.PI * 5.2 + phase * 1.6) * amp * 0.3

    controls.push(
      vertical
        ? { x: bounds.minX + width * baseRatio + wave, z: bounds.minZ + height * t }
        : { x: bounds.minX + width * t, z: bounds.minZ + height * baseRatio + wave },
    )
  }

  return sampleCatmullRom(controls, 8)
}

function createHorizontalRoad(
  bounds: MapBounds,
  rng: () => number,
  baseRatio: number,
  amplitude: number,
  phase: number,
): PlanePoint[] {
  const controls: PlanePoint[] = []
  const steps = 14
  const minX = bounds.minX - 3
  const maxX = bounds.maxX + 3
  const baseZ = bounds.minZ + (bounds.maxZ - bounds.minZ) * baseRatio
  const amp = amplitude * (0.8 + rng() * 0.4)

  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1)
    controls.push({
      x: minX + (maxX - minX) * t,
      z:
        baseZ +
        Math.sin(t * Math.PI * 1.8 + phase) * amp +
        Math.sin(t * Math.PI * 4.2 + phase * 2.1) * amp * 0.22,
    })
  }
  return sampleCatmullRom(controls, 8)
}

function createVerticalRoad(
  bounds: MapBounds,
  rng: () => number,
  baseRatio: number,
  amplitude: number,
  phase: number,
): PlanePoint[] {
  const controls: PlanePoint[] = []
  const steps = 14
  const minZ = bounds.minZ - 3
  const maxZ = bounds.maxZ + 3
  const baseX = bounds.minX + (bounds.maxX - bounds.minX) * baseRatio
  const amp = amplitude * (0.8 + rng() * 0.4)

  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1)
    controls.push({
      x:
        baseX +
        Math.sin(t * Math.PI * 1.7 + phase) * amp +
        Math.sin(t * Math.PI * 4.6 + phase * 1.5) * amp * 0.2,
      z: minZ + (maxZ - minZ) * t,
    })
  }
  return sampleCatmullRom(controls, 8)
}

/** 查询某个世界坐标下的地形顶面高度（道路贴地用） */
export function terrainHeightAt(map: MapData, x: number, z: number): number {
  const { q, r } = worldToAxial(x, z)
  return map.tileMap.get(tileKey(q, r))?.height ?? 0
}
