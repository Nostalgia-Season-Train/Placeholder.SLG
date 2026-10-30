/**
 * 开局同盟配置：同盟名称与关系持久化在 gitignored 的 world.json。
 * 只有被配置的同盟参与世界构建，顺序即地图三块出生区的顺序。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  ALLIANCE_RELATIONS,
  DEFAULT_ALLIANCES,
  FACTIONS,
  type AllianceConfig,
  type AllianceRelation,
  type AllianceNames,
  type Faction,
} from '../../src-shared/types'

const WORLD_PATH = resolve('src-server/data/world.json')
const MAX_ALLIANCES = 3

function sanitize(input: unknown): AllianceConfig[] | null {
  if (!Array.isArray(input)) return null
  if (input.length < 1 || input.length > MAX_ALLIANCES) return null

  const factions = new Set<Faction>()
  const names = new Set<string>()
  let selfCount = 0
  const result: AllianceConfig[] = []

  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null) return null
    const item = raw as Partial<AllianceConfig>
    if (typeof item.faction !== 'string' || !(FACTIONS as string[]).includes(item.faction)) return null
    if (typeof item.relation !== 'string') return null
    if (!(ALLIANCE_RELATIONS as string[]).includes(item.relation)) return null
    const name = typeof item.name === 'string' ? item.name.trim().slice(0, 12) : ''
    if (!name || names.has(name) || factions.has(item.faction as Faction)) return null

    if (item.relation === 'self') selfCount += 1
    factions.add(item.faction as Faction)
    names.add(name)
    result.push({
      faction: item.faction as Faction,
      name,
      relation: item.relation as AllianceRelation,
    })
  }

  return selfCount === 1 ? result : null
}

function readStored(): AllianceConfig[] | null {
  try {
    if (!existsSync(WORLD_PATH)) return null
    const raw = JSON.parse(readFileSync(WORLD_PATH, 'utf8')) as { alliances?: unknown }
    return sanitize(raw.alliances)
  } catch {
    return null
  }
}

let alliances: AllianceConfig[] = readStored() ?? DEFAULT_ALLIANCES.map((item) => ({ ...item }))

function persist(): void {
  try {
    mkdirSync(dirname(WORLD_PATH), { recursive: true })
    writeFileSync(WORLD_PATH, JSON.stringify({ alliances }, null, 2), 'utf8')
  } catch {
    /* 无法写入时配置只留在内存 */
  }
}

export function getAlliances(): AllianceConfig[] {
  return alliances.map((item) => ({ ...item }))
}

/** 校验并保存同盟配置；不合法时抛出可直接展示给玩家的错误 */
export function updateAlliances(input: unknown): AllianceConfig[] {
  const next = sanitize(input)
  if (!next) throw new Error('同盟配置无效：需要 1~3 个同盟、名称不可重复、且恰有一个我方')
  alliances = next
  persist()
  return getAlliances()
}

export function allianceNames(): AllianceNames {
  const names: AllianceNames = {}
  for (const alliance of alliances) names[alliance.faction] = alliance.name
  return names
}

export function playerFactionOf(list: AllianceConfig[]): Faction {
  return list.find((item) => item.relation === 'self')?.faction ?? 'red'
}
