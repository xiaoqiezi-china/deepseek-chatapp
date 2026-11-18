import { randomUUID } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const DATA_DIR = process.env.DSH_DATA_DIR
  ? path.resolve(process.env.DSH_DATA_DIR)
  : path.join(root, 'data')
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
const SUMMARIES_FILE = path.join(DATA_DIR, 'summaries.json')
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions')
const FILES_DIR = path.join(DATA_DIR, 'files')
const STAGING_DIR = path.join(DATA_DIR, 'staging')

type Summary = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  fileIds: string[]
}

const safeId = (id: string) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid id')
  return id
}

const exists = async (p: string) => {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

/** 原子写：先写临时文件再 rename，避免半写入。 */
const atomicWrite = async (file: string, data: string | Buffer) => {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + randomUUID().slice(0, 8)
  try {
    await fsp.writeFile(tmp, data)
    await fsp.rename(tmp, file)
  } catch (error) {
    await fsp.unlink(tmp).catch(() => {})
    throw error
  }
}

const readJson = async <T>(file: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

const saveJson = (file: string, value: unknown) =>
  atomicWrite(file, JSON.stringify(value, null, 2))

async function readSummaries(): Promise<Summary[]> {
  const value = await readJson<Summary[]>(SUMMARIES_FILE)
  return Array.isArray(value) ? value : []
}

/** 从会话文件重建摘要索引（索引缺失时自动调用）。 */
async function rebuildSummaries(dir = SESSIONS_DIR): Promise<Summary[]> {
  const summaries: Summary[] = []
  for (const name of await fsp.readdir(dir).catch(() => [])) {
    if (!name.endsWith('.json')) continue
    const session = await readJson<any>(path.join(dir, name))
    if (!session?.id) continue
    const fileIds = [
      ...new Set<string>(
        (session.messages ?? [])
          .filter((m: any) => m.role === 'user')
          .flatMap((m: any) => (m.files ?? []).map((f: any) => f.id))
      ),
    ]
    summaries.push({
      id: session.id,
      title: session.title ?? '',
      createdAt: session.createdAt ?? 0,
      updatedAt: session.updatedAt ?? 0,
      fileIds,
    })
  }
  await saveJson(SUMMARIES_FILE, summaries)
  return summaries
}

const fileIdsOf = (session: any): string[] => [
  ...new Set<string>(
    (session.messages ?? [])
      .filter((m: any) => m.role === 'user')
      .flatMap((m: any) => (m.files ?? []).map((f: any) => f.id))
  ),
]

// ---- 启动维护 ----
export async function initStore(): Promise<void> {
  await fsp.mkdir(SESSIONS_DIR, { recursive: true })
  await fsp.mkdir(FILES_DIR, { recursive: true })
  await fsp.mkdir(STAGING_DIR, { recursive: true })
  if (!(await exists(SUMMARIES_FILE))) await rebuildSummaries()

  // 清理遗留的 trash 目录与临时文件
  for (const base of [DATA_DIR, STAGING_DIR]) {
    for (const name of await fsp.readdir(base).catch(() => [])) {
      if (name.startsWith('.trash-') || name.includes('.tmp-')) {
        const p = path.join(base, name)
        await fsp.rm(p, { recursive: true, force: true }).catch(() => {})
      }
    }
  }

  // 广播式清理：删除无会话引用的孤儿附件
  const summaries = await readSummaries()
  const referenced = new Set(summaries.flatMap((s) => s.fileIds))
  for (const name of await fsp.readdir(FILES_DIR)) {
    if (name.endsWith('.meta.json') || name.includes('.tmp-')) continue
    if (!referenced.has(name)) {
      await fsp.unlink(path.join(FILES_DIR, name)).catch(() => {})
      await fsp.unlink(path.join(FILES_DIR, name + '.meta.json')).catch(() => {})
    }
  }
}

// ---- 设置 ----
export async function loadSettings(): Promise<Record<string, unknown> | null> {
  return (await readJson<Record<string, unknown>>(SETTINGS_FILE)) ?? null
}
export async function saveSettings(settings: Record<string, unknown>): Promise<void> {
  await saveJson(SETTINGS_FILE, settings)
}

// ---- 会话 ----
export async function loadSessionSummaries() {
  const summaries = await readSummaries()
  return summaries.map((s) => ({ id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt }))
}

export async function loadSession(id: string) {
  return readJson<any>(path.join(SESSIONS_DIR, safeId(id) + '.json'))
}

export async function saveSession(session: any, files: { id: string; blob: Buffer; contentType?: string }[]) {
  for (const file of files) {
    const id = safeId(file.id)
    await atomicWrite(path.join(FILES_DIR, id), file.blob)
    await atomicWrite(path.join(FILES_DIR, id + '.meta.json'), JSON.stringify({ contentType: file.contentType ?? 'application/octet-stream' }))
  }
  const id = safeId(session.id)
  await saveJson(path.join(SESSIONS_DIR, id + '.json'), session)
  const summaries = await readSummaries()
  const summary: Summary = {
    id,
    title: session.title ?? '',
    createdAt: session.createdAt ?? 0,
    updatedAt: session.updatedAt ?? 0,
    fileIds: fileIdsOf(session),
  }
  const index = summaries.findIndex((s) => s.id === id)
  if (index >= 0) summaries[index] = summary
  else summaries.push(summary)
  await saveJson(SUMMARIES_FILE, summaries)
}

export async function renameSession(id: string, title: string) {
  safeId(id)
  const session = await loadSession(id)
  if (!session) return
  session.title = title
  await saveJson(path.join(SESSIONS_DIR, id + '.json'), session)
  const summaries = await readSummaries()
  const index = summaries.findIndex((s) => s.id === id)
  if (index >= 0) {
    summaries[index].title = title
    await saveJson(SUMMARIES_FILE, summaries)
  }
}

export async function deleteSession(id: string) {
  safeId(id)
  const summaries = await readSummaries()
  const summary = summaries.find((s) => s.id === id)
  await fsp.unlink(path.join(SESSIONS_DIR, id + '.json')).catch(() => {})
  const remaining = summaries.filter((s) => s.id !== id)
  await saveJson(SUMMARIES_FILE, remaining)
  const stillUsed = new Set(remaining.flatMap((s) => s.fileIds))
  for (const fileId of summary?.fileIds ?? []) {
    if (!stillUsed.has(fileId)) {
      await fsp.unlink(path.join(FILES_DIR, fileId)).catch(() => {})
      await fsp.unlink(path.join(FILES_DIR, fileId + '.meta.json')).catch(() => {})
    }
  }
}

// ---- 附件原件 ----
export async function saveFile(id: string, blob: Buffer, contentType?: string) {
  safeId(id)
  await atomicWrite(path.join(FILES_DIR, id), blob)
  await atomicWrite(path.join(FILES_DIR, id + '.meta.json'), JSON.stringify({ contentType: contentType ?? 'application/octet-stream' }))
}
export async function loadFile(id: string) {
  const file = path.join(FILES_DIR, safeId(id))
  if (!(await exists(file))) return undefined
  const blob = await fsp.readFile(file)
  const meta = await readJson<{ contentType?: string }>(file + '.meta.json')
  return { blob, contentType: meta?.contentType ?? 'application/octet-stream' }
}

// ---- 导入暂存 ----
const stagingSessionFile = (id: string) => path.join(STAGING_DIR, 'sessions', safeId(id) + '.json')
const stagingFile = (id: string) => path.join(STAGING_DIR, 'files', safeId(id))


export async function clearStaging() {
  await fsp.rm(path.join(STAGING_DIR, 'sessions'), { recursive: true, force: true })
  await fsp.rm(path.join(STAGING_DIR, 'files'), { recursive: true, force: true })
  await fsp.mkdir(path.join(STAGING_DIR, 'sessions'), { recursive: true })
  await fsp.mkdir(path.join(STAGING_DIR, 'files'), { recursive: true })
}

export async function addStagingSession(session: any) {
  await fsp.mkdir(path.dirname(stagingSessionFile(session.id)), { recursive: true })
  await fsp.writeFile(stagingSessionFile(session.id), JSON.stringify(session, null, 2))
}

export async function saveStagingFile(id: string, blob: Buffer, contentType?: string) {
  await fsp.mkdir(path.dirname(stagingFile(id)), { recursive: true })
  await atomicWrite(stagingFile(id), blob)
  await atomicWrite(stagingFile(id) + '.meta.json', JSON.stringify({ contentType: contentType ?? 'application/octet-stream' }))
}

/** 导入时按会话 JSON 回填图片 MIME：原实现对 sessionsStaging 里的附件字段做原地修改。 */
export async function updateStagingFileTypes(types: Record<string, string>) {
  const dir = path.join(STAGING_DIR, 'sessions')
  for (const name of await fsp.readdir(dir).catch(() => [])) {
    if (!name.endsWith('.json')) continue
    const file = path.join(dir, name)
    const s = await readJson<any>(file)
    if (!s) continue
    let changed = false
    for (const m of s.messages ?? []) {
      if (m.role !== 'user') continue
      for (const f of m.files ?? []) {
        const type = types[f.id] ?? ''
        if (f.mimeType !== type) { f.mimeType = type; changed = true }
      }
    }
    if (changed) await fsp.writeFile(file, JSON.stringify(s, null, 2))
  }
}

/** 原子替换正式数据：旧目录移入 trash 后把暂存目录换位。 */
export async function commitStaging() {
  const trash = path.join(DATA_DIR, '.trash-' + Date.now() + '-' + randomUUID().slice(0, 6))
  await fsp.mkdir(trash, { recursive: true })
  for (const dir of [SESSIONS_DIR, FILES_DIR]) {
    if (await exists(dir)) await fsp.rename(dir, path.join(trash, path.basename(dir))).catch(() => {})
  }
  const stagedSessions = path.join(STAGING_DIR, 'sessions')
  const stagedFiles = path.join(STAGING_DIR, 'files')
  await fsp.rename(stagedSessions, SESSIONS_DIR).catch(() => fsp.mkdir(SESSIONS_DIR, { recursive: true }))
  await fsp.rename(stagedFiles, FILES_DIR).catch(() => fsp.mkdir(FILES_DIR, { recursive: true }))
  const summaries = await rebuildSummaries()
  await fsp.rm(trash, { recursive: true, force: true }).catch(() => {})
  return summaries
}

export async function clearHistory() {
  const trash = path.join(DATA_DIR, '.trash-' + Date.now() + '-' + randomUUID().slice(0, 6))
  await fsp.mkdir(trash, { recursive: true })
  for (const dir of [SESSIONS_DIR, FILES_DIR]) {
    if (await exists(dir)) await fsp.rename(dir, path.join(trash, path.basename(dir))).catch(() => {})
  }
  await fsp.mkdir(SESSIONS_DIR, { recursive: true })
  await fsp.mkdir(FILES_DIR, { recursive: true })
  await saveJson(SUMMARIES_FILE, [])
  await fsp.rm(trash, { recursive: true, force: true }).catch(() => {})
}
