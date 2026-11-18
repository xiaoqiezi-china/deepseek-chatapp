/**
 * Capacitor Android 存储注入：网页版与 Tauri 版不生效。
 * 使用 @capacitor/filesystem 的 Directory.Data 读写本地 JSON，不运行 HTTP 服务。
 */
type Json = Record<string, unknown>

type CapWindow = Window & {
  Capacitor?: { isNativePlatform?: () => boolean }
}

const win = typeof window === 'undefined' ? undefined : (window as CapWindow)

if (win?.Capacitor?.isNativePlatform?.()) {
  // 仅在 Android WebView 中按需加载插件，避免进入网页端主 bundle
  const { Filesystem: fs, Directory, Encoding } = await import('@capacitor/filesystem')
  const DIR = Directory.Data
  const root = 'chat-data'
  const pathOf = (path: string): string => root + path

  const isRecord = (value: unknown): value is Json =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

  const asString = (value: unknown): string => (typeof value === 'string' ? value : '')
  const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

  const readJson = async (path: string): Promise<unknown> => {
    try {
      const { data } = await fs.readFile({ path, directory: DIR, encoding: Encoding.UTF8 })
      return JSON.parse(String(data)) as unknown
    } catch {
      return null
    }
  }

  const writeJson = async (path: string, value: unknown): Promise<void> => {
    await fs.writeFile({
      path,
      directory: DIR,
      data: JSON.stringify(value),
      encoding: Encoding.UTF8,
      recursive: true,
    })
  }

  const listJson = async (dir: string): Promise<string[]> => {
    try {
      const { files } = await fs.readdir({ path: dir, directory: DIR })
      return files.map((entry) => entry.name).filter((name) => name.endsWith('.json'))
    } catch {
      return []
    }
  }

  const b64ToBytes = (text: string): Uint8Array => {
    const binary = atob(text)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }

  const bytesToB64 = (buffer: ArrayBuffer): string => {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    return btoa(binary)
  }

  const respond = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })

  const fileIdsOf = (session: Json): string[] => {
    const ids: string[] = []
    for (const message of asArray(session.messages)) {
      if (!isRecord(message) || message.role !== 'user') {
        continue
      }
      for (const file of asArray(message.files)) {
        if (isRecord(file)) {
          const id = asString(file.id)
          if (id && !ids.includes(id)) {
            ids.push(id)
          }
        }
      }
    }
    return ids
  }

  const summaryOf = (session: Json): Json => ({
    id: session.id,
    title: session.title ?? '',
    createdAt: session.createdAt ?? 0,
    updatedAt: session.updatedAt ?? 0,
    fileIds: fileIdsOf(session),
  })

  const publicSummary = (summary: Json): Json => ({
    id: summary.id,
    title: summary.title,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
  })

  const readSummaries = async (): Promise<Json[]> => {
    const stored = await readJson(pathOf('/summaries.json'))
    return Array.isArray(stored) ? stored.filter(isRecord) : []
  }

  const saveSession = async (session: Json): Promise<void> => {
    const id = asString(session.id)
    if (!id) {
      return
    }
    await writeJson(pathOf('/sessions/' + id + '.json'), session)
    const summaries = await readSummaries()
    const index = summaries.findIndex((item) => item.id === id)
    const summary = summaryOf(session)
    if (index >= 0) {
      summaries[index] = summary
    } else {
      summaries.push(summary)
    }
    await writeJson(pathOf('/summaries.json'), summaries)
  }

  const parseBody = (body: string | Blob | undefined): Json => {
    if (typeof body === 'string') {
      try {
        const parsed: unknown = JSON.parse(body)
        return isRecord(parsed) ? parsed : {}
      } catch {
        return {}
      }
    }
    return {}
  }

  win.__DSH_STORAGE_FETCH__ = async (path: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET'
    const parts = path.split('/').filter(Boolean)
    const body = init?.body as string | Blob | undefined
    const jsonBody = (): Json => parseBody(body)

    if (path === '/settings') {
      if (method === 'GET') {
        return respond(200, (await readJson(pathOf('/settings.json'))) ?? {})
      }
      if (method === 'PUT') {
        await writeJson(pathOf('/settings.json'), jsonBody())
        return respond(200, { ok: true })
      }
    }

    if (path === '/sessions' && method === 'GET') {
      const summaries = await readSummaries()
      return respond(200, summaries.map(publicSummary))
    }

    if (parts[0] === 'sessions' && parts.length === 2) {
      const id = parts[1]
      const file = pathOf('/sessions/' + id + '.json')
      if (method === 'GET') {
        const session = await readJson(file)
        return session ? respond(200, session) : respond(404, { error: 'not found' })
      }
      if (method === 'PUT' || method === 'POST') {
        const payload = jsonBody()
        const session = isRecord(payload.session) ? payload.session : payload
        await saveSession(session)
        return respond(200, { ok: true })
      }
      if (method === 'DELETE') {
        try {
          await fs.deleteFile({ path: file, directory: DIR })
        } catch {
          // 文件不存在时忽略
        }
        const summaries = (await readSummaries()).filter((item) => item.id !== id)
        await writeJson(pathOf('/summaries.json'), summaries)
        return respond(200, { ok: true })
      }
    }

    if (parts[0] === 'sessions' && parts.length === 3 && parts[2] === 'title' && method === 'PATCH') {
      const id = parts[1]
      const file = pathOf('/sessions/' + id + '.json')
      const stored = await readJson(file)
      if (isRecord(stored)) {
        const title = asString(jsonBody().title)
        stored.title = title
        await writeJson(file, stored)
        const summaries = await readSummaries()
        for (const summary of summaries) {
          if (summary.id === id) {
            summary.title = title
          }
        }
        await writeJson(pathOf('/summaries.json'), summaries)
      }
      return respond(200, { ok: true })
    }

    if (path === '/session-with-files' && method === 'POST') {
      const payload = jsonBody()
      for (const entry of asArray(payload.files)) {
        if (isRecord(entry)) {
          const id = asString(entry.id)
          const data = asString(entry.base64)
          if (id && data) {
            await fs.writeFile({
              path: pathOf('/files/' + id),
              directory: DIR,
              data,
              encoding: Encoding.UTF8,
              recursive: true,
            })
          }
        }
      }
      if (isRecord(payload.session)) {
        await saveSession(payload.session)
      }
      return respond(200, { ok: true })
    }

    if (parts[0] === 'files' && parts.length === 2) {
      const id = parts[1]
      const file = pathOf('/files/' + id)
      if (method === 'GET') {
        try {
          const { data } = await fs.readFile({ path: file, directory: DIR, encoding: Encoding.UTF8 })
          return new Response(b64ToBytes(String(data)).buffer as ArrayBuffer, { status: 200 })
        } catch {
          return respond(404, { error: 'not found' })
        }
      }
      if (method === 'PUT') {
        const blob = body as Blob
        const data = bytesToB64(await blob.arrayBuffer())
        await fs.writeFile({ path: file, directory: DIR, data, encoding: Encoding.UTF8, recursive: true })
        return respond(200, { ok: true })
      }
    }

    if (path === '/staging/clear' && method === 'POST') {
      for (const dir of [pathOf('/staging/sessions'), pathOf('/staging/files')]) {
        await fs.mkdir({ path: dir, directory: DIR, recursive: true })
      }
      return respond(200, { ok: true })
    }

    if (parts[0] === 'staging' && parts[1] === 'sessions' && parts.length === 3 && method === 'PUT') {
      await writeJson(pathOf('/staging/sessions/' + parts[2] + '.json'), jsonBody())
      return respond(200, { ok: true })
    }

    if (parts[0] === 'staging' && parts[1] === 'files' && parts.length === 3 && method === 'PUT') {
      const blob = body as Blob
      const data = bytesToB64(await blob.arrayBuffer())
      await fs.writeFile({
        path: pathOf('/staging/files/' + parts[2]),
        directory: DIR,
        data,
        encoding: Encoding.UTF8,
        recursive: true,
      })
      return respond(200, { ok: true })
    }

    if (path === '/staging/file-types' && method === 'POST') {
      return respond(200, { ok: true })
    }

    if (path === '/staging/commit' && method === 'POST') {
      const names = await listJson(pathOf('/staging/sessions'))
      const summaries: Json[] = []
      for (const name of names) {
        const staged = await readJson(pathOf('/staging/sessions/' + name))
        if (isRecord(staged)) {
          await writeJson(pathOf('/sessions/' + name), staged)
          summaries.push(summaryOf(staged))
        }
      }
      await writeJson(pathOf('/summaries.json'), summaries)
      return respond(200, summaries.map(publicSummary))
    }

    if (path === '/open-data-dir' && method === 'POST') {
      // Android 应用私有目录无法用系统文件管理器打开
      return respond(501, { error: 'unsupported' })
    }

    if (path === '/history/clear' && method === 'POST') {
      await writeJson(pathOf('/summaries.json'), [])
      return respond(200, { ok: true })
    }

    return respond(404, { error: 'unknown endpoint' })
  }
}

export {}
