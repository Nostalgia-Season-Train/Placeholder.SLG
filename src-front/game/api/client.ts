/**
 * Browser client for the authoritative game server.
 * Only transports state and commands — no game rules live here.
 */
import type { ChatChannel } from '../agent/chat'
import type { Faction } from '../bot/types'
import type {
  ChatResult,
  CommandResult,
  ControlPatch,
  GameStateDTO,
  LlmPatch,
  LlmStatusDTO,
  MapDTO,
  SaveListDTO,
  ServerEvent,
  SnapshotDTO,
  WorldDTO,
} from './protocol'

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

  step(): Promise<SnapshotDTO> {
    return request<SnapshotDTO>('/api/step', { method: 'POST', body: '{}' })
  }

  reset(seed: number): Promise<WorldDTO> {
    return request<WorldDTO>('/api/world/reset', { method: 'POST', body: JSON.stringify({ seed }) })
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
