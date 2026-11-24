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

  const tempPath = (path: string): string =>
    path + '.tmp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)

  const tempSuffixPattern = /\.tmp-[a-z0-9]+-[a-z0-9]+$/

  /** Android 的 Filesystem.rename 在目标存在时会先删除目标再 rename，不是真正原子操作。 */
  type FileEncoding = (typeof Encoding)[keyof typeof Encoding]

  /** 先写唯一临时文件再 rename，避免后台被杀时留下半个 JSON。 */
  const writeFileAtomic = async (path: string, data: string, encoding: FileEncoding): Promise<void> => {
    const tmp = tempPath(path)
    // 失败时不能删除 temp：Android 的 rename 会先删除目标再 rename，
    // 如果 rename 失败或进程在中间被杀，temp 是唯一还能恢复的数据。
    await fs.writeFile({ path: tmp, directory: DIR, data, encoding, recursive: true })
    await fs.rename({ from: tmp, to: path, directory: DIR, toDirectory: DIR })
  }

  const writeJson = async (path: string, value: unknown): Promise<void> => {
    await writeFileAtomic(path, JSON.stringify(value), Encoding.UTF8)
  }

  const listAll = async (dir: string): Promise<string[]> => {
    try {
      const { files } = await fs.readdir({ path: dir, directory: DIR })
      return files.map((entry) => entry.name)
    } catch {
      return []
    }
  }

  const deleteTempQuietly = async (path: string): Promise<void> => {
    try {
      await fs.deleteFile({ path, directory: DIR })
    } catch {
      // 临时文件不存在时忽略
    }
  }

  const deleteSessionTemps = async (id: string): Promise<void> => {
    const prefix = id + '.json.tmp-'
    for (const name of await listAll(pathOf('/sessions'))) {
      if (name.startsWith(prefix)) {
        await deleteTempQuietly(pathOf('/sessions/' + name))
      }
    }
  }

  const promoteTemp = async (temp: string, target: string): Promise<void> => {
    try {
      await fs.rename({ from: temp, to: target, directory: DIR, toDirectory: DIR })
    } catch {
      // 目标暂时不可写时保留临时文件，下次启动会再尝试恢复
    }
  }

  /** rename 删掉目标后进程被杀，会留下完整的 temp；启动时把它补回最终文件。 */
  const recoverTemporaryFiles = async (): Promise<void> => {
    const rootNames = await listAll(root)
    for (const name of rootNames) {
      if (!name.startsWith('summaries.json') || !tempSuffixPattern.test(name)) {
        continue
      }
      const temp = pathOf('/' + name)
      const target = pathOf('/summaries.json')
      const tempValue = await readJson(temp)
      const targetValue = await readJson(target)
      if (Array.isArray(tempValue) && !Array.isArray(targetValue)) {
        await promoteTemp(temp, target)
      } else {
        await deleteTempQuietly(temp)
      }
    }

    const sessionNames = await listAll(pathOf('/sessions'))
    for (const name of sessionNames) {
      const match = name.match(tempSuffixPattern)
      if (!match) {
        continue
      }
      const targetName = name.slice(0, match.index ?? 0)
      if (!targetName.endsWith('.json')) {
        await deleteTempQuietly(pathOf('/sessions/' + name))
        continue
      }
      const id = targetName.slice(0, -5)
      const temp = pathOf('/sessions/' + name)
      const target = pathOf('/sessions/' + targetName)
      const tempValue = await readJson(temp)
      const targetValue = await readJson(target)
      const isSession = (value: unknown): value is Json =>
        isRecord(value) && asString(value.id) === id && Array.isArray(value.messages)
      if (!isSession(tempValue)) {
        await deleteTempQuietly(temp)
        continue
      }
      if (isSession(targetValue)) {
        // 目标文件仍然完整时以目标为准；temp 可能只是上一次重命名失败留下的旧快照。
        await deleteTempQuietly(temp)
      } else {
        await promoteTemp(temp, target)
      }
    }
  }

  let tempRecoveryTask: Promise<void> | undefined
  const ensureTempRecovery = (): Promise<void> => {
    tempRecoveryTask ??= recoverTemporaryFiles()
    return tempRecoveryTask
  }

  const listJson = async (dir: string): Promise<string[]> => {
    return (await listAll(dir)).filter((name) => name.endsWith('.json'))
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

  const readStoredSummaries = async (): Promise<Json[] | null> => {
    const stored = await readJson(pathOf('/summaries.json'))
    return Array.isArray(stored) ? stored.filter(isRecord) : null
  }

  /** 所有会改摘要索引的操作串行执行，避免并发保存互相覆盖。 */
  let summariesQueue: Promise<void> = Promise.resolve()
  const withSummaries = <T>(task: () => Promise<T>): Promise<T> => {
    const run = summariesQueue.then(task, task)
    summariesQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  const rebuildSummariesUnlocked = async (): Promise<Json[]> => {
    const summaries: Json[] = []
    for (const name of await listJson(pathOf('/sessions'))) {
      const session = await readJson(pathOf('/sessions/' + name))
      if (isRecord(session)) {
        summaries.push(summaryOf(session))
      }
    }
    await writeJson(pathOf('/summaries.json'), summaries)
    return summaries
  }

  /** 只有摘要与磁盘会话不一致时才重建，正常情况下只比对 ID。 */
  const ensureSummariesUnlocked = async (): Promise<Json[]> => {
    await ensureTempRecovery()
    const names = await listJson(pathOf('/sessions'))
    const ids = names.map((name) => name.slice(0, -5))
    const stored = await readStoredSummaries()
    if (stored && stored.length === ids.length) {
      const storedIds = new Set(stored.map((summary) => asString(summary.id)))
      if (storedIds.size === stored.length && ids.every((id) => storedIds.has(id))) {
        return stored
      }
    }
    return rebuildSummariesUnlocked()
  }

  const ensureSummaries = (): Promise<Json[]> => withSummaries(ensureSummariesUnlocked)

  const saveSession = async (session: Json): Promise<void> => {
    const id = asString(session.id)
    if (!id) {
      return
    }
    await writeJson(pathOf('/sessions/' + id + '.json'), session)
    await withSummaries(async () => {
      const summaries = await ensureSummariesUnlocked()
      const index = summaries.findIndex((item) => item.id === id)
      const summary = summaryOf(session)
      if (index >= 0) {
        summaries[index] = summary
      } else {
        summaries.push(summary)
      }
      await writeJson(pathOf('/summaries.json'), summaries)
    })
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
    await ensureTempRecovery()
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
      const summaries = await ensureSummaries()
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
        await withSummaries(async () => {
          try {
            await fs.deleteFile({ path: file, directory: DIR })
          } catch {
            // 文件不存在时忽略
          }
          await deleteSessionTemps(id)
          const summaries = (await ensureSummariesUnlocked()).filter((item) => item.id !== id)
          await writeJson(pathOf('/summaries.json'), summaries)
        })
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
        await withSummaries(async () => {
          const summaries = await ensureSummariesUnlocked()
          for (const summary of summaries) {
            if (summary.id === id) {
              summary.title = title
            }
          }
          await writeJson(pathOf('/summaries.json'), summaries)
        })
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
            await writeFileAtomic(pathOf('/files/' + id), data, Encoding.UTF8)
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
        await writeFileAtomic(file, data, Encoding.UTF8)
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
      await writeFileAtomic(pathOf('/staging/files/' + parts[2]), data, Encoding.UTF8)
      return respond(200, { ok: true })
    }

    if (path === '/staging/file-types' && method === 'POST') {
      return respond(200, { ok: true })
    }

    if (path === '/staging/commit' && method === 'POST') {
      const summaries = await withSummaries(async () => {
        const names = await listJson(pathOf('/staging/sessions'))
        const out: Json[] = []
        for (const name of names) {
          const staged = await readJson(pathOf('/staging/sessions/' + name))
          if (isRecord(staged)) {
            await writeJson(pathOf('/sessions/' + name), staged)
            out.push(summaryOf(staged))
          }
        }
        await writeJson(pathOf('/summaries.json'), out)
        return out
      })
      return respond(200, summaries.map(publicSummary))
    }

    if (path === '/open-data-dir' && method === 'POST') {
      // Android 应用私有目录无法用系统文件管理器打开
      return respond(501, { error: 'unsupported' })
    }

    if (path === '/history/clear' && method === 'POST') {
      await withSummaries(async () => {
        await writeJson(pathOf('/summaries.json'), [])
      })
      return respond(200, { ok: true })
    }

    return respond(404, { error: 'unknown endpoint' })
  }
}

export {}
