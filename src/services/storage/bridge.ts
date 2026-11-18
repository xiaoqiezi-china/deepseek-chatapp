/**
 * 存储请求适配：网页端用 fetch 请求本地存储服务；
 * Tauri / Capacitor 环境由原生层注入 window.__DSH_STORAGE_FETCH__，
 * 用同样的 /api 路径直接读写应用数据目录，不启动 HTTP 服务。
 */
type StorageFetch = (path: string, init?: RequestInit) => Promise<Response>

declare global {
  interface Window {
    __DSH_STORAGE_FETCH__?: StorageFetch
    /** Tauri 桌面端：首帧后显示窗口，避免启动白屏 */
    __DSH_REVEAL__?: () => void
  }
}

/** 统一入口：db.ts 与 settings.ts 都用它，避免各写一套环境判断。 */
export const storageFetch = (path: string, init?: RequestInit): Promise<Response> => {
  const native = typeof window !== 'undefined' ? window.__DSH_STORAGE_FETCH__ : undefined
  if (native) {
    return native(path, init)
  }
  return fetch('/api' + path, init)
}

/** 供原生层注册：在应用入口脚本里注入。 */
export const installStorageFetch = (fn: StorageFetch): void => {
  if (typeof window !== 'undefined') {
    window.__DSH_STORAGE_FETCH__ = fn
  }
}

/** 是否运行在 Capacitor 原生容器（Android）中：私有目录无法用系统文件管理器打开。 */
export const isCapacitorNative = (): boolean => {
  const capacitor = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } })
    .Capacitor
  return capacitor?.isNativePlatform?.() === true
}
