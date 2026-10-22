/**
 * Wire protocol shared by the Node game server and the browser client.
 * Types only — importing this module never pulls runtime code.
 */
import type { ChatChannel, ChatMessage } from '../agent/chat'
import type { CardSpawn, Faction, SimSaveState, SimSnapshot } from '../bot/types'
import type { MapData } from '../map/MapGenerator'

/** MapData without the runtime lookup table; the client rebuilds it from tiles */
export type MapDTO = Omit<MapData, 'tileMap'>

/** Snapshot with the occupation Map flattened for JSON transport */
export type SnapshotDTO = Omit<SimSnapshot, 'occupation'> & {
  occupation: [string, Faction][]
}

export interface ChatLog {
  world: ChatMessage[]
  alliance: ChatMessage[]
  team: ChatMessage[]
}

export interface LlmStatusDTO {
  baseUrl: string
  model: string
  hasApiKey: boolean
  configured: boolean
}

export interface GameStateDTO {
  worldVersion: number
  running: boolean
  speed: number
  eventLimit: number
  autoCommand: boolean
  autoInterval: number
  faction: Faction
  seed: number
  llmConfigured: boolean
}

export interface WorldDTO {
  state: GameStateDTO
  map: MapDTO
  snapshot: SnapshotDTO
  chat: ChatLog
  llm: LlmStatusDTO
}

export interface ControlPatch {
  running?: boolean
  speed?: number
  eventLimit?: number
  autoCommand?: boolean
  autoInterval?: number
  faction?: Faction
}

export interface LlmPatch {
  baseUrl?: string
  model?: string
  apiKey?: string
}

export interface CommandResult {
  round: number
  orders: number
  reply: string
  source: 'llm' | 'mock'
  error: string | null
}

export interface ChatResult {
  messages: ChatMessage[]
}

/** Cursors the runtime keeps between rounds, saved so AI cadence resumes intact */
export interface SaveCursorsDTO {
  /** 下一次随机决策触发的回合；0 表示尚未排期 */
  nextAutoRound: number
  /** 下一次随机世界发言的回合；0 表示尚未排期 */
  nextWorldRound: number
  worldChatIndex: number
}

/** Full snapshot of one world, stored as a single save row */
export interface WorldSaveDTO {
  version: 1
  savedAt: string
  label: string
  round: number
  state: Omit<GameStateDTO, 'llmConfigured'>
  sim: SimSaveState
  chat: ChatLog
  cursors: SaveCursorsDTO
}

export interface SaveSummaryDTO {
  id: string
  label: string
  savedAt: string
  round: number
  seed: number
}

export interface SaveListDTO {
  saves: SaveSummaryDTO[]
}

/** One persisted character card; spawn-relevant fields come from CardSpawn */
export interface CharacterCardDTO extends CardSpawn {
  description: string
  dialoguePrompt: string
  authorNote: string
  builtin: boolean
}

export interface CardListDTO {
  cards: CharacterCardDTO[]
}

/** Body of POST /api/cards; the server assigns id and created time */
export interface CardCreateDTO extends Omit<CardSpawn, 'id'> {
  description?: string
  dialoguePrompt?: string
  authorNote?: string
}

export type ServerEvent =
  | { type: 'hello'; world: WorldDTO }
  | {
      type: 'tick'
      worldVersion: number
      snapshot: Omit<SnapshotDTO, 'occupation'>
      occPatch: [string, Faction | null][]
    }
  | { type: 'state'; state: GameStateDTO }
  | { type: 'chat'; channel: ChatChannel; messages: ChatMessage[] }
  | { type: 'reset'; world: WorldDTO }
