/**
 * Authoritative world runtime: owns the map, the march simulation, the AI agents,
 * chat and the tick timer. The browser only reads snapshots and posts commands.
 */
import { generateMap, type MapData } from '../../src/game/map/MapGenerator'
import { MarchSimulation } from '../../src/game/bot/simulation'
import { FACTIONS, type BotOrder, type Faction } from '../../src/game/bot/types'
import { CommanderAgent, type AgentOrderDraft } from '../../src/game/agent/commander'
import { WarChat, type ChatChannel, type ChatMessage } from '../../src/game/agent/chat'
import { encodeSnapshot, occupationPatch } from '../../src/game/api/codec'
import type {
  ChatLog,
  ChatResult,
  CommandResult,
  ControlPatch,
  GameStateDTO,
  LlmPatch,
  LlmStatusDTO,
  MapDTO,
  SnapshotDTO,
  WorldDTO,
} from '../../src/game/api/protocol'
import { createLlmClient, llmStatus, updateLlm } from './llmSettings'
import type { SseHub } from '../http/sse'

const AUTO_DIRECTIVE = '根据当前战况推进，优先夺取价值高且易守的地块'
const WORLD_CHAT_INTERVAL = 20

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
  private lastAutoRound = 0
  private lastWorldRound = 0
  private worldChatIndex = 0

  constructor(private readonly hub: SseHub) {
    const boot = this.boot(this.config.seed)
    this.map = boot.map
    this.sim = boot.sim
    this.commander = boot.commander
    this.chatPanel = boot.chat
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
    return { world: this.chatPanel.list('world'), alliance: this.chatPanel.list('alliance') }
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

  /** Advance exactly one round, useful while paused */
  step(): SnapshotDTO {
    this.advance()
    return this.snapshot()
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
  }

  /* ------------------------------------------------------------------ */
  /* Runtime loop                                                        */
  /* ------------------------------------------------------------------ */

  private boot(seed: number) {
    const map = generateMap(seed)
    const sim = new MarchSimulation(map, ((map.seed ^ 0x9e3779b9) >>> 0) || 1)
    sim.setEventLimit(this.config.eventLimit)
    const client = createLlmClient()
    const commander = new CommanderAgent(sim.terrain, client)
    const chat = new WarChat(sim.terrain, client)
    chat.welcome(this.config.faction, 0)

    this.lastAutoRound = 0
    this.lastWorldRound = 0
    this.worldChatIndex = 0
    return { map, sim, commander, chat }
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
  }

  private maybeWorldChat(): void {
    const round = this.sim.snapshot().round
    if (this.busy || round - this.lastWorldRound < WORLD_CHAT_INTERVAL) return
    this.lastWorldRound = round
    const faction = FACTIONS[this.worldChatIndex % FACTIONS.length] ?? this.config.faction
    this.worldChatIndex += 1
    void this.broadcastWorld(faction)
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
    if (round - this.lastAutoRound < this.config.autoInterval) return
    this.lastAutoRound = round
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
