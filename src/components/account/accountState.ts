import { create } from 'zustand'

/** 登录弹窗状态：无 Key 首屏、设置里更改密钥都会打开。 */
export const useAccountDialog = create<{ open: boolean }>(() => ({ open: false }))

export const openAccountDialog = () => useAccountDialog.setState({ open: true })
export const closeAccountDialog = () => useAccountDialog.setState({ open: false })
