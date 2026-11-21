import { ApiError } from '../api/client.js'
import { isWebUrl } from '../../utils/url.js'
import {
  chatCompletionsUrl,
  streamChatCompletion,
  type ChatCompletionMessage,
  type ChatCompletionTool,
  type ChatCompletionToolCall,
} from '../api/thirdParty.js'
import { searchWithDeepSeek } from '../api/webSearch.js'
import type {
  ServerToolUseBlock,
  WebSearchResult,
  WebSearchToolResultBlock,
} from '../api/types.js'
import type { AssistantMessage, Message, UserMessage } from './types.js'
import { getContextRounds, getReplyText } from './reply.js'

const MAX_TOOL_ROUNDS = 4

/** Google Gemini 的 OpenAI 兼容接口要求回传 tool_calls 里的 thought_signature。 */
const isGoogleApiUrl = (url: string): boolean => {
  try {
    const labels = new URL(url).hostname.toLowerCase().split('.')
    return labels.length >= 2 && labels[labels.length - 2] === 'googleapis'
  } catch {
    return false
  }
}

const outboundToolCalls = (
  toolCalls: ChatCompletionToolCall[],
  googleApi: boolean
): ChatCompletionToolCall[] =>
  googleApi
    ? toolCalls
    : toolCalls.map((call) => ({
        id: call.id,
        type: call.type,
        function: call.function,
      }))

const WEB_SEARCH_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      '联网搜索网页。需要实时信息时调用，由 DeepSeek 搜索服务返回网页结果；回答中引用结果时可使用 [citation:N] 标注来源编号。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜索的关键词或完整问题' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
}

export type ThirdPartyReplyInput = {
  reply: AssistantMessage
  history: Message[]
  question: UserMessage
  prefix?: AssistantMessage
  search: boolean
  latestReminder: string
  systemPrompt: string | null
  config: {
    url: string
    model: string
    apiKey: string
    searchApiKey: string
  }
  signal: AbortSignal
  onUpdate: (reply: AssistantMessage) => void
}

const fileNote = (files: UserMessage['files']): string =>
  files.length > 0 ? `[附件：${files.map((file) => file.name).join('、')}，第三方模型仅接收文本]` : ''

const userContent = (message: UserMessage): string =>
  [message.content.trim(), fileNote(message.files)].filter(Boolean).join('\n\n')

const assistantContent = (message: AssistantMessage): string => getReplyText(message).trim()

/** 把本地会话转换成 Chat Completions 的纯文本上下文；第三方模型不接触 DeepSeek file_id。 */
const toMessages = ({
  history,
  question,
  prefix,
  systemPrompt,
  latestReminder,
}: Pick<ThirdPartyReplyInput, 'history' | 'question' | 'prefix' | 'systemPrompt' | 'latestReminder'>): ChatCompletionMessage[] => {
  const messages: ChatCompletionMessage[] = []
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt })
  }
  const reminders = new Set<string>()
  for (const [, reply] of getContextRounds(history)) {
    if (reply.latestReminder) {
      reminders.add(reply.latestReminder)
    }
  }
  if (latestReminder) {
    reminders.add(latestReminder)
  }
  if (reminders.size > 0) {
    messages.push({
      role: 'system',
      content: `对话环境信息（仅用于理解时间、地点和界面语言）：\n${[...reminders].join('\n')}`,
    })
  }
  for (const [user, reply] of getContextRounds(history)) {
    const content = userContent(user)
    const answer = assistantContent(reply)
    if (!content && !answer) {
      continue
    }
    messages.push({ role: 'user', content: content || '（用户发送了附件）' })
    if (answer) {
      messages.push({ role: 'assistant', content: answer })
    }
  }
  messages.push({ role: 'user', content: userContent(question) || '（用户发送了附件）' })
  if (prefix?.prefix) {
    const content = assistantContent(prefix)
    if (content) {
      messages.push({ role: 'assistant', content })
    }
  }
  return messages
}

const queryFromArguments = (argumentsText: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(argumentsText)
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }
    const value = (parsed as Record<string, unknown>).query
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
    if (Array.isArray(value)) {
      const query = value.filter((item): item is string => typeof item === 'string').join(' ')
      return query.trim() || null
    }
  } catch {
    return null
  }
  return null
}

const isSearchResult = (
  item: WebSearchToolResultBlock['content'][number]
): item is WebSearchResult => item.type === 'web_search_result'

const toolResultText = (
  content: WebSearchToolResultBlock['content'],
  citationFor: (url: string) => number
): string => {
  const results = content.filter(isSearchResult).filter((item) => isWebUrl(item.url))
  if (results.length === 0) {
    return content.some((item) => item.type === 'web_search_tool_result_error')
      ? '联网搜索暂不可用，请基于已有信息回答。'
      : '未搜索到相关网页。'
  }
  return [
    '联网搜索结果（引用网页时使用对应的 [citation:N]）：',
    ...results.map(
      (item) =>
        `[citation:${citationFor(item.url)}] ${item.title}\n${item.url}\n${item.snippet ?? ''}`
    ),
  ].join('\n\n')
}

/**
 * 第三方模型的 tool-call 轮询：模型要求搜索 -> 调 DeepSeek 搜索 -> 结果回填 -> 再请求，
 * 直到模型不再调用工具。搜索块会同步写入回复，UI 的「搜索中」和结果列表直接复用现有渲染。
 */
export const streamThirdPartyReply = async ({
  reply,
  history,
  question,
  prefix,
  search,
  latestReminder,
  systemPrompt,
  config,
  signal,
  onUpdate,
}: ThirdPartyReplyInput): Promise<AssistantMessage> => {
  const url = chatCompletionsUrl(config.url)
  if (!url) {
    throw new ApiError('protocol', { key: 'thirdPartyApiUrlRequired' })
  }
  const googleApi = isGoogleApiUrl(url)
  if (!config.model.trim()) {
    throw new ApiError('protocol', { key: 'thirdPartyModelRequired' })
  }
  if (!config.apiKey.trim()) {
    throw new ApiError('protocol', { key: 'thirdPartyApiKeyRequired' })
  }
  if (search && !config.searchApiKey.trim()) {
    throw new ApiError('protocol', { key: 'thirdPartySearchKeyRequired' })
  }

  const messages = toMessages({ history, question, prefix, systemPrompt, latestReminder })
  const tools = search ? [WEB_SEARCH_TOOL] : []
  const citationIndexes = new Map<string, number>()
  let nextCitation = 0
  const citationFor = (url: string): number => {
    const existing = citationIndexes.get(url)
    if (existing !== undefined) {
      return existing
    }
    nextCitation += 1
    citationIndexes.set(url, nextCitation)
    return nextCitation
  }

  const update = (next: AssistantMessage) => {
    reply = next
    onUpdate(next)
  }

  for (let round = 0; ; round += 1) {
    const allowTools = search && round < MAX_TOOL_ROUNDS
    let textBlockIndex: number | null = null
    let content = ''
    let toolCalls: ChatCompletionToolCall[] = []

    for await (const event of streamChatCompletion({
      url,
      apiKey: config.apiKey.trim(),
      model: config.model.trim(),
      messages,
      tools: allowTools ? tools : [],
      signal,
    })) {
      if (event.type === 'text') {
        content += event.text
        const blocks = [...reply.blocks]
        if (textBlockIndex !== null && blocks[textBlockIndex]?.type === 'text') {
          const block = blocks[textBlockIndex]
          if (block.type === 'text') {
            blocks[textBlockIndex] = { ...block, text: block.text + event.text }
          }
        } else {
          textBlockIndex = blocks.length
          blocks.push({ type: 'text', text: event.text })
        }
        update({ ...reply, status: 'streaming', blocks })
      } else if (event.type === 'tool-calls') {
        toolCalls = event.calls
      }
    }

    if (!allowTools || toolCalls.length === 0) {
      break
    }

    messages.push({
      role: 'assistant',
      content: content || null,
      tool_calls: outboundToolCalls(toolCalls, googleApi),
    })

    for (const call of toolCalls) {
      const query = queryFromArguments(call.function.arguments)
      if (call.function.name !== 'web_search' || !query) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content:
            call.function.name !== 'web_search'
              ? `未知工具：${call.function.name}`
              : '搜索参数无效，请使用 {"query":"..."} 格式。',
        })
        continue
      }

      const toolBlock: ServerToolUseBlock = {
        type: 'server_tool_use',
        id: call.id,
        name: 'deepseek_web_search',
        input: { action: 'search', queries: [query] },
        caller: { type: 'direct' },
        kind: 'search',
      }
      update({ ...reply, status: 'streaming', blocks: [...reply.blocks, toolBlock] })

      let toolResult: WebSearchToolResultBlock['content']
      try {
        toolResult = await searchWithDeepSeek(config.searchApiKey, query, signal)
      } catch (error) {
        if (signal.aborted) {
          throw error
        }
        toolResult = [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }]
      }
      const resultBlock: WebSearchToolResultBlock = {
        type: 'web_search_tool_result',
        tool_use_id: call.id,
        kind: 'search',
        content: toolResult,
      }
      update({ ...reply, status: 'streaming', blocks: [...reply.blocks, resultBlock] })

      const resultText = toolResultText(toolResult, citationFor)
      messages.push({ role: 'tool', tool_call_id: call.id, content: resultText })
    }
  }

  return reply
}
