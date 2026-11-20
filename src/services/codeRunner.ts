import { isCapacitorNative } from './storage/bridge.js'

export type RunLanguage = 'python' | 'js' | 'cmd'

export type RuntimeStatus = {
  available: boolean
  version?: string
  error?: string
}

export type RunCodeResult = {
  ok: boolean
  mode?: 'console'
  consolePath?: string
  stdout?: string
  stderr?: string
  exitCode?: number
  timedOut?: boolean
  truncated?: boolean
  durationMs?: number
  error?: string
  message?: string
}

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown }

const isTauri = (): boolean =>
  typeof window !== 'undefined' && !!(window as TauriWindow).__TAURI_INTERNALS__

const isWebRuntime = (): boolean =>
  typeof window !== 'undefined' &&
  /^https?:$/.test(window.location.protocol) &&
  !isCapacitorNative()

/** 仅桌面端与网页端支持运行；Android 容器不提供本机进程能力。 */
export const isCodeRunSupported = (): boolean => isTauri() || isWebRuntime()

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text()
  let body: unknown = {}
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = {}
  }
  if (!response.ok) {
    const record =
      body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    const message =
      typeof record.error === 'string'
        ? record.error
        : typeof record.message === 'string'
          ? record.message
          : `HTTP ${response.status}`
    throw new Error(message)
  }
  return body
}

export const checkRuntime = async (language: RunLanguage): Promise<RuntimeStatus> => {
  if (!isCodeRunSupported()) {
    return { available: false, error: 'Code execution is not supported on this platform' }
  }
  try {
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core')
      return await invoke<RuntimeStatus>('check_runtime', { language })
    }
    const response = await fetch(`/api/runtime?language=${encodeURIComponent(language)}`)
    return (await readJson(response)) as RuntimeStatus
  } catch (error) {
    return { available: false, error: errorText(error) }
  }
}

export const runCode = async (language: RunLanguage, code: string): Promise<RunCodeResult> => {
  if (!isCodeRunSupported()) {
    return {
      ok: false,
      error: 'UNSUPPORTED_PLATFORM',
      message: 'Code execution is not supported on this platform',
    }
  }
  try {
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core')
      return await invoke<RunCodeResult>('run_code', { language, code })
    }
    const response = await fetch('/api/run-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language, code }),
    })
    return (await readJson(response)) as RunCodeResult
  } catch (error) {
    return { ok: false, error: 'RUN_FAILED', message: errorText(error) }
  }
}
