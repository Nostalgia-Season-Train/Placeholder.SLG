/**
 * Server-sent events hub: one stream per connected browser.
 */
import type { ServerResponse } from 'node:http'
import type { ServerEvent } from '../../src/game/api/protocol'

export class SseHub {
  private readonly clients = new Set<ServerResponse>()

  add(response: ServerResponse): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    response.write(': connected\n\n')
    this.clients.add(response)
    response.on('close', () => this.clients.delete(response))
  }

  broadcast(event: ServerEvent): void {
    const frame = `data: ${JSON.stringify(event)}\n\n`
    for (const client of this.clients) client.write(frame)
  }

  heartbeat(): void {
    for (const client of this.clients) client.write(': ping\n\n')
  }

  closeAll(): void {
    for (const client of this.clients) client.end()
    this.clients.clear()
  }
}
