import http from 'node:http'
import * as fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as store from './store.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DIST_DIR = path.join(root, 'dist')
const PORT = Number(process.env.PORT ?? 8091)

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
}

const sendJson = (res: http.ServerResponse, status: number, value: unknown) => {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

const readJsonBody = async (req: http.IncomingMessage): Promise<any> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > 50 * 1024 * 1024) throw new Error('Request too large')
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

const readBinaryBody = async (req: http.IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > 200 * 1024 * 1024) throw new Error('File too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,PATCH,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  let rel = decodeURIComponent(url.pathname)
  if (rel === '/' || !path.extname(rel)) rel = '/index.html'
  const file = path.join(DIST_DIR, rel.replace(/^\/+/, ''))
  // 阻止路径穿越
  if (!file.startsWith(DIST_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return
  }
  try {
    const body = await fsp.readFile(file)
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    // SPA 回退
    try {
      const html = await fsp.readFile(path.join(DIST_DIR, 'index.html'))
      res.writeHead(200, { 'Content-Type': MIME['.html'] })
      res.end(html)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not found. Run pnpm build first.')
    }
  }
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const method = req.method ?? 'GET'
  const p = url.pathname.replace(/^\/api/, '')
  const parts = p.split('/').filter(Boolean).map(decodeURIComponent)

  try {
    // Settings
    if (p === '/settings') {
      if (method === 'GET') return sendJson(res, 200, (await store.loadSettings()) ?? {})
      if (method === 'PUT') { await store.saveSettings(await readJsonBody(req)); return sendJson(res, 200, { ok: true }) }
    }

    // Sessions
    if (p === '/sessions' && method === 'GET') return sendJson(res, 200, await store.loadSessionSummaries())
    if (parts[0] === 'sessions' && parts.length === 2) {
      const id = parts[1]
      if (method === 'GET') {
        const session = await store.loadSession(id)
        return session ? sendJson(res, 200, session) : sendJson(res, 404, { error: 'Not found' })
      }
      if (method === 'PUT') { await store.saveSession(await readJsonBody(req), []); return sendJson(res, 200, { ok: true }) }
      if (method === 'DELETE') { await store.deleteSession(id); return sendJson(res, 200, { ok: true }) }
    }
    if (parts[0] === 'sessions' && parts.length === 3 && parts[2] === 'title' && method === 'PATCH') {
      const { title } = await readJsonBody(req)
      await store.renameSession(parts[1], String(title ?? ''))
      return sendJson(res, 200, { ok: true })
    }

    // Session with files (saveSession with blobs): multipart-ish JSON with base64 blobs
    if (p === '/session-with-files' && method === 'POST') {
      const body = await readJsonBody(req)
      const files = (body.files ?? []).map((f: any) => ({
        id: f.id,
        contentType: f.contentType,
        blob: Buffer.from(f.base64, 'base64'),
      }))
      await store.saveSession(body.session, files)
      return sendJson(res, 200, { ok: true })
    }

    // Files
    if (parts[0] === 'files' && parts.length === 2) {
      const id = parts[1]
      if (method === 'GET') {
        const file = await store.loadFile(id)
        if (!file) return sendJson(res, 404, { error: 'Not found' })
        res.writeHead(200, { 'Content-Type': file.contentType, 'Content-Length': file.blob.length })
        return res.end(file.blob)
      }
      if (method === 'PUT') {
        const blob = await readBinaryBody(req)
        const contentType = String(req.headers['content-type'] ?? 'application/octet-stream')
        await store.saveFile(id, blob, contentType)
        return sendJson(res, 200, { ok: true })
      }
    }

    // Staging
    if (p === '/staging/clear' && method === 'POST') { await store.clearStaging(); return sendJson(res, 200, { ok: true }) }
    if (parts[0] === 'staging' && parts[1] === 'sessions' && parts.length === 3 && method === 'PUT') {
      await store.addStagingSession(await readJsonBody(req))
      return sendJson(res, 200, { ok: true })
    }
    if (parts[0] === 'staging' && parts[1] === 'files' && parts.length === 3 && method === 'PUT') {
      const blob = await readBinaryBody(req)
      const contentType = String(req.headers['content-type'] ?? 'application/octet-stream')
      await store.saveStagingFile(parts[2], blob, contentType)
      return sendJson(res, 200, { ok: true })
    }
    if (p === '/staging/file-types' && method === 'POST') {
      await store.updateStagingFileTypes(await readJsonBody(req))
      return sendJson(res, 200, { ok: true })
    }
    if (p === '/staging/commit' && method === 'POST') {
      const summaries = await store.commitStaging()
      return sendJson(res, 200, summaries.map((s) => ({ id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt })))
    }

    // Clear all history
    if (p === '/history/clear' && method === 'POST') { await store.clearHistory(); return sendJson(res, 200, { ok: true }) }

    sendJson(res, 404, { error: 'Unknown endpoint', path: p })
  } catch (error) {
    console.error('[api]', method, p, error)
    if (!res.headersSent) sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

await store.initStore()

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  if (url.pathname.startsWith('/api/')) {
    void handleApi(req, res, url)
  } else {
    void serveStatic(req, res, url)
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log('chat-demo server listening on http://localhost:' + PORT)
  console.log('data dir:', store.DATA_DIR)
})
