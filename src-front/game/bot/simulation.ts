/**
 * March simulation: advances round by round. Idle generals pick a target,
 * march along their path and spend a few rounds capturing the tile.
 * Hostile generals sharing a tile settle it by combat power.
 */
import { worldToAxial } from '../map/hex'
import { createSeedRandom, type MapData, type SeedRandom } from '../map/MapGenerator'
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
  FACTION_NAMES,
  FACTIONS,
  ORDER_LABELS,
  type BaseCity,
  type BotOrder,
  type BotStance,
  type CardSpawn,
  type Faction,
  type Coord,
  type GeneralState,
  type Personality,
  type SimEvent,
  type SimSaveState,
  type SimSnapshot,
  type StatGrade,
} from './types'

/** Directions of the three home cities, measured from the map center */
const BASE_ANGLES = [-Math.PI / 2, Math.PI / 6, (5 * Math.PI) / 6]

/** Home cities sit on a ring at this ratio of the shorter map side */
const CITY_RADIUS_RATIO = 0.32

/** Stances that require the bot to march to an explicit tile */
const TARGETED_STANCES: BotStance[] = ['attack', 'defend', 'retreat']

/** Stat grades mapped onto a 1..3 power scale */
const GRADE_SCORE: Record<StatGrade, number> = { 低: 1, 中: 2, 高: 3 }

/** Personality tags adjust the bot's target-selection weights */
const PERSONALITY_ADJUSTMENTS: Record<string, { aggression: number; caution: number }> = {
  勇猛: { aggression: 0.25, caution: -0.15 },
  激进: { aggression: 0.3, caution: -0.25 },
  好战: { aggression: 0.3, caution: -0.2 },
  鲁莽: { aggression: 0.25, caution: -0.3 },
  沉稳: { aggression: -0.05, caution: 0.1 },
  谨慎: { aggression: -0.1, caution: 0.25 },
  多疑: { aggression: -0.05, caution: 0.2 },
  懦弱: { aggression: -0.35, caution: 0.25 },
  胆小: { aggression: -0.3, caution: 0.2 },
}

function clamp01(value: number): number {
  return Math.min(0.9, Math.max(0.1, value))
}

/** Translate card personality text into bot decision weights */
function personalityFromCard(text: string): Personality {
  let aggression = 0.5
  let caution = 0.55
  for (const [tag, adjust] of Object.entries(PERSONALITY_ADJUSTMENTS)) {
    if (!text.includes(tag)) continue
    aggression += adjust.aggression
    caution += adjust.caution
  }
  return { aggression: clamp01(aggression), caution: clamp01(caution) }
}

function cloneGeneral(general: GeneralState): GeneralState {
  return {
    ...general,
    coord: { ...general.coord },
    personality: { ...general.personality },
    order: general.order
      ? { ...general.order, target: general.order.target ? { ...general.order.target } : null }
      : null,
    target: general.target ? { ...general.target } : null,
    path: general.path.map((tile) => ({ ...tile })),
  }
}

export class MarchSimulation {
  readonly terrain: WorldTerrain
  private readonly rng: SeedRandom
  private readonly random: () => number
  private readonly cities: BaseCity[]
  private readonly generals: GeneralState[]
  private readonly occupation = new Map<string, Faction>()
  private readonly events: SimEvent[] = []
  private round = 0
  private occupationVersion = 0
  private eventLimit = 14

  constructor(map: MapData, seed: number, restore?: SimSaveState) {
    this.terrain = buildTerrain(map)
    this.rng = createSeedRandom((seed >>> 0) || 1)
    this.random = () => this.rng.next()

    if (restore) {
      this.cities = restore.cities.map((city) => ({ ...city, coord: { ...city.coord } }))
      this.generals = restore.generals.map(cloneGeneral)
      for (const [key, faction] of restore.occupation) this.occupation.set(key, faction)
      this.round = restore.round
      this.occupationVersion = restore.occupationVersion
      this.eventLimit = restore.eventLimit
      this.events.push(...restore.events.map((event) => ({ ...event })))
      this.rng.state = restore.rngState
      return
    }

    this.cities = this.createCities(map)
    this.generals = []
  }

  /** Serializable mid-run state used by the save system */
  saveState(): SimSaveState {
    return {
      round: this.round,
      occupationVersion: this.occupationVersion,
      eventLimit: this.eventLimit,
      rngState: this.rng.state,
      cities: this.cities.map((city) => ({ ...city, coord: { ...city.coord } })),
      generals: this.generals.map(cloneGeneral),
      occupation: [...this.occupation.entries()],
      events: this.events.map((event) => ({ ...event })),
    }
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

  /** Number of recent events kept in each snapshot */
  setEventLimit(limit: number): void {
    this.eventLimit = Math.max(1, Math.floor(limit))
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
      cities: this.cities.map((city) => ({ ...city, coord: { ...city.coord } })),
      occupation: new Map(this.occupation),
      occupationVersion: this.occupationVersion,
      events: this.events.slice(-this.eventLimit).reverse(),
      capturedCount: this.occupation.size,
      capturableCount: this.terrain.capturable.length,
      factionCounts,
    }
  }

  /* ------------------------------------------------------------------ */
  /* Setup                                                               */
  /* ------------------------------------------------------------------ */

  /** One home city per faction; its tile starts owned by that faction */
  private createCities(map: MapData): BaseCity[] {
    const centerX = (map.bounds.minX + map.bounds.maxX) / 2
    const centerZ = (map.bounds.minZ + map.bounds.maxZ) / 2
    const radius =
      Math.min(map.bounds.maxX - map.bounds.minX, map.bounds.maxZ - map.bounds.minZ) *
      CITY_RADIUS_RATIO
    const taken = new Set<string>()
    const result: BaseCity[] = []

    FACTIONS.forEach((faction, factionIndex) => {
      const angle = BASE_ANGLES[factionIndex] ?? 0
      const seedCoord = worldToAxial(
        centerX + Math.cos(angle) * radius,
        centerZ + Math.sin(angle) * radius,
      )
      const coord =
        nearestCapturable(this.terrain, seedCoord, taken) ??
        nearestCapturable(this.terrain, seedCoord)
      if (!coord) return

      taken.add(coordKey(coord))
      this.occupation.set(coordKey(coord), faction)
      result.push({ faction, coord: { ...coord }, name: `${FACTION_NAMES[faction]}主城` })
      this.log(faction, `${FACTION_NAMES[faction]}主城设立于（${coord.q},${coord.r}）`)
    })

    if (result.length > 0) this.occupationVersion += 1
    return result
  }

  /**
   * Place a character card on the map near its faction city. Position holders
   * (大臣 / 团长) command instead of marching, so they never spawn a unit.
   * Usable both at world boot and mid-run.
   */
  spawnFromCard(card: CardSpawn): GeneralState | null {
    if (card.position !== '无') return null
    const city = this.cities.find((item) => item.faction === card.faction)
    if (!city) return null

    const taken = new Set<string>([
      ...this.cities.map((item) => coordKey(item.coord)),
      ...this.generals.map((general) => coordKey(general.coord)),
    ])

    const spawn =
      this.cityOutskirt(city.coord, taken) ??
      nearestCapturable(this.terrain, city.coord, taken)
    if (!spawn) return null

    const general: GeneralState = {
      id: `card-${card.id}`,
      name: card.name,
      faction: card.faction,
      coord: { ...spawn },
      speed: 0.6 + this.random() * 0.4,
      power: 32 + GRADE_SCORE[card.attack] * 10 + GRADE_SCORE[card.magic] * 7,
      personality: personalityFromCard(card.personality),
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
    }
    this.generals.push(general)
    this.log(
      general.faction,
      card.role === '武将' || card.role === '术武将'
        ? `${card.name}率小队自${city.name}出发`
        : `${card.name}抵达${city.name}，随队行动`,
    )
    return general
  }

  /** First free passable tile adjacent to the city, used as the squad departure tile */
  private cityOutskirt(coord: Coord, taken: Set<string>): Coord | null {
    for (const neighbor of neighbors(coord)) {
      if (taken.has(coordKey(neighbor))) continue
      const tile = getTile(this.terrain, neighbor)
      if (!tile?.passable) continue
      return { ...neighbor }
    }
    return null
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

    general.actionPoints = Math.min(2, general.actionPoints + general.speed)
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
    this.primeMarch(general)
    this.log(
      general.faction,
      `${general.name}前往${tile?.name ?? '地块'}（${choice.target.q},${choice.target.r}）`,
    )
  }

  /** Start moving in the same round once a new direction has been chosen */
  private primeMarch(general: GeneralState): void {
    const next = general.path[0]
    if (!next) return
    const tile = getTile(this.terrain, next)
    if (!tile) return
    general.actionPoints = Math.max(general.actionPoints, tile.moveCost)
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
      this.primeMarch(general)
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
