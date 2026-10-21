/**
 * March simulation: advances round by round. Idle generals pick a target,
 * march along their path and spend a few rounds capturing the tile.
 * Hostile generals sharing a tile settle it by combat power.
 */
import { worldToAxial } from '../map/hex'
import { mulberry32, type MapData } from '../map/MapGenerator'
import { chooseTarget } from './decision'
import { findPath } from './pathfinding'
import {
  coordKey,
  getTile,
  hexDistance,
  nearestCapturable,
  neighbors,
  buildTerrain,
  type WorldTerrain,
} from './terrain'
import {
  FACTIONS,
  ORDER_LABELS,
  type BotOrder,
  type BotStance,
  type Faction,
  type Coord,
  type SimEvent,
  type SimSnapshot,
  type GeneralState,
} from './types'

const NAME_POOL: Record<Faction, string[]> = {
  red: ['赤羽', '烈风'],
  cyan: ['青岚', '寒江'],
  gold: ['金沙', '狼烟'],
}

/** Number of generals per faction */
const GENERALS_PER_FACTION = 2

/** Stances that require the bot to march to an explicit tile */
const TARGETED_STANCES: BotStance[] = ['attack', 'defend', 'retreat']

export class MarchSimulation {
  readonly terrain: WorldTerrain
  private readonly random: () => number
  private readonly generals: GeneralState[]
  private readonly occupation = new Map<string, Faction>()
  private readonly events: SimEvent[] = []
  private round = 0
  private occupationVersion = 0

  constructor(map: MapData, seed: number) {
    this.terrain = buildTerrain(map)
    this.random = mulberry32((seed >>> 0) || 1)
    this.generals = this.createGenerals(map)
  }

  /** Advance one round: every general acts in order */
  step(): void {
    this.round += 1
    for (const general of this.generals) this.act(general)
  }

  /** Assign an order to one bot; returns false when the bot does not belong to the simulation */
  setOrder(generalId: string, order: BotOrder): boolean {
    const general = this.generals.find((item) => item.id === generalId)
    if (!general) return false

    general.order = order
    general.captureProgress = 0

    const target = order.target ? `（${order.target.q},${order.target.r}）` : ''
    this.log(general.faction, `${general.name}收到指令：${ORDER_LABELS[order.stance]}${target}`)
    return true
  }

  /** Read-only snapshot shared with the rendering layer */
  snapshot(): SimSnapshot {
    const factionCounts: Record<Faction, number> = { red: 0, cyan: 0, gold: 0 }
    for (const faction of this.occupation.values()) factionCounts[faction] += 1

    return {
      round: this.round,
      generals: this.generals.map((general) => ({
        ...general,
        coord: { ...general.coord },
        target: general.target ? { ...general.target } : null,
        path: general.path.map((tile) => ({ ...tile })),
        personality: { ...general.personality },
        order: general.order ? { ...general.order, target: general.order.target ? { ...general.order.target } : null } : null,
      })),
      occupation: new Map(this.occupation),
      occupationVersion: this.occupationVersion,
      events: this.events.slice(-14).reverse(),
      capturedCount: this.occupation.size,
      capturableCount: this.terrain.capturable.length,
      factionCounts,
    }
  }

  /* ------------------------------------------------------------------ */
  /* Setup                                                               */
  /* ------------------------------------------------------------------ */

  private createGenerals(map: MapData): GeneralState[] {
    const centerX = (map.bounds.minX + map.bounds.maxX) / 2
    const centerZ = (map.bounds.minZ + map.bounds.maxZ) / 2
    const radius =
      Math.min(map.bounds.maxX - map.bounds.minX, map.bounds.maxZ - map.bounds.minZ) * 0.32
    const baseAngles = [-Math.PI / 2, Math.PI / 6, (5 * Math.PI) / 6]
    const taken = new Set<string>()
    const result: GeneralState[] = []

    FACTIONS.forEach((faction, factionIndex) => {
      for (let member = 0; member < GENERALS_PER_FACTION; member++) {
        const angle = (baseAngles[factionIndex] ?? 0) + (member - (GENERALS_PER_FACTION - 1) / 2) * 0.24
        const seedCoord = worldToAxial(
          centerX + Math.cos(angle) * radius,
          centerZ + Math.sin(angle) * radius,
        )
        const spawn =
          nearestCapturable(this.terrain, seedCoord, taken) ??
          nearestCapturable(this.terrain, seedCoord)
        if (!spawn) continue
        taken.add(coordKey(spawn))

        result.push({
          id: `${faction}-${member}`,
          name: NAME_POOL[faction][member] ?? `${faction}${member + 1}`,
          faction,
          coord: { ...spawn },
          speed: 1 + this.random() * 0.65,
          power: 48 + Math.round(this.random() * 34),
          personality: {
            aggression: this.random(),
            caution: 0.35 + this.random() * 0.65,
          },
          order: null,
          target: null,
          path: [],
          actionPoints: 0,
          captureProgress: 0,
          captureCost: 2,
          status: 'idle',
          restTurns: 0,
          marchDistance: 0,
          captured: 0,
        })
      }
    })

    return result
  }

  /* ------------------------------------------------------------------ */
  /* Single general turn                                                 */
  /* ------------------------------------------------------------------ */

  private act(general: GeneralState): void {
    if (general.restTurns > 0) {
      general.restTurns -= 1
      general.status = 'resting'
      return
    }

    if (general.order) {
      if (general.order.stance === 'hold') {
        general.target = null
        general.path = []
        general.captureProgress = 0
        general.status = 'garrison'
        return
      }
      if (TARGETED_STANCES.includes(general.order.stance)) {
        this.followOrder(general, general.order)
      }
    }

    if (!general.target) this.pickTarget(general)
    if (!general.target) {
      general.status = 'idle'
      return
    }

    if (coordKey(general.coord) === coordKey(general.target)) {
      this.captureTile(general)
      return
    }

    general.actionPoints = Math.min(4, general.actionPoints + general.speed)
    general.status = 'marching'

    while (general.path.length > 0) {
      const next = general.path[0]!
      const tile = getTile(this.terrain, next)
      if (!tile) break
      if (general.actionPoints + 1e-6 < tile.moveCost) break

      general.actionPoints -= tile.moveCost
      general.marchDistance += tile.moveCost
      general.path.shift()
      general.coord = { ...next }

      const enemy = this.enemyOnTile(general)
      if (enemy) {
        this.resolveEncounter(general, enemy)
        return
      }

      if (coordKey(general.coord) === coordKey(general.target)) {
        this.captureTile(general)
        return
      }
    }
  }

  private pickTarget(general: GeneralState): void {
    const locked = new Set<string>()
    for (const other of this.generals) {
      if (other === general || other.faction !== general.faction || !other.target) continue
      locked.add(coordKey(other.target))
    }

    const choice = chooseTarget(general, this.terrain, this.occupation, locked, this.random)
    if (!choice) return

    const tile = getTile(this.terrain, choice.target)
    general.target = { ...choice.target }
    general.path = choice.path
    general.captureProgress = 0
    general.captureCost = Math.max(2, (tile?.level ?? 0) + 1)
    this.log(
      general.faction,
      `${general.name}前往${tile?.name ?? '地块'}（${choice.target.q},${choice.target.r}）`,
    )
  }

  private captureTile(general: GeneralState): void {
    if (!general.target) return

    const key = coordKey(general.coord)
    const tile = getTile(this.terrain, general.coord)
    if (!tile) {
      general.target = null
      general.path = []
      return
    }

    const owner = this.occupation.get(key)
    if (owner === general.faction) {
      general.target = null
      general.path = []
      general.captureProgress = 0
      general.status = 'garrison'
      if (general.order?.stance === 'attack' || general.order?.stance === 'retreat') {
        general.order = null
      }
      return
    }

    general.status = 'capturing'
    general.captureProgress += 1
    if (general.captureProgress < general.captureCost) return

    if (owner) this.log(owner, `失去${tile.name}（${general.coord.q},${general.coord.r}）`)

    this.occupation.set(key, general.faction)
    this.occupationVersion += 1
    general.captured += 1
    general.captureProgress = 0
    general.target = null
    general.path = []
    general.status = 'garrison'
    if (general.order?.stance === 'attack' || general.order?.stance === 'retreat') {
      general.order = null
    }
    this.log(
      general.faction,
      `${general.name}占领${tile.level}级${tile.name}（${general.coord.q},${general.coord.r}）`,
    )
  }

  /** Move a bot toward the tile named by its order, recomputing the path when needed */
  private followOrder(general: GeneralState, order: BotOrder): void {
    if (!order.target) {
      general.order = null
      return
    }

    const tile = getTile(this.terrain, order.target)
    if (!tile?.passable) {
      general.order = null
      return
    }

    const targetKey = coordKey(order.target)
    if (coordKey(general.coord) === targetKey) {
      general.target = { ...order.target }
      return
    }

    if (!general.target || coordKey(general.target) !== targetKey || general.path.length === 0) {
      const result = findPath(this.terrain, general.coord, order.target)
      if (!result) {
        general.order = null
        return
      }
      general.target = { ...order.target }
      general.path = result.path
      general.captureProgress = 0
      general.captureCost = Math.max(2, tile.level + 1)
    }
  }

  /* ------------------------------------------------------------------ */
  /* Encounters                                                          */
  /* ------------------------------------------------------------------ */

  private enemyOnTile(general: GeneralState): GeneralState | undefined {
    return this.generals.find(
      (other) =>
        other !== general &&
        other.faction !== general.faction &&
        coordKey(other.coord) === coordKey(general.coord),
    )
  }

  private resolveEncounter(attacker: GeneralState, defender: GeneralState): void {
    const attackRoll = attacker.power * (0.82 + this.random() * 0.36)
    const defendRoll = defender.power * (0.82 + this.random() * 0.36)
    const winner = attackRoll >= defendRoll ? attacker : defender
    const loser = winner === attacker ? defender : attacker

    const retreat = this.retreatTile(loser)
    if (retreat) loser.coord = retreat
    loser.target = null
    loser.path = []
    loser.captureProgress = 0
    loser.restTurns = 2
    loser.status = 'resting'
    loser.order = null

    const key = coordKey(winner.coord)
    winner.target = null
    winner.path = []
    winner.captureProgress = 0
    winner.status = 'garrison'

    if (this.occupation.get(key) !== winner.faction) {
      this.occupation.set(key, winner.faction)
      this.occupationVersion += 1
    }

    this.log(
      winner.faction,
      `${winner.name}击退${loser.name}，夺取${getTile(this.terrain, winner.coord)?.name ?? '地块'}`,
    )
  }

  private retreatTile(loser: GeneralState): Coord | null {
    let best: Coord | null = null
    let bestDistance = Infinity

    for (const neighbor of neighbors(loser.coord)) {
      const tile = getTile(this.terrain, neighbor)
      if (!tile?.passable) continue

      const hasEnemy = this.generals.some(
        (other) =>
          other !== loser &&
          other.faction !== loser.faction &&
          coordKey(other.coord) === coordKey(neighbor),
      )
      if (hasEnemy) continue

      const distance = hexDistance(neighbor, loser.coord)
      if (distance < bestDistance) {
        bestDistance = distance
        best = neighbor
      }
    }

    return best
  }

  private log(faction: Faction, text: string): void {
    this.events.push({ round: this.round, faction, text })
    if (this.events.length > 80) this.events.splice(0, this.events.length - 80)
  }
}
