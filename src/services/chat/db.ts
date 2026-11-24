import type { Session, SessionSummary } from './types.js'
import { storageFetch } from '../storage/bridge.js'

/** 与后端约定：附件原件按本地 id 存储，所有引用共用一份。 */
export type StoredFile = {
  id: string
  blob: Blob
}

const jsonRequest = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await storageFetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!response.ok) {
    throw new Error('storage ' + (init?.method ?? 'GET') + ' ' + path + ' failed: ' + response.status)
  }
  return (await response.json()) as T
}

const blobToBase64 = async (blob: Blob): Promise<string> => {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export const loadSessionSummaries = (): Promise<SessionSummary[]> =>
  jsonRequest<SessionSummary[]>('/sessions')

export const loadSession = async (id: string): Promise<Session | undefined> => {
  const response = await storageFetch('/sessions/' + encodeURIComponent(id))
  if (response.status === 404) { return undefined }
  if (!response.ok) { throw new Error('load session failed: ' + response.status) }
  return (await response.json()) as Session
}

/** 保存会话及新增附件原件：一次请求带上 base64 文件，避免多次往返。 */
export const saveSession = async (session: Session, files: StoredFile[] = []): Promise<void> => {
  const payload = {
    session,
    files: await Promise.all(
      files.map(async (file) => ({
        id: file.id,
        contentType: file.blob.type || 'application/octet-stream',
        base64: await blobToBase64(file.blob),
      }))
    ),
  }
  await jsonRequest('/session-with-files', { method: 'POST', body: JSON.stringify(payload) })
}

export const renameSession = async (id: string, title: string): Promise<void> => {
  await jsonRequest('/sessions/' + encodeURIComponent(id) + '/title', {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  })
}

export const deleteSession = async (sessionId: string): Promise<void> => {
  await jsonRequest('/sessions/' + encodeURIComponent(sessionId), { method: 'DELETE' })
}

const putFile = async (path: string, file: StoredFile): Promise<void> => {
  const response = await storageFetch(path, {
    method: 'PUT',
    headers: { 'Content-Type': file.blob.type || 'application/octet-stream' },
    body: file.blob,
  })
  if (!response.ok) { throw new Error('save file failed: ' + response.status) }
}

export const loadFile = async (id: string): Promise<Blob | undefined> => {
  const response = await storageFetch('/files/' + encodeURIComponent(id))
  if (response.status === 404) { return undefined }
  if (!response.ok) { throw new Error('load file failed: ' + response.status) }
  const type = response.headers.get('content-type') ?? 'application/octet-stream'
  return new Blob([await response.arrayBuffer()], { type })
}

// ---- 历史导入暂存 ----

export const clearStaging = async (): Promise<void> => {
  await jsonRequest('/staging/clear', { method: 'POST' })
}

export const addStagingSession = async (session: Session): Promise<void> => {
  await jsonRequest('/staging/sessions/' + encodeURIComponent(session.id), {
    method: 'PUT',
    body: JSON.stringify(session),
  })
}

export const saveStagingFiles = async (files: StoredFile[]): Promise<void> => {
  for (const file of files) {
    await putFile('/staging/files/' + encodeURIComponent(file.id), file)
  }
}

export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  await jsonRequest('/staging/file-types', {
    method: 'POST',
    body: JSON.stringify(Object.fromEntries(types)),
  })
}

export const commitStaging = (): Promise<SessionSummary[]> =>
  jsonRequest<SessionSummary[]>('/staging/commit', { method: 'POST' })

/** 本地存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[storage] ' + action + ' failed', error)
}
