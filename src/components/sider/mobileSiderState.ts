import { create } from 'zustand'

/** 移动端侧边栏抽屉：顶栏菜单按钮打开，点遮罩、左滑、切换会话或开启新对话后关闭 */
export const useMobileSider = create<{ open: boolean; closing: boolean }>(() => ({
  open: false,
  closing: false,
}))

let closeTimer: ReturnType<typeof setTimeout> | null = null

export const openMobileSider = () => {
  if (closeTimer) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
  useMobileSider.setState({ open: true, closing: false })
}

/** 先播放退场动画，再真正卸载抽屉 */
export const closeMobileSider = () => {
  if (!useMobileSider.getState().open || closeTimer) {
    return
  }
  useMobileSider.setState({ closing: true })
  closeTimer = setTimeout(() => {
    closeTimer = null
    useMobileSider.setState({ open: false, closing: false })
  }, 200)
}
