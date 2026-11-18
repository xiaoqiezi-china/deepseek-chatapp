/**
 * 自动更新：
 * - 桌面端：Tauri updater 从 GitHub Releases 拉取 latest.json
 * - Android：GitHub API 查询最新 Release，应用内下载 APK 并拉起系统安装器
 * - 网页版：不支持
 */
type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown }
type CapWindow = Window & {
  Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string }
}

const REPO = 'xiaoqiezi-china/deepseek-chatapp'

const isTauri = (): boolean =>
  typeof window !== 'undefined' && !!((window as TauriWindow).__TAURI_INTERNALS__)

const isAndroid = (): boolean => {
  if (typeof window === 'undefined') {
    return false
  }
  const cap = (window as CapWindow).Capacitor
  return cap?.isNativePlatform?.() === true && cap?.getPlatform?.() === 'android'
}

/** 当前环境是否支持应用内更新 */
export const isUpdaterSupported = (): boolean => isTauri() || isAndroid()

export type UpdateCheck =
  | { status: 'available'; version: string; notes: string; downloadUrl: string }
  | { status: 'latest' }

type AppUpdaterPlugin = {
  getVersion(): Promise<{ version: string }>
  downloadAndInstall(options: { url: string }): Promise<void>
}

/** 比较 a.b.c 形式的版本号，返回 -1 / 0 / 1 */
const compareVersion = (left: string, right: string): number => {
  const parse = (value: string): number[] =>
    value
      .split(/[.-]/)
      .map((part) => Number.parseInt(part, 10))
      .filter((part) => Number.isFinite(part))
  const a = parse(left)
  const b = parse(right)
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) {
      return diff > 0 ? 1 : -1
    }
  }
  return 0
}

/** 查询是否有新版本 */
export const checkForUpdate = async (): Promise<UpdateCheck> => {
  if (isTauri()) {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (!update) {
      return { status: 'latest' }
    }
    return {
      status: 'available',
      version: update.version,
      notes: update.body ?? '',
      downloadUrl: '',
    }
  }

  if (isAndroid()) {
    const { registerPlugin } = await import('@capacitor/core')
    const plugin = registerPlugin<AppUpdaterPlugin>('AppUpdater')
    const current = (await plugin.getVersion()).version
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (!response.ok) {
      throw new Error('github api ' + response.status)
    }
    const release = (await response.json()) as {
      tag_name?: string
      body?: string
      assets?: { name: string; browser_download_url: string }[]
    }
    const latest = (release.tag_name ?? '').replace(/^v/, '')
    const asset = release.assets?.find((item) => item.name.endsWith('.apk'))
    if (!latest || !asset) {
      throw new Error('no apk asset in release')
    }
    if (compareVersion(latest, current) > 0) {
      return {
        status: 'available',
        version: latest,
        notes: release.body ?? '',
        downloadUrl: asset.browser_download_url,
      }
    }
    return { status: 'latest' }
  }

  throw new Error('updater not supported')
}

/** 下载并安装更新；桌面端完成后自动重启，Android 拉起系统安装器 */
export const installUpdate = async (
  downloadUrl: string,
  onProgress?: (percent: number) => void
): Promise<void> => {
  if (isTauri()) {
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
    return
  }

  if (isAndroid()) {
    const { registerPlugin } = await import('@capacitor/core')
    const plugin = registerPlugin<AppUpdaterPlugin>('AppUpdater')
    await plugin.downloadAndInstall({ url: downloadUrl })
    return
  }

  throw new Error('updater not supported')
}
