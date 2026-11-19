/**
 * 拍照：Android 走系统相机（Capacitor Camera），其余环境用实时预览或 capture 输入。
 */
type CapWindow = Window & {
  Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string }
}

const capacitor = (): CapWindow['Capacitor'] =>
  typeof window === 'undefined' ? undefined : (window as CapWindow).Capacitor

/** 是否运行在 Capacitor 原生容器中 */
export const isNativeApp = (): boolean => capacitor()?.isNativePlatform?.() === true

/** 是否运行在 Android 原生容器中 */
export const isNativeAndroid = (): boolean =>
  isNativeApp() && capacitor()?.getPlatform?.() === 'android'

/** 浏览器能否用 getUserMedia 做实时预览（需要 https 或 localhost） */
export const canUseLiveCamera = (): boolean =>
  typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function'

/** 调起系统相机拍照；非 Android 原生环境返回 null，由调用方回退 */
export const captureWithNativeCamera = async (): Promise<File | null> => {
  if (!isNativeAndroid()) {
    return null
  }
  const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera')
  const photo = await Camera.getPhoto({
    source: CameraSource.Camera,
    resultType: CameraResultType.Uri,
    quality: 92,
    width: 2560,
    correctOrientation: true,
    saveToGallery: false,
  })
  if (!photo.webPath) {
    return null
  }
  const response = await fetch(photo.webPath)
  const blob = await response.blob()
  const ext = photo.format === 'png' ? 'png' : 'jpg'
  return new File([blob], `photo-${Date.now()}.${ext}`, {
    type: blob.type || (ext === 'png' ? 'image/png' : 'image/jpeg'),
  })
}

/** 把实时预览的当前帧截成图片文件 */
export const frameToFile = async (video: HTMLVideoElement): Promise<File> => {
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('canvas unavailable')
  }
  context.drawImage(video, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', 0.92)
  })
  if (!blob) {
    throw new Error('capture failed')
  }
  return new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' })
}
