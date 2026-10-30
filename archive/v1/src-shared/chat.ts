/**
 * 频道消息类型：服务端与浏览器共用。
 * 仅类型定义，频道实现（ChannelLog）位于 src-server/game/agent/channel.ts。
 */
import type { Faction } from './types'

export type ChatChannel = 'world' | 'alliance' | 'team'
export type ChatSource = 'llm' | 'mock' | 'player' | 'system'

export interface ChatMessage {
  id: number
  channel: ChatChannel
  /** 归属同盟：同盟频道按此字段隔离，世界频道为 null */
  faction: Faction | null
  author: string
  /** 发言角色标识；玩家与系统消息为 null */
  actorId?: string | null
  text: string
  round: number
  source: ChatSource
}
