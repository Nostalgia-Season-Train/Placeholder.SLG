/**
 * Static hosting for the built frontend: serves files from the build directory
 * and falls back to index.html for client-side routes.
 */
import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import type { ServerResponse } from 'node:http'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
}

/** Resolve a URL path inside the build directory, refusing traversal outside it */
function resolveFile(root: string, pathname: string): string | null {
  let relative: string
  try {
    relative = decodeURIComponent(pathname).replace(/^\/+/, '')
  } catch {
    return null
  }

  const target = resolve(root, relative)
  if (target !== root && !target.startsWith(root + sep)) return null
  return target
}

async function sendFile(
  file: string,
  path: string,
  method: string,
  response: ServerResponse,
): Promise<void> {
  const info = await stat(file)
  const headers = {
    'Content-Type': MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': path.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  }
  response.writeHead(200, headers)
  if (method === 'HEAD') {
    response.end()
    return
  }
  response.end(await readFile(file))
}

/**
 * Handle a request against the built frontend.
 * Returns false when the path is not a client asset, so the caller can 404.
 */
export async function serveStatic(
  root: string,
  pathname: string,
  method: string,
  response: ServerResponse,
): Promise<boolean> {
  const rootDir = resolve(root)
  const target = resolveFile(rootDir, pathname)
  if (target === null) return false

  const info = await stat(target).catch(() => null)
  if (info?.isFile()) {
    await sendFile(target, pathname, method, response)
    return true
  }

  // Requests with a file extension are missing assets, not client routes
  if (extname(target)) return false

  const index = join(rootDir, 'index.html')
  const indexInfo = await stat(index).catch(() => null)
  if (!indexInfo?.isFile()) return false

  await sendFile(index, '/', method, response)
  return true
}
