/**
 * Commander agent: turns a player directive into concrete orders for one faction's bots.
 * When an LLM client is configured the directive is interpreted by the model; otherwise a
 * deterministic local parser produces the same order structure, so the demo works offline.
 */
import { axialToWorld } from '../map/hex'
import { coordKey, getTile, hexDistance, type TileInfo, type WorldTerrain } from '../bot/terrain'
import {
  FACTION_NAMES,
  type BotStance,
  type Coord,
  type Faction,
  type SimSnapshot,
} from '../bot/types'
import type { LlmClient, LlmMessage } from './llm'

export interface AgentOrderDraft {
  generalId: string
  stance: BotStance
  target: Coord | null
  reason: string
}

export interface AgentDecision {
  faction: Faction
  reply: string
  source: 'llm' | 'mock'
  orders: AgentOrderDraft[]
  error: string | null
}

interface AttackCandidate {
  tile: TileInfo
  score: number
}

interface Direction {
  x: number
  z: number
}

const STANCE_LABELS: Record<BotStance, string> = {
  auto: '自主行动',
  attack: '进攻',
  defend: '防守',
  hold: '待命',
  retreat: '撤退',
}

const VALID_STANCES: BotStance[] = ['auto', 'attack', 'defend', 'hold', 'retreat']

const SYSTEM_PROMPT = `你是即时战略游戏中的 AI 决策层，负责把玩家指令翻译成指定阵营 Bot（武将行动层）的行动命令。

规则：
1. 只能指挥 directive 所属阵营的 Bot，generalId 必须来自 generals 列表。
2. 每个 Bot 最多一条命令，stance 取 attack / defend / hold / retreat / auto。
3. attack / defend / retreat 必须给出 target，且 target 必须从 candidates（进攻）或己方地块（防守）中选择。
4. 优先选择价值高、距离近、有战略意义的地块，并让 Bot 的目标分散。
5. 只输出 JSON，不要输出 Markdown 或解释文字。

JSON 结构：
{"reply":"一句中文回应","orders":[{"generalId":"red-0","stance":"attack","target":[q,r],"reason":"简短理由"}]}`

function detectStance(text: string): BotStance {
  if (/待命|停止|原地|待机|不动|按兵/.test(text)) return 'hold'
  if (/撤|退|回防|收缩/.test(text)) return 'retreat'
  if (/守|防|驻|护|固守/.test(text)) return 'defend'
  if (/自由|自主|随意|自行/.test(text)) return 'auto'
  return 'attack'
}

/** Screen-relative direction: north is -z, east is +x */
function detectDirection(text: string): Direction | null {
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
  const end = text.lastIndexOf('}')
  return start >= 0 && end > start ? text.slice(start, end + 1) : text
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

export class CommanderAgent {
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

  async decide(
    directive: string,
    faction: Faction,
    snapshot: SimSnapshot,
  ): Promise<AgentDecision> {
    if (this.llm) {
      try {
        const raw = await this.llm.complete(this.buildMessages(directive, faction, snapshot))
        const parsed = this.parseDecision(raw, faction, snapshot)
        if (parsed) {
          return {
            faction,
            reply: parsed.reply,
            source: 'llm',
            orders: parsed.orders,
            error: null,
          }
        }
        const fallback = this.mockDecision(directive, faction, snapshot)
        fallback.error = 'LLM 返回内容无法解析，已回退本地解析'
        return fallback
      } catch (error) {
        const fallback = this.mockDecision(directive, faction, snapshot)
        fallback.error = error instanceof Error ? error.message : 'LLM 调用失败，已回退本地解析'
        return fallback
      }
    }

    return this.mockDecision(directive, faction, snapshot)
  }

  /**
   * Core-squad channel: parse the directive locally and never touch the LLM.
   * The player directly commands the squad's bots (see docs/同盟关系.md).
   */
  directDecision(directive: string, faction: Faction, snapshot: SimSnapshot): AgentDecision {
    const decision = this.mockDecision(directive, faction, snapshot)
    decision.source = 'mock'
    const assigned = decision.orders.filter((order) => order.target).length
    decision.reply = `军令已下达：${decision.orders.length} 个 Bot 接令，${assigned} 个锁定目标。`
    return decision
  }

  /* ------------------------------------------------------------------ */
  /* LLM path                                                            */
  /* ------------------------------------------------------------------ */

  private buildMessages(
    directive: string,
    faction: Faction,
    snapshot: SimSnapshot,
  ): LlmMessage[] {
    const generals = snapshot.generals.filter((general) => general.faction === faction)
    const enemyTiles: Record<string, number> = {}
    for (const other of Object.keys(snapshot.factionCounts) as Faction[]) {
      if (other !== faction) enemyTiles[FACTION_NAMES[other]] = snapshot.factionCounts[other]
    }

    const context = {
      faction,
      factionName: FACTION_NAMES[faction],
      round: snapshot.round,
      directive,
      generals: generals.map((general) => ({
        id: general.id,
        name: general.name,
        coord: [general.coord.q, general.coord.r],
        status: general.status,
        power: general.power,
      })),
      ownTiles: snapshot.factionCounts[faction],
      enemyTiles,
      capturedCount: snapshot.capturedCount,
      capturableCount: snapshot.capturableCount,
      candidates: this.attackCandidates(faction, snapshot, null)
        .slice(0, 24)
        .map((entry) => ({
          q: entry.tile.coord.q,
          r: entry.tile.coord.r,
          name: entry.tile.name,
          level: entry.tile.level,
          value: entry.tile.value,
          owner: snapshot.occupation.get(coordKey(entry.tile.coord)) ?? null,
          score: Math.round(entry.score),
        })),
    }

    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `战场态势：\n${JSON.stringify(context)}\n请输出 JSON。` },
    ]
  }

  private parseDecision(
    raw: string,
    faction: Faction,
    snapshot: SimSnapshot,
  ): { reply: string; orders: AgentOrderDraft[] } | null {
    let data: unknown
    try {
      data = JSON.parse(extractJson(raw))
    } catch {
      return null
    }
    if (typeof data !== 'object' || data === null) return null

    const record = data as { reply?: unknown; orders?: unknown }
    if (!Array.isArray(record.orders)) return null

    const ids = new Set(
      snapshot.generals.filter((general) => general.faction === faction).map((general) => general.id),
    )
    const orders: AgentOrderDraft[] = []

    for (const item of record.orders) {
      if (typeof item !== 'object' || item === null) continue
      const row = item as Record<string, unknown>
      const generalId = typeof row.generalId === 'string' ? row.generalId : ''
      if (!ids.has(generalId)) continue

      const stance =
        typeof row.stance === 'string' && VALID_STANCES.includes(row.stance as BotStance)
          ? (row.stance as BotStance)
          : 'auto'
      const target = parseTarget(row.target)

      if (stance !== 'auto' && stance !== 'hold') {
        if (!target || !getTile(this.terrain, target)?.passable) continue
      }

      orders.push({
        generalId,
        stance,
        target: stance === 'auto' || stance === 'hold' ? null : target,
        reason: typeof row.reason === 'string' ? row.reason : '',
      })
    }

    if (orders.length === 0) return null
    return { reply: typeof record.reply === 'string' ? record.reply : '已下达指令', orders }
  }

  /* ------------------------------------------------------------------ */
  /* Local fallback path                                                 */
  /* ------------------------------------------------------------------ */

  private mockDecision(
    directive: string,
    faction: Faction,
    snapshot: SimSnapshot,
  ): AgentDecision {
    const stance = detectStance(directive)
    const direction = detectDirection(directive)
    const explicit = detectCoord(directive)
    const explicitTile = explicit ? getTile(this.terrain, explicit) : undefined

    const generals = snapshot.generals.filter((general) => general.faction === faction)
    const attackPool = this.attackCandidates(faction, snapshot, direction)
    const ownPool = this.ownTiles(faction, snapshot)
    const used = new Set<string>()
    const orders: AgentOrderDraft[] = []

    for (const general of generals) {
      if (stance === 'hold' || stance === 'auto') {
        orders.push({ generalId: general.id, stance, target: null, reason: '保持现状' })
        continue
      }

      if (explicitTile?.passable) {
        orders.push({
          generalId: general.id,
          stance: stance === 'attack' ? 'attack' : stance,
          target: { ...explicitTile.coord },
          reason: '按指定坐标行动',
        })
        continue
      }

      const pool = stance === 'attack' || ownPool.length === 0 ? attackPool : ownPool
      let best: AttackCandidate | null = null
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
    return {
      faction,
      reply: `${FACTION_NAMES[faction]} AI（模拟）：${STANCE_LABELS[stance]}，已向 ${assigned} 个 Bot 下达指令。`,
      source: 'mock',
      orders,
      error: null,
    }
  }

  /* ------------------------------------------------------------------ */
  /* Shared helpers                                                      */
  /* ------------------------------------------------------------------ */

  private factionCentroid(faction: Faction, snapshot: SimSnapshot): Coord {
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

  private attackCandidates(
    faction: Faction,
    snapshot: SimSnapshot,
    direction: Direction | null,
  ): AttackCandidate[] {
    const centroid = this.factionCentroid(faction, snapshot)
    const centerWorld = axialToWorld(centroid.q, centroid.r)
    const result: AttackCandidate[] = []

    for (const tile of this.terrain.capturable) {
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

  private ownTiles(faction: Faction, snapshot: SimSnapshot): AttackCandidate[] {
    const tiles: AttackCandidate[] = []
    for (const [key, owner] of snapshot.occupation) {
      if (owner !== faction) continue
      const [q, r] = key.split(',').map(Number)
      if (q === undefined || r === undefined || Number.isNaN(q) || Number.isNaN(r)) continue
      const tile = getTile(this.terrain, { q, r })
      if (tile?.passable) tiles.push({ tile, score: tile.value })
    }
    return tiles
  }
}
