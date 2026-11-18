import type { Session, SessionSummary } from '../chat/types.js'

/** 附件原件与媒体类型，写入存储层的最小单元 */
export type StoredFile = {
  id: string
  blob: Blob
  contentType?: string
}

/**
 * 存储后端接口：网页端走 HTTP（server/storageApi.ts），
 * 桌面端与手机端后续可换 Electron IPC / Capacitor 插件实现，UI 层无需改动。
 */
export interface StorageBackend {
  loadSettings(): Promise<Record<string, unknown> | null>
  saveSettings(settings: Record<string, unknown>): Promise<void>

  loadSessionSummaries(): Promise<SessionSummary[]>
  loadSession(id: string): Promise<Session | undefined>
  saveSession(session: Session, files: StoredFile[]): Promise<void>
  renameSession(id: string, title: string): Promise<void>
  deleteSession(id: string): Promise<void>

  saveFiles(files: StoredFile[]): Promise<void>
  loadFile(id: string): Promise<Blob | undefined>

  clearStaging(): Promise<void>
  addStagingSession(session: Session): Promise<void>
  saveStagingFiles(files: StoredFile[]): Promise<void>
  updateStagingFileTypes(types: ReadonlyMap<string, string>): Promise<void>
  commitStaging(): Promise<SessionSummary[]>
  clearHistory(): Promise<void>
}
