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
        {selectionMode ? (
          <>
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
          </>
        ) : (
          <>
            <div className={styles.appName}><DeepSeekTitleIcon /></div>
            <IconButton
              size="m"
              icon={<IconPanelLeftOutline16 />}
              tooltip={t('collapseSiderbarButton')}
              tooltipPlacement="bottom"
              onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
            />
          </>
        )}
      </div>
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
  const [offset, setOffset] = useState(0)
  const gesture = useRef<{ x: number; y: number; horizontal: boolean } | null>(null)

  if (!open) {
    return null
  }

  const onTouchStart = (event: React.TouchEvent) => {
    const touch = event.touches[0]
    gesture.current = { x: touch.clientX, y: touch.clientY, horizontal: false }
    setOffset(0)
  }

  const onTouchMove = (event: React.TouchEvent) => {
    const start = gesture.current
    if (!start) {
      return
    }
    const touch = event.touches[0]
    const dx = touch.clientX - start.x
    const dy = touch.clientY - start.y
    // 纵向为主时视为滚动列表，不拦截
    if (!start.horizontal) {
      if (Math.abs(dy) > Math.abs(dx)) {
        return
      }
      start.horizontal = true
    }
    // 只允许向左拖动
    setOffset(Math.min(0, dx))
  }

  const onTouchEnd = () => {
    gesture.current = null
    if (offset < -60) {
      closeMobileSider()
    }
    setOffset(0)
  }

  return (
    <>
      <div
        className={closing ? styles.drawerMaskClosing : styles.drawerMask}
        onClick={closeMobileSider}
      />
      <div
        className={closing ? styles.drawerClosing : styles.drawer}
        style={offset ? { transform: `translateX(${offset}px)` } : undefined}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        <Sider mobile />
      </div>
    </>
  )
}
