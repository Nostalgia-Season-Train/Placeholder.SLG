/**
 * Diplomacy layer for map coloring.
 * A tile or token is painted by its owner's relation to the player's faction:
 * self = green, ally = blue, every other relation = red with an optional frame.
 */
import type { Faction } from '@shared/types'

export type FactionRelation =
  | 'self'
  | 'ally'
  | 'neutral'
  | 'hostileAlliance'
  | 'friendlyAlliance'

export const RELATION_LABELS: Record<FactionRelation, string> = {
  self: '我方核心团',
  ally: '我方同盟',
  neutral: '非友方非敌方',
  hostileAlliance: '敌方同盟',
  friendlyAlliance: '友方同盟',
}

export interface RelationStyle {
  fill: number
  /** Frame color; null means no frame */
  border: number | null
}

export const RELATION_STYLES: Record<FactionRelation, RelationStyle> = {
  self: { fill: 0x4fb477, border: null },
  ally: { fill: 0x3f7fd6, border: null },
  neutral: { fill: 0xc84b3c, border: null },
  hostileAlliance: { fill: 0xc84b3c, border: 0xff4d4d },
  friendlyAlliance: { fill: 0xc84b3c, border: 0x4d8dff },
}

export interface Diplomacy {
  playerFaction: Faction
  relations: Record<Faction, FactionRelation>
}

/** Each playable faction sees a different diplomatic layout, covering all five styles */
const RELATION_MATRIX: Record<Faction, Record<Faction, FactionRelation>> = {
  red: { red: 'self', cyan: 'ally', gold: 'hostileAlliance' },
  cyan: { red: 'neutral', cyan: 'self', gold: 'ally' },
  gold: { red: 'ally', cyan: 'friendlyAlliance', gold: 'self' },
}

export function createDiplomacy(playerFaction: Faction): Diplomacy {
  return { playerFaction, relations: { ...RELATION_MATRIX[playerFaction] } }
}

export function relationOf(diplomacy: Diplomacy, faction: Faction): FactionRelation {
  return diplomacy.relations[faction]
}

export function relationStyleOf(diplomacy: Diplomacy, faction: Faction): RelationStyle {
  return RELATION_STYLES[relationOf(diplomacy, faction)]
}
