import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconCloseOutline16,
  IconPanelLeftOutline16,
  IconSettingsOutline16,
  IconTrashOutline16,
  NewChatIcon,
  DeepSeekTitleIcon,
} from '../base/icons.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { newChat, removeSession, useChatStore } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import styles from './Sider.module.css'

/** 展开的侧边栏：名称与收起按钮、开启新对话、按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const groups = useMemo(() => groupSessions(sessions, now, t), [sessions, now, t])
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  // 多选：从会话菜单进入，选中的会话可批量删除
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [selectionPending, setSelectionPending] = useState(false)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  const exitSelection = () => {
    setSelectionMode(false)
    setSelectedIds(new Set())
  }

  const enterSelection = (sessionId: string) => {
    setSelectionMode(true)
    setSelectedIds(new Set([sessionId]))
  }

  const toggleSelected = (sessionId: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (next.has(sessionId)) {
        next.delete(sessionId)
      } else {
        next.add(sessionId)
      }
      return next
    })
  }

  const deleteSelected = async () => {
    if (selectionPending) {
      return
    }
    setSelectionPending(true)
    let failed = false
    try {
      for (const id of [...selectedIds]) {
        if (!(await removeSession(id))) {
          failed = true
        }
      }
    } finally {
      setSelectionPending(false)
      setConfirmDelete(false)
      exitSelection()
    }
    if (failed) {
      showToast({ key: 'sessionDeleteFailed', type: 'error' })
    }
  }

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      <div className={styles.top}>
        <div className={styles.appName}><DeepSeekTitleIcon /></div>
        <IconButton
          size="m"
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('collapseSiderbarButton')}
          tooltipPlacement="bottom"
          onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
        />
      </div>
      {selectionMode ? (
        <div className={styles.selectionBar}>
          <div className={styles.selectionTitle}>
            {t('sessionSelectionCount', { count: selectedIds.size })}
          </div>
          <IconButton
            size="m"
            icon={<IconCloseOutline16 />}
            tooltip={t('cancel')}
            tooltipPlacement="bottom"
            onClick={exitSelection}
          />
        </div>
      ) : null}
      {selectionMode ? null : (
        <button
          type="button"
          className={styles.newChat}
          onClick={() => {
            newChat()
            closeMobileSider()
          }}
        >
          <span className={styles.newChatIcon}>
            <NewChatIcon />
          </span>
          {t('newChat')}
        </button>
      )}
      <div className={styles.listWrap}>
        <div className={styles.list}>
          {groups.map((group) => (
            <div key={group.key} className={styles.section}>
              <div className={styles.sectionHeader}>{group.label}</div>
              {group.sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeId}
                  selectionMode={selectionMode}
                  selected={selectedIds.has(session.id)}
                  onDelete={() => setDeleting(session)}
                  onToggleSelect={() => toggleSelected(session.id)}
                  onEnterSelection={() => enterSelection(session.id)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className={styles.bottom}>
        {selectionMode ? (
          <button
            type="button"
            className={styles.deleteSelected}
            disabled={selectedIds.size === 0 || selectionPending}
            onClick={() => setConfirmDelete(true)}
          >
            <span className={styles.settingsIcon}>
              <IconTrashOutline16 />
            </span>
            <span className={styles.settingsLabel}>{t('deleteSelected')}</span>
          </button>
        ) : (
          <button type="button" className={styles.settings} onClick={() => openSettings('general')}>
            <span className={styles.settingsIcon}>
              <IconSettingsOutline16 />
            </span>
            <span className={styles.settingsLabel}>{t('settings')}</span>
          </button>
        )}
      </div>
      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    if (await removeSession(deleting.id)) {
                      setDeleting(null)
                    } else {
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
      {confirmDelete ? (
        <Modal
          title={t('deleteSelectedModalTitle')}
          onClose={() => {
            if (!selectionPending) {
              setConfirmDelete(false)
            }
          }}
          footer={
            <>
              <Button
                variant="outlined"
                disabled={selectionPending}
                onClick={() => setConfirmDelete(false)}
              >
                {t('cancel')}
              </Button>
              <Button variant="danger" disabled={selectionPending} onClick={() => void deleteSelected()}>
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSelectedModalDescription', { count: selectedIds.size })}
        </Modal>
      ) : null}
    </div>
  )
}

/** 移动端抽屉：浮在页面上方，点空白区域或向左滑动关闭。 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  const closing = useMobileSider((state) => state.closing)
  const drawerRef = useRef<HTMLDivElement | null>(null)
  const gesture = useRef<{
    x: number
    y: number
    axis: 'horizontal' | 'vertical' | null
    offset: number
    lastAt: number
    lastOffset: number
    velocity: number
  } | null>(null)

  if (!open) {
    return null
  }

  /** 直接写 transform，避免拖动时整棵会话列表跟着重渲染 */
  const applyOffset = (offset: number) => {
    const drawer = drawerRef.current
    if (!drawer) {
      return
    }
    drawer.style.transition = 'none'
    drawer.style.transform = offset ? `translateX(${offset}px)` : ''
  }

  const settleBack = () => {
    const drawer = drawerRef.current
    if (!drawer) {
      return
    }
    drawer.style.transition = 'transform 0.22s var(--ds-ease-out-back)'
    // 先强制一次样式计算，让过渡从当前位移开始，避免直接跳回原点
    void drawer.offsetWidth
    drawer.style.transform = ''
    window.setTimeout(() => {
      if (drawerRef.current === drawer) {
        drawer.style.transition = ''
      }
    }, 260)
  }

  const onTouchStart = (event: React.TouchEvent) => {
    const touch = event.touches[0]
    gesture.current = {
      x: touch.clientX,
      y: touch.clientY,
      axis: null,
      offset: 0,
      lastAt: performance.now(),
      lastOffset: 0,
      velocity: 0,
    }
    applyOffset(0)
  }

  const onTouchMove = (event: React.TouchEvent) => {
    const start = gesture.current
    if (!start) {
      return
    }
    const touch = event.touches[0]
    const dx = touch.clientX - start.x
    const dy = touch.clientY - start.y
    if (!start.axis) {
      // 先判定方向：横向明显占优才当作滑动关闭，否则交给列表滚动
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.3) {
        start.axis = 'horizontal'
      } else if (Math.abs(dy) > 8) {
        start.axis = 'vertical'
        return
      } else {
        return
      }
    }
    if (start.axis !== 'horizontal') {
      return
    }
    // 只跟随向左的拖动，向右拖动保持原位
    const offset = Math.min(0, dx)
    const now = performance.now()
    start.velocity = (offset - start.lastOffset) / Math.max(1, now - start.lastAt)
    start.lastAt = now
    start.lastOffset = offset
    start.offset = offset
    applyOffset(offset)
  }

  /** 拖动结束后浏览器可能补发一次 click，拦掉它，避免误触按钮或切换会话 */
  const swallowNextClick = () => {
    const stop = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
    }
    document.addEventListener('click', stop, { capture: true, once: true })
    window.setTimeout(() => document.removeEventListener('click', stop, true), 400)
  }

  const onTouchEnd = () => {
    const start = gesture.current
    gesture.current = null
    if (!start) {
      return
    }
    if (start.axis !== 'horizontal') {
      applyOffset(0)
      return
    }
    if (start.offset < -6) {
      swallowNextClick()
    }
    const drawer = drawerRef.current
    const threshold = Math.min(112, Math.max(56, (drawer?.offsetWidth ?? 300) * 0.26))
    // 拖动距离够深，或足够快的甩出（速度乘以时长）都判定为关闭
    const flung =
      start.offset < -36 &&
      start.velocity < -0.6 &&
      performance.now() - start.lastAt < 120
    if (start.offset < -threshold || flung) {
      // 保持当前位移，让退场动画从这里继续向左
      closeMobileSider()
      return
    }
    settleBack()
  }

  return (
    <>
      <div
        className={clsx(styles.drawerMask, closing && styles.drawerMaskClosing)}
        onClick={closeMobileSider}
      />
      <div className={clsx(styles.drawerWrap, closing && styles.drawerWrapClosing)}>
        <div
          ref={drawerRef}
          className={styles.drawer}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchEnd}
        >
          <Sider mobile />
        </div>
      </div>
    </>
  )
}
