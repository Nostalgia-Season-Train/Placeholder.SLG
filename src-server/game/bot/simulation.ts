/**
 * March simulation: advances round by round. Idle generals pick a target,
 * march along their path and spend a few rounds capturing the tile.
 * Hostile generals sharing a tile settle it by combat power.
 */
import { createSeedRandom, type MapData, type SeedRandom } from '../../../src-shared/map/MapGenerator'
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
  ORDER_LABELS,
  personalityOf,
  type AllianceConfig,
  type BaseCity,
  type BotOrder,
  type BotStance,
  type CardSpawn,
  type Faction,
  type Coord,
  type GeneralState,
  type GeneralRole,
  type Personality,
  type SimEvent,
  type SimSaveState,
  type SimSnapshot,
  type StatGrade,
} from '../../../src-shared/types'

/** Stances that require the bot to march to an explicit tile */
const TARGETED_STANCES: BotStance[] = ['attack', 'defend', 'retreat']

/** 关键点信号：交给角色协程判断，本身不参与推演、不消费随机数 */
export type SimSignalKind = 'encounter' | 'capture' | 'defeat' | 'blocked' | 'lost'

export interface SimSignal {
  kind: SimSignalKind
  faction: Faction
  /** 相关单位；地块易手这类没有具体单位的变化为 null */
  generalId: string | null
  round: number
  label: string
  detail: string
}

/** Stat grades mapped onto a 1..3 power scale */
const GRADE_SCORE: Record<StatGrade, number> = { 低: 1, 中: 2, 高: 3 }

/** 定位对兵力上限与普攻强度的缩放系数 */
const ROLE_COMBAT: Record<GeneralRole, { hp: number; attack: number }> = {
  武将: { hp: 1.15, attack: 1.15 },
  术武将: { hp: 1.05, attack: 1.05 },
  法师: { hp: 0.9, attack: 0.95 },
  疗愈师: { hp: 0.85, attack: 0.8 },
}

/** 由战力换算兵力上限，再按定位缩放 */
function maxHpOf(power: number, role: GeneralRole): number {
  return Math.round((60 + power * 2) * ROLE_COMBAT[role].hp)
}

function cloneGeneral(general: GeneralState): GeneralState {
  const role = general.role ?? '武将'
  const maxHp = general.maxHp ?? maxHpOf(general.power, role)
  return {
    ...general,
    // 旧存档没有职位与团字段，按「无职位、无团」处理
    position: general.position ?? '无',
    team: general.team ?? null,
    role,
    maxHp,
    hp: general.hp ?? maxHp,
    // 旧存档没有 Tick 字段，按未移动处理
    moveTicks: general.moveTicks ?? 0,
    moveDelay: general.moveDelay ?? 0,
    retreatGrace: general.retreatGrace ?? 0,
    coord: { ...general.coord },
    personality: { ...general.personality, assault: general.personality.assault ?? 0 },
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
  private readonly alliances: AllianceConfig[]
  private readonly cities: BaseCity[]
  private readonly generals: GeneralState[]
  private readonly occupation = new Map<string, Faction>()
  private readonly events: SimEvent[] = []
  private readonly signals: SimSignal[] = []
  private round = 0
  private occupationVersion = 0
  private eventLimit = 14

  constructor(map: MapData, seed: number, alliances: AllianceConfig[], restore?: SimSaveState) {
    this.terrain = buildTerrain(map)
    this.rng = createSeedRandom((seed >>> 0) || 1)
    this.random = () => this.rng.next()
    this.alliances = alliances.map((alliance) => ({ ...alliance }))

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

  /**
   * Advance one tick. A tick is also one combat round:
   * units within one tile of an enemy are locked and each lands one basic attack,
   * the rest move, capture or rest.
   */
  step(): void {
    this.round += 1

    for (const general of this.generals) {
      if (general.retreatGrace > 0) general.retreatGrace -= 1
    }

    // 交战中收到撤退指令的单位优先脱离，脱离保护期内不会被再次拖入交战
    const locked = new Set<string>()
    for (const general of this.generals) {
      if (general.order?.stance !== 'retreat' || !this.engaged(general)) continue
      this.disengage(general)
      locked.add(general.id)
    }

    const fighters = this.generals.filter((general) => this.engaged(general))
    if (fighters.length > 0) {
      this.fightRound(fighters)
      for (const fighter of fighters) locked.add(fighter.id)
    }

    for (const general of this.generals) {
      if (locked.has(general.id)) continue
      this.act(general)
    }
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

  /** 取走本轮累积的关键点信号，供角色系统唤醒对应角色 */
  drainSignals(): SimSignal[] {
    return this.signals.splice(0, this.signals.length)
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
        personality: { ...general.personality, assault: general.personality.assault ?? 0 },
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

  /** One home city per enabled alliance, in configuration order against map.spawns */
  private createCities(map: MapData): BaseCity[] {
    const result: BaseCity[] = []

    this.alliances.forEach((alliance, factionIndex) => {
      const anchor = map.spawns[factionIndex]
      const coord = anchor
        ? getTile(this.terrain, anchor)?.passable
          ? { ...anchor }
          : nearestCapturable(this.terrain, anchor)
        : null
      if (!coord) return

      this.occupation.set(coordKey(coord), alliance.faction)
      result.push({ faction: alliance.faction, coord: { ...coord }, name: `${alliance.name}主城` })
      this.log(alliance.faction, `${alliance.name}主城设立于（${coord.q},${coord.r}）`)
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

    const power = 32 + GRADE_SCORE[card.attack] * 10 + GRADE_SCORE[card.magic] * 7
    const maxHp = maxHpOf(power, card.role)

    const general: GeneralState = {
      id: `card-${card.id}`,
      name: card.name,
      faction: card.faction,
      position: card.position,
      team: card.team ?? null,
      role: card.role,
      coord: { ...spawn },
      power,
      hp: maxHp,
      maxHp,
      personality: personalityOf(card.personality),
      order: null,
      target: null,
      path: [],
      moveTicks: 0,
      moveDelay: 0,
      retreatGrace: 0,
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
      // 休整只恢复部分兵力，撤退后不会直接回满
      general.hp = Math.min(general.maxHp, general.hp + Math.ceil(general.maxHp * 0.15))
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

    general.status = 'marching'

    // 慢地形（丘陵、河滩、关口）占 2 个 Tick：进入后原地等待一格
    if (general.moveDelay > 0) {
      general.moveDelay -= 1
      return
    }

    const next = general.path[0]
    if (!next) return
    const tile = getTile(this.terrain, next)
    if (!tile) return

    general.path.shift()
    general.coord = { ...next }
    general.moveTicks = Math.max(1, Math.round(tile.moveCost))
    general.moveDelay = general.moveTicks - 1
    general.marchDistance += general.moveTicks

    if (coordKey(general.coord) === coordKey(general.target)) {
      this.captureTile(general)
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
    // 地块上有敌军时不能占领，需先分出胜负
    if (this.enemyOnTile(general)) return

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
    this.signal('capture', general.faction, general.id, '占领成功', `${general.name}占领${tile.name}`)
    if (owner) {
      this.signal(
        'lost',
        owner,
        null,
        '地块易手',
        `${tile.name}被${general.name}夺取`,
      )
    }
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
      this.signal('blocked', general.faction, general.id, '目标失效', `${general.name}的指令目标不可通行`)
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
        this.signal('blocked', general.faction, general.id, '行军受阻', `${general.name}无法抵达指令目标`)
        return
      }
      general.target = { ...order.target }
      general.path = result.path
      general.captureProgress = 0
      general.captureCost = Math.max(2, tile.level + 1)
    }
  }

  /* ------------------------------------------------------------------ */
  /* Combat                                                              */
  /* ------------------------------------------------------------------ */

  /** 同格或 6 个周边地块的敌对单位即进入交战状态；休整与脱战保护期内除外 */
  private engaged(general: GeneralState): boolean {
    if (general.restTurns > 0 || general.retreatGrace > 0) return false
    return this.generals.some(
      (other) =>
        other !== general &&
        other.faction !== general.faction &&
        other.restTurns === 0 &&
        hexDistance(other.coord, general.coord) <= 1,
    )
  }

  /**
   * 一个 Tick 即一个战斗回合：交战双方各进行一次普攻，伤害同时结算。
   * 随机数按 this.generals 的固定顺序消费，保证推演确定性。
   */
  private fightRound(fighters: GeneralState[]): void {
    const incoming = new Map<string, number>()

    for (const fighter of fighters) {
      const target = this.chooseCombatTarget(fighter, fighters)
      if (!target) continue
      const damage = this.basicDamage(fighter)
      incoming.set(target.id, (incoming.get(target.id) ?? 0) + damage)
    }

    for (const [id, damage] of incoming) {
      const target = this.generals.find((general) => general.id === id)
      if (!target) continue
      target.hp = Math.max(0, target.hp - damage)
      if (target.hp > 0) continue
      this.defeat(target)
    }

    for (const fighter of fighters) {
      if (fighter.status === 'fighting') continue
      fighter.status = 'fighting'
      this.signal('encounter', fighter.faction, fighter.id, '遭遇战', `${fighter.name}进入交战`)
    }
  }

  /** 同格敌人优先，其次是相邻敌人；同等条件下优先攻击兵力最少者 */
  private chooseCombatTarget(fighter: GeneralState, fighters: GeneralState[]): GeneralState | null {
    const enemies = fighters.filter(
      (other) => other !== fighter && other.faction !== fighter.faction,
    )
    if (enemies.length === 0) return null

    const sameTile = enemies.filter((other) => coordKey(other.coord) === coordKey(fighter.coord))
    const pool = sameTile.length > 0 ? sameTile : enemies

    let best: GeneralState = pool[0]!
    for (const enemy of pool) {
      if (enemy.hp < best.hp || (enemy.hp === best.hp && enemy.id < best.id)) best = enemy
    }
    return best
  }

  /** 单次普攻伤害：战力换算后按定位缩放，附带 ±10% 浮动 */
  private basicDamage(general: GeneralState): number {
    const base = (6 + general.power * 0.28) * ROLE_COMBAT[general.role].attack
    return Math.max(1, Math.round(base * (0.9 + this.random() * 0.2)))
  }

  /** 兵力归零：撤退到相邻空格并休整，兵力不回满 */
  private defeat(loser: GeneralState): void {
    const retreat = this.retreatTile(loser)
    if (retreat) loser.coord = retreat
    loser.hp = Math.max(1, loser.hp)
    loser.target = null
    loser.path = []
    loser.captureProgress = 0
    loser.moveDelay = 0
    loser.moveTicks = 0
    loser.retreatGrace = 0
    loser.restTurns = 2
    loser.status = 'resting'
    loser.order = null

    this.log(loser.faction, `${loser.name}兵力耗尽，被迫后撤休整`)
    this.signal('defeat', loser.faction, loser.id, '交战失利', `${loser.name}兵力耗尽，被迫后撤`)
  }

  /** 主动撤退：向远离敌军的方向退一格，并获得 2 Tick 脱战保护 */
  private disengage(general: GeneralState): void {
    const retreat = this.retreatTile(general)
    if (retreat) {
      general.coord = retreat
      const tile = getTile(this.terrain, retreat)
      general.moveTicks = Math.max(1, Math.round(tile?.moveCost ?? 1))
      general.marchDistance += general.moveTicks
    }

    general.target = null
    general.path = []
    general.captureProgress = 0
    general.moveDelay = 0
    general.retreatGrace = 2
    general.status = 'marching'
    this.log(general.faction, `${general.name}主动脱离交战`)
  }

  private enemyOnTile(general: GeneralState): GeneralState | undefined {
    return this.generals.find(
      (other) =>
        other !== general &&
        other.faction !== general.faction &&
        coordKey(other.coord) === coordKey(general.coord),
    )
  }

  /** 撤退落点：在可通行的相邻地块中，选离最近敌军最远的一块 */
  private retreatTile(loser: GeneralState): Coord | null {
    let best: Coord | null = null
    let bestDistance = -Infinity

    for (const neighbor of neighbors(loser.coord)) {
      const tile = getTile(this.terrain, neighbor)
      if (!tile?.passable) continue

      let nearestEnemy = Infinity
      for (const other of this.generals) {
        if (other === loser || other.faction === loser.faction) continue
        if (coordKey(other.coord) === coordKey(neighbor)) {
          nearestEnemy = -Infinity
          break
        }
        nearestEnemy = Math.min(nearestEnemy, hexDistance(other.coord, neighbor))
      }

      if (nearestEnemy === -Infinity) continue
      if (nearestEnemy > bestDistance) {
        bestDistance = nearestEnemy
        best = neighbor
      }
    }

    return best
  }

  private log(faction: Faction, text: string): void {
    this.events.push({ round: this.round, faction, text })
    if (this.events.length > 80) this.events.splice(0, this.events.length - 80)
  }

  private signal(
    kind: SimSignalKind,
    faction: Faction,
    generalId: string | null,
    label: string,
    detail: string,
  ): void {
    this.signals.push({ kind, faction, generalId, round: this.round, label, detail })
    if (this.signals.length > 200) this.signals.splice(0, this.signals.length - 200)
  }
}
