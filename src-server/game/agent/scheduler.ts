/**
 * 角色协程的调度原语：回合信号、LLM 令牌信号量、角色收件箱与发言配额。
 * 这些结构只负责节奏与限流，不参与任何地图推演，也不消费推演随机数。
 */
import type { ChatChannel } from '../../../src-shared/chat'

/** 关键点类型：Bot 侧变化与玩家发言，均作为唤醒角色的输入 */
export type KeypointKind = 'encounter' | 'capture' | 'defeat' | 'blocked' | 'lost' | 'player'

export interface ActorKeypoint {
  kind: KeypointKind
  round: number
  /** 简短类型名，用于日志与上下文 */
  label: string
  /** 具体内容，例如「朔风击退寒江」 */
  detail: string
  /** 玩家发言所在的频道与原文 */
  channel?: ChatChannel
  text?: string
}

/** 角色收件箱：关键点先进先出，同类同回合去重，决策进行中到达的并入下次 */
export class ActorInbox {
  private items: ActorKeypoint[] = []

  get size(): number {
    return this.items.length
  }

  push(item: ActorKeypoint): void {
    const duplicate = this.items.some(
      (existing) =>
        existing.kind === item.kind && existing.round === item.round && existing.detail === item.detail,
    )
    if (duplicate) return
    this.items.push(item)
    if (this.items.length > 12) this.items.shift()
  }

  has(kind: KeypointKind): boolean {
    return this.items.some((item) => item.kind === kind)
  }

  drain(): ActorKeypoint[] {
    const items = this.items
    this.items = []
    return items
  }

  clear(): void {
    this.items = []
  }
}

/**
 * 回合信号：世界回合循环每 tick 广播一次，所有等待中的角色协程在同一边界恢复。
 * 关闭时唤醒全部等待者，让协程退出。
 */
export class RoundGate {
  private waiters: ((round: number) => void)[] = []
  private closed = false
  private last = 0

  wait(): Promise<number> {
    if (this.closed) return Promise.resolve(this.last)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  broadcast(round: number): void {
    this.last = round
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter(round)
  }

  close(): void {
    this.closed = true
    this.broadcast(this.last)
  }
}

/** LLM 全局并发令牌：默认 2 路，超出排队；玩家触发的决策插队，避免被关键点决策挤在后面 */
export class LlmSemaphore {
  private active = 0
  private readonly queue: (() => void)[] = []

  constructor(private readonly limit = 2) {}

  async acquire(priority = false): Promise<void> {
    if (this.active < this.limit && this.queue.length === 0) {
      this.active += 1
      return
    }
    if (priority) {
      await new Promise<void>((resolve) => this.queue.unshift(resolve))
    } else {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }
    // 令牌由 release() 直接转交，active 保持不变
  }

  release(): void {
    const next = this.queue.shift()
    if (next) {
      next()
      return
    }
    if (this.active > 0) this.active -= 1
  }
}

/** 发言配额：同一频道（同盟频道按同盟区分）每回合最多一条，超出排队到下一回合 */
export class SpeechQuota {
  private readonly used = new Map<string, number>()

  take(key: string, round: number): boolean {
    if (this.used.get(key) === round) return false
    this.used.set(key, round)
    return true
  }

  reset(): void {
    this.used.clear()
  }
}
