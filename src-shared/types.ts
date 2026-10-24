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
  /** 对敌军目标的额外偏好，由突击类标签提供；旧存档按 0 处理 */
  assault: number
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

/** 团编制；仅我方同盟会分团，本团为玩家所在的核心团 */
export const GENERAL_TEAMS = ['本团'] as const
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

/**
 * 性格标签：按维度分组，同一维度内的标签互斥（如勇猛与怯战），
 * 不同维度可自由组合（如「勇猛 + 突击」）。这样既能表达复杂性格，
 * 又不会出现互相打架的设定。
 */
export type PersonalityAxis = '胆略' | '用兵'

export const PERSONALITY_AXES: { axis: PersonalityAxis; tags: PersonalityTag[]; hint: string }[] = [
  {
    axis: '胆略',
    tags: ['勇猛', '果敢', '稳健', '谨慎', '怯战'],
    hint: '决定接战的意愿：越靠前越主动求战，越靠后越优先避战',
  },
  {
    axis: '用兵',
    tags: ['突击', '拓土', '固守'],
    hint: '决定目标偏好：突击偏打敌军，拓土偏占空地，固守偏守己方',
  },
]

export type PersonalityTag =
  | '勇猛'
  | '果敢'
  | '稳健'
  | '谨慎'
  | '怯战'
  | '突击'
  | '拓土'
  | '固守'

/** 扁平化的全部标签，顺序与 PERSONALITY_AXES 一致 */
export const PERSONALITY_TAGS: PersonalityTag[] = PERSONALITY_AXES.flatMap((item) => item.tags)

export const DEFAULT_PERSONALITY: PersonalityTag[] = ['稳健', '拓土']

export interface PersonalityTrait {
  /** 对侵略性的加成，越高越愿意深入敌境 */
  aggression: number
  /** 对谨慎度的加成，越高越偏好近处、安全的目标 */
  caution: number
  /** 对敌军目标的额外偏好，用于突击类标签 */
  assault: number
  /** 供 LLM 扮演的行为描述 */
  behavior: string
}

export const PERSONALITY_TRAITS: Record<PersonalityTag, PersonalityTrait> = {
  勇猛: { aggression: 0.35, caution: -0.3, assault: 0.1, behavior: '主动逼近敌军，优先抢占敌占与高价值地块' },
  果敢: { aggression: 0.18, caution: -0.13, assault: 0.05, behavior: '有机会就压上，遇强敌会先拉开距离' },
  稳健: { aggression: 0, caution: 0, assault: 0, behavior: '占点与避战兼顾，不冒险深入' },
  谨慎: { aggression: -0.16, caution: 0.17, assault: -0.06, behavior: '优先稳固后方，绕开强敌只打有把握的仗' },
  怯战: { aggression: -0.32, caution: 0.33, assault: -0.12, behavior: '尽量避战，只在安全的空地上扩张' },
  突击: { aggression: 0.05, caution: -0.03, assault: 0.15, behavior: '盯着敌军单位打，愿意为咬住敌人绕路' },
  拓土: { aggression: 0.02, caution: 0, assault: -0.04, behavior: '优先圈占无主地块，把边界往外推' },
  固守: { aggression: -0.04, caution: 0.12, assault: -0.08, behavior: '守成优先，先稳固己方地块再图扩张' },
}

/** 标签所属维度，用于校验互斥关系 */
export function personalityAxisOf(tag: PersonalityTag): PersonalityAxis {
  return PERSONALITY_AXES.find((item) => item.tags.includes(tag))?.axis ?? '胆略'
}

/** 标签之间是否冲突：同一维度即冲突 */
export function personalityConflicts(a: PersonalityTag, b: PersonalityTag): boolean {
  return personalityAxisOf(a) === personalityAxisOf(b)
}

/** 把一组标签换算为 Bot 决策权重，基线为不偏不倚 */
export function personalityOf(tags: PersonalityTag[]): Personality {
  let aggression = 0.5
  let caution = 0.55
  let assault = 0
  for (const tag of tags) {
    const trait = PERSONALITY_TRAITS[tag]
    aggression += trait.aggression
    caution += trait.caution
    assault += trait.assault
  }
  return {
    aggression: Math.min(0.9, Math.max(0.1, aggression)),
    caution: Math.min(0.9, Math.max(0.1, caution)),
    assault: Math.min(0.4, Math.max(-0.2, assault)),
  }
}

/** 旧版自由文本或旧数组的兼容归并，保证每个维度只留一个标签 */
export function normalizePersonality(value: string | string[] | null | undefined): PersonalityTag[] {
  const raw = Array.isArray(value) ? value : (value ?? '').split(/[、，,／/\s]+/)
  const picked: PersonalityTag[] = []
  for (const item of raw) {
    const text = item.trim()
    if (!text) continue
    const tag = personalityTagOf(text)
    if (!tag) continue
    if (picked.some((existing) => existing === tag)) continue
    if (picked.some((existing) => personalityConflicts(existing, tag))) continue
    picked.push(tag)
  }
  return picked.length > 0 ? picked : [...DEFAULT_PERSONALITY]
}

/** 单个词的识别：先精确匹配，再按关键词归类 */
function personalityTagOf(text: string): PersonalityTag | null {
  if (PERSONALITY_TAGS.includes(text as PersonalityTag)) return text as PersonalityTag
  if (/怯|懦|胆小|畏/.test(text)) return '怯战'
  if (/勇猛|激进|好战|鲁莽|悍/.test(text)) return '勇猛'
  if (/果敢|果断|锐/.test(text)) return '果敢'
  if (/谨慎|多疑|细/.test(text)) return '谨慎'
  if (/沉稳|稳/.test(text)) return '稳健'
  if (/突击|进攻|攻坚/.test(text)) return '突击'
  if (/拓土|扩张|占地/.test(text)) return '拓土'
  if (/固守|防守|保守/.test(text)) return '固守'
  return null
}

/** 性格的一行摘要：标签用顿号连接，行为说明用分号连接 */
export function personalitySummary(tags: PersonalityTag[]): { label: string; behavior: string } {
  const list = normalizePersonality(tags)
  return {
    label: list.join('、'),
    behavior: list.map((tag) => PERSONALITY_TRAITS[tag].behavior).join('；'),
  }
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
  personality: PersonalityTag[]
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
