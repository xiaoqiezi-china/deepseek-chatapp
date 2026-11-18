/**
 * 自动更新：
 * - 桌面端：Tauri updater（endpoints 配置多个源，依次兜底）
 * - Android：并行探测镜像源，取最快可用源读取更新信息并下载 APK
 * - 网页版：不支持
 */
type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown }
type CapWindow = Window & {
  Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string }
}

const REPO = 'xiaoqiezi-china/deepseek-chatapp'
const LATEST_JSON = `https://github.com/${REPO}/releases/latest/download/latest.json`

/** 常见 GitHub 加速镜像；空前缀表示直连 */
export const MIRRORS: { name: string; prefix: string }[] = [
  { name: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' },
  { name: 'ghfast.top', prefix: 'https://ghfast.top/' },
  { name: 'ghproxy.net', prefix: 'https://ghproxy.net/' },
  { name: 'github', prefix: '' },
]

const mirrorUrl = (prefix: string, url: string): string => (prefix ? prefix + url : url)

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
  | { status: 'available'; version: string; notes: string; downloadUrl: string; source: string }
  | { status: 'latest'; source: string }

/** 比较 a.b.c 版本号，返回 -1 / 0 / 1 */
export const compareVersion = (left: string, right: string): number => {
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

type Manifest = {
  version?: string
  notes?: string
  platforms?: Record<string, { url?: string }>
}

/** 并行探测各镜像的连通性与耗时，返回按耗时升序的可用源 */
export const probeMirrors = async (
  timeoutMs = 8000
): Promise<{ name: string; url: string; ms: number; manifest: Manifest }[]> => {
  const tasks = MIRRORS.map(async (mirror) => {
    const url = mirrorUrl(mirror.prefix, LATEST_JSON)
    const start = performance.now()
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) {
      throw new Error(mirror.name + ' status ' + response.status)
    }
    const manifest = (await response.json()) as Manifest
    return { name: mirror.name, url, ms: Math.round(performance.now() - start), manifest }
  })
  const settled = await Promise.allSettled(tasks)
  return settled
    .filter((item): item is PromiseFulfilledResult<{ name: string; url: string; ms: number; manifest: Manifest }> =>
      item.status === 'fulfilled'
    )
    .map((item) => item.value)
    .sort((a, b) => a.ms - b.ms)
}

/** 查询是否有新版本 */
export const checkForUpdate = async (): Promise<UpdateCheck> => {
  if (isTauri()) {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (!update) {
      return { status: 'latest', source: 'tauri' }
    }
    return {
      status: 'available',
      version: update.version,
      notes: update.body ?? '',
      downloadUrl: '',
      source: 'tauri',
    }
  }

  if (isAndroid()) {
    const { registerPlugin } = await import('@capacitor/core')
    const plugin = registerPlugin<{ getVersion(): Promise<{ version: string }> }>('AppUpdater')
    const current = (await plugin.getVersion()).version
    const sources = await probeMirrors()
    if (sources.length === 0) {
      throw new Error('all mirrors unreachable')
    }
    // 取最快的可用源；若其清单缺少 APK，继续尝试其他源
    for (const source of sources) {
      const latest = (source.manifest.version ?? '').trim()
      const apkUrl = source.manifest.platforms?.android?.url
      if (!latest || !apkUrl) {
        continue
      }
      if (compareVersion(latest, current) > 0) {
        return {
          status: 'available',
          version: latest,
          notes: source.manifest.notes ?? '',
          downloadUrl: apkUrl,
          source: source.name,
        }
      }
      return { status: 'latest', source: source.name }
    }
    throw new Error('no usable manifest')
  }

  throw new Error('updater not supported')
}

/** 下载并安装更新 */
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
    const plugin = registerPlugin<{ downloadAndInstall(options: { url: string }): Promise<void> }>(
      'AppUpdater'
    )
    await plugin.downloadAndInstall({ url: downloadUrl })
    return
  }

  throw new Error('updater not supported')
}
