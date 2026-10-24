/**
 * Browser client for the authoritative game server.
 * Only transports state and commands — no game rules live here.
 */
import type { ChatChannel } from '@shared/chat'
import type { Faction } from '@shared/types'
import type {
  CardCreateDTO,
  CardListDTO,
  ChatResult,
  CommandResult,
  ControlPatch,
  GameStateDTO,
  LlmPatch,
  LlmStatusDTO,
  LlmTestResult,
  MapDTO,
  SaveListDTO,
  ServerEvent,
  SnapshotDTO,
  WorldDTO,
} from '@shared/protocol'

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let message = text.trim()
    try {
      const parsed = JSON.parse(text) as { error?: string }
      if (typeof parsed.error === 'string') message = parsed.error
    } catch {
      /* keep the raw body when it is not JSON */
    }
    throw new Error(message || `HTTP ${response.status}`)
  }
  return (await response.json()) as T
}

export class WorldApi {
  getWorld(): Promise<WorldDTO> {
    return request<WorldDTO>('/api/world')
  }

  getMap(): Promise<MapDTO> {
    return request<MapDTO>('/api/map')
  }

  control(patch: ControlPatch): Promise<GameStateDTO> {
    return request<GameStateDTO>('/api/control', { method: 'POST', body: JSON.stringify(patch) })
  }

  reset(): Promise<WorldDTO> {
    return request<WorldDTO>('/api/world/reset', { method: 'POST', body: '{}' })
  }

  command(directive: string, faction: Faction): Promise<CommandResult> {
    return request<CommandResult>('/api/command', {
      method: 'POST',
      body: JSON.stringify({ directive, faction }),
    })
  }

  chat(channel: ChatChannel, text: string, faction: Faction): Promise<ChatResult> {
    return request<ChatResult>('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ channel, text, faction }),
    })
  }

  getLlm(): Promise<LlmStatusDTO> {
    return request<LlmStatusDTO>('/api/llm')
  }

  setLlm(patch: LlmPatch): Promise<LlmStatusDTO> {
    return request<LlmStatusDTO>('/api/llm', { method: 'PUT', body: JSON.stringify(patch) })
  }

  testLlm(): Promise<LlmTestResult> {
    return request<LlmTestResult>('/api/llm/test', { method: 'POST', body: '{}' })
  }

  listSaves(): Promise<SaveListDTO> {
    return request<SaveListDTO>('/api/saves')
  }

  createSave(label: string): Promise<SaveListDTO> {
    return request<SaveListDTO>('/api/saves', {
      method: 'POST',
      body: JSON.stringify({ label }),
    })
  }

  loadSave(id: string): Promise<WorldDTO> {
    return request<WorldDTO>(`/api/saves/${encodeURIComponent(id)}/load`, {
      method: 'POST',
      body: '{}',
    })
  }

  deleteSave(id: string): Promise<SaveListDTO> {
    return request<SaveListDTO>(`/api/saves/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  listCards(): Promise<CardListDTO> {
    return request<CardListDTO>('/api/cards')
  }

  createCard(payload: CardCreateDTO): Promise<CardListDTO> {
    return request<CardListDTO>('/api/cards', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  subscribe(onEvent: (event: ServerEvent) => void, onError?: () => void): EventSource {
    const source = new EventSource('/api/events')
    source.onmessage = (message) => {
      try {
        onEvent(JSON.parse(message.data) as ServerEvent)
      } catch {
        /* ignore malformed frames and keep the stream alive */
      }
    }
    source.onerror = () => onError?.()
    return source
  }
}
