/**
 * 角色协程：每个角色一个长期存活的 async 协程，循环
 * 「等待回合 → 判定触发 → LLM 决策 → 应用指令与发言」。
 *
 * Bot 状态机由世界回合循环推进（见《角色行动》2.4），协程只施加指令，
 * 因此寻路与遭遇战的随机数消费顺序不随协程调度漂移，战报与存档保持确定性。
 */
import { axialToWorld } from '../../../src-shared/map/hex'
import { coordKey, getTile, hexDistance, type TileInfo, type WorldTerrain } from '../bot/terrain'
import {
  FACTION_NAMES,
  FACTIONS,
  formatUnitName,
  type BotStance,
  type Coord,
  type Faction,
  type GeneralState,
  type SimSnapshot,
} from '../../../src-shared/types'
import type { CharacterCardDTO, ActorSaveDTO } from '../../../src-shared/protocol'
import type { ChatChannel } from '../../../src-shared/chat'
import type { LlmClient, LlmMessage } from './llm'
import { buildActorContext, type ActorTrigger } from './context'
import { ActorMemory } from './memory'
import {
  ActorInbox,
  LlmSemaphore,
  RoundGate,
  SpeechQuota,
  type ActorKeypoint,
} from './scheduler'
import type { ChannelLog } from './channel'

export interface AgentOrderDraft {
  generalId: string
  stance: BotStance
  target: Coord | null
  reason: string
}

/** 一次决策的产物：一段回应、可选发言、若干条行动指令 */
export interface ActorDecision {
  reply: string
  speech: { channel: ChatChannel; text: string } | null
  orders: AgentOrderDraft[]
  source: 'llm' | 'mock'
  error: string | null
}

/** 协程运行所需的共享设施，由 GameRuntime 装配 */
export interface ActorDeps {
  gate: RoundGate
  tokens: LlmSemaphore
  quota: SpeechQuota
  log: ChannelLog
  terrain: WorldTerrain
  llm(): LlmClient | null
  snapshot(): SimSnapshot
  playerFaction(): Faction
  autoEnabled(): boolean
  autoInterval(): number
  /** 该角色是否为所属同盟的发言人，只有发言人按自身排期在世界频道发声 */
  isSpokesperson(cardId: string): boolean
  applyOrders(orders: AgentOrderDraft[], round: number): number
  onOrdersApplied(): void
  typing(channel: ChatChannel, actorId: string, author: string | null): void
  onChat(channel: ChatChannel): void
}

const STANCE_LABELS: Record<BotStance, string> = {
  auto: '自主行动',
  attack: '进攻',
  defend: '防守',
  hold: '待命',
  retreat: '撤退',
}

const VALID_STANCES: BotStance[] = ['auto', 'attack', 'defend', 'hold', 'retreat']

const AUTO_DIRECTIVE = '根据当前战况推进，优先夺取价值高且易守的地块'

/** 失败后的冷却回合数 */
const FAILURE_COOLDOWN = 3
/** 同一角色两次关键点决策之间的最小间隔：期间的关键点合并，避免遭遇战刷屏占满 LLM */
const KEYPOINT_GAP = 20
/** 世界频道发言的基准间隔 */
const WORLD_SPEECH_INTERVAL = 20

const SYSTEM_PROMPT = `你是大地图上的一个角色，由 LLM 扮演，Bot 负责执行你的指令。

规则：
1. 只指挥本同盟的 Bot。orders 里的 generalId 必须来自「己方单位」，每个单位最多一条。
2. 职位决定指挥范围：大臣可指挥本同盟全部单位，团长可指挥本团团员，无职位者只能指挥自己的单位。
3. 定位决定行为边界：武将、术武将可前线带兵；法师、疗愈师不统兵，只发言不下达带兵指令。
4. stance 取 attack / defend / hold / retreat / auto。attack / defend / retreat 必须给出 target，且来自「可占领候选」或己方地块。
5. 发言使用角色自己的口吻，承接「环境上下文」里的对话，不要重复已经说过的话。
6. 「本轮触发」是玩家发言时，reply 直接回应玩家，可以执行、讨论、质疑或婉拒。
7. 「随机时间」与「局势变化」时，可只更新目标，不必长篇发言。
8. 只输出 JSON，不要输出 Markdown 或解释文字。
9. 保持简短：reply 不超过 30 字，speech.text 不超过 60 字，reason 不超过 10 字，orders 最多 3 条。

JSON 结构：
{"reply":"一句中文回应","speech":{"channel":"alliance","text":"要向频道公开的发言"},"orders":[{"generalId":"card-xxx","stance":"attack","target":[q,r],"reason":"简短理由"}]}`

/** 核心团角色的附加约束：同一条 LLM 通道，只改身份设定，不另开旁路 */
const LOYALTY_RULE = `

附加身份：你属于盟主的核心团，对盟主绝对忠诚。盟主的军令无条件执行，不得质疑、拒绝或讨价还价；回应中要明确表示已经照办。`

const WORLD_RULE = `

本轮触发为世界发言：只在世界频道发一条简短战报或宣言，不下达任何指令。`

function detectStance(text: string): BotStance {
  if (/待命|停止|原地|待机|不动|按兵/.test(text)) return 'hold'
  if (/撤|退|回防|收缩/.test(text)) return 'retreat'
  if (/守|防|驻|护|固守/.test(text)) return 'defend'
  if (/自由|自主|随意|自行/.test(text)) return 'auto'
  return 'attack'
}

/** Screen-relative direction: north is -z, east is +x */
function detectDirection(text: string): { x: number; z: number } | null {
  let x = 0
  let z = 0
  if (/北|上|north/i.test(text)) z -= 1
  if (/南|下|south/i.test(text)) z += 1
  if (/东|右|east/i.test(text)) x += 1
  if (/西|左|west/i.test(text)) x -= 1
  return x === 0 && z === 0 ? null : { x, z }
}

function detectCoord(text: string): Coord | null {
  const match = text.match(/(-?\d+)\s*[,，]\s*(-?\d+)/)
  if (!match) return null
  const q = Number(match[1])
  const r = Number(match[2])
  return Number.isFinite(q) && Number.isFinite(r) ? { q, r } : null
}

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const text = fenced?.[1] ?? raw
  const start = text.indexOf('{')
  if (start < 0) return text

  // 按括号配对截取首个完整对象，模型在 JSON 前后追加说明文字时仍可解析
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }

  const end = text.lastIndexOf('}')
  return end > start ? text.slice(start, end + 1) : text
}

function parseTarget(value: unknown): Coord | null {
  if (Array.isArray(value) && value.length >= 2) {
    const q = Number(value[0])
    const r = Number(value[1])
    if (Number.isFinite(q) && Number.isFinite(r)) return { q, r }
  }
  if (typeof value === 'object' && value !== null) {
    const row = value as Record<string, unknown>
    const q = Number(row.q)
    const r = Number(row.r)
    if (Number.isFinite(q) && Number.isFinite(r)) return { q, r }
  }
  return null
}

export class CharacterAgent {
  readonly id: string
  readonly card: CharacterCardDTO
  /** 地图单位标识；坐镇的角色没有单位 */
  readonly generalId: string | null
  /** 频道中的显示名：【同盟名】职务·角色 */
  readonly author: string

  nextDecisionRound = 0
  nextSpeechRound = 0
  /** 下一次允许因关键点决策的回合；期间到达的关键点合并进收件箱 */
  nextKeypointRound = 0
  cooldownUntilRound = 0

  private alive = true
  private readonly inbox = new ActorInbox()
  private readonly memory = new ActorMemory()
  private pending: { channel: ChatChannel; text: string } | null = null
  private lastSource: 'llm' | 'mock' = 'mock'

  constructor(
    card: CharacterCardDTO,
    private readonly deps: ActorDeps,
    saved?: ActorSaveDTO,
  ) {
    this.card = card
    this.id = card.id
    this.generalId = card.position === '无' ? `card-${card.id}` : null
    this.author = formatUnitName(card.faction, card.position, card.name)
    if (saved) this.restore(saved)
  }

  /* ------------------------------------------------------------------ */
  /* 协程                                                                */
  /* ------------------------------------------------------------------ */

  start(): void {
    void this.run()
  }

  stop(): void {
    this.alive = false
    this.inbox.clear()
  }

  /** 角色收件箱：Bot 侧关键点与玩家发言在这里排队，同一回合合并 */
  pushKeypoint(item: ActorKeypoint): void {
    this.inbox.push(item)
  }

  /** 供玩家的直接指令使用：立即决策一次，不改动排期与收件箱 */
  async decideNow(trigger: ActorTrigger): Promise<ActorDecision> {
    return this.decide(trigger)
  }

  toSave(): ActorSaveDTO {
    return {
      cardId: this.id,
      nextDecisionRound: this.nextDecisionRound,
      nextSpeechRound: this.nextSpeechRound,
      cooldownUntilRound: this.cooldownUntilRound,
      memory: this.memory.toSave(),
    }
  }

  restore(state: ActorSaveDTO): void {
    this.nextDecisionRound = state.nextDecisionRound ?? 0
    this.nextSpeechRound = state.nextSpeechRound ?? 0
    this.cooldownUntilRound = state.cooldownUntilRound ?? 0
    this.memory.restore(state.memory)
  }

  private async run(): Promise<void> {
    while (this.alive) {
      const round = await this.deps.gate.wait()
      if (!this.alive) return
      try {
        await this.tick(round)
      } catch (error) {
        console.warn(`[slg] ${this.author} 协程异常：`, error)
      }
    }
  }

  private async tick(round: number): Promise<void> {
    this.flush(round)
    const trigger = this.claimTrigger(round)
    if (!trigger) return

    const decision = await this.decideWithTyping(trigger)
    if (!this.alive) return
    this.apply(trigger, decision, this.deps.snapshot().round)
  }

  /** 触发优先级：玩家发言 > 关键点 > 随机时间决策 > 世界发言 */
  private claimTrigger(round: number): ActorTrigger | null {
    if (this.inbox.has('player')) {
      return { kind: 'player', round, items: this.inbox.drain() }
    }

    if (this.inbox.size > 0 && round >= this.nextKeypointRound) {
      this.nextKeypointRound = round + KEYPOINT_GAP
      return { kind: 'keypoint', round, items: this.inbox.drain() }
    }

    if (this.deps.autoEnabled() && round >= this.nextDecisionRound) {
      if (this.nextDecisionRound === 0) {
        this.nextDecisionRound = round + this.randomGap(this.deps.autoInterval())
        return null
      }
      this.nextDecisionRound = round + this.randomGap(this.deps.autoInterval())
      return { kind: 'random', round, items: [] }
    }

    if (round >= this.nextSpeechRound) {
      if (this.nextSpeechRound === 0) {
        this.nextSpeechRound = round + this.randomGap(WORLD_SPEECH_INTERVAL)
        return null
      }
      this.nextSpeechRound = round + this.randomGap(WORLD_SPEECH_INTERVAL)
      // 只有同盟发言人按自身排期在世界频道发声
      if (!this.deps.isSpokesperson(this.id)) return null
      return { kind: 'world', round, items: [] }
    }

    return null
  }

  /** 随机时间触发：在基准间隔的 0.5~1.5 倍之间取下一次触发回合 */
  private randomGap(base: number): number {
    return Math.max(1, Math.round(base * (0.5 + Math.random())))
  }

  /* ------------------------------------------------------------------ */
  /* 决策                                                                */
  /* ------------------------------------------------------------------ */

  private async decideWithTyping(trigger: ActorTrigger): Promise<ActorDecision> {
    const channel = trigger.items.find((item) => item.kind === 'player')?.channel
    const showTyping = trigger.kind === 'player' && channel !== undefined && channel !== 'world'
    if (showTyping && channel) this.deps.typing(channel, this.id, this.author)
    try {
      return await this.decide(trigger)
    } finally {
      if (showTyping && channel) this.deps.typing(channel, this.id, null)
    }
  }

  private async decide(trigger: ActorTrigger): Promise<ActorDecision> {
    const snapshot = this.deps.snapshot()
    const context = buildActorContext(this.card, trigger, {
      memory: this.memory,
      log: this.deps.log,
      snapshot,
      terrain: this.deps.terrain,
      playerFaction: this.deps.playerFaction(),
    })

    const llm = this.deps.llm()
    if (!llm || trigger.round < this.cooldownUntilRound) {
      return this.mockDecision(trigger, snapshot)
    }

    await this.deps.tokens.acquire(trigger.kind === 'player')
    try {
      const raw = await llm.complete(this.buildMessages(context, trigger))
      const parsed = this.parseDecision(raw, snapshot)
      if (parsed) return { ...parsed, source: 'llm', error: null }
      console.warn(`[llm-raw] ${raw.slice(0, 300)}`)
      throw new Error('LLM 返回内容无法解析')
    } catch (error) {
      this.cooldownUntilRound = trigger.round + FAILURE_COOLDOWN
      const message = error instanceof Error ? error.message : 'LLM 调用失败'
      console.warn(`[slg] ${this.author} 决策失败，回退模拟 LLM：${message}`)
      const fallback = this.mockDecision(trigger, snapshot)
      fallback.error = message
      return fallback
    } finally {
      this.deps.tokens.release()
    }
  }

  private buildMessages(context: Record<string, unknown>, trigger: ActorTrigger): LlmMessage[] {
    const channel = trigger.items.find((item) => item.kind === 'player')?.channel
    const loyal = channel === 'team'
    const extra = trigger.kind === 'world' ? WORLD_RULE : loyal ? LOYALTY_RULE : ''
    return [
      { role: 'system', content: `${this.identity()}\n\n${SYSTEM_PROMPT}${extra}` },
      { role: 'user', content: `当前局面：\n${JSON.stringify(context)}\n请输出 JSON。` },
    ]
  }

  private identity(): string {
    const card = this.card
    const position = card.position === '无' ? '' : `${card.position}·`
    return [
      `你是【${FACTION_NAMES[card.faction]}】${position}${card.name}，定位${card.role}。`,
      card.description ? `描述：${card.description}` : '',
      card.personality ? `性格：${card.personality}` : '',
      card.dialoguePrompt ? `对话风格：${card.dialoguePrompt}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  private parseDecision(
    raw: string,
    snapshot: SimSnapshot,
  ): { reply: string; speech: { channel: ChatChannel; text: string } | null; orders: AgentOrderDraft[] } | null {
    let data: unknown
    try {
      data = JSON.parse(extractJson(raw))
    } catch {
      return null
    }
    if (typeof data !== 'object' || data === null) return null

    const record = data as { reply?: unknown; speech?: unknown; orders?: unknown }
    const reply = typeof record.reply === 'string' ? record.reply.trim() : ''
    const speech = this.parseSpeech(record.speech)
    const orders = this.parseOrders(record.orders, snapshot)
    if (!reply && !speech && orders.length === 0) return null
    return { reply, speech, orders }
  }

  private parseSpeech(value: unknown): { channel: ChatChannel; text: string } | null {
    if (typeof value !== 'object' || value === null) return null
    const row = value as Record<string, unknown>
    const channel = row.channel
    if (channel !== 'world' && channel !== 'alliance' && channel !== 'team') return null
    const text = typeof row.text === 'string' ? row.text.trim() : ''
    if (!text) return null
    return { channel, text }
  }

  private parseOrders(value: unknown, snapshot: SimSnapshot): AgentOrderDraft[] {
    if (!Array.isArray(value)) return []
    const allowed = new Set(this.commandableGenerals(snapshot).map((general) => general.id))
    const orders: AgentOrderDraft[] = []

    for (const item of value) {
      if (typeof item !== 'object' || item === null) continue
      const row = item as Record<string, unknown>
      const generalId = typeof row.generalId === 'string' ? row.generalId : ''
      if (!allowed.has(generalId)) continue

      const stance =
        typeof row.stance === 'string' && VALID_STANCES.includes(row.stance as BotStance)
          ? (row.stance as BotStance)
          : 'auto'
      const target = parseTarget(row.target)

      if (stance !== 'auto' && stance !== 'hold') {
        if (!target || !getTile(this.deps.terrain, target)?.passable) continue
      }

      orders.push({
        generalId,
        stance,
        target: stance === 'auto' || stance === 'hold' ? null : target,
        reason: typeof row.reason === 'string' ? row.reason : '',
      })
    }

    return orders
  }

  /* ------------------------------------------------------------------ */
  /* 决策应用                                                            */
  /* ------------------------------------------------------------------ */

  private apply(trigger: ActorTrigger, decision: ActorDecision, round: number): void {
    this.lastSource = decision.source

    if (decision.orders.length > 0) {
      const applied = this.deps.applyOrders(decision.orders, round)
      if (applied > 0) this.deps.onOrdersApplied()
      this.memory.rememberOrders(round, decision.orders, applied > 0 ? '已下达' : '未生效')
    }

    this.speak(trigger, decision, round)
  }

  private speak(trigger: ActorTrigger, decision: ActorDecision, round: number): void {
    if (trigger.kind === 'player') {
      const channel = trigger.items.find((item) => item.kind === 'player')?.channel ?? 'alliance'
      const reply =
        decision.speech && decision.speech.channel === channel ? decision.speech.text : decision.reply
      this.publish(channel, reply || decision.speech?.text || '', round)
      if (decision.speech && decision.speech.channel !== channel) {
        this.publish(decision.speech.channel, decision.speech.text, round)
      }
      return
    }

    if (trigger.kind === 'world') {
      this.publish('world', decision.speech?.text || decision.reply, round)
      return
    }

    if (decision.speech) this.publish(decision.speech.channel, decision.speech.text, round)
    else this.publish('alliance', decision.reply, round)
  }

  /** 发言配额超出时排队到下一回合，由 flush 补发 */
  private publish(channel: ChatChannel, text: string, round: number): void {
    const clean = text.trim()
    if (!clean) return
    if (!this.deps.quota.take(this.quotaKey(channel), round)) {
      this.pending = { channel, text: clean }
      return
    }
    this.post(channel, clean, round)
  }

  private flush(round: number): void {
    const pending = this.pending
    if (!pending) return
    if (!this.deps.quota.take(this.quotaKey(pending.channel), round)) return
    this.pending = null
    this.post(pending.channel, pending.text, round)
  }

  private post(channel: ChatChannel, text: string, round: number): void {
    this.deps.log.pushActor(channel, this.card.faction, this.id, this.author, text, round, this.lastSource)
    this.memory.rememberSpeech(round, channel, text)
    this.deps.onChat(channel)
  }

  private quotaKey(channel: ChatChannel): string {
    return channel === 'world' ? 'world' : `${channel}:${this.card.faction}`
  }

  /* ------------------------------------------------------------------ */
  /* 模拟 LLM：未配置或调用失败时按同一套输入输出产出                    */
  /* ------------------------------------------------------------------ */

  private mockDecision(trigger: ActorTrigger, snapshot: SimSnapshot): ActorDecision {
    if (trigger.kind === 'world') {
      return {
        reply: '',
        speech: { channel: 'world', text: this.localBroadcast(snapshot) },
        orders: [],
        source: 'mock',
        error: null,
      }
    }

    if (trigger.kind === 'keypoint') {
      const detail = trigger.items.map((item) => item.detail).join('；')
      return {
        reply: `${detail ? `${detail}，` : ''}${this.localAdvice(snapshot)}`,
        speech: null,
        orders: [],
        source: 'mock',
        error: null,
      }
    }

    const directive = trigger.kind === 'player' ? (trigger.items[0]?.text ?? '') : AUTO_DIRECTIVE
    const stance = detectStance(directive)
    const direction = detectDirection(directive)
    const explicit = detectCoord(directive)
    const explicitTile = explicit ? getTile(this.deps.terrain, explicit) : undefined

    const attackPool = this.attackCandidates(snapshot, direction)
    const ownPool = this.ownTiles(snapshot)
    const used = new Set<string>()
    const orders: AgentOrderDraft[] = []

    for (const general of this.commandableGenerals(snapshot)) {
      if (stance === 'hold' || stance === 'auto') {
        orders.push({ generalId: general.id, stance, target: null, reason: '保持现状' })
        continue
      }

      if (explicitTile?.passable) {
        orders.push({
          generalId: general.id,
          stance,
          target: { ...explicitTile.coord },
          reason: '按指定坐标行动',
        })
        continue
      }

      const pool = stance === 'attack' || ownPool.length === 0 ? attackPool : ownPool
      let best: { tile: TileInfo; score: number } | null = null
      let bestScore = -Infinity

      for (const entry of pool) {
        const key = coordKey(entry.tile.coord)
        if (used.has(key)) continue
        const distance = hexDistance(general.coord, entry.tile.coord)
        const score = entry.score - distance * (stance === 'attack' ? 0.7 : 1.8)
        if (score > bestScore) {
          bestScore = score
          best = entry
        }
      }

      if (!best) {
        orders.push({ generalId: general.id, stance: 'auto', target: null, reason: '附近没有合适目标' })
        continue
      }

      used.add(coordKey(best.tile.coord))
      orders.push({
        generalId: general.id,
        stance: pool === ownPool ? stance : 'attack',
        target: { ...best.tile.coord },
        reason: `${best.tile.name}（价值 ${best.tile.value}）`,
      })
    }

    const assigned = orders.filter((order) => order.target).length
    const reply =
      trigger.kind === 'player'
        ? `${STANCE_LABELS[stance]}，已向 ${assigned} 个 Bot 下达指令。`
        : `按当前战况推进，已更新 ${assigned} 个 Bot 的目标。`

    return { reply, speech: null, orders, source: 'mock', error: null }
  }

  private localAdvice(snapshot: SimSnapshot): string {
    const faction = this.card.faction
    const own = snapshot.factionCounts[faction]
    const leader = FACTIONS.reduce((best, item) =>
      snapshot.factionCounts[item] > snapshot.factionCounts[best] ? item : best,
    )
    const active = snapshot.generals.filter(
      (general) =>
        general.faction === faction &&
        (general.status === 'marching' || general.status === 'capturing'),
    ).length

    const target = this.bestTarget(snapshot)
    const heading = target
      ? `建议优先夺取${target.name}（${target.coord.q},${target.coord.r}）。`
      : '建议稳守现有地块。'
    const position =
      leader === faction ? '我方暂时领先' : `${FACTION_NAMES[leader]}以 ${snapshot.factionCounts[leader]} 块领先`

    return `${FACTION_NAMES[faction]}现有 ${own} 块地，${position}；${active} 名 Bot 在行动。${heading}`
  }

  private localBroadcast(snapshot: SimSnapshot): string {
    const faction = this.card.faction
    const own = snapshot.factionCounts[faction]
    const lines = [
      `${FACTION_NAMES[faction]}已控 ${own} 块地，旗子插稳了。`,
      `${FACTION_NAMES[faction]}的 Bot 已经出发，别挡路。`,
      `这片地，${FACTION_NAMES[faction]}要一半。`,
      `世界频道没人应答？那就用兵说话。`,
    ]
    return lines[(snapshot.round + own) % lines.length] ?? lines[0]!
  }

  private bestTarget(snapshot: SimSnapshot): { name: string; coord: Coord } | null {
    const centroid = factionCentroid(this.card.faction, snapshot)
    let best: { name: string; coord: Coord } | null = null
    let bestScore = -Infinity
    for (const tile of this.deps.terrain.capturable) {
      if (snapshot.occupation.get(coordKey(tile.coord)) === this.card.faction) continue
      const score = tile.value - hexDistance(centroid, tile.coord) * 2
      if (score > bestScore) {
        bestScore = score
        best = { name: tile.name, coord: tile.coord }
      }
    }
    return best
  }

  /* ------------------------------------------------------------------ */
  /* 指挥范围与候选地块                                                  */
  /* ------------------------------------------------------------------ */

  /** 该角色可下达指令的单位：无职位者只能指挥自己的单位，团长与大臣可指挥本同盟 */
  private commandableGenerals(snapshot: SimSnapshot): GeneralState[] {
    const generals = snapshot.generals.filter((general) => general.faction === this.card.faction)
    if (this.card.position === '无') {
      return generals.filter((general) => general.id === this.generalId)
    }
    return generals
  }

  private attackCandidates(
    snapshot: SimSnapshot,
    direction: { x: number; z: number } | null,
  ): { tile: TileInfo; score: number }[] {
    const faction = this.card.faction
    const centroid = factionCentroid(faction, snapshot)
    const centerWorld = axialToWorld(centroid.q, centroid.r)
    const result: { tile: TileInfo; score: number }[] = []

    for (const tile of this.deps.terrain.capturable) {
      const owner = snapshot.occupation.get(coordKey(tile.coord))
      if (owner === faction) continue

      const distance = hexDistance(centroid, tile.coord)
      let alignment = 0
      if (direction) {
        const dx = tile.x - centerWorld.x
        const dz = tile.z - centerWorld.z
        const length = Math.hypot(dx, dz) || 1
        alignment = (dx / length) * direction.x + (dz / length) * direction.z
      }

      const score = tile.value + (owner ? 10 : 0) + alignment * 26 - distance * 1.6
      result.push({ tile, score })
    }

    result.sort((a, b) => b.score - a.score)
    return result
  }

  private ownTiles(snapshot: SimSnapshot): { tile: TileInfo; score: number }[] {
    const tiles: { tile: TileInfo; score: number }[] = []
    for (const [key, owner] of snapshot.occupation) {
      if (owner !== this.card.faction) continue
      const [q, r] = key.split(',').map(Number)
      if (q === undefined || r === undefined || Number.isNaN(q) || Number.isNaN(r)) continue
      const tile = getTile(this.deps.terrain, { q, r })
      if (tile?.passable) tiles.push({ tile, score: tile.value })
    }
    return tiles
  }
}

function factionCentroid(faction: Faction, snapshot: SimSnapshot): Coord {
  let q = 0
  let r = 0
  let count = 0

  for (const [key, owner] of snapshot.occupation) {
    if (owner !== faction) continue
    const [tq, tr] = key.split(',').map(Number)
    if (tq === undefined || tr === undefined || Number.isNaN(tq) || Number.isNaN(tr)) continue
    q += tq
    r += tr
    count += 1
  }

  if (count === 0) {
    for (const general of snapshot.generals) {
      if (general.faction !== faction) continue
      q += general.coord.q
      r += general.coord.r
      count += 1
    }
  }

  return count === 0 ? { q: 0, r: 0 } : { q: Math.round(q / count), r: Math.round(r / count) }
}
