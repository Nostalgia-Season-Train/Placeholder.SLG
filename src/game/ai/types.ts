/**
 * March simulation data model.
 * Factions, generals, tile ownership, events and snapshots live here.
 * This module has no dependency on the rendering layer.
 */
export type Faction = 'red' | 'cyan' | 'gold'

export const FACTIONS: Faction[] = ['red', 'cyan', 'gold']

export const FACTION_NAMES: Record<Faction, string> = {
  red: '赤军',
  cyan: '青军',
  gold: '黄军',
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

export interface GeneralState {
  id: string
  name: string
  faction: Faction
  coord: Coord
  speed: number
  power: number
  personality: Personality
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

export interface SimSnapshot {
  round: number
  generals: GeneralState[]
  occupation: Map<string, Faction>
  occupationVersion: number
  events: SimEvent[]
  capturedCount: number
  capturableCount: number
  factionCounts: Record<Faction, number>
}
