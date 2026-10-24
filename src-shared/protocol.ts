/**
 * Wire protocol shared by the Node game server and the browser client.
 * Types only — importing this module never pulls runtime code.
 */
import type { ChatChannel, ChatMessage } from './chat'
import type { CardSpawn, Faction, SimSaveState, SimSnapshot } from './types'
import type { MapData } from './map/MapGenerator'

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

/** live = 调用真实接口；mock = 强制使用本地模拟决策，不联网 */
export type LlmMode = 'live' | 'mock'

export interface LlmStatusDTO {
  baseUrl: string
  model: string
  hasApiKey: boolean
  configured: boolean
  mode: LlmMode
  /** 最近一次真实接口调用失败的原因，成功调用后清空 */
  lastError: string | null
}

/** 连接测试结果：error 为 null 表示连通 */
export interface LlmTestResult {
  ok: boolean
  error: string | null
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
  llmError: string | null
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
  mode?: LlmMode
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

/** 角色私有记忆：指令记录与发言记录，容量上限与角色系统文档一致 */
export interface ActorMemoryDTO {
  orders: {
    round: number
    generalId: string | null
    stance: string
    target: [number, number] | null
    result: string
  }[]
  speech: { round: number; channel: ChatChannel; text: string }[]
}

/** 一个角色的协程状态：排期、冷却与私有记忆 */
export interface ActorSaveDTO {
  cardId: string
  nextDecisionRound: number
  /** 下一次世界频道发言的回合；0 表示尚未排期 */
  nextSpeechRound: number
  cooldownUntilRound: number
  memory: ActorMemoryDTO
}

/** Full snapshot of one world, stored as a single save row */
export interface WorldSaveDTO {
  /** 1：旧存档（仅有全局排期）；2：按角色存档 */
  version: 1 | 2
  savedAt: string
  label: string
  round: number
  /** LLM 连接状态属于运行时状态，不写入存档 */
  state: Omit<GameStateDTO, 'llmConfigured' | 'llmError'>
  sim: SimSaveState
  chat: ChatLog
  /** 旧存档没有该段，读档后所有角色重新随机排期 */
  actors?: ActorSaveDTO[]
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
  /** 发言人开始/结束输入：author 为 null 表示结束；世界频道不推送该事件 */
  | { type: 'typing'; channel: ChatChannel; actorId: string | null; author: string | null }
  | { type: 'reset'; world: WorldDTO }
