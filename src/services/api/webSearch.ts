import { streamMessage } from './client.js'
import type {
  CreateMessageRequest,
  WebSearchResult,
  WebSearchToolResultBlock,
} from './types.js'

const SEARCH_TIMEOUT = 45_000

/**
 * 用 DeepSeek 官方接口执行一次联网搜索，只取搜索结果，不把搜索模型自己的回答带回第三方模型。
 * 第三方模型通过 tool_call 触发这里；DeepSeek API Key 仍来自账户设置。
 */
export const searchWithDeepSeek = async (
  apiKey: string,
  query: string,
  signal: AbortSignal
): Promise<WebSearchToolResultBlock['content']> => {
  if (signal.aborted) {
    throw signal.reason
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort('search-timeout'), SEARCH_TIMEOUT)
  const onAbort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) {
    controller.abort(signal.reason)
  }

  const request: CreateMessageRequest = {
    model: 'deepseek-flash',
    system:
      '你是联网搜索执行器。只调用 deepseek_web_search 获取网页搜索结果，不要直接回答用户问题，也不要写总结。',
    messages: [{ role: 'user', content: query }],
    thinking: { type: 'disabled' },
    tools: [{ type: 'deepseek_web_search', name: 'deepseek_web_search' }],
  }

  const results: WebSearchResult[] = []
  const seenUrls = new Set<string>()
  let sawResultBlock = false
  let sawError = false
  try {
    for await (const event of streamMessage(apiKey, request, controller.signal)) {
      if (event.type !== 'content_block_start') {
        continue
      }
      const block = event.content_block
      if (block.type !== 'web_search_tool_result') {
        continue
      }
      sawResultBlock = true
      for (const item of block.content) {
        if (item.type === 'web_search_tool_result_error') {
          sawError = true
          continue
        }
        if (!seenUrls.has(item.url)) {
          seenUrls.add(item.url)
          results.push(item)
        }
      }
    }
  } catch (error) {
    if (signal.aborted) {
      throw error
    }
    // 搜索失败不影响第三方模型继续回答；把错误作为工具结果回传。
    return [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }]
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }

  if (results.length > 0) {
    return results
  }
  return sawError || !sawResultBlock ? [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }] : []
}
