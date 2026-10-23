/**
 * Authoritative world runtime: owns the map, the march simulation, the character
 * agents, chat and the tick timer. The browser only reads snapshots and posts commands.
 *
 * 两条循环分工：世界回合循环推进 sim.step() 并广播回合信号，每个角色协程只负责
 * 判定决策时机、组装上下文、调用 LLM、写回指令与发言（见《角色行动》2.4）。
 */
import { generateMap, type MapData } from '../../src-shared/map/MapGenerator'
import { MarchSimulation, type SimSignal } from '../game/bot/simulation'
import { FACTIONS, type BotOrder, type Faction } from '../../src-shared/types'
import { CharacterAgent, type ActorDeps, type AgentOrderDraft } from '../game/agent/actor'
import { ChannelLog } from '../game/agent/channel'
import { LlmSemaphore, RoundGate, SpeechQuota, type ActorKeypoint } from '../game/agent/scheduler'
import type { LlmClient } from '../game/agent/llm'
import type { ChatChannel, ChatMessage } from '../../src-shared/chat'
import { encodeSnapshot, occupationPatch } from '../../src-shared/codec'
import type {
  CardCreateDTO,
  CardListDTO,
  ChatLog,
  ChatResult,
  CommandResult,
  ControlPatch,
  GameStateDTO,
  LlmPatch,
  LlmStatusDTO,
  MapDTO,
  SaveListDTO,
  SnapshotDTO,
  WorldDTO,
  WorldSaveDTO,
} from '../../src-shared/protocol'
import { createLlmClient, llmStatus, updateLlm } from './llmSettings'
import { insertCard, listCards } from './cardStore'
import {
  deleteSave,
  listSaves,
  readAutoSave,
  readSave,
  writeAutoSave,
  writeSave,
} from './saveStore'
import type { SseHub } from '../http/sse'

const AUTOSAVE_INTERVAL = 5
const AUTO_SAVE_LABEL = '自动续档'
/** LLM 全局并发上限：几十个角色同时排期时避免被服务商排队到超时 */
const LLM_CONCURRENCY = 3

interface RuntimeConfig {
  running: boolean
  speed: number
  eventLimit: number
  autoCommand: boolean
  autoInterval: number
  faction: Faction
  seed: number
}

export class GameRuntime {
  private map!: MapData
  private sim!: MarchSimulation
  private channelLog!: ChannelLog
  private gate!: RoundGate
  private tokens!: LlmSemaphore
  private quota!: SpeechQuota
  private actors: CharacterAgent[] = []
  private llm: LlmClient | null = null

  private readonly config: RuntimeConfig = {
    running: true,
    speed: 650,
    eventLimit: 14,
    autoCommand: true,
    autoInterval: 10,
    faction: 'red',
    seed: 20261021,
  }

  private worldVersion = 1
  private runId = 0
  private timer: NodeJS.Timeout | null = null
  private lastOccupation: Map<string, Faction> | null = null

  constructor(private readonly hub: SseHub) {
    const restored = readAutoSave()
    if (restored) this.applySaveState(restored)
    this.buildWorld(restored)
    if (restored) console.log(`[slg] 已恢复自动续档：第 ${restored.round} 回合`)
    this.schedule()
  }

  /* ------------------------------------------------------------------ */
  /* Reads                                                               */
  /* ------------------------------------------------------------------ */

  world(): WorldDTO {
    return {
      state: this.state(),
      map: this.mapDto(),
      snapshot: this.snapshot(),
      chat: this.chat(),
      llm: llmStatus(),
    }
  }

  mapDto(): MapDTO {
    const { seed, cols, rows, tiles, rivers, roads, bounds } = this.map
    return { seed, cols, rows, tiles, rivers, roads, bounds }
  }

  snapshot(): SnapshotDTO {
    return encodeSnapshot(this.sim.snapshot())
  }

  state(): GameStateDTO {
    return {
      worldVersion: this.worldVersion,
      running: this.config.running,
      speed: this.config.speed,
      eventLimit: this.config.eventLimit,
      autoCommand: this.config.autoCommand,
      autoInterval: this.config.autoInterval,
      faction: this.config.faction,
      seed: this.config.seed,
      llmConfigured: llmStatus().configured,
    }
  }

  /** 玩家可见的频道：世界频道全部，同盟与本团频道只含本方同盟 */
  chat(): ChatLog {
    return {
      world: this.channelLog.list('world', this.config.faction),
      alliance: this.channelLog.list('alliance', this.config.faction),
      team: this.channelLog.list('team', this.config.faction),
    }
  }

  /* ------------------------------------------------------------------ */
  /* Controls                                                            */
  /* ------------------------------------------------------------------ */

  control(patch: ControlPatch): GameStateDTO {
    if (typeof patch.running === 'boolean') this.config.running = patch.running
    if (typeof patch.speed === 'number' && Number.isFinite(patch.speed)) {
      this.config.speed = Math.min(5000, Math.max(200, Math.round(patch.speed)))
    }
    if (typeof patch.eventLimit === 'number' && Number.isFinite(patch.eventLimit)) {
      this.config.eventLimit = Math.min(100, Math.max(1, Math.round(patch.eventLimit)))
      this.sim.setEventLimit(this.config.eventLimit)
    }
    if (typeof patch.autoCommand === 'boolean') this.config.autoCommand = patch.autoCommand
    if (typeof patch.autoInterval === 'number' && Number.isFinite(patch.autoInterval)) {
      this.config.autoInterval = Math.min(100, Math.max(1, Math.round(patch.autoInterval)))
    }
    if (patch.faction && FACTIONS.includes(patch.faction)) this.config.faction = patch.faction

    this.reschedule()
    const state = this.state()
    this.hub.broadcast({ type: 'state', state })
    return state
  }

  reset(seed: number): WorldDTO {
    this.runId += 1
    this.stopTimer()
    this.stopActors()
    this.worldVersion += 1
    this.config.seed = Number.isFinite(seed) && seed > 0 ? Math.floor(seed) : this.config.seed

    this.buildWorld(null)

    const world = this.world()
    writeAutoSave(this.captureSave(AUTO_SAVE_LABEL))
    this.hub.broadcast({ type: 'reset', world })
    this.schedule()
    return world
  }

  updateLlm(patch: LlmPatch): LlmStatusDTO {
    const status = updateLlm(patch)
    this.llm = createLlmClient()
    this.hub.broadcast({ type: 'state', state: this.state() })
    return status
  }

  /* ------------------------------------------------------------------ */
  /* Saves                                                               */
  /* ------------------------------------------------------------------ */

  saveList(): SaveListDTO {
    return { saves: listSaves() }
  }

  createSave(label: string): SaveListDTO {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    writeSave(id, this.captureSave(label.trim() || AUTO_SAVE_LABEL))
    return this.saveList()
  }

  loadSave(id: string): WorldDTO {
    const save = readSave(id)
    if (!save) throw new Error('存档不存在或已损坏')

    this.runId += 1
    this.stopTimer()
    this.stopActors()

    this.applySaveState(save)
    this.buildWorld(save)
    this.worldVersion += 1

    const world = this.world()
    this.hub.broadcast({ type: 'reset', world })
    writeAutoSave(this.captureSave(AUTO_SAVE_LABEL))
    this.schedule()
    return world
  }

  removeSave(id: string): SaveListDTO {
    if (!deleteSave(id)) throw new Error('存档不存在')
    return this.saveList()
  }

  /** 包含全部同盟频道内容的存档快照；读档后按 faction 字段恢复隔离 */
  private saveChat(): ChatLog {
    const messages = this.channelLog.saveState()
    return {
      world: messages.filter((message) => message.channel === 'world'),
      alliance: messages.filter((message) => message.channel === 'alliance'),
      team: messages.filter((message) => message.channel === 'team'),
    }
  }

  /** Snapshot of every mutable piece of the world, ready to persist */
  private captureSave(label: string): WorldSaveDTO {
    const sim = this.sim.saveState()
    return {
      version: 2,
      savedAt: new Date().toISOString(),
      label,
      round: sim.round,
      state: {
        worldVersion: this.worldVersion,
        running: this.config.running,
        speed: this.config.speed,
        eventLimit: this.config.eventLimit,
        autoCommand: this.config.autoCommand,
        autoInterval: this.config.autoInterval,
        faction: this.config.faction,
        seed: this.config.seed,
      },
      sim,
      chat: this.saveChat(),
      actors: this.actors.map((actor) => actor.toSave()),
    }
  }

  /* ------------------------------------------------------------------ */
  /* Character cards                                                     */
  /* ------------------------------------------------------------------ */

  cardList(): CardListDTO {
    return { cards: listCards() }
  }

  /** Persist a new card, spawn it when it marches, and start its coroutine */
  createCard(input: CardCreateDTO): CardListDTO {
    const card = insertCard(input)
    const spawned = this.sim.spawnFromCard(card)
    const actor = new CharacterAgent(card, this.actorDeps())
    this.actors.push(actor)
    actor.start()
    if (spawned) this.sendTick()
    return this.cardList()
  }

  /* ------------------------------------------------------------------ */
  /* Player input                                                        */
  /* ------------------------------------------------------------------ */

  async command(directive: string, faction: Faction): Promise<CommandResult> {
    const runId = this.runId
    const snapshot = this.sim.snapshot()
    const actor = this.spokespersonOf(faction)
    if (!actor) {
      return { round: snapshot.round, orders: 0, reply: '', source: 'mock', error: null }
    }

    const decision = await actor.decideNow({
      kind: 'player',
      round: snapshot.round,
      items: [
        {
          kind: 'player',
          round: snapshot.round,
          label: '玩家指令',
          detail: directive,
          channel: 'alliance',
          text: directive,
        },
      ],
    })

    // 决策之间互不阻塞，只用 runId 丢弃跨存档（重置/读档）返回的过期结果
    if (runId !== this.runId) {
      return { round: snapshot.round, orders: 0, reply: '', source: decision.source, error: null }
    }

    const applied = this.applyOrders(decision.orders, snapshot.round)
    if (applied > 0) this.sendTick()
    return {
      round: snapshot.round,
      orders: applied,
      reply: decision.reply,
      source: decision.source,
      error: decision.error,
    }
  }

  /**
   * 玩家发言：立即写入频道并返回，不等待任何角色思考；
   * 被唤醒的角色在各自协程里决策，回执经 chat / typing 事件送达。
   */
  async chatSend(channel: ChatChannel, text: string, faction: Faction): Promise<ChatResult> {
    const round = this.sim.snapshot().round
    this.channelLog.pushPlayer(channel, faction, text, round)
    this.broadcastChat(channel)
    this.wakeForPlayer(channel, text, faction, round)
    return { messages: this.channelLog.list(channel, this.config.faction) }
  }

  dispose(): void {
    this.stopTimer()
    this.stopActors()
    writeAutoSave(this.captureSave(AUTO_SAVE_LABEL))
  }

  /* ------------------------------------------------------------------ */
  /* World assembly                                                      */
  /* ------------------------------------------------------------------ */

  private buildWorld(save: WorldSaveDTO | null): void {
    const map = generateMap(this.config.seed)
    const sim = new MarchSimulation(map, this.simSeed(map), save?.sim)
    sim.setEventLimit(this.config.eventLimit)
    if (!save) {
      for (const card of listCards()) sim.spawnFromCard(card)
    }

    this.map = map
    this.sim = sim
    this.llm = createLlmClient()
    this.channelLog = new ChannelLog()
    this.gate = new RoundGate()
    this.tokens = new LlmSemaphore(LLM_CONCURRENCY)
    this.quota = new SpeechQuota()
    this.lastOccupation = null

    if (save) {
      this.channelLog.restore([
        ...save.chat.world,
        ...save.chat.alliance,
        ...(save.chat.team ?? []),
      ])
    } else {
      this.channelLog.welcome(this.config.faction, 0)
    }

    this.actors = listCards().map(
      (card) =>
        new CharacterAgent(
          card,
          this.actorDeps(),
          save?.actors?.find((state) => state.cardId === card.id),
        ),
    )
    this.startActors()
  }

  private startActors(): void {
    for (const actor of this.actors) actor.start()
  }

  private stopActors(): void {
    for (const actor of this.actors) actor.stop()
    this.actors = []
    this.gate?.close()
  }

  private actorDeps(): ActorDeps {
    return {
      gate: this.gate,
      tokens: this.tokens,
      quota: this.quota,
      log: this.channelLog,
      terrain: this.sim.terrain,
      llm: () => this.llm,
      snapshot: () => this.sim.snapshot(),
      playerFaction: () => this.config.faction,
      autoEnabled: () => this.config.autoCommand,
      autoInterval: () => this.config.autoInterval,
      isSpokesperson: (cardId) => {
        for (const id of this.spokespersonIds().values()) {
          if (id === cardId) return true
        }
        return false
      },
      applyOrders: (orders, round) => this.applyOrders(orders, round),
      onOrdersApplied: () => this.sendTick(),
      typing: (channel, actorId, author) => {
        this.hub.broadcast({ type: 'typing', channel, actorId, author })
      },
      onChat: (channel) => this.broadcastChat(channel),
    }
  }

  private applySaveState(save: WorldSaveDTO): void {
    const state = save.state
    this.config.running = state.running
    this.config.speed = state.speed
    this.config.eventLimit = state.eventLimit
    this.config.autoCommand = state.autoCommand
    this.config.autoInterval = state.autoInterval
    this.config.faction = state.faction
    this.config.seed = state.seed
    this.worldVersion = state.worldVersion
  }

  private simSeed(map: MapData): number {
    return ((map.seed ^ 0x9e3779b9) >>> 0) || 1
  }

  /* ------------------------------------------------------------------ */
  /* Character routing                                                   */
  /* ------------------------------------------------------------------ */

  /** 每个同盟的发言人：职位最高的角色（大臣优先，其次团长），世界频道与玩家发言都由其回应 */
  private spokespersonIds(): Map<Faction, string> {
    const best = new Map<Faction, { id: string; rank: number }>()
    const rank = (position: string): number =>
      position === '大臣' ? 0 : position === '团长' ? 1 : 2
    for (const card of listCards()) {
      const current = best.get(card.faction)
      if (!current || rank(card.position) < current.rank) {
        best.set(card.faction, { id: card.id, rank: rank(card.position) })
      }
    }
    return new Map([...best].map(([faction, value]) => [faction, value.id]))
  }

  private spokespersonOf(faction: Faction): CharacterAgent | undefined {
    const id = this.spokespersonIds().get(faction)
    return this.actors.find((actor) => actor.id === id)
  }

  /** 玩家发言只唤醒一个角色：同盟与本团频道交给本方发言人，世界频道交给另一个同盟 */
  private wakeForPlayer(
    channel: ChatChannel,
    text: string,
    faction: Faction,
    round: number,
  ): void {
    let target: CharacterAgent | undefined
    if (channel === 'world') {
      const others = FACTIONS.filter((item) => item !== faction)
      const responder = others[(round + text.length) % Math.max(1, others.length)] ?? faction
      target = this.spokespersonOf(responder)
    } else {
      target = this.spokespersonOf(faction)
    }

    const label =
      channel === 'team' ? '本团军令' : channel === 'world' ? '世界发言' : '玩家指令'
    if (!target) return
    target.pushKeypoint({
      kind: 'player',
      round,
      label,
      detail: text,
      channel,
      text,
    })
    // 立即唤醒一轮，省去等待下一个回合边界，玩家发言的回应更快开始
    this.gate.broadcast(round)
  }

  /** Bot 关键点：有具体单位的交给该单位所属角色，无单位的交给同盟发言人 */
  private dispatchSignals(): void {
    const signals = this.sim.drainSignals()
    for (const signal of signals) {
      const actor = signal.generalId
        ? this.actors.find((item) => item.generalId === signal.generalId)
        : this.actors.find(
            (item) =>
              item.card.faction === signal.faction &&
              this.spokespersonIds().get(signal.faction) === item.id,
          )
      actor?.pushKeypoint(this.toKeypoint(signal))
    }
  }

  private toKeypoint(signal: SimSignal): ActorKeypoint {
    return {
      kind: signal.kind,
      round: signal.round,
      label: signal.label,
      detail: signal.detail,
    }
  }

  /* ------------------------------------------------------------------ */
  /* Runtime loop                                                        */
  /* ------------------------------------------------------------------ */

  private schedule(): void {
    if (this.timer || !this.config.running) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.config.running) return
      this.advance()
      this.schedule()
    }, this.config.speed)
  }

  private reschedule(): void {
    this.stopTimer()
    this.schedule()
  }

  private stopTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private advance(): void {
    this.sim.step()
    const snapshot = this.sim.snapshot()
    this.sendTick(snapshot)
    this.dispatchSignals()
    this.gate.broadcast(snapshot.round)
    if (snapshot.round % AUTOSAVE_INTERVAL === 0) {
      writeAutoSave(this.captureSave(AUTO_SAVE_LABEL))
    }
  }

  private applyOrders(orders: AgentOrderDraft[], round: number): number {
    let applied = 0
    for (const order of orders) {
      const payload: BotOrder = {
        stance: order.stance,
        target: order.target,
        note: order.reason,
        issuedRound: round,
      }
      if (this.sim.setOrder(order.generalId, payload)) applied += 1
    }
    return applied
  }

  /* ------------------------------------------------------------------ */
  /* Broadcasts                                                          */
  /* ------------------------------------------------------------------ */

  private sendTick(snapshot = this.sim.snapshot()): void {
    const patch = occupationPatch(this.lastOccupation, snapshot.occupation)
    this.lastOccupation = new Map(snapshot.occupation)
    this.hub.broadcast({
      type: 'tick',
      worldVersion: this.worldVersion,
      snapshot: {
        round: snapshot.round,
        generals: snapshot.generals,
        cities: snapshot.cities,
        occupationVersion: snapshot.occupationVersion,
        events: snapshot.events,
        capturedCount: snapshot.capturedCount,
        capturableCount: snapshot.capturableCount,
        factionCounts: snapshot.factionCounts,
      },
      occPatch: patch,
    })
  }

  private broadcastChat(channel: ChatChannel): void {
    const messages: ChatMessage[] = this.channelLog.list(channel, this.config.faction)
    this.hub.broadcast({ type: 'chat', channel, messages })
  }
}
