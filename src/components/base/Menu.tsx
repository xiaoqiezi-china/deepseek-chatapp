import clsx from 'clsx'
import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from './anchored.js'
import styles from './Menu.module.css'

export type MenuOption = {
  key: string
  label: string
  icon: ReactNode
  danger?: boolean
  onSelect: () => void
}

/** 点击触发，向下展开；点外部或 Esc 关闭。传入 open 时由调用方控制开关（如长按唤起） */
export const Menu = ({
  options,
  children,
  open: controlledOpen,
  onOpenChange,
  anchorPoint,
}: {
  options: MenuOption[]
  children: (props: { open: boolean; toggle: () => void }) => ReactNode
  /** 受控打开状态；不传则内部自行管理 */
  open?: boolean
  /** 打开状态变化时通知调用方，用于在菜单打开期间保持触发元素可见 */
  onOpenChange?: (open: boolean) => void
  /** 长按菜单：按手指位置定位；不传则锚定触发按钮 */
  anchorPoint?: { x: number; y: number } | null
}) => {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) {
      setInternalOpen(next)
    }
    onOpenChange?.(next)
  }
  const close = () => setOpen(false)
  // 普通点击对齐触发按钮；长按则把菜单中心放在手指落点，空间不够自动翻到上方
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLSpanElement, HTMLDivElement>(
    open,
    {
      anchorPoint,
      align: anchorPoint ? 'center' : 'start',
      alignOffset: anchorPoint ? 0 : -5,
      offset: anchorPoint ? 10 : 4,
    }
  )
  useDismiss(open, [anchorRef, floatingRef], close)

  return (
    <>
      <span ref={anchorRef} className={styles.anchor}>
        {children({ open, toggle: () => setOpen(!open) })}
      </span>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.menu}
              style={position ?? undefined}
              role="menu"
            >
              {options.map((option) => (
                <div
                  key={option.key}
                  role="menuitem"
                  className={clsx(styles.option, option.danger && styles.danger)}
                  onClick={() => {
                    setOpen(false)
                    option.onSelect()
                  }}
                >
                  <span className={styles.icon}>{option.icon}</span>
                  {option.label}
                </div>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
