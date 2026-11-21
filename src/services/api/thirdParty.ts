import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { ApiError } from './client.js'
import { readServerSentEvents } from './sse.js'

/** OpenAI Chat Completions 兼容请求所需的字段。 */
export type ChatCompletionToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
  /** Gemini 等厂商的附加元数据，需要在下一轮 assistant 消息中原样回传。 */
  extra_content?: Record<string, unknown>
}

export type ChatCompletionMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatCompletionToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export type ChatCompletionTool = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export type ThirdPartyStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool-calls'; calls: ChatCompletionToolCall[] }
  | { type: 'finish'; reason: string | null }

type StreamChoice = {
  delta?: {
    content?: unknown
    tool_calls?: Array<{
      index?: number
      id?: string
      function?: { name?: string; arguments?: string }
      extra_content?: unknown
    }>
  }
  message?: {
    content?: unknown
    tool_calls?: Array<{
      id?: string
      function?: { name?: string; arguments?: string }
      extra_content?: unknown
    }>
  }
  finish_reason?: string | null
}

type StreamBody = {
  error?: { message?: string }
  choices?: StreamChoice[]
}

/** Tauri / Capacitor 已经有原生网络栈，Web 端则优先走同源本地代理绕开 CORS。 */
const runtimeWindow = (): {
  __TAURI_INTERNALS__?: unknown
  Capacitor?: { isNativePlatform?: () => boolean }
} | null => {
  if (typeof window === 'undefined') {
    return null
  }
  return window as unknown as {
    __TAURI_INTERNALS__?: unknown
    Capacitor?: { isNativePlatform?: () => boolean }
  }
}

const isTauriRuntime = (): boolean => Boolean(runtimeWindow()?.__TAURI_INTERNALS__)

const isCapacitorRuntime = (): boolean =>
  runtimeWindow()?.Capacitor?.isNativePlatform?.() === true

/** 读取 Windows 系统代理；Tauri 的 HTTP 插件不会自动继承 IE/系统代理设置。 */
let systemProxyPromise: Promise<string | null> | null = null
const readSystemProxy = (): Promise<string | null> => {
  if (!systemProxyPromise) {
    systemProxyPromise = (async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      return (await invoke<string | null>('system_proxy')) ?? null
    })().catch(() => null)
  }
  return systemProxyPromise
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const textFromContent = (content: unknown): string => {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

/** 第三方 API 地址：支持填写 base URL，也支持直接填写完整的 /chat/completions 地址。 */
export const chatCompletionsUrl = (raw: string): string => {
  const url = raw.trim().replace(/\/+$/, '')
  if (!url) {
    return ''
  }
  return /\/chat\/completions$/i.test(url) ? url : `${url}/chat/completions`
}

const errorFromResponse = async (response: Response): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || response.statusText
  try {
    const body: unknown = JSON.parse(text)
    if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
      message = body.error.message
    }
  } catch {
    // 非 JSON 错误体直接展示原文
  }
  return new ApiError('http', message, response.status)
}

const makeToolCalls = (
  pending: Map<
    number,
    { id: string; name: string; arguments: string; extra_content?: Record<string, unknown> }
  >,
  fallbackSeed: string
): ChatCompletionToolCall[] =>
  [...pending.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([index, item]) =>
      item.name
        ? [
            {
              id: item.id || `call_${fallbackSeed}_${index}`,
              type: 'function' as const,
              function: { name: item.name, arguments: item.arguments || '{}' },
              extra_content: item.extra_content,
            },
          ]
        : []
    )

const readJsonFallback = async (
  response: Response,
  pending: Map<
    number,
    { id: string; name: string; arguments: string; extra_content?: Record<string, unknown> }
  >
): Promise<ThirdPartyStreamEvent[]> => {
  const body = (await response.json().catch(() => null)) as StreamBody | null
  if (!body) {
    throw new ApiError('protocol', '第三方 API 返回了无法解析的响应')
  }
  if (body.error?.message) {
    throw new ApiError('stream', body.error.message)
  }
  const choice = body.choices?.[0]
  if (!choice?.message) {
    throw new ApiError('protocol', '第三方 API 没有返回 choices')
  }
  const events: ThirdPartyStreamEvent[] = [
    { type: 'text', text: textFromContent(choice.message.content) },
  ]
  choice.message.tool_calls?.forEach((call, index) => {
    pending.set(index, {
      id: call.id ?? '',
      name: call.function?.name ?? '',
      arguments: call.function?.arguments ?? '',
      extra_content: isRecord(call.extra_content) ? call.extra_content : undefined,
    })
  })
  events.push({ type: 'tool-calls', calls: makeToolCalls(pending, String(Date.now())) })
  events.push({ type: 'finish', reason: choice.finish_reason ?? null })
  return events
}

/**
 * 逐个产出第三方 Chat Completions 的文本增量和完整工具调用。
 * 兼容常规 SSE 服务，也兼容忽略 stream 参数、直接返回 JSON 的实现。
 */
export async function* streamChatCompletion({
  url,
  apiKey,
  model,
  messages,
  tools,
  signal,
}: {
  url: string
  apiKey: string
  model: string
  messages: ChatCompletionMessage[]
  tools: ChatCompletionTool[]
  signal: AbortSignal
}): AsyncGenerator<ThirdPartyStreamEvent> {
  const body: Record<string, unknown> = { model, messages, stream: true }
  if (tools.length > 0) {
    body.tools = tools
    body.tool_choice = 'auto'
  }

  const requestInit: RequestInit = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal,
  }

  const directFetch = (): Promise<Response> => fetch(url, requestInit)

  // Tauri 使用 Rust 后端发起请求，绕开 WebView 的 CORS 限制，并显式带上系统代理。
  const desktopFetch = async (): Promise<Response> => {
    const proxy = await readSystemProxy()
    return tauriFetch(url, proxy ? { ...requestInit, proxy: { all: proxy } } : requestInit)
  }

  // Web 端走本机代理；代理不存在或是静态部署时回退到直连。
  const requestFetch = async (): Promise<Response> => {
    if (isTauriRuntime()) {
      return desktopFetch()
    }
    if (isCapacitorRuntime()) {
      return directFetch()
    }
    try {
      const response = await fetch('/api/third-party-proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, apiKey, payload: body }),
        signal,
      })
      if (
        response.headers.get('X-DSH-Third-Party-Proxy') === '1' ||
        response.status !== 404
      ) {
        return response
      }
    } catch (error) {
      if (signal.aborted) {
        throw error
      }
    }
    return directFetch()
  }

  let response: Response
  try {
    response = await requestFetch()
  } catch (error) {
    if (signal.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw await errorFromResponse(response)
  }

  const pending = new Map<
    number,
    { id: string; name: string; arguments: string; extra_content?: Record<string, unknown> }
  >()
  const contentType = response.headers.get('Content-Type') ?? ''
  if (contentType.includes('application/json')) {
    for (const event of await readJsonFallback(response, pending)) {
      yield event
    }
    return
  }
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw new ApiError('protocol', '第三方 API 没有返回流式响应')
  }

  let finishReason: string | null = null
  for await (const sse of readServerSentEvents(response.body, signal)) {
    if (sse.data.trim() === '[DONE]') {
      break
    }
    let payload: StreamBody
    try {
      payload = JSON.parse(sse.data) as StreamBody
    } catch {
      continue
    }
    if (payload.error?.message) {
      throw new ApiError('stream', payload.error.message)
    }
    const choice = payload.choices?.[0]
    if (!choice) {
      continue
    }
    const text = textFromContent(choice.delta?.content)
    if (text) {
      yield { type: 'text', text }
    }
    choice.delta?.tool_calls?.forEach((call, order) => {
      const index = typeof call.index === 'number' ? call.index : order
      const current = pending.get(index) ?? { id: '', name: '', arguments: '' }
      if (call.id) {
        current.id = call.id
      }
      if (call.function?.name) {
        current.name = call.function.name
      }
      current.arguments += call.function?.arguments ?? ''
      if (isRecord(call.extra_content)) {
        current.extra_content = call.extra_content
      }
      pending.set(index, current)
    })
    if (choice.finish_reason) {
      finishReason = choice.finish_reason
    }
  }

  yield { type: 'tool-calls', calls: makeToolCalls(pending, String(Date.now())) }
  yield { type: 'finish', reason: finishReason }
}
