/**
 * Wire protocol shared by the Node game server and the browser client.
 * Types only — importing this module never pulls runtime code.
 */
import type { ChatChannel, ChatMessage } from '../agent/chat'
import type { Faction, SimSnapshot } from '../bot/types'
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
