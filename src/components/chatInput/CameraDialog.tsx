import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { frameToFile } from '../../services/camera.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './CameraDialog.module.css'

/** 实时预览拍照：桌面与浏览器用 getUserMedia，快门截取当前帧 */
export const CameraDialog = ({
  onCapture,
  onClose,
  onPickFile,
}: {
  onCapture: (file: File) => void
  onClose: () => void
  onPickFile: () => void
}) => {
  const t = useTranslate()
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    const start = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1440 },
          },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        streamRef.current = stream
        const video = videoRef.current
        if (video) {
          video.srcObject = stream
          await video.play().catch(() => {})
        }
        setReady(true)
      } catch {
        if (!cancelled) {
          setError(true)
        }
      }
    }
    void start()
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
  }, [])

  const shoot = async () => {
    const video = videoRef.current
    if (!video || !video.videoWidth) {
      return
    }
    try {
      const file = await frameToFile(video)
      onCapture(file)
    } catch {
      setError(true)
    }
  }

  return (
    <Modal
      title={t('takePhoto')}
      closable
      className={styles.dialog}
      mainClassName={styles.main}
      onClose={onClose}
      footer={
        error ? (
          <>
            <Button variant="outlined" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button onClick={onPickFile}>{t('cameraChooseFile')}</Button>
          </>
        ) : (
          <>
            <Button variant="outlined" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button onClick={() => void shoot()} disabled={!ready}>
              {t('cameraShutter')}
            </Button>
          </>
        )
      }
    >
      <div className={styles.stage}>
        <video ref={videoRef} className={styles.video} playsInline muted />
        {error ? <div className={styles.error}>{t('cameraUnavailable')}</div> : null}
      </div>
    </Modal>
  )
}
