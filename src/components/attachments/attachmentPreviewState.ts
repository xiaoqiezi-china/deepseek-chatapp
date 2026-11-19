import { create } from 'zustand'

/** 草稿传本地 File，已发送的附件传存储里的原件 ID。 */
export type AttachmentPreviewSource = {
  source: File | string
  name: string
}

type AttachmentPreviewState = {
  preview: AttachmentPreviewSource | null
  open: (source: File | string, name: string) => void
  close: () => void
}

export const useAttachmentPreview = create<AttachmentPreviewState>((set) => ({
  preview: null,
  open: (source, name) => set({ preview: { source, name } }),
  close: () => set({ preview: null }),
}))

export const openAttachmentPreview = (source: File | string, name: string) =>
  useAttachmentPreview.getState().open(source, name)

export const closeAttachmentPreview = () => useAttachmentPreview.getState().close()
