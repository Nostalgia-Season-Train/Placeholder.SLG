/**
 * Server-side LLM configuration: environment defaults plus a gitignored JSON file.
 * Keys never leave this process.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  DEFAULT_LLM_CONFIG,
  OpenAiCompatClient,
  isLlmConfigured,
  type LlmClient,
  type LlmConfig,
} from '../game/agent/llm'
import type { LlmPatch, LlmStatusDTO, LlmTestResult } from '../../src-shared/protocol'

const SETTINGS_PATH = resolve('src-server/data/settings.json')

function envDefaults(): LlmConfig {
  return {
    baseUrl: process.env.SLG_LLM_BASE_URL?.trim() || DEFAULT_LLM_CONFIG.baseUrl,
    model: process.env.SLG_LLM_MODEL?.trim() || DEFAULT_LLM_CONFIG.model,
    apiKey: process.env.SLG_LLM_API_KEY?.trim() || '',
    mode: 'live',
  }
}

function readStored(): Partial<LlmConfig> {
  try {
    if (!existsSync(SETTINGS_PATH)) return {}
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')) as { llm?: Partial<LlmConfig> }
    return raw.llm ?? {}
  } catch {
    return {}
  }
}

let config: LlmConfig = { ...envDefaults(), ...readStored() }
if (config.mode !== 'live' && config.mode !== 'mock') config.mode = 'live'

/** 最近一次真实接口调用失败的原因；成功的调用会清空 */
let lastError: string | null = null

function persist(): void {
  try {
    mkdirSync(dirname(SETTINGS_PATH), { recursive: true })
    writeFileSync(SETTINGS_PATH, JSON.stringify({ llm: config }, null, 2), 'utf8')
  } catch {
    /* settings stay in memory when the file cannot be written */
  }
}

export function getLlmConfig(): LlmConfig {
  return { ...config }
}

export function llmStatus(): LlmStatusDTO {
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    hasApiKey: Boolean(config.apiKey),
    configured: isLlmConfigured(config),
    mode: config.mode,
    lastError,
  }
}

export function llmError(): string | null {
  return lastError
}

export function updateLlm(patch: LlmPatch): LlmStatusDTO {
  if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) {
    config.baseUrl = patch.baseUrl.trim()
  }
  if (typeof patch.model === 'string' && patch.model.trim()) {
    config.model = patch.model.trim()
  }
  if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
    config.apiKey = patch.apiKey.trim()
  }
  if (patch.mode === 'live' || patch.mode === 'mock') {
    config.mode = patch.mode
  }
  lastError = null
  persist()
  return llmStatus()
}

/** 真实接口调用失败时记录原因，成功后清空 */
function noteResult(error: unknown): void {
  lastError = error ? (error instanceof Error ? error.message : String(error)) : null
}

/** 包一层记录调用结果，供界面显示连接错误 */
class ReportingClient implements LlmClient {
  readonly kind = 'llm'
  private readonly inner: LlmClient

  constructor(inner: LlmClient) {
    this.inner = inner
  }

  async complete(messages: Parameters<LlmClient['complete']>[0]): Promise<string> {
    try {
      const text = await this.inner.complete(messages)
      noteResult(null)
      return text
    } catch (error) {
      noteResult(error)
      throw error
    }
  }
}

export function createLlmClient(): LlmClient | null {
  if (config.mode === 'mock' || !isLlmConfigured(config)) return null
  return new ReportingClient(new OpenAiCompatClient({ ...config }))
}

/** 用一次最小请求验证接口可达；模拟模式下无需联网 */
export async function testLlmConnection(): Promise<LlmTestResult> {
  if (config.mode === 'mock') return { ok: true, error: null }
  const client = createLlmClient()
  if (!client) return { ok: false, error: '尚未填写 apiKey，无法连接 LLM 接口' }
  try {
    await client.complete([{ role: 'user', content: 'ping' }])
    return { ok: true, error: null }
  } catch (error) {
    noteResult(error)
    return { ok: false, error: error instanceof Error ? error.message : 'LLM 连接失败' }
  }
}
