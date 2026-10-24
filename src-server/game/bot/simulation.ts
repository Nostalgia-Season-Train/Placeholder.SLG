/**
 * March simulation: advances round by round. Idle generals pick a target,
 * march along their path and spend a few rounds capturing the tile.
 * Hostile generals sharing a tile settle it by combat power.
 */
import { createSeedRandom, type MapData, type SeedRandom } from '../../../src-shared/map/MapGenerator'
import { chooseTarget } from './decision'
import { findPath, findRoadPath } from './pathfinding'
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
  type FortState,
  type GeneralState,
  type GeneralRole,
  type MinionState,
  type Personality,
  type SimEvent,
  type SimSaveState,
  type SimSnapshot,
  type StatGrade,
} from '../../../src-shared/types'

/** Stances that require the bot to march to an explicit tile */
const TARGETED_STANCES: BotStance[] = ['attack', 'defend', 'retreat', 'buildFortress']

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

/**
 * 兵线：每 20 Tick，每座主城按当前归属出一波 3 个小兵，
 * 只走道路与关口，遇敌即战，相邻攻城；沿用每 Tick 一次普攻的现有战斗。
 */
const WAVE_INTERVAL = 20
const WAVE_SIZE = 3
const MINION_MAX_HP = 70
const MINION_DAMAGE = 7
const MINION_CITY_DAMAGE = 8
const CITY_MAX_HP = 600
const MAX_MINIONS_PER_FACTION = 15

/**
 * 要塞：由角色在道路或关口上驻留建造，建成后占格阻断敌方兵线，
 * 敌方必须先摧毁要塞才能继续沿路进攻。被摧毁后永久消失。
 */
const FORT_MAX_HP = 360
const FORT_MAX_PER_FACTION = 6
/** 工程档位 → 建造所需 Tick */
const FORT_BUILD_COST: Record<StatGrade, number> = { 低: 18, 中: 12, 高: 8 }
/** 工程档位 → 对要塞与主城城防的每 Tick 伤害 */
const FORT_DAMAGE: Record<StatGrade, number> = { 低: 4, 中: 7, 高: 11 }
/** 小兵对要塞的每 Tick 伤害 */
const MINION_FORT_DAMAGE = 6

/** 兵线战报：小兵全灭或主城易手时写入，由运行时转发到世界频道 */
export interface SimReport {
  round: number
  faction: Faction
  text: string
}

/** 交战单位：角色与小兵共用同一套普攻结算 */
type CombatUnit =
  | { kind: 'general'; unit: GeneralState }
  | { kind: 'minion'; unit: MinionState }

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
    // 旧存档没有工程字段，按中档处理
    engineering: general.engineering ?? '中',
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

function cloneMinion(minion: MinionState): MinionState {
  return {
    ...minion,
    coord: { ...minion.coord },
    target: minion.target ? { ...minion.target } : null,
    path: minion.path.map((tile) => ({ ...tile })),
    moveDelay: minion.moveDelay ?? 0,
    engagedSince: minion.engagedSince ?? 0,
  }
}

function cloneFort(fort: FortState): FortState {
  return { ...fort, coord: { ...fort.coord } }
}

export class MarchSimulation {
  readonly terrain: WorldTerrain
  private readonly rng: SeedRandom
  private readonly random: () => number
  private readonly alliances: AllianceConfig[]
  private readonly cities: BaseCity[]
  private readonly generals: GeneralState[]
  private readonly minions: MinionState[] = []
  private readonly forts: FortState[] = []
  private readonly occupation = new Map<string, Faction>()
  private readonly events: SimEvent[] = []
  private readonly signals: SimSignal[] = []
  private readonly reports: SimReport[] = []
  private round = 0
  private occupationVersion = 0
  private eventLimit = 14

  constructor(map: MapData, seed: number, alliances: AllianceConfig[], restore?: SimSaveState) {
    this.terrain = buildTerrain(map)
    this.rng = createSeedRandom((seed >>> 0) || 1)
    this.random = () => this.rng.next()
    this.alliances = alliances.map((alliance) => ({ ...alliance }))

    if (restore) {
      this.cities = restore.cities.map((city) => ({
        ...city,
        coord: { ...city.coord },
        // 旧存档没有归属与城防，按原主、满血处理
        owner: city.owner ?? city.faction,
        maxHp: city.maxHp ?? CITY_MAX_HP,
        hp: city.hp ?? city.maxHp ?? CITY_MAX_HP,
      }))
      this.generals = restore.generals.map(cloneGeneral)
      for (const minion of restore.minions ?? []) this.minions.push(cloneMinion(minion))
      for (const fort of restore.forts ?? []) this.forts.push(cloneFort(fort))
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
      minions: this.minions.map(cloneMinion),
      forts: this.forts.map(cloneFort),
      occupation: [...this.occupation.entries()],
      events: this.events.map((event) => ({ ...event })),
    }
  }

  /**
   * Advance one tick. A tick is also one combat round:
   * units within one tile of an enemy are locked and each lands one basic attack,
   * the rest move, capture or rest. Minions spawn first, then fight or push their lane.
   */
  step(): void {
    this.round += 1

    for (const general of this.generals) {
      if (general.retreatGrace > 0) general.retreatGrace -= 1
    }

    this.spawnWave()

    const units = this.combatUnits()
    const locked = new Set<string>()

    // 交战中收到撤退指令的单位优先脱离，脱离保护期内不会被再次拖入交战
    for (const unit of units) {
      if (unit.kind !== 'general') continue
      if (unit.unit.order?.stance !== 'retreat' || !this.engaged(unit, units)) continue
      this.disengage(unit.unit)
      locked.add(unit.unit.id)
    }

    const fighters = units.filter((unit) => this.engaged(unit, units))
    if (fighters.length > 0) {
      this.fightRound(fighters)
      for (const fighter of fighters) locked.add(fighter.unit.id)
    }

    // 不再交战的兵线清空交战起点，下次重新计时
    for (const unit of units) {
      if (unit.kind === 'minion' && !fighters.includes(unit)) unit.unit.engagedSince = 0
    }

    // 工事：先推进建造进度，再结算对要塞与主城的工程伤害（均不消费随机数）
    this.advanceFortBuilds()
    this.resolveFortSieges(locked)

    for (const general of this.generals) {
      if (locked.has(general.id)) continue
      this.act(general)
    }

    for (const minion of this.minions) {
      if (locked.has(minion.id)) continue
      this.actMinion(minion)
    }
  }

  /** Assign an order to one bot; returns false when the bot does not belong to the simulation */
  setOrder(generalId: string, order: BotOrder): boolean {
    const general = this.generals.find((item) => item.id === generalId)
    if (!general) return false

    // 换指令即放弃在建工事；重新下达同一筑垒目标时保留已完成进度
    this.cancelBuilderForts(
      general.id,
      '收到新指令',
      order.stance === 'buildFortress' ? order.target ?? undefined : undefined,
    )

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

  /** 取走本轮累积的兵线战报，供运行时转发到世界频道 */
  drainReports(): SimReport[] {
    return this.reports.splice(0, this.reports.length)
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
      minions: this.minions.map(cloneMinion),
      forts: this.forts.map(cloneFort),
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
      result.push({
        faction: alliance.faction,
        owner: alliance.faction,
        coord: { ...coord },
        name: `${alliance.name}主城`,
        hp: CITY_MAX_HP,
        maxHp: CITY_MAX_HP,
      })
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
      engineering: card.engineering ?? '中',
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
      if (this.readyFortAt(neighbor)) continue
      const tile = getTile(this.terrain, neighbor)
      if (!tile?.passable) continue
      return { ...neighbor }
    }
    return null
  }

  /* ------------------------------------------------------------------ */
  /* Minion lanes                                                        */
  /* ------------------------------------------------------------------ */

  private cityKeys(): Set<string> {
    return new Set(this.cities.map((city) => coordKey(city.coord)))
  }

  private cityAt(coord: Coord): BaseCity | undefined {
    return this.cities.find((city) => coordKey(city.coord) === coordKey(coord))
  }

  private fortAt(coord: Coord): FortState | undefined {
    return this.forts.find((fort) => coordKey(fort.coord) === coordKey(coord))
  }

  /** 只返回已建成的要塞：半成品只做展示，不阻断、不可攻击 */
  private readyFortAt(coord: Coord): FortState | undefined {
    return this.forts.find((fort) => fort.status === 'ready' && coordKey(fort.coord) === coordKey(coord))
  }

  /** 敌方已建成的要塞占格不可通行；归属方与其友军可正常通行 */
  private blockedFor(faction: Faction): (coord: Coord) => boolean {
    const hostile = this.hostileFactions(faction)
    return (coord) => {
      const fort = this.readyFortAt(coord)
      return fort !== undefined && hostile.has(fort.faction)
    }
  }

  private nameOf(faction: Faction): string {
    return this.alliances.find((item) => item.faction === faction)?.name ?? faction
  }

  /** 关系为「敌方」的同盟与其余所有同盟互为敌对；我方与友方互为友军 */
  private hostileFactions(faction: Faction): Set<Faction> {
    const hostile = new Set(
      this.alliances.filter((item) => item.relation === 'hostile').map((item) => item.faction),
    )
    if (hostile.has(faction)) {
      return new Set(
        this.alliances
          .map((item) => item.faction)
          .filter((other) => other !== faction && !hostile.has(other)),
      )
    }
    hostile.delete(faction)
    return hostile
  }

  /** 主城相邻的道路或关口地块，作为兵线终点候选 */
  private cityApproaches(coord: Coord): Coord[] {
    const goals: Coord[] = []
    for (const neighbor of neighbors(coord)) {
      const tile = getTile(this.terrain, neighbor)
      if (tile?.passable && (tile.road || tile.gate)) goals.push({ ...neighbor })
    }
    return goals
  }

  /** 本城出兵点：按 neighbors 顺序取第一个道路或关口邻格 */
  private cityRoadOutskirt(coord: Coord): Coord | null {
    for (const neighbor of neighbors(coord)) {
      const tile = getTile(this.terrain, neighbor)
      if (tile?.passable && (tile.road || tile.gate)) return { ...neighbor }
    }
    return null
  }

  /** 从当前位置选一条通往敌对主城的道路，取路径最短者，平手按 cities 顺序 */
  private chooseEnemyRoute(
    faction: Faction,
    start: Coord,
  ): { city: BaseCity; path: Coord[] } | null {
    const enemies = this.hostileFactions(faction)
    let best: { city: BaseCity; path: Coord[]; cost: number } | null = null

    for (const city of this.cities) {
      if (!enemies.has(city.owner)) continue
      const route = findRoadPath(this.terrain, start, this.cityApproaches(city.coord))
      if (!route) continue
      if (!best || route.cost < best.cost) best = { city, path: route.path, cost: route.cost }
    }

    return best ? { city: best.city, path: best.path } : null
  }

  /** 每 20 Tick 由每座主城按当前归属出一波小兵 */
  private spawnWave(): void {
    if (this.round % WAVE_INTERVAL !== 0) return

    for (const city of this.cities) {
      const faction = city.owner
      const alive = this.minions.filter((minion) => minion.faction === faction).length
      if (alive >= MAX_MINIONS_PER_FACTION) continue

      const start = this.cityRoadOutskirt(city.coord)
      if (!start) continue

      const route = this.chooseEnemyRoute(faction, start)
      if (!route) continue

      for (let index = 0; index < WAVE_SIZE; index += 1) {
        this.minions.push({
          id: `minion-${this.round}-${faction}-${index}`,
          faction,
          coord: { ...start },
          hp: MINION_MAX_HP,
          maxHp: MINION_MAX_HP,
          target: { ...route.city.coord },
          path: route.path.map((tile) => ({ ...tile })),
          moveDelay: 0,
          status: 'marching',
          wave: this.round,
          engagedSince: 0,
        })
      }

      this.log(
        faction,
        `${this.nameOf(faction)}自${city.name}派出${WAVE_SIZE}个小兵，目标${route.city.name}`,
      )
    }
  }

  /** 小兵单个 Tick：重选目标、攻城或沿道路推进一格 */
  private actMinion(minion: MinionState): void {
    let city = minion.target ? this.cityAt(minion.target) : undefined
    if (
      !city ||
      city.owner === minion.faction ||
      !this.hostileFactions(minion.faction).has(city.owner)
    ) {
      const route = this.chooseEnemyRoute(minion.faction, minion.coord)
      if (!route) {
        minion.target = null
        minion.path = []
        return
      }
      minion.target = { ...route.city.coord }
      minion.path = route.path.map((tile) => ({ ...tile }))
      minion.moveDelay = 0
      city = route.city
    }

    // 挡在路上的敌方要塞：先拆要塞，既不能前进也不能越过它攻城
    if (this.adjacentEnemyFort(minion.faction, minion.coord, minion.path[0])) {
      minion.status = 'sieging'
      return
    }

    if (hexDistance(minion.coord, city.coord) <= 1) {
      minion.status = 'sieging'
      this.siegeCity(city, minion.faction)
      return
    }

    if (minion.moveDelay > 0) {
      minion.moveDelay -= 1
      return
    }

    const next = minion.path[0]
    if (!next) {
      // 路径走完却没到城边，重新沿道路计算一次
      const route = this.chooseEnemyRoute(minion.faction, minion.coord)
      if (route) {
        minion.target = { ...route.city.coord }
        minion.path = route.path.map((tile) => ({ ...tile }))
      }
      return
    }

    minion.path.shift()
    minion.coord = { ...next }
    if (getTile(this.terrain, next)?.gate) minion.moveDelay = 1
    minion.status = 'marching'
  }

  private siegeCity(city: BaseCity, faction: Faction): void {
    city.hp = Math.max(0, city.hp - MINION_CITY_DAMAGE)
    if (city.hp > 0) return
    this.captureCity(city, faction)
  }

  /** 城破：归属改攻方、城防回满、地块同步，并通知原主与攻方角色 */
  private captureCity(city: BaseCity, attacker: Faction): void {
    const previous = city.owner
    city.owner = attacker
    city.hp = city.maxHp
    this.occupation.set(coordKey(city.coord), attacker)
    this.occupationVersion += 1

    const text = `${this.nameOf(attacker)}攻破${city.name}，${this.nameOf(previous)}失城`
    this.log(attacker, text)
    this.reports.push({ round: this.round, faction: attacker, text })
    this.signal('lost', previous, null, '主城失守', `${city.name}被${this.nameOf(attacker)}攻破`)
    this.signal('capture', attacker, null, '攻破主城', `${this.nameOf(attacker)}攻破${city.name}`)
  }

  private loseMinion(minion: MinionState, attacker: Faction): void {
    const index = this.minions.indexOf(minion)
    if (index < 0) return
    this.minions.splice(index, 1)

    const left = this.minions.filter((item) => item.faction === minion.faction).length
    const from = minion.engagedSince > 0 ? minion.engagedSince : minion.wave
    const text =
      `${this.nameOf(minion.faction)}的兵线在（${minion.coord.q},${minion.coord.r}）` +
      `被${this.nameOf(attacker)}击溃，尚存${left}个小兵（第${from}~${this.round}回合）`
    this.log(minion.faction, text)
    this.reports.push({ round: this.round, faction: minion.faction, text })
  }

  /* ------------------------------------------------------------------ */
  /* Fortifications                                                      */
  /* ------------------------------------------------------------------ */

  /** 相邻（≤1 格）的敌方已建成要塞；优先返回挡在当前路径上的那座 */
  private adjacentEnemyFort(faction: Faction, coord: Coord, preferred?: Coord): FortState | null {
    const hostile = this.hostileFactions(faction)
    const candidates = this.forts.filter(
      (fort) =>
        fort.status === 'ready' &&
        hostile.has(fort.faction) &&
        hexDistance(fort.coord, coord) <= 1,
    )
    if (candidates.length === 0) return null
    if (preferred) {
      const ahead = candidates.find((fort) => coordKey(fort.coord) === coordKey(preferred))
      if (ahead) return ahead
    }
    return candidates[0]!
  }

  private adjacentEnemyCity(faction: Faction, coord: Coord): BaseCity | null {
    const hostile = this.hostileFactions(faction)
    for (const city of this.cities) {
      if (!hostile.has(city.owner)) continue
      if (hexDistance(city.coord, coord) <= 1) return city
    }
    return null
  }

  /**
   * 工程结算：被交战锁定的单位本 Tick 先解决遭遇战，不攻击工事。
   * 小兵与角色相邻敌方要塞即可拆除；角色没有要塞可拆时攻击相邻敌对主城的城防。
   * 顺序固定（小兵 → 角色，各自按数组顺序），伤害同时生效，不消费随机数。
   */
  private resolveFortSieges(locked: Set<string>): void {
    const fortIncoming = new Map<FortState, { damage: number; attacker: Faction }>()
    const cityIncoming = new Map<BaseCity, { damage: number; attacker: Faction }>()

    const addFort = (fort: FortState, damage: number, attacker: Faction): void => {
      const entry = fortIncoming.get(fort)
      if (entry) entry.damage += damage
      else fortIncoming.set(fort, { damage, attacker })
    }
    const addCity = (city: BaseCity, damage: number, attacker: Faction): void => {
      const entry = cityIncoming.get(city)
      if (entry) entry.damage += damage
      else cityIncoming.set(city, { damage, attacker })
    }

    for (const minion of this.minions) {
      if (locked.has(minion.id)) continue
      const fort = this.adjacentEnemyFort(minion.faction, minion.coord, minion.path[0])
      if (fort) addFort(fort, MINION_FORT_DAMAGE, minion.faction)
    }

    for (const general of this.generals) {
      if (locked.has(general.id) || general.restTurns > 0) continue
      const fort = this.adjacentEnemyFort(general.faction, general.coord)
      if (fort) {
        addFort(fort, FORT_DAMAGE[general.engineering], general.faction)
        continue
      }
      const city = this.adjacentEnemyCity(general.faction, general.coord)
      if (city) addCity(city, FORT_DAMAGE[general.engineering], general.faction)
    }

    for (const [fort, entry] of fortIncoming) {
      fort.hp = Math.max(0, fort.hp - entry.damage)
      if (fort.hp > 0) continue
      this.destroyFort(fort, entry.attacker)
    }

    for (const [city, entry] of cityIncoming) {
      city.hp = Math.max(0, city.hp - entry.damage)
      if (city.hp <= 0) this.captureCity(city, entry.attacker)
    }
  }

  /** 建造中的要塞每 Tick 累积 1 点进度；建造者必须仍在格上并保持筑垒指令 */
  private advanceFortBuilds(): void {
    for (const fort of [...this.forts]) {
      if (fort.status !== 'building') continue

      const builder = this.generals.find((general) => general.id === fort.builderId)
      if (!builder) {
        this.cancelFort(fort, '建造者已不在战场')
        continue
      }

      const holding =
        coordKey(builder.coord) === coordKey(fort.coord) &&
        builder.order?.stance === 'buildFortress' &&
        builder.order.target !== null &&
        coordKey(builder.order.target) === coordKey(fort.coord)
      if (!holding) {
        this.cancelFort(fort, `${builder.name}离开建造位置`)
        continue
      }

      fort.progress += 1
      if (fort.progress < fort.buildCost) continue

      fort.progress = fort.buildCost
      fort.status = 'ready'
      fort.builtRound = this.round
      this.occupation.set(coordKey(fort.coord), fort.faction)
      this.occupationVersion += 1

      const text = `${this.nameOf(fort.faction)}的${builder.name}建成要塞（${fort.coord.q},${fort.coord.r}）`
      this.log(fort.faction, text)
      this.reports.push({ round: this.round, faction: fort.faction, text })
      this.signal('capture', fort.faction, builder.id, '要塞建成', `${builder.name}建成要塞`)
    }
  }

  /** 角色抵达筑垒目标格：校验通过后开工，站上目标格的当前 Tick 即算第 1 点进度 */
  private startFort(general: GeneralState): void {
    const target = general.order?.target
    if (!target) {
      general.order = null
      return
    }

    const existing = this.fortAt(target)
    if (existing) {
      // 正在由自己建造：继续累积进度
      if (existing.status === 'building' && existing.builderId === general.id) {
        general.status = 'capturing'
        return
      }
      // 该格已有要塞（含自己刚建成的）：指令完成，原地驻守
      general.order = null
      general.target = null
      general.path = []
      general.status = 'garrison'
      return
    }

    const reason = this.fortBlockReason(general, target)
    if (reason) {
      general.order = null
      general.target = null
      general.path = []
      general.status = 'idle'
      this.signal('blocked', general.faction, general.id, '无法筑垒', `${general.name}${reason}`)
      return
    }

    this.forts.push({
      id: `fort-${this.round}-${general.id}`,
      faction: general.faction,
      coord: { ...target },
      hp: FORT_MAX_HP,
      maxHp: FORT_MAX_HP,
      status: 'building',
      progress: 1,
      buildCost: FORT_BUILD_COST[general.engineering],
      builderId: general.id,
      builtRound: 0,
    })

    general.captureProgress = 0
    general.status = 'capturing'
    this.log(general.faction, `${general.name}在（${target.q},${target.r}）开始筑垒`)
  }

  /** 筑垒位置合法性：返回不可建的原因，合法时返回 null */
  private fortBlockReason(general: GeneralState, coord: Coord): string | null {
    const tile = getTile(this.terrain, coord)
    if (!tile?.passable || (!tile.road && !tile.gate)) return '只能在道路或关口上筑垒'
    if (this.cityAt(coord)) return '无法在主城格筑垒'

    for (const city of this.cities) {
      if (hexDistance(city.coord, coord) <= 1) return '距主城太近，无法筑垒'
    }

    const owner = this.occupation.get(coordKey(coord))
    if (owner && owner !== general.faction) return '只能在自己或中立地块上筑垒'

    const occupied =
      this.generals.some(
        (other) => other !== general && coordKey(other.coord) === coordKey(coord),
      ) || this.minions.some((minion) => coordKey(minion.coord) === coordKey(coord))
    if (occupied) return '目标地块上还有其他单位'

    const mine = this.forts.filter((fort) => fort.faction === general.faction).length
    if (mine >= FORT_MAX_PER_FACTION) return `要塞数量已达上限（${FORT_MAX_PER_FACTION}）`
    return null
  }

  /** 建造者换指令、撤退或战败时清除其在建工事；重新下达同一目标时保留进度 */
  private cancelBuilderForts(generalId: string, reason: string, keep?: Coord): void {
    for (const fort of [...this.forts]) {
      if (fort.status !== 'building' || fort.builderId !== generalId) continue
      if (keep && coordKey(keep) === coordKey(fort.coord)) continue
      this.cancelFort(fort, reason)
    }
  }

  private cancelFort(fort: FortState, reason: string): void {
    const index = this.forts.indexOf(fort)
    if (index < 0) return
    this.forts.splice(index, 1)

    const text = `${this.nameOf(fort.faction)}在（${fort.coord.q},${fort.coord.r}）的在建要塞中断：${reason}`
    this.log(fort.faction, text)
    this.reports.push({ round: this.round, faction: fort.faction, text })
  }

  /** 要塞血量归零：永久移除，并清空该格归属 */
  private destroyFort(fort: FortState, attacker: Faction): void {
    const index = this.forts.indexOf(fort)
    if (index < 0) return
    this.forts.splice(index, 1)
    if (this.occupation.get(coordKey(fort.coord)) === fort.faction) {
      this.occupation.delete(coordKey(fort.coord))
      this.occupationVersion += 1
    }

    const text = `${this.nameOf(attacker)}摧毁${this.nameOf(fort.faction)}的要塞（${fort.coord.q},${fort.coord.r}）`
    this.log(fort.faction, text)
    this.reports.push({ round: this.round, faction: attacker, text })
    this.signal('lost', fort.faction, null, '要塞失守', `${this.nameOf(fort.faction)}的要塞被摧毁`)
    this.signal('capture', attacker, null, '摧毁要塞', `${this.nameOf(attacker)}摧毁要塞`)
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
        // 筑垒：站上目标格即开工，之后原地驻留直到建成
        if (general.order?.stance === 'buildFortress') {
          const target = general.order.target
          if (target && coordKey(general.coord) === coordKey(target)) {
            this.startFort(general)
            return
          }
        }
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

    // 敌方要塞占格：停在原地，由 resolveFortSieges 拆除后才可继续
    if (this.blockedFor(general.faction)(next)) return

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

    // 主城格与要塞格都不作为自由行动的目标
    const exclude = this.cityKeys()
    for (const fort of this.forts) exclude.add(coordKey(fort.coord))

    const choice = chooseTarget(
      general,
      this.terrain,
      this.occupation,
      locked,
      this.random,
      exclude,
    )
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

    // 主城格只由小兵破城改归属，角色到达后视为驻守
    if (this.cityAt(general.coord)) {
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
    if (order.stance === 'buildFortress' && !tile.road && !tile.gate) {
      general.order = null
      this.signal('blocked', general.faction, general.id, '目标失效', `${general.name}的筑垒目标不是道路或关口`)
      return
    }

    const targetKey = coordKey(order.target)
    if (coordKey(general.coord) === targetKey) {
      general.target = { ...order.target }
      return
    }

    if (!general.target || coordKey(general.target) !== targetKey || general.path.length === 0) {
      const result = findPath(
        this.terrain,
        general.coord,
        order.target,
        4000,
        this.blockedFor(general.faction),
      )
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

  /** 全部可参战单位：角色在前、小兵在后，顺序固定以保证随机数消费顺序 */
  private combatUnits(): CombatUnit[] {
    return [
      ...this.generals.map((unit): CombatUnit => ({ kind: 'general', unit })),
      ...this.minions.map((unit): CombatUnit => ({ kind: 'minion', unit })),
    ]
  }

  /** 同格或 6 个周边地块的敌对单位即进入交战状态；休整与脱战保护期内除外 */
  private engaged(unit: CombatUnit, units: CombatUnit[]): boolean {
    if (unit.kind === 'general') {
      if (unit.unit.restTurns > 0 || unit.unit.retreatGrace > 0) return false
    }
    return units.some(
      (other) =>
        other.unit !== unit.unit &&
        other.unit.faction !== unit.unit.faction &&
        (other.kind === 'minion' || other.unit.restTurns === 0) &&
        hexDistance(other.unit.coord, unit.unit.coord) <= 1,
    )
  }

  /**
   * 一个 Tick 即一个战斗回合：交战双方各进行一次普攻，伤害同时结算。
   * 角色普攻按 units 中的固定顺序消费随机数；小兵伤害固定，不消费随机数。
   */
  private fightRound(fighters: CombatUnit[]): void {
    const incoming = new Map<string, { damage: number; attacker: Faction }>()

    for (const fighter of fighters) {
      const target = this.chooseCombatTarget(fighter, fighters)
      if (!target) continue
      const damage = fighter.kind === 'general' ? this.basicDamage(fighter.unit) : MINION_DAMAGE
      const entry = incoming.get(target.unit.id)
      if (entry) entry.damage += damage
      else incoming.set(target.unit.id, { damage, attacker: fighter.unit.faction })
    }

    const fallenGenerals: GeneralState[] = []
    const fallenMinions: { minion: MinionState; attacker: Faction }[] = []
    const fallenIds = new Set<string>()

    for (const [id, entry] of incoming) {
      const target = fighters.find((unit) => unit.unit.id === id)
      if (!target) continue
      target.unit.hp = Math.max(0, target.unit.hp - entry.damage)
      if (target.unit.hp > 0) continue
      fallenIds.add(id)
      if (target.kind === 'general') fallenGenerals.push(target.unit)
      else fallenMinions.push({ minion: target.unit, attacker: entry.attacker })
    }

    for (const general of fallenGenerals) this.defeat(general)
    for (const entry of fallenMinions) this.loseMinion(entry.minion, entry.attacker)

    for (const fighter of fighters) {
      if (fallenIds.has(fighter.unit.id)) continue
      if (fighter.kind === 'general') {
        if (fighter.unit.status === 'fighting') continue
        fighter.unit.status = 'fighting'
        this.signal('encounter', fighter.unit.faction, fighter.unit.id, '遭遇战', `${fighter.unit.name}进入交战`)
      } else {
        // 记录交战起点，战报里用回合区间描述这场遭遇
        if (fighter.unit.engagedSince === 0) fighter.unit.engagedSince = this.round
        fighter.unit.status = 'fighting'
      }
    }
  }

  /** 同格敌人优先，其次是相邻敌人；同等条件下优先攻击兵力最少者 */
  private chooseCombatTarget(fighter: CombatUnit, units: CombatUnit[]): CombatUnit | null {
    const enemies = units.filter(
      (other) => other.unit !== fighter.unit && other.unit.faction !== fighter.unit.faction,
    )
    if (enemies.length === 0) return null

    const sameTile = enemies.filter(
      (other) => coordKey(other.unit.coord) === coordKey(fighter.unit.coord),
    )
    const pool = sameTile.length > 0 ? sameTile : enemies

    let best: CombatUnit = pool[0]!
    for (const enemy of pool) {
      if (
        enemy.unit.hp < best.unit.hp ||
        (enemy.unit.hp === best.unit.hp && enemy.unit.id < best.unit.id)
      ) {
        best = enemy
      }
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
    this.cancelBuilderForts(loser.id, '建造者被迫后撤')
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
    this.cancelBuilderForts(general.id, '建造者主动撤退')
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
    const hostile = this.hostileFactions(loser.faction)

    for (const neighbor of neighbors(loser.coord)) {
      const tile = getTile(this.terrain, neighbor)
      if (!tile?.passable) continue

      // 敌方要塞占格不可进入
      const fort = this.readyFortAt(neighbor)
      if (fort && hostile.has(fort.faction)) continue

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
