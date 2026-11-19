import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { IconCloseOutline16 } from '../base/icons.js'
import { useFileView } from '../files/useFileView.js'
import { useAttachmentPreview, type AttachmentPreviewSource } from './attachmentPreviewState.js'
import styles from './AttachmentPreview.module.css'

/** 应用内图片预览：独占遮罩，Esc / 点背景 / 右上角关闭。 */
export const AttachmentPreview = () => {
  const preview = useAttachmentPreview((state) => state.preview)
  const close = useAttachmentPreview((state) => state.close)
  if (!preview) {
    return null
  }
  return <PreviewDialog preview={preview} onClose={close} />
}

const PreviewDialog = ({
  preview,
  onClose,
}: {
  preview: AttachmentPreviewSource
  onClose: () => void
}) => {
  const t = useTranslate()
  const { url } = useFileView(preview.source, preview.name)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return createPortal(
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label={preview.name}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <button
        type="button"
        className={styles.close}
        aria-label={t('close')}
        onClick={onClose}
      >
        <IconCloseOutline16 />
      </button>
      {url ? (
        <img
          className={styles.image}
          src={url}
          alt={preview.name}
          title={preview.name}
          draggable={false}
        />
      ) : (
        <span className={styles.spinner} aria-label={preview.name} />
      )}
    </div>,
    document.body
  )
}
