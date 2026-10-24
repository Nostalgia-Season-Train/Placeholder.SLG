/**
 * March simulation data model.
 * Factions, generals, tile ownership, events and snapshots live here.
 * This module has no dependency on the rendering layer.
 *
 * 术语说明：General / generals 为遗留命名，指「角色」——由角色属性驱动的地图单位。
 * 「武将」仅是角色属性四种定位（武将 / 术武将 / 法师 / 疗愈师）之一，不是地图单位的通称。
 * Faction / FACTION_NAMES 为遗留命名，指「同盟」——北庭 / 东川 / 西陵 即同盟名，
 * 游戏概念中只有同盟，没有势力层。
 */
export type Faction = 'red' | 'cyan' | 'gold'

export const FACTIONS: Faction[] = ['red', 'cyan', 'gold']

/** 同盟名称 */
export const FACTION_NAMES: Record<Faction, string> = {
  red: '北庭',
  cyan: '东川',
  gold: '西陵',
}

export const FACTION_COLORS: Record<Faction, number> = {
  red: 0xd2523f,
  cyan: 0x3fa8a0,
  gold: 0xd9b23c,
}

/** 同盟与玩家的关系；每局恰有一个我方 */
export type AllianceRelation = 'self' | 'friendly' | 'hostile'

export const ALLIANCE_RELATIONS: AllianceRelation[] = ['self', 'friendly', 'hostile']

export const ALLIANCE_RELATION_LABELS: Record<AllianceRelation, string> = {
  self: '我方',
  friendly: '友方',
  hostile: '敌方',
}

/** 一个同盟：faction 为内部槽位，名称与关系由开局设置决定 */
export interface AllianceConfig {
  faction: Faction
  name: string
  relation: AllianceRelation
}

export const DEFAULT_ALLIANCES: AllianceConfig[] = [
  { faction: 'red', name: '北庭', relation: 'self' },
  { faction: 'cyan', name: '东川', relation: 'friendly' },
  { faction: 'gold', name: '西陵', relation: 'hostile' },
]

/** 运行期显示用的同盟名称表；缺省回落到内置名称 */
export type AllianceNames = Partial<Record<Faction, string>>

export function allianceNameOf(names: AllianceNames | undefined, faction: Faction): string {
  return names?.[faction] ?? FACTION_NAMES[faction]
}

export function allianceNamesOf(alliances: AllianceConfig[]): AllianceNames {
  const names: AllianceNames = {}
  for (const alliance of alliances) names[alliance.faction] = alliance.name
  return names
}

export interface Coord {
  q: number
  r: number
}

export type GeneralStatus = 'idle' | 'marching' | 'capturing' | 'garrison' | 'resting' | 'fighting'

export const STATUS_LABELS: Record<GeneralStatus, string> = {
  idle: '待命',
  marching: '行军',
  capturing: '占领',
  garrison: '驻守',
  resting: '休整',
  fighting: '交战',
}

export interface Personality {
  /** Higher values favor distant targets and enemy-held tiles. */
  aggression: number
  /** Higher values favor nearby, safe targets. */
  caution: number
}

/** Stance a commander agent can assign to a bot */
export type BotStance = 'auto' | 'attack' | 'defend' | 'hold' | 'retreat'

export const ORDER_LABELS: Record<BotStance, string> = {
  auto: '自主行动',
  attack: '进攻',
  defend: '防守',
  hold: '待命',
  retreat: '撤退',
}

/** Order issued by an agent; `auto` means the bot falls back to its own decision logic */
export interface BotOrder {
  stance: BotStance
  target: Coord | null
  note: string
  issuedRound: number
}

export interface GeneralState {
  id: string
  name: string
  faction: Faction
  /** 角色属性中的职位；用于地图与聊天统一的显示名 */
  position: GeneralPosition
  /** 角色属性中的团编制；友盟与敌盟不设团 */
  team: GeneralTeam | null
  /** 角色属性中的定位；影响兵力与普攻强度 */
  role: GeneralRole
  coord: Coord
  power: number
  /** 当前兵力与兵力上限；兵力归零即战败撤退 */
  hp: number
  maxHp: number
  personality: Personality
  order: BotOrder | null
  target: Coord | null
  path: Coord[]
  /** 当前所处地块占用的 Tick 数：普通地块 1，丘陵与河滩 2 */
  moveTicks: number
  /** 慢地形上还需原地等待的 Tick 数 */
  moveDelay: number
  /** 主动撤退后的脱战保护 Tick 数，期间不会被拖入交战 */
  retreatGrace: number
  captureProgress: number
  captureCost: number
  status: GeneralStatus
  restTurns: number
  marchDistance: number
  captured: number
}

export interface SimEvent {
  round: number
  faction: Faction | null
  text: string
}

/** Home city of one faction; squads depart from its outskirts */
export interface BaseCity {
  faction: Faction
  coord: Coord
  name: string
}

export interface SimSnapshot {
  round: number
  generals: GeneralState[]
  cities: BaseCity[]
  occupation: Map<string, Faction>
  occupationVersion: number
  events: SimEvent[]
  capturedCount: number
  capturableCount: number
  factionCounts: Record<Faction, number>
}

/** Character-card roles; decide stat lean and front-line duty */
export const GENERAL_ROLES = ['武将', '术武将', '法师', '疗愈师'] as const
export type GeneralRole = (typeof GENERAL_ROLES)[number]

/** Command positions; holders command instead of marching themselves */
export const GENERAL_POSITIONS = ['无', '团长', '大臣'] as const
export type GeneralPosition = (typeof GENERAL_POSITIONS)[number]

/** 团编制；本团为玩家所在的核心团，团1 为下属团 */
export const GENERAL_TEAMS = ['本团', '团1'] as const
export type GeneralTeam = (typeof GENERAL_TEAMS)[number]

/** Coarse stat grades used by character cards */
export const STAT_GRADES = ['低', '中', '高'] as const
export type StatGrade = (typeof STAT_GRADES)[number]

/** 统一显示名：【同盟名】团·职务·角色；团与职务缺省时省略对应段 */
export function formatUnitName(
  names: AllianceNames | undefined,
  faction: Faction,
  team: GeneralTeam | null,
  position: GeneralPosition,
  name: string,
): string {
  const parts = [team, position === '无' ? null : position, name].filter(Boolean)
  return `【${allianceNameOf(names, faction)}】${parts.join('·')}`
}

/** Character-card fields the simulation needs to place a unit on the map */
export interface CardSpawn {
  id: string
  name: string
  faction: Faction
  team: GeneralTeam | null
  role: GeneralRole
  position: GeneralPosition
  attack: StatGrade
  magic: StatGrade
  personality: string
}

/** Serializable mid-run state, enough to resume round by round */
export interface SimSaveState {
  round: number
  occupationVersion: number
  eventLimit: number
  rngState: number
  cities: BaseCity[]
  generals: GeneralState[]
  occupation: [string, Faction][]
  events: SimEvent[]
}
