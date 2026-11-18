import { create } from 'zustand'
import type { ChatModel } from './api/types.js'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 系统提示词模式：默认（官方身份）/ 自定义（内容为空即不发送 system） */
export type SystemPromptMode = 'default' | 'custom'

export const DEFAULT_SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'

/** 本机设置，持久化到后端本地 JSON 文件。 */
type Settings = {
  apiKey: string | null
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  search: boolean
  siderCollapsed: boolean
  systemPromptMode: SystemPromptMode
  systemPrompt: string
  /** 当前使用的聊天模型，默认 deepseek-flash */
  model: ChatModel
}

/** 默认值：首次启动或在后端不可达时使用。 */
const defaults: Settings = {
  apiKey: null,
  locale: 'zh-CN',
  themePreference: 'system',
  location: null,
  ttsVoice: 'stella',
  thinking: false,
  search: false,
  siderCollapsed: false,
  systemPromptMode: 'default',
  systemPrompt: '',
  model: 'deepseek-flash',
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

/** 从后端读取的设置可能是旧版本格式，逐字段校验回退到默认值。 */
const sanitize = (raw: Record<string, unknown> | null): Settings => {
  if (!raw) { return { ...defaults, locale: isChineseBrowser() ? 'zh-CN' : 'en-US' } }
  const location = normalizeLocation(raw.location ?? null)
  const browserZh = isChineseBrowser()
  const normalizedLocation = browserZh
    ? location?.region === 'CN' && location.province
      ? location
      : null
    : location
      ? { region: location.region }
      : null
  const locale = raw.locale === 'zh-CN' || raw.locale === 'en-US' ? raw.locale : browserZh ? 'zh-CN' : 'en-US'
  return {
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : null,
    locale,
    themePreference: raw.themePreference === 'light' || raw.themePreference === 'dark' ? raw.themePreference : 'system',
    location: normalizedLocation,
    ttsVoice: raw.ttsVoice === 'tide' ? 'tide' : 'stella',
    thinking: raw.thinking === true,
    search: raw.search === true,
    siderCollapsed: raw.siderCollapsed === true,
    systemPromptMode: raw.systemPromptMode === 'custom' ? 'custom' : 'default',
    systemPrompt: typeof raw.systemPrompt === 'string' ? raw.systemPrompt : '',
    model: raw.model === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-flash',
  }
}

const persist = () => {
  void fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(useSettings.getState()),
  }).catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[settings] save failed', error)
  })
}

let initialized = false

/** 渲染前调用：从后端加载设置；后端不可达时用默认值启动。 */
export const initSettings = async (): Promise<void> => {
  if (initialized) { return }
  initialized = true
  try {
    const response = await fetch('/api/settings')
    if (!response.ok) { throw new Error('status ' + response.status) }
    useSettings.setState(sanitize((await response.json()) as Record<string, unknown>))
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[settings] load failed, using defaults', error)
  }
}

export const useSettings = create<Settings>(() => ({
  ...defaults,
  locale: isChineseBrowser() ? 'zh-CN' : 'en-US',
}))

/** 当前请求应发送的系统提示词；自定义且为空时返回 null（请求中省略 system 字段）。 */
export const currentSystemPrompt = (): string | null => {
  const { systemPromptMode, systemPrompt } = useSettings.getState()
  if (systemPromptMode === 'default') { return DEFAULT_SYSTEM_PROMPT }
  return systemPrompt.trim() ? systemPrompt.trim() : null
}

export const setLocale = (locale: Locale) => {
  useSettings.setState({ locale })
  persist()
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  useSettings.setState({ location })
  persist()
}

export const setThemePreference = (themePreference: ThemePreference) => {
  useSettings.setState({ themePreference })
  persist()
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  useSettings.setState({ ttsVoice })
  persist()
}

export const setApiKey = (apiKey: string | null) => {
  useSettings.setState({ apiKey })
  persist()
}

export const setThinking = (thinking: boolean) => {
  useSettings.setState({ thinking })
  persist()
}

export const setSearch = (search: boolean) => {
  useSettings.setState({ search })
  persist()
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  useSettings.setState({ siderCollapsed })
  persist()
}

export const setSystemPromptMode = (systemPromptMode: SystemPromptMode) => {
  useSettings.setState({ systemPromptMode })
  persist()
}

export const setSystemPrompt = (systemPrompt: string) => {
  useSettings.setState({ systemPrompt })
  persist()
}

export const setModel = (model: ChatModel) => {
  useSettings.setState({ model })
  persist()
}
