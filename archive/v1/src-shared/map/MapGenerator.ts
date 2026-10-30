/**
 * 大地图的数据契约与前后端共用的几何工具。
 * 具体地形由 presetMap.ts 里的预制配置提供，这里不再做程序化生成。
 */
import type { PlanePoint } from './hex'
import type { Coord } from '../types'

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
  /** 道路瓦片，行军成本更低 */
  isRoad: boolean
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
  bounds: MapBounds
  /** 三处出生点，顺序与阵营顺序一致 */
  spawns: Coord[]
}

/* ------------------------------------------------------------------ */
/* 随机数                                                              */
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

/* ------------------------------------------------------------------ */
/* 网格工具                                                            */
/* ------------------------------------------------------------------ */

export function hexDistance(a: Coord, b: Coord): number {
  const dq = a.q - b.q
  const dr = a.r - b.r
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2
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

/** 两点之间的连续地块序列，用于按折点铺路 */
export function hexLine(a: Coord, b: Coord): Coord[] {
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
    result.push(cubeRound(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t))
  }
  return result
}
