/**
 * March simulation data model.
 * Factions, generals, tile ownership, events and snapshots live here.
 * This module has no dependency on the rendering layer.
 *
 * 术语说明：General / generals 为遗留命名，指「角色」——由角色卡驱动的地图单位。
 * 「武将」仅是角色卡四种定位（武将 / 术武将 / 法师 / 疗愈师）之一，不是地图单位的通称。
 */
export type Faction = 'red' | 'cyan' | 'gold'

export const FACTIONS: Faction[] = ['red', 'cyan', 'gold']

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

export interface Coord {
  q: number
  r: number
}

export type GeneralStatus = 'idle' | 'marching' | 'capturing' | 'garrison' | 'resting'

export const STATUS_LABELS: Record<GeneralStatus, string> = {
  idle: '待命',
  marching: '行军',
  capturing: '占领',
  garrison: '驻守',
  resting: '休整',
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
  coord: Coord
  speed: number
  power: number
  personality: Personality
  order: BotOrder | null
  target: Coord | null
  path: Coord[]
  actionPoints: number
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

/** Coarse stat grades used by character cards */
export const STAT_GRADES = ['低', '中', '高'] as const
export type StatGrade = (typeof STAT_GRADES)[number]

/** Character-card fields the simulation needs to place a unit on the map */
export interface CardSpawn {
  id: string
  name: string
  faction: Faction
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
