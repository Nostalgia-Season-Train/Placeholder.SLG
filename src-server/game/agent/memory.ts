/**
 * 角色私有记忆：自己下达过的指令与自己说过的发言。
 * 每次请求时与会话上下文一起组装，容量超出后从头截断。
 */
import type { ActorMemoryDTO } from '../../../src-shared/protocol'
import type { ChatChannel } from '../../../src-shared/chat'

export interface OrderRecord {
  round: number
  generalId: string | null
  stance: string
  target: [number, number] | null
  result: string
}

export interface SpeechRecord {
  round: number
  channel: ChatChannel
  text: string
}

const ORDER_LIMIT = 8
const SPEECH_LIMIT = 6

function trim<T>(items: T[], limit: number): void {
  if (items.length > limit) items.splice(0, items.length - limit)
}

export class ActorMemory {
  readonly orders: OrderRecord[] = []
  readonly speech: SpeechRecord[] = []

  rememberOrders(
    round: number,
    orders: { generalId: string; stance: string; target: { q: number; r: number } | null }[],
    result: string,
  ): void {
    for (const order of orders) {
      this.orders.push({
        round,
        generalId: order.generalId,
        stance: order.stance,
        target: order.target ? [order.target.q, order.target.r] : null,
        result,
      })
    }
    trim(this.orders, ORDER_LIMIT)
  }

  rememberEvent(round: number, stance: string, result: string): void {
    this.orders.push({ round, generalId: null, stance, target: null, result })
    trim(this.orders, ORDER_LIMIT)
  }

  rememberSpeech(round: number, channel: ChatChannel, text: string): void {
    this.speech.push({ round, channel, text })
    trim(this.speech, SPEECH_LIMIT)
  }

  toSave(): ActorMemoryDTO {
    return {
      orders: this.orders.map((item) => ({
        ...item,
        target: item.target ? [item.target[0], item.target[1]] : null,
      })),
      speech: this.speech.map((item) => ({ ...item })),
    }
  }

  restore(data: ActorMemoryDTO | undefined): void {
    this.orders.length = 0
    this.speech.length = 0
    if (!data) return
    for (const item of data.orders ?? []) {
      this.orders.push({
        round: item.round,
        generalId: item.generalId ?? null,
        stance: item.stance,
        target: item.target ? [item.target[0], item.target[1]] : null,
        result: item.result,
      })
    }
    for (const item of data.speech ?? []) {
      this.speech.push({ round: item.round, channel: item.channel, text: item.text })
    }
    trim(this.orders, ORDER_LIMIT)
    trim(this.speech, SPEECH_LIMIT)
  }
}
