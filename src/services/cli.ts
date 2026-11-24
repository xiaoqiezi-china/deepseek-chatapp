import { showToast } from '../components/base/toastState.js'
import { useUploads } from './attachments.js'
import { addDraftFiles, getDraft, setDraftText } from './chat/drafts.js'
import { initChat, newChat, selectSession, sendMessage, useChatStore } from './chat/store.js'
import { setSearch, setThinking, useSettings } from './settings.js'

/**
 * 其他应用通过命令行启动本应用时传入的参数，与 Rust 侧 `CliOptions` 一一对应。
 * 只在桌面端生效：网页与 Android 没有外部启动入口。
 */
export type CliInvocation = {
  text?: string | null
  /** --file 传入的绝对路径，未识别的文件由草稿的校验拒绝 */
  files: string[]
  search: boolean
  thinking: boolean
  send: boolean
  new: boolean
}

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown }

const isTauri = (): boolean =>
  typeof window !== 'undefined' && !!(window as TauriWindow).__TAURI_INTERNALS__

/** 等待上传、会话加载与停止生成的上限：任何一步卡住都不要让调用永远挂着。 */
const WAIT_TIMEOUT_MS = 120_000

const logCliError = (action: string, error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[cli] ' + action + ' failed', error)
}

const decodeBase64 = (text: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/** 读取 --file 指定的附件，之后完全交给草稿的上传流程。 */
const readCliFile = async (path: string): Promise<File> => {
  const { invoke } = await import('@tauri-apps/api/core')
  const { name, base64 } = await invoke<{ name: string; base64: string }>('read_cli_file', { path })
  return new File([decodeBase64(base64)], name)
}

/** 等指定附件全部结束上传；true 表示全部成功。 */
const waitForUploads = (ids: string[]): Promise<boolean> =>
  new Promise((resolve) => {
    const current = () => ids.map((id) => useUploads.getState().tasks[id])
    const finished = () =>
      current().every((task) => task === undefined || task.status !== 'uploading')
    const succeeded = () => current().every((task) => task?.status === 'done')
    if (finished()) {
      resolve(succeeded())
      return
    }
    const settle = (value: boolean) => {
      window.clearTimeout(timer)
      unsubscribe()
      resolve(value)
    }
    const timer = window.setTimeout(() => settle(false), WAIT_TIMEOUT_MS)
    const unsubscribe = useUploads.subscribe(() => {
      if (finished()) {
        settle(succeeded())
      }
    })
  })

/** 等会话正文加载完成：命令行到达时目标会话可能还没打开过。 */
const waitForSession = (sessionId: string): Promise<void> =>
  new Promise((resolve) => {
    if (Object.hasOwn(useChatStore.getState().sessionCache, sessionId)) {
      resolve()
      return
    }
    let timer = 0
    const unsubscribe = useChatStore.subscribe((state) => {
      if (Object.hasOwn(state.sessionCache, sessionId)) {
        window.clearTimeout(timer)
        unsubscribe()
        resolve()
      }
    })
    timer = window.setTimeout(() => {
      unsubscribe()
      resolve()
    }, WAIT_TIMEOUT_MS)
  })

/** 等会话停止生成：流式回复期间 sendMessage 会被拒绝。 */
const waitForIdle = (sessionId: string): Promise<void> =>
  new Promise((resolve) => {
    if (!Object.hasOwn(useChatStore.getState().streaming, sessionId)) {
      resolve()
      return
    }
    let timer = 0
    const unsubscribe = useChatStore.subscribe((state) => {
      if (!Object.hasOwn(state.streaming, sessionId)) {
        window.clearTimeout(timer)
        unsubscribe()
        resolve()
      }
    })
    timer = window.setTimeout(() => {
      unsubscribe()
      resolve()
    }, WAIT_TIMEOUT_MS)
  })

/** --send：等附件与会话就绪后直接发送当前草稿。 */
const sendDraft = async (sessionId: string | null) => {
  if (!useChatStore.getState().ready) {
    showToast({ key: 'cliSendFailed' })
    return
  }
  if (sessionId !== null) {
    selectSession(sessionId)
    await waitForSession(sessionId)
    await waitForIdle(sessionId)
  }
  const ids = getDraft(sessionId).attachments.map((attachment) => attachment.id)
  if (ids.length > 0 && !(await waitForUploads(ids))) {
    showToast({ key: 'uploadFileStatusFailed' })
    return
  }
  if (!sendMessage(sessionId)) {
    showToast({ key: 'cliSendFailed' })
  }
}

/**
 * 执行一次命令行调用：
 * --new 强制新会话；否则停在会话内就在该会话执行，停在新会话页面就用新会话。
 */
const applyInvocation = async (invocation: CliInvocation) => {
  await initChat()
  if (invocation.new) {
    newChat()
  }
  // activeId 为 null 表示新会话页面：草稿挂在 null 上，发送时才创建会话。
  const sessionId = useChatStore.getState().activeId
  if (invocation.search) {
    setSearch(true)
  }
  if (invocation.thinking) {
    setThinking(true)
  }
  if (invocation.text) {
    setDraftText(sessionId, invocation.text)
  }
  const files: File[] = []
  for (const path of invocation.files) {
    try {
      files.push(await readCliFile(path))
    } catch (error) {
      logCliError('read attachment', error)
      showToast({ key: 'cliFileReadFailed' })
    }
  }
  if (files.length > 0) {
    const rejected = addDraftFiles(sessionId, files, useSettings.getState().apiKey ?? '')
    if (rejected) {
      showToast(rejected)
    }
  }
  if (invocation.send) {
    await sendDraft(sessionId)
  }
}

/**
 * 订阅桌面端的命令行调用。Rust 侧先入队再发事件，前端注册监听后取走队列，
 * 因此第二个实例早于页面就绪到达也不会丢。返回解绑函数。
 */
export const bindCliCalls = (): (() => void) => {
  if (!isTauri()) {
    return () => undefined
  }
  let disposed = false
  let unlisten: (() => void) | undefined

  const drain = async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    const invocations = await invoke<CliInvocation[]>('take_cli_invocations')
    for (const invocation of invocations) {
      if (disposed) {
        return
      }
      try {
        await applyInvocation(invocation)
      } catch (error) {
        logCliError('apply invocation', error)
      }
    }
  }

  void (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event')
      const off = await listen('cli-invoke', () => {
        void drain().catch((error: unknown) => logCliError('drain', error))
      })
      if (disposed) {
        off()
        return
      }
      unlisten = off
      await drain()
    } catch (error) {
      logCliError('listen', error)
    }
  })()

  return () => {
    disposed = true
    unlisten?.()
  }
}
