type SaveFilePickerAcceptType = {
  description?: string
  accept: Record<string, string[]>
}

type SaveFilePickerOptions = {
  suggestedName?: string
  types?: SaveFilePickerAcceptType[]
  excludeAcceptAllOption?: boolean
}

type SaveFileHandle = {
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void>
    close: () => Promise<void>
  }>
}

type WindowWithSaveFilePicker = Window & {
  showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<SaveFileHandle>
}

export type SaveTextFileResult = 'saved' | 'cancelled' | 'failed'

const fallbackDownload = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.style.display = 'none'
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * 代码块“下载”：优先弹出系统另存为对话框；不支持 File System Access API 时退回浏览器下载。
 */
export const saveTextFile = async ({
  content,
  filename,
  mimeType,
  description,
}: {
  content: string
  filename: string
  mimeType: string
  description: string
}): Promise<SaveTextFileResult> => {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` })
  const picker = (window as WindowWithSaveFilePicker).showSaveFilePicker
  if (typeof picker === 'function') {
    try {
      const handle = await picker.call(window, {
        suggestedName: filename,
        types: [
          {
            description,
            accept: { [mimeType]: [filename.slice(filename.lastIndexOf('.'))] },
          },
        ],
      })
      const writable = await handle.createWritable()
      try {
        await writable.write(blob)
      } finally {
        await writable.close()
      }
      return 'saved'
    } catch (error) {
      if ((error as DOMException | undefined)?.name === 'AbortError') {
        return 'cancelled'
      }
      // 系统对话框不可用时继续走普通下载，避免按钮完全失效。
    }
  }
  try {
    fallbackDownload(blob, filename)
    return 'saved'
  } catch {
    return 'failed'
  }
}
