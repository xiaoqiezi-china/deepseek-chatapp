// Tauri WebView 存储注入：网页版不生效，由 server 处理 /api。
// 通过 Tauri v2 内部 IPC 调用 Rust 的 storage_request，不启动 HTTP 服务。
type RawResp = { status: number; body: unknown }

const internals = (
  typeof window === 'undefined' ? undefined : (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
) as { invoke?: (cmd: string, args: Record<string, unknown>) => Promise<RawResp> } | undefined

if (internals?.invoke) {
  const invoke = internals.invoke

  const encodeBase64 = async (buf: ArrayBuffer): Promise<string> => {
    const bytes = new Uint8Array(buf)
    let binary = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    return btoa(binary)
  }

  const decodeBase64 = (s: string): Uint8Array => {
    const binary = atob(s)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }

  const toResponse = (raw: RawResp, isFile: boolean): Response => {
    const { status, body } = raw
    if (status >= 400) {
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    }
    if (isFile && body && typeof body === 'object' && 'base64' in body) {
      const b = body as { base64: string; contentType: string }
      return new Response(decodeBase64(b.base64).buffer as ArrayBuffer, {
        status: 200,
        headers: { 'Content-Type': b.contentType },
      })
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  window.__DSH_STORAGE_FETCH__ = async (path: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET'
    const isFilePut = method === 'PUT' && path.includes('/files/')
    const isFileGet = method === 'GET' && path.includes('/files/')
    let body: string | undefined
    let contentType: string | undefined
    if (init?.body != null) {
      if (isFilePut) {
        const blob = init.body as Blob
        contentType = blob.type || 'application/octet-stream'
        body = await encodeBase64(await blob.arrayBuffer())
      } else {
        body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body)
        contentType = 'application/json'
      }
    }
    const raw = await invoke('storage_request', { method, path, body, contentType })
    return toResponse(raw, isFileGet)
  }
}

// 窗口默认隐藏，首帧渲染后显示，避免启动白屏；兜底 2 秒强制显示。
let revealed = false
const reveal = () => {
  if (revealed) {
    return
  }
  revealed = true
  void internals?.invoke?.('report_startup', { navMs: Math.round(performance.now()) })
  void internals?.invoke?.('plugin:window|show', { label: 'main' })
}
window.__DSH_REVEAL__ = reveal
setTimeout(reveal, 2000)
