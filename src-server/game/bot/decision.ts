/**
 * Target selection: picks a worthwhile, reachable tile for an idle general.
 * Score = tile value + enemy-held bonus - path cost * personality weight.
 */
import { coordKey, hexDistance, type TileInfo, type WorldTerrain } from './terrain'
import { findPath } from './pathfinding'
import type { Coord, Faction, GeneralState } from '../../../src-shared/types'

/** Longest path a general accepts in one decision */
const MAX_PATH_COST = 46

/** Only the highest rough-score candidates are expanded with A* */
const MAX_CANDIDATES = 8

export interface TargetChoice {
  target: Coord
  path: Coord[]
  cost: number
  value: number
}

export function chooseTarget(
  general: GeneralState,
  terrain: WorldTerrain,
  occupation: Map<string, Faction>,
  locked: Set<string>,
  random: () => number,
): TargetChoice | null {
  const personality = general.personality
  const weight = Math.max(
    0.45,
    Math.min(1.6, 0.7 + personality.caution * 0.9 - personality.aggression * 0.35),
  )
  const candidates: { tile: TileInfo; roughScore: number }[] = []

  for (const tile of terrain.capturable) {
    const key = coordKey(tile.coord)
    const owner = occupation.get(key)
    if (owner === general.faction) continue

    const distance = hexDistance(general.coord, tile.coord)
    if (distance === 0) continue

    const enemyBonus = owner ? 6 + personality.aggression * 14 + personality.assault * 10 : 0
    const lockPenalty = locked.has(key) ? 30 : 0
    const roughScore = tile.value + enemyBonus - distance * weight * 2 - lockPenalty

    candidates.push({ tile, roughScore })
  }

  candidates.sort((a, b) => b.roughScore - a.roughScore)

  let best: TargetChoice | null = null
  let bestScore = -Infinity

  for (const entry of candidates.slice(0, MAX_CANDIDATES)) {
    const result = findPath(terrain, general.coord, entry.tile.coord)
    if (!result || result.path.length === 0) continue
    if (result.cost > MAX_PATH_COST) continue

    const owner = occupation.get(coordKey(entry.tile.coord))
    const enemyBonus = owner ? 6 + personality.aggression * 14 + personality.assault * 10 : 0
    const score = entry.tile.value + enemyBonus - result.cost * weight + random() * 3

    if (score > bestScore) {
      bestScore = score
      best = {
        target: entry.tile.coord,
        path: result.path,
        cost: result.cost,
        value: entry.tile.value,
      }
    }
  }

  return best
}
