/**
 * LLM transport for the commander agent.
 * Any OpenAI-compatible chat completion endpoint works; configuration is held by the server.
 */
export interface LlmConfig {
  baseUrl: string
  model: string
  apiKey: string
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmClient {
  readonly kind: string
  complete(messages: LlmMessage[]): Promise<string>
}

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: '',
}

/** A key is required unless the endpoint is local */
export function isLlmConfigured(config: LlmConfig): boolean {
  if (!config.model.trim() || !config.baseUrl.trim()) return false
  if (config.apiKey.trim()) return true
  return /localhost|127\.0\.0\.1/.test(config.baseUrl)
}

export class OpenAiCompatClient implements LlmClient {
  readonly kind = 'llm'
  private readonly config: LlmConfig

  constructor(config: LlmConfig) {
    this.config = config
  }

  async complete(messages: LlmMessage[]): Promise<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (this.config.apiKey.trim()) headers.Authorization = `Bearer ${this.config.apiKey.trim()}`

      const response = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: this.config.model,
          messages,
          temperature: 0.4,
        }),
      })

      if (!response.ok) throw new Error(`LLM 请求失败：HTTP ${response.status}`)

      const data = (await response.json()) as {
        choices?: { message?: { content?: string } }[]
      }
      const content = data.choices?.[0]?.message?.content
      if (!content) throw new Error('LLM 未返回内容')
      return content
    } finally {
      clearTimeout(timeout)
    }
  }
}
