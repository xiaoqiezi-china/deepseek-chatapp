import { useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  canUseLiveCamera,
  captureWithNativeCamera,
  isNativeAndroid,
} from '../../services/camera.js'
import { IconButton } from '../base/IconButton.js'
import { IconCameraOutline16 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { CameraDialog } from './CameraDialog.js'

/**
 * 拍照入口：Android 调系统相机；其余环境能开实时预览就预览，否则回退到 capture 文件选择。
 */
export const CameraButton = ({
  onCapture,
  disabled,
  beforeOpen,
}: {
  onCapture: (file: File) => void
  disabled?: boolean
  /** 打开相机前的前置检查（例如是否已填写 API Key） */
  beforeOpen?: () => boolean
}) => {
  const t = useTranslate()
  const [live, setLive] = useState(false)
  const [busy, setBusy] = useState(false)
  const fallbackRef = useRef<HTMLInputElement>(null)

  const openFallback = () => {
    setLive(false)
    fallbackRef.current?.click()
  }

  const onClick = async () => {
    if (busy || disabled || (beforeOpen && !beforeOpen())) {
      return
    }
    if (isNativeAndroid()) {
      setBusy(true)
      try {
        const file = await captureWithNativeCamera()
        if (file) {
          onCapture(file)
        }
      } catch {
        showToast({ key: 'cameraFailed' })
      } finally {
        setBusy(false)
      }
      return
    }
    if (canUseLiveCamera()) {
      setLive(true)
      return
    }
    openFallback()
  }

  return (
    <>
      <IconButton
        size="m"
        tone="primary"
        icon={<IconCameraOutline16 />}
        tooltip={t('takePhoto')}
        disabled={disabled}
        onClick={() => void onClick()}
      />
      <input
        ref={fallbackRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) {
            onCapture(file)
          }
        }}
      />
      {live ? (
        <CameraDialog
          onClose={() => setLive(false)}
          onPickFile={openFallback}
          onCapture={(file) => {
            setLive(false)
            onCapture(file)
          }}
        />
      ) : null}
    </>
  )
}
