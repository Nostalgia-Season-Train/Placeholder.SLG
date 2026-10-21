import { HEX_WIDTH, HEX_ROW_HEIGHT, axialToWorld, tileKey, worldToAxial, type PlanePoint } from './hex'
import { BANK_HEIGHT, getTerrainLevel } from './terrainLevels'

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
}

/* ------------------------------------------------------------------ */
/* 随机数与噪声                                                        */
/* ------------------------------------------------------------------ */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
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

const LEVEL_WEIGHTS = [0.3, 0.24, 0.2, 0.14, 0.09, 0.03]

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

  for (let r = 0; r < rows; r++) {
    for (let q = 0; q < cols; q++) {
      const { x, z } = axialToWorld(q, r)
      const noise = fbm(q * 0.16 + noiseOffsetX, r * 0.16 + noiseOffsetZ, seed)
      raw.push({ q, r, x, z, noise })
      noises.push(noise)
    }
  }

  // 按分位数切等级，保证 0~5 级地在每张图里都能出现
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

  const tileMap = new Map<string, MapTile>()
  for (const tile of tiles) tileMap.set(tileKey(tile.q, tile.r), tile)

  // 道路：两条横向主路 + 一条纵向连接路，高度跟随地形
  const roads: PlanePoint[][] = [
    createHorizontalRoad(bounds, rng, 0.36, (bounds.maxZ - bounds.minZ) * 0.08, rng() * Math.PI * 2),
    createHorizontalRoad(bounds, rng, 0.64, (bounds.maxZ - bounds.minZ) * 0.07, rng() * Math.PI * 2 + 1.3),
    createVerticalRoad(bounds, rng, 0.52, (bounds.maxX - bounds.minX) * 0.06, rng() * Math.PI * 2),
  ]

  // 以地图中心为原点
  const centerX = (bounds.minX + bounds.maxX) / 2
  const centerZ = (bounds.minZ + bounds.maxZ) / 2
  for (const tile of tiles) {
    tile.x -= centerX
    tile.z -= centerZ
  }
  for (const path of [...rivers, ...roads]) {
    for (const p of path) {
      p.x -= centerX
      p.z -= centerZ
    }
  }

  return {
    seed,
    cols,
    rows,
    tiles,
    tileMap,
    rivers,
    roads,
    bounds: {
      minX: bounds.minX - centerX,
      maxX: bounds.maxX - centerX,
      minZ: bounds.minZ - centerZ,
      maxZ: bounds.maxZ - centerZ,
    },
  }
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
