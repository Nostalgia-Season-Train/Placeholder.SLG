/**
 * Authoritative game service: one world, JSON commands, SSE snapshots.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { SseHub } from './http/sse'
import { serveStatic } from './http/static'
import { BusyError, GameRuntime } from './runtime/GameRuntime'
import { FACTIONS, type Faction } from '../src-front/game/bot/types'
import type { ChatChannel } from '../src-front/game/agent/chat'
import type { ControlPatch, LlmPatch } from '../src-front/game/api/protocol'

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
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
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
  throw new HttpError(400, '未知势力')
}

function asChannel(value: unknown): ChatChannel {
  if (value === 'world' || value === 'alliance') return value
  throw new HttpError(400, '未知频道')
}

function asText(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  throw new HttpError(400, `${label}不能为空`)
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
    json(response, 200, { messages: channel === 'world' ? log.world : log.alliance })
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
    json(response, 200, runtime.updateLlm(patch))
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
    if (body.faction !== undefined) patch.faction = asFaction(body.faction)
    json(response, 200, runtime.control(patch))
    return
  }

  if (method === 'POST' && path === '/api/step') {
    json(response, 200, runtime.step())
    return
  }

  if (method === 'POST' && path === '/api/world/reset') {
    const body = await readJson(request)
    const seed = typeof body.seed === 'number' ? body.seed : Number(body.seed)
    if (!Number.isFinite(seed) || seed <= 0) throw new HttpError(400, '种子必须是正数')
    json(response, 200, runtime.reset(seed))
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

  if ((method === 'GET' || method === 'HEAD') && !path.startsWith('/api')) {
    if (await serveStatic(CLIENT_DIR, path, method, response)) return
  }

  throw new HttpError(404, path.startsWith('/api') ? '接口不存在' : '资源不存在')
}

const server = createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    const status = error instanceof HttpError ? error.status : error instanceof BusyError ? 409 : 500
    const message = error instanceof Error ? error.message : '服务端错误'
    if (!response.headersSent) json(response, status, { error: message })
    else response.end()
  })
})

const heartbeat = setInterval(() => hub.heartbeat(), 15_000)

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
  hub.closeAll()
  server.close(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
