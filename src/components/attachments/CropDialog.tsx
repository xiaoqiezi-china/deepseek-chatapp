import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './CropDialog.module.css'

type Box = { x: number; y: number; w: number; h: number }
type Mode = 'move' | 'nw' | 'ne' | 'sw' | 'se'

const MIN_SIDE = 32

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

/** 把裁剪框限制在图片范围内 */
const clampBox = (box: Box, view: { w: number; h: number }): Box => {
  const w = clamp(box.w, MIN_SIDE, view.w)
  const h = clamp(box.h, MIN_SIDE, view.h)
  return { w, h, x: clamp(box.x, 0, view.w - w), y: clamp(box.y, 0, view.h - h) }
}

const fullBox = (view: { w: number; h: number }): Box =>
  clampBox({ x: 0, y: 0, w: view.w, h: view.h }, view)

/**
 * 裁剪对话框：拖拽移动、四角缩放，确认后把选区导出成图片文件。
 * 坐标都在「显示尺寸」下计算，导出时按缩放比例换算回原图。
 */
export const CropDialog = ({
  file,
  onCancel,
  onConfirm,
}: {
  file: File
  onCancel: () => void
  onConfirm: (file: File) => void
}) => {
  const t = useTranslate()
  const [url, setUrl] = useState('')
  const [natural, setNatural] = useState({ w: 0, h: 0 })
  const [view, setView] = useState({ w: 0, h: 0 })
  const [box, setBox] = useState<Box>({ x: 0, y: 0, w: 0, h: 0 })
  const [busy, setBusy] = useState(false)
  const boxRef = useRef(box)
  boxRef.current = box
  const dragRef = useRef<{ mode: Mode; startX: number; startY: number; box: Box } | null>(null)

  useEffect(() => {
    const objectUrl = URL.createObjectURL(file)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [file])

  const onLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget
    const w = image.naturalWidth
    const h = image.naturalHeight
    setNatural({ w, h })
    const maxW = Math.max(240, Math.min(window.innerWidth - 160, 920))
    const maxH = Math.max(200, Math.min(window.innerHeight - 300, 620))
    const ratio = Math.min(maxW / w, maxH / h, 1)
    const display = { w: Math.round(w * ratio), h: Math.round(h * ratio) }
    setView(display)
    // 默认保留整张图，用户不动裁剪框也能直接使用
    setBox(fullBox(display))
  }

  const startDrag = useCallback(
    (mode: Mode) => (event: React.PointerEvent) => {
      event.preventDefault()
      event.stopPropagation()
      dragRef.current = {
        mode,
        startX: event.clientX,
        startY: event.clientY,
        box: { ...boxRef.current },
      }
      const onMove = (moveEvent: PointerEvent) => {
        const drag = dragRef.current
        if (!drag) {
          return
        }
        const dx = moveEvent.clientX - drag.startX
        const dy = moveEvent.clientY - drag.startY
        const base = drag.box
        let next: Box
        if (drag.mode === 'move') {
          next = { ...base, x: base.x + dx, y: base.y + dy }
        } else {
          const left = drag.mode === 'nw' || drag.mode === 'sw' ? base.x + dx : base.x
          const top = drag.mode === 'nw' || drag.mode === 'ne' ? base.y + dy : base.y
          const right =
            drag.mode === 'ne' || drag.mode === 'se' ? base.x + base.w + dx : base.x + base.w
          const bottom =
            drag.mode === 'sw' || drag.mode === 'se' ? base.y + base.h + dy : base.y + base.h
          next = {
            x: Math.min(left, right - MIN_SIDE),
            y: Math.min(top, bottom - MIN_SIDE),
            w: Math.max(MIN_SIDE, right - left),
            h: Math.max(MIN_SIDE, bottom - top),
          }
        }
        setBox(clampBox(next, view))
      }
      const onUp = () => {
        dragRef.current = null
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [view]
  )

  const setSquare = () => {
    const side = Math.round(Math.min(view.w, view.h) * 0.8)
    setBox(clampBox({ w: side, h: side, x: (view.w - side) / 2, y: (view.h - side) / 2 }, view))
  }

  const reset = () => setBox(fullBox(view))

  const scale = useMemo(() => (view.w > 0 ? natural.w / view.w : 1), [natural.w, view.w])

  const confirm = async () => {
    const image = new Image()
    image.src = url
    await image.decode().catch(() => {})
    if (!image.naturalWidth) {
      return
    }
    setBusy(true)
    try {
      const sx = Math.round(box.x * scale)
      const sy = Math.round(box.y * scale)
      const sw = Math.max(1, Math.round(box.w * scale))
      const sh = Math.max(1, Math.round(box.h * scale))
      const canvas = document.createElement('canvas')
      canvas.width = sw
      canvas.height = sh
      const context = canvas.getContext('2d')
      if (!context) {
        return
      }
      context.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh)
      const png = file.type === 'image/png'
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, png ? 'image/png' : 'image/jpeg', png ? undefined : 0.92)
      })
      if (!blob) {
        return
      }
      const base = file.name.replace(/\.[^.]+$/, '') || 'image'
      onConfirm(new File([blob], `${base}-crop.${png ? 'png' : 'jpg'}`, { type: blob.type }))
    } finally {
      setBusy(false)
    }
  }

  const unchanged = view.w > 0 && box.x === 0 && box.y === 0 && box.w === view.w && box.h === view.h

  return (
    <Modal
      title={t('cropTitle')}
      className={styles.dialog}
      mainClassName={styles.main}
      onClose={onCancel}
      footer={
        <>
          <Button variant="outlined" onClick={onCancel} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button onClick={() => void confirm()} disabled={busy || view.w === 0}>
            {t('cropUse')}
          </Button>
        </>
      }
    >
      <div className={styles.tools}>
        <button type="button" className={styles.preset} onClick={reset} disabled={unchanged}>
          {t('cropReset')}
        </button>
        <button type="button" className={styles.preset} onClick={setSquare}>
          {t('cropSquare')}
        </button>
      </div>
      <div className={styles.stage} style={{ width: view.w || 1, height: view.h || 1 }}>
        {url ? (
          <img src={url} alt="" className={styles.image} onLoad={onLoad} draggable={false} />
        ) : null}
        {view.w > 0 ? (
          <div
            className={styles.box}
            style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
            onPointerDown={startDrag('move')}
          >
            <div className={styles.grid} />
            {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
              <span
                key={corner}
                className={`${styles.handle} ${styles[corner]}`}
                onPointerDown={startDrag(corner)}
              />
            ))}
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
