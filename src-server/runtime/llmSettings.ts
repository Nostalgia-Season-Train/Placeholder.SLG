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
import type { LlmPatch, LlmStatusDTO } from '../../src-shared/protocol'

const SETTINGS_PATH = resolve('src-server/data/settings.json')

function envDefaults(): LlmConfig {
  return {
    baseUrl: process.env.SLG_LLM_BASE_URL?.trim() || DEFAULT_LLM_CONFIG.baseUrl,
    model: process.env.SLG_LLM_MODEL?.trim() || DEFAULT_LLM_CONFIG.model,
    apiKey: process.env.SLG_LLM_API_KEY?.trim() || '',
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
  }
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
  persist()
  return llmStatus()
}

export function createLlmClient(): LlmClient | null {
  return isLlmConfigured(config) ? new OpenAiCompatClient({ ...config }) : null
}
