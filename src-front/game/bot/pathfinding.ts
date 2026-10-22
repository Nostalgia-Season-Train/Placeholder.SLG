/**
 * A* pathfinding on the hex grid.
 * Costs come from terrain movement cost; water and high mountains are impassable.
 */
import { coordKey, getTile, hexDistance, neighbors, type WorldTerrain } from './terrain'
import type { Coord } from './types'

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

export function findPath(
  terrain: WorldTerrain,
  start: Coord,
  goal: Coord,
  maxExpansions = 4000,
): PathResult | null {
  const startKey = coordKey(start)
  const goalKey = coordKey(goal)
  if (startKey === goalKey) return { path: [], cost: 0 }
  if (!getTile(terrain, goal)?.passable) return null

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
