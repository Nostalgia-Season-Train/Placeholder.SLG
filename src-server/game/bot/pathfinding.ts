/**
 * A* pathfinding on the hex grid.
 * Costs come from terrain movement cost; water and high mountains are impassable.
 */
import { coordKey, getTile, hexDistance, neighbors, type WorldTerrain } from './terrain'
import type { Coord } from '../../../src-shared/types'

interface Node {
  coord: Coord
  cost: number
  estimate: number
  parent: Node | null
}

export interface PathResult {
  path: Coord[]
  cost: number
}

/** Smallest movement cost among passable tiles, keeps the heuristic admissible */
const MIN_COST = 0.6

/**
 * @param blocked 额外禁行判定（例如敌方要塞占格）；不传时行为不变，起点不受限制
 */
export function findPath(
  terrain: WorldTerrain,
  start: Coord,
  goal: Coord,
  maxExpansions = 4000,
  blocked?: (coord: Coord) => boolean,
): PathResult | null {
  const startKey = coordKey(start)
  const goalKey = coordKey(goal)
  if (startKey === goalKey) return { path: [], cost: 0 }
  if (!getTile(terrain, goal)?.passable) return null
  if (blocked?.(goal)) return null

  const open = new Map<string, Node>()
  const closed = new Set<string>()
  open.set(startKey, {
    coord: start,
    cost: 0,
    estimate: hexDistance(start, goal) * MIN_COST,
    parent: null,
  })

  let expansions = 0
  while (open.size > 0 && expansions < maxExpansions) {
    expansions += 1

    let current: Node | null = null
    let currentKey = ''
    for (const [key, node] of open) {
      if (!current || node.estimate < current.estimate) {
        current = node
        currentKey = key
      }
    }
    if (!current) break

    open.delete(currentKey)
    if (currentKey === goalKey) {
      const path: Coord[] = []
      let cursor: Node | null = current
      while (cursor?.parent) {
        path.push(cursor.coord)
        cursor = cursor.parent
      }
      path.reverse()
      return { path, cost: current.cost }
    }

    closed.add(currentKey)
    for (const neighbor of neighbors(current.coord)) {
      const key = coordKey(neighbor)
      if (closed.has(key)) continue

      const tile = getTile(terrain, neighbor)
      if (!tile?.passable) continue
      if (blocked?.(neighbor)) continue

      const cost = current.cost + tile.moveCost
      const existing = open.get(key)
      if (existing && existing.cost <= cost) continue

      open.set(key, {
        coord: neighbor,
        cost,
        estimate: cost + hexDistance(neighbor, goal) * MIN_COST,
        parent: current,
      })
    }
  }

  return null
}

/** 兵线只在道路与关口上推进：道路 1 Tick，关口 2 Tick */
const ROAD_STEP = 1
const GATE_STEP = 2

/**
 * 沿道路与关口的寻路，用于兵线。起点可以是任意格（通常是主城邻格），
 * 中间格与终点必须 `road || gate`；多个 goal 时返回到达的最近一条路径。
 * 展开顺序固定，代价相同按插入顺序决胜，保证确定性。
 */
export function findRoadPath(
  terrain: WorldTerrain,
  start: Coord,
  goals: Coord[],
  blocked?: (coord: Coord) => boolean,
): PathResult | null {
  const goalKeys = new Set(goals.map((goal) => coordKey(goal)))
  if (goalKeys.size === 0) return null

  const startKey = coordKey(start)
  if (goalKeys.has(startKey)) return { path: [], cost: 0 }

  const open = new Map<string, { coord: Coord; cost: number }>()
  const parent = new Map<string, string | null>()
  const coords = new Map<string, Coord>()
  const closed = new Set<string>()

  open.set(startKey, { coord: start, cost: 0 })
  parent.set(startKey, null)
  coords.set(startKey, start)

  while (open.size > 0) {
    let currentKey = ''
    let current: { coord: Coord; cost: number } | null = null
    for (const [key, node] of open) {
      if (!current || node.cost < current.cost) {
        current = node
        currentKey = key
      }
    }
    if (!current) break

    open.delete(currentKey)
    if (closed.has(currentKey)) continue
    closed.add(currentKey)

    if (goalKeys.has(currentKey)) {
      const path: Coord[] = []
      let cursor: string | null = currentKey
      while (cursor && parent.get(cursor)) {
        path.push({ ...coords.get(cursor)! })
        cursor = parent.get(cursor) ?? null
      }
      path.reverse()
      return { path, cost: current.cost }
    }

    for (const neighbor of neighbors(current.coord)) {
      const key = coordKey(neighbor)
      if (closed.has(key)) continue

      const tile = getTile(terrain, neighbor)
      if (!tile?.passable || (!tile.road && !tile.gate)) continue
      if (blocked?.(neighbor)) continue

      const cost = current.cost + (tile.gate ? GATE_STEP : ROAD_STEP)
      const existing = open.get(key)
      if (existing && existing.cost <= cost) continue

      open.set(key, { coord: neighbor, cost })
      parent.set(key, currentKey)
      coords.set(key, neighbor)
    }
  }

  return null
}
