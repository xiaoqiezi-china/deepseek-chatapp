import http from 'node:http'
import * as fsp from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as store from './store.js'
import { checkRuntime, runCode, type RunLanguage } from './codeRunner.js'

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

const isHttpUrl = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 第三方 Chat Completions 代理：浏览器只访问同源 /api，本机服务负责转发并原样串流 SSE。
 * 这样第三方服务只需要允许本机 Node 访问，不再受浏览器 CORS 限制。
 */
async function proxyThirdParty(req: http.IncomingMessage, res: http.ServerResponse) {
  // 只接受应用自身发起的同站请求，避免浏览器里的第三方网页把本机服务当成开放代理。
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    sendJson(res, 403, { error: { message: 'Cross-site proxy request rejected' } })
    return
  }
  const body = (await readJsonBody(req)) as {
    url?: unknown
    apiKey?: unknown
    payload?: unknown
  }
  if (!isHttpUrl(body.url) || typeof body.apiKey !== 'string' || body.payload == null) {
    sendJson(res, 400, { error: { message: 'Invalid third-party proxy request' } })
    return
  }

  const controller = new AbortController()
  const onClose = () => {
    if (!res.writableEnded) controller.abort()
  }
  res.on('close', onClose)

  try {
    const upstream = await fetch(body.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${body.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body.payload),
      signal: controller.signal,
    })
    res.statusCode = upstream.status
    res.setHeader('X-DSH-Third-Party-Proxy', '1')
    const contentType = upstream.headers.get('content-type')
    if (contentType) res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    if (!upstream.body) {
      res.end(await upstream.text())
      return
    }

    const reader = upstream.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (res.destroyed) {
          await reader.cancel().catch(() => undefined)
          break
        }
        if (!res.write(Buffer.from(value))) {
          // 客户端断开时也要唤醒等待中的背压，否则代理线程会一直挂住。
          await new Promise<void>((resolve) => {
            const onReady = () => {
              res.off('drain', onReady)
              res.off('close', onReady)
              resolve()
            }
            res.once('drain', onReady)
            res.once('close', onReady)
          })
        }
      }
      res.end()
    } finally {
      reader.releaseLock()
    }
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      })
    } else if (!res.destroyed) {
      res.destroy()
    }
  } finally {
    res.off('close', onClose)
  }
}

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,PATCH,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

const isRunLanguage = (value: unknown): value is RunLanguage =>
  value === 'python' || value === 'js' || value === 'cmd'

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

    // Third-party Chat Completions proxy: keep the API key out of browser CORS preflights.
    if (p === '/third-party-proxy' && method === 'POST') {
      await proxyThirdParty(req, res)
      return
    }

    // Code execution: web UI delegates to the local Node process.
    if (p === '/runtime' && method === 'GET') {
      const language = url.searchParams.get('language')
      if (!isRunLanguage(language)) return sendJson(res, 400, { error: 'Invalid language' })
      return sendJson(res, 200, await checkRuntime(language))
    }
    if (p === '/run-code' && method === 'POST') {
      const body = await readJsonBody(req)
      if (!isRunLanguage(body?.language) || typeof body.code !== 'string') {
        return sendJson(res, 400, { error: 'Invalid run request' })
      }
      return sendJson(res, 200, await runCode(body.language, body.code))
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

    // 在系统文件管理器中打开数据目录（只允许打开固定的 data 目录）
    if (p === '/open-data-dir' && method === 'POST') {
      await fsp.mkdir(store.DATA_DIR, { recursive: true })
      const opener = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open'
      spawn(opener, [store.DATA_DIR], { detached: true, stdio: 'ignore' }).unref()
      return sendJson(res, 200, { ok: true })
    }

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
