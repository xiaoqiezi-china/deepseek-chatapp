/**
 * 自动更新：
 * - 桌面端：读取 GitHub Release API 获取版本、安装包和签名，再交给 Tauri updater 安装
 * - Android：读取 GitHub Release API 获取 APK，多镜像回退下载
 * - 网页版：不支持
 *
 * 不再依赖 Release 里的 latest.json。GitHub API 直连容易被未认证限流，
 * 因此 API 请求和资产下载都走镜像优先、直连兜底。
 */
type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown }
type CapWindow = Window & {
  Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string }
}

const REPO = 'xiaoqiezi-china/deepseek-chatapp'
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`

/** 常见 GitHub 加速镜像；空前缀表示直连 */
export const MIRRORS: { name: string; prefix: string }[] = [
  { name: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' },
  { name: 'ghproxy.net', prefix: 'https://ghproxy.net/' },
  { name: 'github', prefix: '' },
  { name: 'ghfast.top', prefix: 'https://ghfast.top/' },
]

const mirrorUrl = (prefix: string, url: string): string => (prefix ? prefix + url : url)

/** Rust 安装命令回传的事件 */
type RustUpdateEvent =
  | { event: 'attempt'; data: { attempt: number; total: number; source: string } }
  | { event: 'progress'; data: { percent: number | null } }

const isTauri = (): boolean =>
  typeof window !== 'undefined' && !!(window as TauriWindow).__TAURI_INTERNALS__

const isAndroid = (): boolean => {
  if (typeof window === 'undefined') {
    return false
  }
  const cap = (window as CapWindow).Capacitor
  return cap?.isNativePlatform?.() === true && cap?.getPlatform?.() === 'android'
}

/** 当前环境是否支持应用内更新 */
export const isUpdaterSupported = (): boolean => isTauri() || isAndroid()

type ReleaseAsset = {
  name: string
  browser_download_url: string
  size?: number
}

type ReleaseInfo = {
  tag_name: string
  body?: string | null
  published_at?: string | null
  assets: ReleaseAsset[]
}

type ReleaseSource = { release: ReleaseInfo; source: string }

/** 并发请求同一路径的多个镜像，取最先返回的有效结果 */
const firstSuccessful = async <T>(tasks: Promise<T>[]): Promise<T> => {
  if (tasks.length === 0) {
    throw new Error('no sources configured')
  }
  return new Promise<T>((resolve, reject) => {
    let pending = tasks.length
    const errors: unknown[] = []
    tasks.forEach((task) => {
      task.then(resolve).catch((error: unknown) => {
        errors.push(error)
        pending -= 1
        if (pending === 0) {
          reject(new Error(errors.map((item) => String(item)).join('; ')))
        }
      })
    })
  })
}

/** 并行请求 GitHub Release API，返回最先成功的镜像结果 */
const fetchLatestRelease = async (timeoutMs = 8000): Promise<ReleaseSource> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const tasks = MIRRORS.map(async (mirror) => {
    const response = await fetch(mirrorUrl(mirror.prefix, RELEASE_API), {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!response.ok) {
      throw new Error(mirror.name + ' status ' + response.status)
    }
    const release = (await response.json()) as ReleaseInfo
    if (!release || typeof release.tag_name !== 'string' || !Array.isArray(release.assets)) {
      throw new Error(mirror.name + ' invalid release')
    }
    return { release, source: mirror.name }
  })
  try {
    return await firstSuccessful(tasks)
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

/** 获取 Release 资产文本（签名文件），镜像优先 */
const fetchAssetText = async (url: string, timeoutMs = 8000): Promise<string> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const tasks = MIRRORS.map(async (mirror) => {
    const response = await fetch(mirrorUrl(mirror.prefix, url), {
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!response.ok) {
      throw new Error(mirror.name + ' status ' + response.status)
    }
    const text = await response.text()
    if (!text.trim()) {
      throw new Error(mirror.name + ' empty signature')
    }
    return text
  })
  try {
    return await firstSuccessful(tasks)
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

export type UpdateCheck =
  | {
      status: 'available'
      version: string
      notes: string
      downloadUrl: string
      signature: string
      publishedAt: string
      source: string
    }
  | { status: 'latest'; source: string }

/** 比较 a.b.c 版本号，返回 -1 / 0 / 1 */
export const compareVersion = (left: string, right: string): number => {
  const parse = (value: string): number[] =>
    value
      .replace(/^v/i, '')
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

const currentVersion = async (): Promise<string> => {
  if (isTauri()) {
    const { getVersion } = await import('@tauri-apps/api/app')
    return getVersion()
  }
  if (isAndroid()) {
    const { registerPlugin } = await import('@capacitor/core')
    const plugin = registerPlugin<{ getVersion(): Promise<{ version: string }> }>('AppUpdater')
    return (await plugin.getVersion()).version
  }
  throw new Error('updater not supported')
}

/** 查询是否有新版本 */
export const checkForUpdate = async (): Promise<UpdateCheck> => {
  if (!isUpdaterSupported()) {
    throw new Error('updater not supported')
  }

  const current = await currentVersion()
  const { release, source } = await fetchLatestRelease()
  const latest = release.tag_name.replace(/^v/i, '').trim()
  const notes = release.body ?? ''
  const publishedAt = release.published_at ?? ''

  if (!latest || compareVersion(latest, current) <= 0) {
    return { status: 'latest', source }
  }

  if (isTauri()) {
    const installer = release.assets.find((asset) => /x64-setup\.exe$/i.test(asset.name))
    if (!installer?.browser_download_url) {
      throw new Error('release missing desktop installer')
    }
    const signatureAsset = release.assets.find(
      (asset) => asset.name === installer.name + '.sig'
    )
    if (!signatureAsset?.browser_download_url) {
      throw new Error('release missing desktop signature')
    }
    const signature = await fetchAssetText(signatureAsset.browser_download_url)
    return {
      status: 'available',
      version: latest,
      notes,
      downloadUrl: installer.browser_download_url,
      signature,
      publishedAt,
      source,
    }
  }

  const apk = release.assets.find((asset) => /\.apk$/i.test(asset.name))
  if (!apk?.browser_download_url) {
    throw new Error('release missing android apk')
  }
  return {
    status: 'available',
    version: latest,
    notes,
    downloadUrl: apk.browser_download_url,
    signature: '',
    publishedAt,
    source,
  }
}

/** 下载并安装更新 */
export const installUpdate = async (
  info: {
    version: string
    notes: string
    downloadUrl: string
    signature: string
    publishedAt: string
  },
  onProgress?: (percent: number) => void
): Promise<void> => {
  if (isTauri()) {
    // 安装由 Rust 侧接管：本地生成临时 manifest，下载安装包时在镜像间逐个回退，
    // 并逐块回传进度；Windows 上安装成功后进程会退出。
    const { invoke, Channel } = await import('@tauri-apps/api/core')
    const channel = new Channel<RustUpdateEvent>()
    channel.onmessage = (message) => {
      if (message.event === 'attempt') {
        onProgress?.(-1)
        return
      }
      onProgress?.(message.data.percent ?? -1)
    }
    await invoke<string>('install_update', {
      version: info.version,
      notes: info.notes,
      downloadUrl: info.downloadUrl,
      signature: info.signature,
      publishedAt: info.publishedAt,
      onProgress: channel,
    })
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
    return
  }

  if (isAndroid()) {
    const { registerPlugin } = await import('@capacitor/core')
    const plugin = registerPlugin<{
      downloadAndInstall(options: { url: string; urls?: string[] }): Promise<void>
    }>('AppUpdater')
    const urls = MIRRORS.map((mirror) => mirrorUrl(mirror.prefix, info.downloadUrl))
    await plugin.downloadAndInstall({ url: info.downloadUrl, urls })
    return
  }

  throw new Error('updater not supported')
}
