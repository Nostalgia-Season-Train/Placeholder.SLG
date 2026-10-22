/**
 * Authoritative world runtime: owns the map, the march simulation, the AI agents,
 * chat and the tick timer. The browser only reads snapshots and posts commands.
 */
import { generateMap, type MapData } from '../../src-front/game/map/MapGenerator'
import { MarchSimulation } from '../../src-front/game/bot/simulation'
import { FACTIONS, type BotOrder, type Faction } from '../../src-front/game/bot/types'
import { CommanderAgent, type AgentOrderDraft } from '../../src-front/game/agent/commander'
import {
  WarChat,
  type ChatChannel,
  type ChatMessage,
  type FactionSpokesperson,
} from '../../src-front/game/agent/chat'
import { encodeSnapshot, occupationPatch } from '../../src-front/game/api/codec'
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
} from '../../src-front/game/api/protocol'
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

const AUTO_DIRECTIVE = '根据当前战况推进，优先夺取价值高且易守的地块'
const WORLD_CHAT_INTERVAL = 20
const AUTOSAVE_INTERVAL = 5
const AUTO_SAVE_LABEL = '自动续档'

interface RuntimeConfig {
  running: boolean
  speed: number
  eventLimit: number
  autoCommand: boolean
  autoInterval: number
  faction: Faction
  seed: number
}

export class BusyError extends Error {
  constructor() {
    super('AI 正在处理上一条指令，请稍后再试')
  }
}

export class GameRuntime {
  private map: MapData
  private sim: MarchSimulation
  private commander: CommanderAgent
  private chatPanel: WarChat
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
  private busy = false
  private timer: NodeJS.Timeout | null = null
  private lastOccupation: Map<string, Faction> | null = null
  /** 下一次随机决策 / 随机世界发言的回合；0 表示尚未排期 */
  private nextAutoRound = 0
  private nextWorldRound = 0
  private worldChatIndex = 0

  constructor(private readonly hub: SseHub) {
    const restored = readAutoSave()
    const boot = restored ? this.bootFromSave(restored) : this.boot(this.config.seed)
    this.map = boot.map
    this.sim = boot.sim
    this.commander = boot.commander
    this.chatPanel = boot.chat
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

  chat(): ChatLog {
    return {
      world: this.chatPanel.list('world'),
      alliance: this.chatPanel.list('alliance'),
      team: this.chatPanel.list('team'),
    }
  }

  isBusy(): boolean {
    return this.busy
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
    this.busy = false
    this.stopTimer()
    this.worldVersion += 1
    this.config.seed = Number.isFinite(seed) && seed > 0 ? Math.floor(seed) : this.config.seed

    const boot = this.boot(this.config.seed)
    this.map = boot.map
    this.sim = boot.sim
    this.commander = boot.commander
    this.chatPanel = boot.chat
    this.lastOccupation = null

    const world = this.world()
    writeAutoSave(this.captureSave(AUTO_SAVE_LABEL))
    this.hub.broadcast({ type: 'reset', world })
    this.schedule()
    return world
  }

  updateLlm(patch: LlmPatch): LlmStatusDTO {
    const status = updateLlm(patch)
    const client = createLlmClient()
    this.commander.setLlm(client)
    this.chatPanel.setLlm(client)
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
    this.busy = false
    this.stopTimer()

    const boot = this.bootFromSave(save)
    this.map = boot.map
    this.sim = boot.sim
    this.commander = boot.commander
    this.chatPanel = boot.chat
    this.lastOccupation = null
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

  /** Snapshot of every mutable piece of the world, ready to persist */
  private captureSave(label: string): WorldSaveDTO {
    const sim = this.sim.saveState()
    return {
      version: 1,
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
      chat: this.chat(),
      cursors: {
        nextAutoRound: this.nextAutoRound,
        nextWorldRound: this.nextWorldRound,
        worldChatIndex: this.worldChatIndex,
      },
    }
  }

  /* ------------------------------------------------------------------ */
  /* Character cards                                                     */
  /* ------------------------------------------------------------------ */

  cardList(): CardListDTO {
    return { cards: listCards() }
  }

  /** Persist a new card and, when it should march, spawn it onto the map */
  createCard(input: CardCreateDTO): CardListDTO {
    const card = insertCard(input)
    this.chatPanel.setSpokespersons(this.spokespersons())
    if (this.sim.spawnFromCard(card)) this.sendTick()
    return this.cardList()
  }

  /** 每个同盟的发言人：职位最高的角色卡（大臣优先，其次团长），聊天作者按【同盟名】职务·角色 显示 */
  private spokespersons(): Partial<Record<Faction, FactionSpokesperson>> {
    const rank = (position: string): number => (position === '大臣' ? 0 : position === '团长' ? 1 : 2)
    const result: Partial<Record<Faction, FactionSpokesperson>> = {}
    for (const card of listCards()) {
      const existing = result[card.faction]
      if (!existing || rank(card.position) < rank(existing.position)) {
        result[card.faction] = { position: card.position, name: card.name }
      }
    }
    return result
  }

  /* ------------------------------------------------------------------ */
  /* AI commands                                                         */
  /* ------------------------------------------------------------------ */

  async command(directive: string, faction: Faction): Promise<CommandResult> {
    if (this.busy) throw new BusyError()
    this.busy = true
    const runId = this.runId

    try {
      const current = this.sim.snapshot()
      const decision = await this.commander.decide(directive, faction, current)
      if (runId !== this.runId) {
        return { round: current.round, orders: 0, reply: '', source: decision.source, error: null }
      }
      const applied = this.applyOrders(decision.orders, current.round)
      if (applied > 0) this.sendTick()
      return {
        round: current.round,
        orders: applied,
        reply: decision.reply,
        source: decision.source,
        error: decision.error,
      }
    } finally {
      if (runId === this.runId) this.busy = false
    }
  }

  async chatSend(channel: ChatChannel, text: string, faction: Faction): Promise<ChatResult> {
    // 本团频道：军令直达 Bot，本地同步解析，不经 AI 决策层，不受 busy 锁限制
    if (channel === 'team') {
      const snapshot = this.sim.snapshot()
      this.chatPanel.postPlayer(channel, text, faction, snapshot.round)
      const decision = this.commander.directDecision(text, faction, snapshot)
      const applied = this.applyOrders(decision.orders, snapshot.round)
      this.chatPanel.postSystem(channel, decision.reply, snapshot.round)
      this.broadcastChat(channel)
      if (applied > 0) this.sendTick()
      return { messages: this.chatPanel.list(channel) }
    }

    if (this.busy) throw new BusyError()
    this.busy = true
    const runId = this.runId

    try {
      const snapshot = this.sim.snapshot()
      if (channel === 'alliance') {
        this.chatPanel.postPlayer(channel, text, faction, snapshot.round)
        this.broadcastChat(channel)

        const decision = await this.commander.decide(text, faction, this.sim.snapshot())
        if (runId !== this.runId) return { messages: [] }

        const applied = this.applyOrders(decision.orders, snapshot.round)
        this.chatPanel.postAgent(channel, faction, decision.reply, snapshot.round, decision.source)
        this.broadcastChat(channel)
        if (applied > 0) this.sendTick()
      } else {
        await this.chatPanel.post(channel, text, faction, snapshot)
        if (runId !== this.runId) return { messages: [] }
        this.broadcastChat(channel)
      }

      return { messages: this.chatPanel.list(channel) }
    } finally {
      if (runId === this.runId) this.busy = false
    }
  }

  dispose(): void {
    this.stopTimer()
    writeAutoSave(this.captureSave(AUTO_SAVE_LABEL))
  }

  /* ------------------------------------------------------------------ */
  /* Runtime loop                                                        */
  /* ------------------------------------------------------------------ */

  private boot(seed: number) {
    const map = generateMap(seed)
    const sim = new MarchSimulation(map, this.simSeed(map))
    sim.setEventLimit(this.config.eventLimit)
    for (const card of listCards()) sim.spawnFromCard(card)
    const client = createLlmClient()
    const commander = new CommanderAgent(sim.terrain, client)
    const chat = new WarChat(sim.terrain, client)
    chat.setSpokespersons(this.spokespersons())
    chat.welcome(this.config.faction, 0)

    this.nextAutoRound = 0
    this.nextWorldRound = 0
    this.worldChatIndex = 0
    return { map, sim, commander, chat }
  }

  /** Rebuild the world components from a stored snapshot instead of a seed */
  private bootFromSave(save: WorldSaveDTO) {
    this.applySaveState(save)
    const map = generateMap(this.config.seed)
    const sim = new MarchSimulation(map, this.simSeed(map), save.sim)
    const client = createLlmClient()
    const commander = new CommanderAgent(sim.terrain, client)
    const chat = new WarChat(sim.terrain, client)
    chat.setSpokespersons(this.spokespersons())
    chat.restoreMessages([...save.chat.world, ...save.chat.alliance, ...(save.chat.team ?? [])])
    return { map, sim, commander, chat }
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
    // 旧存档只记录上次触发回合，没有下次排期，按「未排期」重新随机即可
    this.nextAutoRound = save.cursors.nextAutoRound ?? 0
    this.nextWorldRound = save.cursors.nextWorldRound ?? 0
    this.worldChatIndex = save.cursors.worldChatIndex ?? 0
  }

  private simSeed(map: MapData): number {
    return ((map.seed ^ 0x9e3779b9) >>> 0) || 1
  }

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
    this.sendTick()
    this.maybeWorldChat()
    this.maybeAutoCommand()
    if (this.sim.snapshot().round % AUTOSAVE_INTERVAL === 0) {
      writeAutoSave(this.captureSave(AUTO_SAVE_LABEL))
    }
  }

  private maybeWorldChat(): void {
    const round = this.sim.snapshot().round
    if (this.busy) return
    if (this.nextWorldRound === 0) {
      this.nextWorldRound = round + this.randomGap(WORLD_CHAT_INTERVAL)
      return
    }
    if (round < this.nextWorldRound) return
    this.nextWorldRound = round + this.randomGap(WORLD_CHAT_INTERVAL)
    const faction = FACTIONS[this.worldChatIndex % FACTIONS.length] ?? this.config.faction
    this.worldChatIndex += 1
    void this.broadcastWorld(faction)
  }

  /** 随机时间触发：在基准间隔的 0.5~1.5 倍之间取下一次触发回合 */
  private randomGap(base: number): number {
    return Math.max(1, Math.round(base * (0.5 + Math.random())))
  }

  private async broadcastWorld(faction: Faction): Promise<void> {
    if (this.busy) return
    this.busy = true
    const runId = this.runId
    try {
      await this.chatPanel.broadcast(faction, this.sim.snapshot())
      if (runId !== this.runId) return
      this.broadcastChat('world')
    } finally {
      if (runId === this.runId) this.busy = false
    }
  }

  private maybeAutoCommand(): void {
    if (!this.config.autoCommand || this.busy) return
    const round = this.sim.snapshot().round
    if (this.nextAutoRound === 0) {
      this.nextAutoRound = round + this.randomGap(this.config.autoInterval)
      return
    }
    if (round < this.nextAutoRound) return
    this.nextAutoRound = round + this.randomGap(this.config.autoInterval)
    void this.command(AUTO_DIRECTIVE, this.config.faction).catch(() => {
      /* a skipped or failed decision leaves the bots on their own logic */
    })
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

  private sendTick(): void {
    const snapshot = this.sim.snapshot()
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
    const messages: ChatMessage[] = this.chatPanel.list(channel)
    this.hub.broadcast({ type: 'chat', channel, messages })
  }
}
