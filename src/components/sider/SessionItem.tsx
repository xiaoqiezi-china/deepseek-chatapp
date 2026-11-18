import clsx from 'clsx'
import { memo, useState } from 'react'
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
  const displayTitle = session.title || t('untitledChat')

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
        selected && styles.selected,
        menuOpen && styles.menuOpen
      )}
      onClick={onClick}
    >
      {selectionMode ? (
        <span className={clsx(styles.checkbox, selected && styles.checkboxChecked)} aria-hidden>
          {selected ? <IconCheckOutline16 /> : null}
        </span>
      ) : null}
      <div className={styles.title}>{displayTitle}</div>
      {selectionMode ? null : (
        <div className={styles.action} onClick={(event) => event.stopPropagation()}>
          <Menu
            onOpenChange={setMenuOpen}
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
              <IconButton icon={<IconEllipsisOutline16 />} aria-label={t('more')} onClick={toggle} />
            )}
          </Menu>
        </div>
      )}
    </div>
  )
})
