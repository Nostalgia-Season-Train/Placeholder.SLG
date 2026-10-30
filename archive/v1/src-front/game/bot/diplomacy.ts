/**
 * Diplomacy layer for map coloring.
 * A tile or token is painted by its alliance's relation to the player's side:
 * self = green, friendly = blue, hostile = red. Names come from the start-up
 * alliance configuration, never from hard-coded faction labels.
 */
import {
  ALLIANCE_RELATION_LABELS,
  type AllianceConfig,
  type AllianceNames,
  type AllianceRelation,
  type Faction,
} from '@shared/types'

export type FactionRelation = AllianceRelation

export const RELATION_LABELS: Record<FactionRelation, string> = ALLIANCE_RELATION_LABELS

export interface RelationStyle {
  fill: number
  /** Frame color; null means no frame */
  border: number | null
}

export const RELATION_STYLES: Record<FactionRelation, RelationStyle> = {
  self: { fill: 0x4fb477, border: null },
  friendly: { fill: 0x3f7fd6, border: null },
  hostile: { fill: 0xc84b3c, border: null },
}

export interface Diplomacy {
  playerFaction: Faction
  relations: Record<Faction, FactionRelation>
  /** 开局配置的同盟名称表 */
  names: AllianceNames
}

/** 未启用的槽位不出现城池与单位，统一按敌方色兜底 */
const DISABLED_RELATION: FactionRelation = 'hostile'

export function createDiplomacy(alliances: AllianceConfig[]): Diplomacy {
  const relations: Record<Faction, FactionRelation> = {
    red: DISABLED_RELATION,
    cyan: DISABLED_RELATION,
    gold: DISABLED_RELATION,
  }
  const names: AllianceNames = {}

  for (const alliance of alliances) {
    relations[alliance.faction] = alliance.relation
    names[alliance.faction] = alliance.name
  }

  const playerFaction =
    alliances.find((alliance) => alliance.relation === 'self')?.faction ?? 'red'
  return { playerFaction, relations, names }
}

export function relationOf(diplomacy: Diplomacy, faction: Faction): FactionRelation {
  return diplomacy.relations[faction]
}

export function relationStyleOf(diplomacy: Diplomacy, faction: Faction): RelationStyle {
  return RELATION_STYLES[relationOf(diplomacy, faction)]
}

/** 名称或关系变化都需要重绘，用签名判断是否换了一份配置 */
export function diplomacySignature(diplomacy: Diplomacy): string {
  return `${diplomacy.playerFaction}|${JSON.stringify(diplomacy.relations)}|${JSON.stringify(diplomacy.names)}`
}
