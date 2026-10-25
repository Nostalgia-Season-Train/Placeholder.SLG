/**
 * 角色请求上下文组装：自身上下文 + 环境上下文 + 可见战况 + 本轮触发。
 * 只给角色可见范围内的信息，按固定上限裁剪，作者注释不进入上下文。
 */
import { coordKey, hexDistance, type WorldTerrain } from '../bot/terrain'
import {
  RESOURCE_KINDS,
  RESOURCE_NAMES,
  allianceNameOf,
  personalitySummary,
  type AllianceNames,
  type Coord,
  type Faction,
  type FortState,
  type GeneralState,
  type SimSnapshot,
} from '../../../src-shared/types'
import type { CharacterCardDTO } from '../../../src-shared/protocol'
import type { ChatChannel, ChatMessage } from '../../../src-shared/chat'
import type { ActorMemory } from './memory'
import type { ChannelLog } from './channel'
import type { ActorKeypoint } from './scheduler'

/** 一次唤醒角色时的触发：玩家发言、关键点、随机时间、世界发言 */
export interface ActorTrigger {
  kind: 'player' | 'keypoint' | 'random' | 'world'
  round: number
  items: ActorKeypoint[]
}

export interface ContextDeps {
  memory: ActorMemory
  log: ChannelLog
  snapshot: SimSnapshot
  terrain: WorldTerrain
  playerFaction: Faction
  /** 开局配置的同盟名称表 */
  allianceNames: AllianceNames
}

/** 频道上下文的裁剪上限，见《角色行动》5.3 */
const CHANNEL_LIMIT = 6
const ORDER_LIMIT = 8
const SPEECH_LIMIT = 6
const CANDIDATE_LIMIT = 16
const ENEMY_LIMIT = 6
const FORT_LIMIT = 6
/** 周边敌方单位的可见半径 */
const SIGHT_RADIUS = 12

const CHANNEL_NAMES: Record<ChatChannel, string> = {
  world: '世界',
  alliance: '同盟',
  team: '本团',
}

const TRIGGER_LABELS: Record<ActorTrigger['kind'], string> = {
  player: '玩家发言',
  keypoint: '局势变化',
  random: '随机时间',
  world: '世界发言',
}

export function buildActorContext(
  card: CharacterCardDTO,
  trigger: ActorTrigger,
  deps: ContextDeps,
): Record<string, unknown> {
  const { snapshot } = deps

  return {
    角色: {
      名称: card.name,
      同盟: allianceNameOf(deps.allianceNames, card.faction),
      职位: card.position,
      团: card.team ?? '',
      定位: card.role,
      工程: card.engineering ?? '中',
      性格: personalitySummary(card.personality).label,
      性格倾向: personalitySummary(card.personality).behavior,
      描述: card.description,
      对话提示词: card.dialoguePrompt,
    },
    自身上下文: {
      行动: deps.memory.orders.slice(-ORDER_LIMIT).reverse().map(orderLine),
      发言: deps.memory.speech.slice(-SPEECH_LIMIT).reverse().map(speechLine),
    },
    环境上下文: {
      世界: channelView(deps, 'world', card.faction, trigger),
      同盟: channelView(deps, 'alliance', card.faction, trigger),
      本团:
        card.faction === deps.playerFaction
          ? channelView(deps, 'team', card.faction, trigger)
          : [],
    },
    可见战况: {
      回合: snapshot.round,
      己方地块数: snapshot.factionCounts[card.faction],
      己方资源: resourceLine(card.faction, snapshot),
      己方单位: ownGenerals(card.faction, snapshot).map(unitLine),
      周边敌方单位: nearbyEnemies(card.faction, snapshot, deps.allianceNames),
      己方要塞: fortView(card.faction, snapshot, deps.allianceNames, true),
      敌方要塞: fortView(card.faction, snapshot, deps.allianceNames, false),
      可占领候选: candidates(card.faction, snapshot, deps.terrain, deps.allianceNames),
    },
    本轮触发: {
      类型: TRIGGER_LABELS[trigger.kind],
      内容: trigger.items.map((item) => {
        const text = (item.detail ?? '').trim()
        if (item.kind === 'player') {
          const where = item.channel === 'world' ? '世界频道' : item.channel === 'alliance' ? '同盟频道' : '本团频道'
          return `第${item.round}回合 玩家在${where}对你说：${text}`
        }
        return `第${item.round}回合 ${item.label}：${text}`
      }),
    },
  }
}

/** 记忆与战况统一用紧凑单行文本，字段名重复是上下文膨胀的主因 */
function orderLine(order: { round: number; generalId: string | null; stance: string; target: [number, number] | null; result: string }): string {
  const target = order.target ? `→(${order.target[0]},${order.target[1]})` : ''
  const unit = order.generalId ?? '全部'
  return `第${order.round}回合 ${order.stance} ${unit}${target} ${order.result}`.trim()
}

function speechLine(speech: { round: number; channel: ChatChannel; text: string }): string {
  return `第${speech.round}回合 ${CHANNEL_NAMES[speech.channel]}：${speech.text}`
}

function unitLine(general: GeneralState): string {
  return `${general.id} ${general.name} (${general.coord.q},${general.coord.r}) ${general.status} 战力${general.power} 兵力${general.hp}/${general.maxHp} 工程${general.engineering}`
}

/** 本同盟资源：角色需要知道自己付得起几座要塞、补得起多少兵 */
function resourceLine(faction: Faction, snapshot: SimSnapshot): string {
  const pool = snapshot.resources[faction]
  return RESOURCE_KINDS.map((kind) => `${RESOURCE_NAMES[kind]}${Math.floor(pool[kind])}`).join(' ')
}

/** 要塞摘要：己方全部展示，敌方只展示周边可见范围 */
function fortView(
  faction: Faction,
  snapshot: SimSnapshot,
  names: AllianceNames,
  own: boolean,
): string[] {
  const centroid = factionCentroid(faction, snapshot)
  return snapshot.forts
    .filter((fort) => (fort.faction === faction) === own)
    .filter((fort) => own || hexDistance(centroid, fort.coord) <= SIGHT_RADIUS)
    .sort((a, b) => a.builtRound - b.builtRound || a.id.localeCompare(b.id))
    .slice(0, FORT_LIMIT)
    .map((fort) => fortLine(fort, names))
}

function fortLine(fort: FortState, names: AllianceNames): string {
  const state =
    fort.status === 'building'
      ? `建造中${fort.progress}/${fort.buildCost}`
      : `已建成 ${fort.hp}/${fort.maxHp}`
  return `(${fort.coord.q},${fort.coord.r}) ${allianceNameOf(names, fort.faction)} ${state}`
}

/** 频道最近消息，剔除本轮触发的那句，避免与触发内容重复 */
function channelView(
  deps: ContextDeps,
  channel: ChatChannel,
  viewer: Faction,
  trigger: ActorTrigger,
): unknown[] {
  const player = trigger.items.find((item) => item.kind === 'player')
  const messages = deps.log
    .recent(channel, viewer, CHANNEL_LIMIT)
    .filter((message) => !isTriggerLine(message, player?.text, player?.round))

  return messages.map((message) => `第${message.round}回合 ${message.author}：${message.text}`)
}

function isTriggerLine(message: ChatMessage, text: string | undefined, round: number | undefined): boolean {
  return Boolean(
    text && message.source === 'player' && message.text === text && message.round === round,
  )
}

function ownGenerals(faction: Faction, snapshot: SimSnapshot): GeneralState[] {
  return snapshot.generals.filter((general) => general.faction === faction)
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

function nearbyEnemies(
  faction: Faction,
  snapshot: SimSnapshot,
  names: AllianceNames,
): unknown[] {
  const centroid = factionCentroid(faction, snapshot)
  return snapshot.generals
    .filter((general) => general.faction !== faction)
    .map((general) => ({ general, distance: hexDistance(centroid, general.coord) }))
    .filter((entry) => entry.distance <= SIGHT_RADIUS)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, ENEMY_LIMIT)
    .map(
      (entry) =>
        `${entry.general.name}(${allianceNameOf(names, entry.general.faction)}) (${entry.general.coord.q},${entry.general.coord.r}) ${entry.general.status} 战力${entry.general.power} 兵力${entry.general.hp}/${entry.general.maxHp}`,
    )
}

function candidates(
  faction: Faction,
  snapshot: SimSnapshot,
  terrain: WorldTerrain,
  names: AllianceNames,
): unknown[] {
  const centroid = factionCentroid(faction, snapshot)
  const fortKeys = new Set(snapshot.forts.map((fort) => coordKey(fort.coord)))
  return terrain.capturable
    .filter((tile) => snapshot.occupation.get(coordKey(tile.coord)) !== faction)
    .filter((tile) => !fortKeys.has(coordKey(tile.coord)))
    .map((tile) => {
      const owner = snapshot.occupation.get(coordKey(tile.coord)) ?? null
      const distance = hexDistance(centroid, tile.coord)
      return {
        tile,
        owner,
        score: tile.value + (owner ? 10 : 0) - distance * 1.6,
      }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATE_LIMIT)
    .map((entry) => {
      const owner = entry.owner ? allianceNameOf(names, entry.owner) : '无主'
      return `(${entry.tile.coord.q},${entry.tile.coord.r})${entry.tile.name} L${entry.tile.level} 值${entry.tile.value} ${owner} 评${Math.round(entry.score)}`
    })
}
