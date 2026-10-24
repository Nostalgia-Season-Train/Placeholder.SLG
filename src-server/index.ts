/**
 * Authoritative game service: one world, JSON commands, SSE snapshots.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { SseHub } from './http/sse'
import { serveStatic } from './http/static'
import { GameRuntime } from './runtime/GameRuntime'
import { closeSaveStore, isValidSaveId } from './runtime/saveStore'
import { closeCardStore } from './runtime/cardStore'
import {
  DEFAULT_PERSONALITY,
  DEFAULT_PERSONALITY_BY_AXIS,
  FACTIONS,
  GENERAL_POSITIONS,
  GENERAL_ROLES,
  GENERAL_TEAMS,
  PERSONALITY_AXES,
  PERSONALITY_TAGS,
  personalityConflicts,
  STAT_GRADES,
  type Faction,
  type GeneralPosition,
  type GeneralRole,
  type GeneralTeam,
  type PersonalityTag,
  type StatGrade,
} from '../src-shared/types'
import type { ChatChannel } from '../src-shared/chat'
import type { CardCreateDTO, ControlPatch, LlmPatch } from '../src-shared/protocol'

const PORT = Number(process.env.SERVER_PORT ?? 8787)
const HOST = process.env.SERVER_HOST ?? '127.0.0.1'
/** Built frontend files, served in production so one process hosts UI and API */
const CLIENT_DIR = resolve(process.env.SLG_CLIENT_DIR ?? 'dist')

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const hub = new SseHub()
const runtime = new GameRuntime(hub)

function setCors(response: ServerResponse): void {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  })
  response.end(text)
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > 1_000_000) throw new HttpError(413, '请求体过大')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch {
    throw new HttpError(400, '请求体必须是 JSON 对象')
  }
}

function asFaction(value: unknown): Faction {
  if (typeof value === 'string' && (FACTIONS as string[]).includes(value)) return value as Faction
  throw new HttpError(400, '未知同盟')
}

function asChannel(value: unknown): ChatChannel {
  if (value === 'world' || value === 'alliance' || value === 'team') return value
  throw new HttpError(400, '未知频道')
}

function asText(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  throw new HttpError(400, `${label}不能为空`)
}

function asRole(value: unknown): GeneralRole {
  if (typeof value === 'string' && (GENERAL_ROLES as readonly string[]).includes(value)) {
    return value as GeneralRole
  }
  throw new HttpError(400, '未知定位')
}

function asPosition(value: unknown): GeneralPosition {
  if (typeof value === 'string' && (GENERAL_POSITIONS as readonly string[]).includes(value)) {
    return value as GeneralPosition
  }
  throw new HttpError(400, '未知职位')
}

function asGrade(value: unknown): StatGrade {
  if (typeof value === 'string' && (STAT_GRADES as readonly string[]).includes(value)) {
    return value as StatGrade
  }
  throw new HttpError(400, '未知档位')
}

function asTeam(value: unknown): GeneralTeam | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string' && (GENERAL_TEAMS as readonly string[]).includes(value)) {
    return value as GeneralTeam
  }
  throw new HttpError(400, '未知团')
}

/** 性格只接受固定标签数组；同一维度内出现多个标签视为冲突 */
function asPersonality(value: unknown): PersonalityTag[] {
  if (value === undefined || value === null || value === '') return [...DEFAULT_PERSONALITY]
  if (!Array.isArray(value)) throw new HttpError(400, '性格需要标签数组')
  const picked: PersonalityTag[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !PERSONALITY_TAGS.includes(item as PersonalityTag)) {
      throw new HttpError(400, '未知性格标签')
    }
    const tag = item as PersonalityTag
    if (picked.includes(tag)) continue
    const conflict = picked.find((existing) => personalityConflicts(existing, tag))
    if (conflict) {
      throw new HttpError(400, `性格标签冲突：${conflict} 与 ${tag} 属于同一维度`)
    }
    picked.push(tag)
  }
  // 缺失的维度补默认标签，保证每个角色两个维度都有取值
  for (const group of PERSONALITY_AXES) {
    if (picked.some((tag) => group.tags.includes(tag))) continue
    picked.push(DEFAULT_PERSONALITY_BY_AXIS[group.axis])
  }
  return picked
}

/** Body of POST /api/cards and PATCH /api/cards/:id */
function readCardInput(body: Record<string, unknown>): CardCreateDTO {
  const input: CardCreateDTO = {
    name: asText(body.name, '名称').slice(0, 24),
    faction: asFaction(body.faction),
    team: asTeam(body.team),
    role: asRole(body.role),
    position: asPosition(body.position),
    attack: asGrade(body.attack),
    magic: asGrade(body.magic),
    personality: asPersonality(body.personality),
  }
  if (typeof body.description === 'string') input.description = body.description.slice(0, 2000)
  if (typeof body.dialoguePrompt === 'string') {
    input.dialoguePrompt = body.dialoguePrompt.slice(0, 2000)
  }
  if (typeof body.authorNote === 'string') input.authorNote = body.authorNote.slice(0, 2000)
  if (typeof body.active === 'boolean') input.active = body.active
  return input
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  setCors(response)
  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    response.end()
    return
  }

  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  const path = url.pathname
  const method = request.method ?? 'GET'

  if (method === 'GET' && path === '/api/health') {
    json(response, 200, { ok: true, node: process.version })
    return
  }

  if (method === 'GET' && path === '/api/world') {
    json(response, 200, runtime.world())
    return
  }

  if (method === 'GET' && path === '/api/map') {
    json(response, 200, runtime.mapDto())
    return
  }

  if (method === 'GET' && path === '/api/snapshot') {
    json(response, 200, runtime.snapshot())
    return
  }

  if (method === 'GET' && path === '/api/chat') {
    const channel = asChannel(url.searchParams.get('channel') ?? 'world')
    const log = runtime.chat()
    json(response, 200, {
      messages: channel === 'world' ? log.world : channel === 'team' ? log.team : log.alliance,
    })
    return
  }

  if (method === 'GET' && path === '/api/alliances') {
    json(response, 200, { alliances: runtime.world().alliances })
    return
  }

  if (method === 'PUT' && path === '/api/alliances') {
    const body = await readJson(request)
    try {
      json(response, 200, { alliances: runtime.setAlliances(body.alliances) })
    } catch (error) {
      throw error instanceof HttpError
        ? error
        : new HttpError(400, error instanceof Error ? error.message : '同盟配置无效')
    }
    return
  }

  if (method === 'GET' && path === '/api/llm') {
    json(response, 200, runtime.world().llm)
    return
  }

  if (method === 'PUT' && path === '/api/llm') {
    const body = await readJson(request)
    const patch: LlmPatch = {}
    if (typeof body.baseUrl === 'string') patch.baseUrl = body.baseUrl
    if (typeof body.model === 'string') patch.model = body.model
    if (typeof body.apiKey === 'string') patch.apiKey = body.apiKey
    if (body.mode === 'live' || body.mode === 'mock') patch.mode = body.mode
    json(response, 200, runtime.updateLlm(patch))
    return
  }

  if (method === 'POST' && path === '/api/llm/test') {
    json(response, 200, await runtime.testLlm())
    return
  }

  if (method === 'GET' && path === '/api/events') {
    hub.add(response)
    response.write(`data: ${JSON.stringify({ type: 'hello', world: runtime.world() })}\n\n`)
    return
  }

  if (method === 'POST' && path === '/api/control') {
    const body = await readJson(request)
    const patch: ControlPatch = {}
    if (typeof body.running === 'boolean') patch.running = body.running
    if (typeof body.speed === 'number') patch.speed = body.speed
    if (typeof body.eventLimit === 'number') patch.eventLimit = body.eventLimit
    if (typeof body.autoCommand === 'boolean') patch.autoCommand = body.autoCommand
    if (typeof body.autoInterval === 'number') patch.autoInterval = body.autoInterval
    json(response, 200, runtime.control(patch))
    return
  }

  if (method === 'POST' && path === '/api/world/reset') {
    json(response, 200, runtime.reset())
    return
  }

  if (method === 'POST' && path === '/api/command') {
    const body = await readJson(request)
    const directive = asText(body.directive, '指令')
    const faction = asFaction(body.faction)
    json(response, 200, await runtime.command(directive, faction))
    return
  }

  if (method === 'POST' && path === '/api/chat') {
    const body = await readJson(request)
    const channel = asChannel(body.channel)
    const text = asText(body.text, '消息')
    const faction = asFaction(body.faction)
    json(response, 200, await runtime.chatSend(channel, text, faction))
    return
  }

  if (method === 'GET' && path === '/api/saves') {
    json(response, 200, runtime.saveList())
    return
  }

  if (method === 'POST' && path === '/api/saves') {
    const body = await readJson(request)
    json(response, 200, runtime.createSave(asText(body.label, '存档名称')))
    return
  }

  const saveMatch = /^\/api\/saves\/([^/]+)(\/load)?$/.exec(path)
  if (saveMatch) {
    const id = decodeURIComponent(saveMatch[1] ?? '')
    if (!isValidSaveId(id)) throw new HttpError(400, '非法的存档标识')
    if (method === 'POST' && saveMatch[2] === '/load') {
      json(response, 200, runtime.loadSave(id))
      return
    }
    if (method === 'DELETE' && saveMatch[2] === undefined) {
      json(response, 200, runtime.removeSave(id))
      return
    }
  }

  if (method === 'GET' && path === '/api/cards') {
    json(response, 200, runtime.cardList())
    return
  }

  if (method === 'POST' && path === '/api/cards') {
    json(response, 200, runtime.createCard(readCardInput(await readJson(request))))
    return
  }

  const cardMatch = /^\/api\/cards\/([^/]+)$/.exec(path)
  if (method === 'PATCH' && cardMatch) {
    const id = decodeURIComponent(cardMatch[1] ?? '')
    try {
      json(response, 200, runtime.editCard(id, readCardInput(await readJson(request))))
    } catch (error) {
      throw error instanceof HttpError
        ? error
        : new HttpError(404, error instanceof Error ? error.message : '角色不存在')
    }
    return
  }

  if ((method === 'GET' || method === 'HEAD') && !path.startsWith('/api')) {
    if (await serveStatic(CLIENT_DIR, path, method, response)) return
  }

  throw new HttpError(404, path.startsWith('/api') ? '接口不存在' : '资源不存在')
}

const server = createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    const status = error instanceof HttpError ? error.status : 500
    const message = error instanceof Error ? error.message : '服务端错误'
    if (!response.headersSent) json(response, status, { error: message })
    else response.end()
  })
})

const heartbeat = setInterval(() => hub.heartbeat(), 15_000)

server.on('error', (error: NodeJS.ErrnoException) => {
  const reason =
    error.code === 'EADDRINUSE'
      ? `端口 ${PORT} 已被占用，请先停止旧的 npm run dev 或 npm run server 进程`
      : '服务启动失败'
  console.error(`[slg] ${reason}：`, error)
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  console.log(`[slg] 后端推演服务已启动：http://${HOST}:${PORT}`)
  console.log(
    existsSync(resolve(CLIENT_DIR, 'index.html'))
      ? `[slg] 前端静态挂载：${CLIENT_DIR}`
      : '[slg] 前端产物不存在，运行 npm run build 后即可由本服务托管',
  )
})

function shutdown(): void {
  clearInterval(heartbeat)
  runtime.dispose()
  closeSaveStore()
  closeCardStore()
  hub.closeAll()
  server.close(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
