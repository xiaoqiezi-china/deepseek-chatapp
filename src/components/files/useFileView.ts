import { useEffect, useState } from 'react'
import { getFileViewType, isImage } from '../../services/attachments.js'
import { loadFile } from '../../services/chat/db.js'

const createViewUrl = (original: Blob, type: string) => {
  const blob = original.slice(0, original.size, type || 'application/octet-stream')
  if (type !== 'image/svg+xml') {
    return URL.createObjectURL(blob)
  }
  // SVG 缩略图用 data: 地址，单独打开图片时也与应用隔离。
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** 草稿传 File，已发送的附件传 IndexedDB 原件 ID。 */
export const useFileView = (source: File | string, name: string) => {
  const type = getFileViewType(name)
  const [state, setState] = useState<{ source: File | string; type: string; url: string | null }>()
  useEffect(() => {
    let active = true
    // 消息发出后原件由异步保存流程写入，首次读取可能 404；短暂重试避免缩略图退化成文件卡片。
    const loadOriginal = async (): Promise<Blob | undefined> => {
      if (typeof source !== 'string') {
        return source
      }
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const blob = await loadFile(source)
        if (blob || !active || attempt === 4) {
          return blob
        }
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      return undefined
    }
    const pending = loadOriginal()
      .then((blob) => (active && blob ? createViewUrl(blob, type) : null))
      .catch(() => null)
    void pending.then((url) => {
      if (active) {
        setState({ source, type, url })
      }
    })
    return () => {
      active = false
      void pending.then((url) => {
        if (url?.startsWith('blob:')) {
          URL.revokeObjectURL(url)
        }
      })
    }
  }, [source, type])

  const url = state?.source === source && state.type === type ? state.url : undefined
  const image = isImage(type)
  const openInTab = type === 'application/pdf' || (image && type !== 'image/svg+xml')
  const action = openInTab ? { target: '_blank', rel: 'noreferrer' } : { download: name }
  return { url, image, link: url ? { href: url, ...action } : undefined }
}
