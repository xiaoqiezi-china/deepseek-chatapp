import clsx from 'clsx'
import { memo, useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconCheckOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconMultiSelectOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
import { renameSession, selectSession } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionItem.module.css'

export const SessionItem = memo(function SessionItem({
  session,
  active,
  selectionMode = false,
  selected = false,
  onDelete,
  onToggleSelect,
  onEnterSelection,
}: {
  session: SessionSummary
  active: boolean
  /** 侧边栏处于多选状态 */
  selectionMode?: boolean
  /** 当前项是否被选中 */
  selected?: boolean
  onDelete: () => void
  onToggleSelect: () => void
  onEnterSelection: () => void
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  // 长按/右键时菜单跟随落点；从「更多」按钮打开时清空，回到按钮锚定
  const [menuPoint, setMenuPoint] = useState<{ x: number; y: number } | null>(null)
  // 长按：按住不动 480ms 打开会话菜单，移动超过阈值则视为滚动
  const press = useRef<{
    timer: ReturnType<typeof setTimeout>
    x: number
    y: number
    fired: boolean
  } | null>(null)
  // 长按后松手会补发一次 click，用它拦掉，避免误切换会话
  const suppressClick = useRef(false)
  const displayTitle = session.title || t('untitledChat')

  const cancelPress = () => {
    if (press.current) {
      clearTimeout(press.current.timer)
      press.current = null
    }
  }

  useEffect(() => cancelPress, [])

  const onTouchStart = (event: React.TouchEvent) => {
    suppressClick.current = false
    if (selectionMode) {
      return
    }
    const touch = event.touches[0]
    cancelPress()
    press.current = {
      timer: setTimeout(() => {
        if (!press.current) {
          return
        }
        press.current.fired = true
        suppressClick.current = true
        setMenuPoint({ x: press.current.x, y: press.current.y })
        setMenuOpen(true)
        try {
          navigator.vibrate?.(8)
        } catch {
          // 部分浏览器不支持震动，忽略
        }
      }, 480),
      x: touch.clientX,
      y: touch.clientY,
      fired: false,
    }
  }

  const onTouchMove = (event: React.TouchEvent) => {
    const current = press.current
    if (!current || current.fired) {
      return
    }
    const touch = event.touches[0]
    if (Math.abs(touch.clientX - current.x) > 10 || Math.abs(touch.clientY - current.y) > 10) {
      cancelPress()
    }
  }

  if (editing) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <input
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        }}
      />
    )
  }

  const onClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    cancelPress()
    if (selectionMode) {
      onToggleSelect()
      return
    }
    selectSession(session.id)
    closeMobileSider()
  }

  return (
    <div
      className={clsx(
        styles.item,
        active && !selectionMode && styles.active,
        selectionMode && styles.selectionMode,
        selected && styles.selected,
        menuOpen && styles.menuOpen
      )}
      onClick={onClick}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={cancelPress}
      onTouchCancel={cancelPress}
      onContextMenu={(event) => {
        if (selectionMode) {
          return
        }
        // 移动端长按会弹出系统菜单，这里统一换成本地会话菜单
        event.preventDefault()
        setMenuPoint({ x: event.clientX, y: event.clientY })
        setMenuOpen(true)
      }}
    >
      <span
        className={clsx(
          styles.checkbox,
          selectionMode && styles.checkboxVisible,
          selected && styles.checkboxChecked
        )}
        aria-hidden
      >
        {selected ? <IconCheckOutline16 /> : null}
      </span>
      <div className={styles.title}>{displayTitle}</div>
      {selectionMode ? null : (
        <div className={styles.action} onClick={(event) => event.stopPropagation()}>
          <Menu
            open={menuOpen}
            anchorPoint={menuPoint}
            onOpenChange={(open) => {
              setMenuOpen(open)
              if (!open) {
                setMenuPoint(null)
              }
            }}
            options={[
              {
                key: 'select',
                label: t('sessionItemMenuSelect'),
                icon: <IconMultiSelectOutline16 />,
                onSelect: onEnterSelection,
              },
              {
                key: 'rename',
                label: t('sessionItemMenuRenameOption'),
                icon: <IconEditOutline16 />,
                onSelect: () => setEditing(true),
              },
              {
                key: 'delete',
                label: t('delete'),
                icon: <IconTrashOutline16 />,
                danger: true,
                onSelect: onDelete,
              },
            ]}
          >
            {({ toggle }) => (
              <IconButton
                icon={<IconEllipsisOutline16 />}
                aria-label={t('more')}
                onClick={() => {
                  setMenuPoint(null)
                  toggle()
                }}
              />
            )}
          </Menu>
        </div>
      )}
    </div>
  )
})
