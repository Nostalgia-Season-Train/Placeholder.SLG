/**
 * LLM transport for the commander agent.
 * Any OpenAI-compatible chat completion endpoint works; configuration is held by the server.
 */
export interface LlmConfig {
  baseUrl: string
  model: string
  apiKey: string
  mode: 'live' | 'mock'
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
  mode: 'live',
}

/** A key is required unless the endpoint is local */
export function isLlmConfigured(config: LlmConfig): boolean {
  if (config.mode === 'mock') return true
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

      let response: Response
      try {
        response = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            model: this.config.model,
            messages,
            temperature: 0.4,
            // 关闭思考模式：思考 token 不进入回复，只会拉长等待
            thinking: { type: 'disabled' },
            // 限制回复长度：角色发言只需一两句话，长文生成是延迟的主要来源
            max_tokens: 240,
          }),
        })
      } catch (error) {
        if (controller.signal.aborted) throw new Error('LLM 请求超时（30 秒未返回）')
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`无法连接 LLM 接口：${reason}`)
      }

      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).trim().slice(0, 160)
        throw new Error(`LLM 请求失败：HTTP ${response.status}${detail ? ` ${detail}` : ''}`)
      }

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
