import { create } from 'zustand'
import { isThirdPartyModel, useSettings } from '../../services/settings.js'

/** 需要 DeepSeek API Key 的功能：用于在登录弹窗里说明拦截原因。 */
export type DeepSeekKeyReason = 'chat' | 'search' | 'tts' | 'voice' | 'attachment'

/** 登录弹窗状态：普通登录不带 reason；被功能拦截时记录原因。 */
export const useAccountDialog = create<{ open: boolean; reason: DeepSeekKeyReason | null }>(
  () => ({ open: false, reason: null })
)

export const openAccountDialog = (reason: DeepSeekKeyReason | null = null) =>
  useAccountDialog.setState({ open: true, reason })

export const closeAccountDialog = () => useAccountDialog.setState({ open: false, reason: null })

/** 是否已填写 DeepSeek API Key；第三方模型的纯文本对话不依赖它。 */
export const hasDeepSeekKey = () => Boolean((useSettings.getState().apiKey ?? '').trim())

/** 需要 DeepSeek API Key 的功能统一入口：没有 Key 时弹登录窗并返回 false。 */
export const requireDeepSeekKey = (reason: DeepSeekKeyReason) => {
  if (hasDeepSeekKey()) {
    return true
  }
  openAccountDialog(reason)
  return false
}

/**
 * 发送、重新生成、续写和编辑消息前的统一检查。
 * 第三方模型只有开启联网搜索时才需要 DeepSeek Key，纯文本对话直接放行。
 */
export const ensureCanSend = (search: boolean = useSettings.getState().search) => {
  const thirdParty = isThirdPartyModel()
  if (thirdParty && !search) {
    return true
  }
  return requireDeepSeekKey(thirdParty ? 'search' : 'chat')
}
