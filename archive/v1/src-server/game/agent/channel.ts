/**
 * 频道消息存储：世界频道所有同盟共用，同盟与本团频道按同盟隔离。
 * 只负责落库与按查看者过滤，发言由各角色协程自行产生。
 */
import type { Faction } from '../../../src-shared/types'
import type { ChatChannel, ChatMessage, ChatSource } from '../../../src-shared/chat'

const VIEW_LIMIT = 80
const CHANNEL_LIMIT = 120

export class ChannelLog {
  private messages: ChatMessage[] = []
  private nextId = 1

  /** 玩家可见的消息：世界频道全部，同盟与本团仅本同盟 */
  list(channel: ChatChannel, viewer: Faction): ChatMessage[] {
    return this.messages
      .filter((message) => message.channel === channel && this.visible(message, viewer))
      .slice(-VIEW_LIMIT)
  }

  /** 该角色可见的最近若干条消息，作为环境上下文 */
  recent(channel: ChatChannel, viewer: Faction, limit: number): ChatMessage[] {
    return this.messages
      .filter((message) => message.channel === channel && this.visible(message, viewer))
      .slice(-limit)
  }

  pushPlayer(channel: ChatChannel, faction: Faction, text: string, round: number): void {
    this.push({ channel, faction, author: '玩家', actorId: null, text, round, source: 'player' })
  }

  pushActor(
    channel: ChatChannel,
    faction: Faction,
    actorId: string,
    author: string,
    text: string,
    round: number,
    source: ChatSource,
  ): void {
    this.push({ channel, faction, author, actorId, text, round, source })
  }

  pushSystem(channel: ChatChannel, faction: Faction | null, text: string, round: number): void {
    this.push({ channel, faction, author: '系统', actorId: null, text, round, source: 'system' })
  }

  welcome(faction: Faction, round: number): void {
    this.pushSystem('world', null, '世界频道已开放。', round)
    this.pushSystem('alliance', faction, '同盟频道已建立，可直接下发指令或询问战况。', round)
    this.pushSystem(
      'team',
      faction,
      '本团频道已建立，核心团角色由 LLM 扮演并受忠诚约束，军令必然照办。',
      round,
    )
  }

  saveState(): ChatMessage[] {
    return this.messages.map((message) => ({ ...message }))
  }

  restore(messages: ChatMessage[]): void {
    this.messages = []
    for (const message of messages) this.messages.push({ ...message })
    this.messages.sort((a, b) => a.id - b.id)
    this.nextId = this.messages.reduce((max, message) => Math.max(max, message.id), 0) + 1
  }

  private visible(message: ChatMessage, viewer: Faction): boolean {
    if (message.channel === 'world') return true
    return message.faction === viewer
  }

  private push(message: Omit<ChatMessage, 'id'>): void {
    this.messages.push({ id: this.nextId, ...message })
    this.nextId += 1
    const sameChannel = this.messages.filter((item) => item.channel === message.channel)
    if (sameChannel.length > CHANNEL_LIMIT) {
      const drop = new Set(sameChannel.slice(0, sameChannel.length - CHANNEL_LIMIT))
      this.messages = this.messages.filter((item) => !drop.has(item))
    }
  }
}
