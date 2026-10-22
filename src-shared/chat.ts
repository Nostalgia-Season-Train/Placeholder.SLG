/**
 * 频道消息类型：服务端与浏览器共用。
 * 仅类型定义，频道实现（WarChat）位于 src-server/game/agent/chat.ts。
 */
import type { Faction } from './types'

export type ChatChannel = 'world' | 'alliance' | 'team'
export type ChatSource = 'llm' | 'mock' | 'player' | 'system'

export interface ChatMessage {
  id: number
  channel: ChatChannel
  faction: Faction | null
  author: string
  text: string
  round: number
  source: ChatSource
}
