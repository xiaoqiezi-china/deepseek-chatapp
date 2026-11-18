/**
 * 自动更新：桌面端通过 Tauri updater 从 GitHub Releases 获取最新版本。
 * 网页版和 Android 不支持，相关入口不展示。
 */
type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown }

/** 当前环境是否支持自动更新（仅 Tauri 桌面端） */
export const isUpdaterSupported = (): boolean =>
  typeof window !== 'undefined' && !!((window as TauriWindow).__TAURI_INTERNALS__)

export type UpdateCheck =
  | { status: 'available'; version: string; notes: string; date: string | null }
  | { status: 'latest' }

/** 查询 GitHub Releases 上是否有新版本 */
export const checkForUpdate = async (): Promise<UpdateCheck> => {
  const { check } = await import('@tauri-apps/plugin-updater')
  const update = await check()
  if (!update) {
    return { status: 'latest' }
  }
  return {
    status: 'available',
    version: update.version,
    notes: update.body ?? '',
    date: update.date ?? null,
  }
}

/** 下载并安装更新，完成后重启应用。progress 为 0-100 的百分比。 */
export const downloadAndInstallUpdate = async (
  onProgress?: (percent: number) => void
): Promise<void> => {
  const { check } = await import('@tauri-apps/plugin-updater')
  const { relaunch } = await import('@tauri-apps/plugin-process')
  const update = await check()
  if (!update) {
    return
  }
  let total = 0
  let downloaded = 0
  await update.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      total = event.data.contentLength ?? 0
    } else if (event.event === 'Progress') {
      downloaded += event.data.chunkLength
      if (total > 0) {
        onProgress?.(Math.min(100, Math.round((downloaded / total) * 100)))
      }
    }
  })
  await relaunch()
}
