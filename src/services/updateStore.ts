import { create } from 'zustand'
import { checkForUpdate, installUpdate } from './updater.js'

export type UpdateStatus = 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'error'

type UpdateState = {
  status: UpdateStatus
  version: string
  notes: string
  downloadUrl: string
  /** Release 中安装包的 minisign 签名原文，桌面端安装时由 Rust 转成 manifest */
  signature: string
  publishedAt: string
  /** 本次结果来自哪个源（github / 镜像名），用于排查 */
  source: string
  /** 下载进度，-1 表示不确定 */
  percent: number
}

export const useUpdateStore = create<UpdateState>(() => ({
  status: 'idle',
  version: '',
  notes: '',
  downloadUrl: '',
  signature: '',
  publishedAt: '',
  source: '',
  percent: -1,
}))

/** 检查更新；结果写入全局状态，启动时的静默检查与「关于」页共用 */
export const checkUpdate = async (): Promise<void> => {
  const { status } = useUpdateStore.getState()
  if (status === 'checking' || status === 'downloading') {
    return
  }
  useUpdateStore.setState({ status: 'checking' })
  try {
    const result = await checkForUpdate()
    if (result.status === 'available') {
      useUpdateStore.setState({
        status: 'available',
        version: result.version,
        notes: result.notes,
        downloadUrl: result.downloadUrl,
        signature: result.signature,
        publishedAt: result.publishedAt,
        source: result.source,
        percent: -1,
      })
    } else {
      useUpdateStore.setState({
        status: 'latest',
        source: result.source,
        version: '',
        notes: '',
        downloadUrl: '',
        signature: '',
        publishedAt: '',
      })
    }
  } catch {
    useUpdateStore.setState({ status: 'error' })
  }
}

/** 下载并安装已发现的更新 */
export const installUpdateNow = async (): Promise<void> => {
  const { status, version, notes, downloadUrl, signature, publishedAt } = useUpdateStore.getState()
  if (status !== 'available') {
    return
  }
  useUpdateStore.setState({ status: 'downloading', percent: -1 })
  try {
    await installUpdate(
      { version, notes, downloadUrl, signature, publishedAt },
      (percent) => {
        useUpdateStore.setState({ percent })
      }
    )
  } catch {
    useUpdateStore.setState({ status: 'error' })
  }
}
