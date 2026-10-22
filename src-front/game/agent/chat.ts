/**
 * Faction chat: a world channel shared by every faction AI and an alliance channel
 * dedicated to the player's own faction. With an LLM client the replies come from the
 * model; otherwise the simulated AI keeps both channels alive.
 */
import { coordKey, hexDistance, type WorldTerrain } from '../bot/terrain'
import { FACTIONS, FACTION_NAMES, type Faction, type SimSnapshot } from '../bot/types'
import type { LlmClient, LlmMessage } from './llm'

export type ChatChannel = 'world' | 'alliance'
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

const MAX_MESSAGES = 160

const ALLIANCE_PROMPT = `你是本方阵营的 AI 决策层，用简短中文回答主将的问题，给出战况判断和行动建议。
要求：不超过 60 字；不要输出 Markdown；只依据给出的战场数据，不编造坐标。`

const WORLD_PROMPT = `你是本方阵营的 AI 决策层，在世界频道向其他阵营发一条简短战报或宣言。
要求：不超过 30 字；态度符合本方立场；不要输出 Markdown；不要编造数据。`

export class WarChat {
  private readonly messages: ChatMessage[] = []
  private nextId = 1
  private llm: LlmClient | null

  constructor(
    private readonly terrain: WorldTerrain,
    llm: LlmClient | null = null,
  ) {
    this.llm = llm
  }

  setLlm(llm: LlmClient | null): void {
    this.llm = llm
  }

  list(channel: ChatChannel): ChatMessage[] {
    return this.messages.filter((message) => message.channel === channel).slice(-80)
  }

  welcome(faction: Faction, round: number): void {
    this.push({
      channel: 'world',
      faction: null,
      author: '系统',
      text: '世界频道已开放。',
      round,
      source: 'system',
    })
    this.push({
      channel: 'alliance',
      faction,
      author: `${FACTION_NAMES[faction]} AI`,
      text: '同盟频道已建立，可直接下发指令或询问战况。',
      round,
      source: 'system',
    })
  }

  /** Player speech: a world message may draw a reply from another faction, alliance goes to own agent */
  async post(
    channel: ChatChannel,
    text: string,
    faction: Faction,
    snapshot: SimSnapshot,
  ): Promise<void> {
    this.postPlayer(channel, text, faction, snapshot.round)

    if (channel === 'alliance') {
      await this.reply(faction, snapshot, text, 'alliance', true)
      return
    }

    const others = FACTIONS.filter((item) => item !== faction)
    const responder = others[(snapshot.round + text.length) % Math.max(1, others.length)] ?? faction
    await this.reply(responder, snapshot, text, 'world', false)
  }

  /** Add the player's own line without generating a reply */
  postPlayer(channel: ChatChannel, text: string, faction: Faction, round: number): void {
    this.push({ channel, faction, author: '你', text, round, source: 'player' })
  }

  /** Add an AI line when the decision layer already produced the reply */
  postAgent(
    channel: ChatChannel,
    faction: Faction,
    text: string,
    round: number,
    source: 'llm' | 'mock',
  ): void {
    this.push({ channel, faction, author: `${FACTION_NAMES[faction]} AI`, text, round, source })
  }

  /** Periodic world broadcast from one faction AI */
  async broadcast(faction: Faction, snapshot: SimSnapshot): Promise<void> {
    await this.reply(faction, snapshot, '', 'world', false)
  }

  /* ------------------------------------------------------------------ */

  private async reply(
    faction: Faction,
    snapshot: SimSnapshot,
    prompt: string,
    channel: ChatChannel,
    answerPlayer: boolean,
  ): Promise<void> {
    if (this.llm) {
      try {
        const text = await this.llm.complete(this.buildMessages(faction, snapshot, prompt, channel))
        const clean = text.trim().replace(/\s+/g, ' ').slice(0, 160)
        if (clean) {
          this.push({
            channel,
            faction,
            author: `${FACTION_NAMES[faction]} AI`,
            text: clean,
            round: snapshot.round,
            source: 'llm',
          })
          return
        }
      } catch {
        /* fall through to the local line */
      }
    }

    this.push({
      channel,
      faction,
      author: `${FACTION_NAMES[faction]} AI`,
      text: answerPlayer
        ? this.localAdvice(faction, snapshot)
        : this.localBroadcast(faction, snapshot),
      round: snapshot.round,
      source: 'mock',
    })
  }

  private buildMessages(
    faction: Faction,
    snapshot: SimSnapshot,
    prompt: string,
    channel: ChatChannel,
  ): LlmMessage[] {
    const generals = snapshot.generals.filter((general) => general.faction === faction)
    const counts = FACTIONS.map((item) => ({
      faction: FACTION_NAMES[item],
      tiles: snapshot.factionCounts[item],
    }))

    const context = {
      faction: FACTION_NAMES[faction],
      round: snapshot.round,
      counts,
      totals: { captured: snapshot.capturedCount, capturable: snapshot.capturableCount },
      generals: generals.map((general) => ({
        name: general.name,
        coord: [general.coord.q, general.coord.r],
        status: general.status,
        target: general.target ? [general.target.q, general.target.r] : null,
      })),
      message: prompt || null,
    }

    return [
      { role: 'system', content: channel === 'alliance' ? ALLIANCE_PROMPT : WORLD_PROMPT },
      { role: 'user', content: JSON.stringify(context) },
    ]
  }

  private localAdvice(faction: Faction, snapshot: SimSnapshot): string {
    const own = snapshot.factionCounts[faction]
    const leader = FACTIONS.reduce((best, item) =>
      snapshot.factionCounts[item] > snapshot.factionCounts[best] ? item : best,
    )
    const active = snapshot.generals.filter(
      (general) =>
        general.faction === faction &&
        (general.status === 'marching' || general.status === 'capturing'),
    ).length

    const target = this.bestTarget(faction, snapshot)
    const heading = target ? `建议优先夺取${target.name}（${target.coord.q},${target.coord.r}）。` : '建议稳守现有地块。'
    const position =
      leader === faction ? '我方暂时领先' : `${FACTION_NAMES[leader]}以 ${snapshot.factionCounts[leader]} 块领先`

    return `${FACTION_NAMES[faction]}现有 ${own} 块地，${position}；${active} 名 Bot 在行动。${heading}`
  }

  private localBroadcast(faction: Faction, snapshot: SimSnapshot): string {
    const own = snapshot.factionCounts[faction]
    const lines = [
      `${FACTION_NAMES[faction]}已控 ${own} 块地，旗子插稳了。`,
      `${FACTION_NAMES[faction]}的 Bot 已经出发，别挡路。`,
      `这片地，${FACTION_NAMES[faction]}要一半。`,
      `世界频道没人应答？那就用兵说话。`,
    ]
    return lines[(snapshot.round + own) % lines.length] ?? lines[0]!
  }

  private bestTarget(
    faction: Faction,
    snapshot: SimSnapshot,
  ): { name: string; coord: { q: number; r: number } } | null {
    let centroidQ = 0
    let centroidR = 0
    let count = 0
    for (const [key, owner] of snapshot.occupation) {
      if (owner !== faction) continue
      const [q, r] = key.split(',').map(Number)
      if (q === undefined || r === undefined || Number.isNaN(q) || Number.isNaN(r)) continue
      centroidQ += q
      centroidR += r
      count += 1
    }
    const centroid = count === 0 ? { q: 0, r: 0 } : { q: Math.round(centroidQ / count), r: Math.round(centroidR / count) }

    let best: { name: string; coord: { q: number; r: number } } | null = null
    let bestScore = -Infinity
    for (const tile of this.terrain.capturable) {
      if (snapshot.occupation.get(coordKey(tile.coord)) === faction) continue
      const score = tile.value - hexDistance(centroid, tile.coord) * 2
      if (score > bestScore) {
        bestScore = score
        best = { name: tile.name, coord: tile.coord }
      }
    }
    return best
  }

  private push(message: Omit<ChatMessage, 'id'>): void {
    this.messages.push({ id: this.nextId, ...message })
    this.nextId += 1
    if (this.messages.length > MAX_MESSAGES) {
      this.messages.splice(0, this.messages.length - MAX_MESSAGES)
    }
  }
}
