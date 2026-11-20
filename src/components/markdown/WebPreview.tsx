import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useTheme } from '../../app/theme.js'
import { useTranslate } from '../../i18n/index.js'

type PreviewKind = 'html' | 'svg'
type PreviewPalette = {
  background: string
  text: string
  scheme: 'light' | 'dark'
}

const HEIGHT_MESSAGE = 'ds-preview-height'

/** 让 iframe 内容把实际高度回传给父页面，自动撑开预览区域。 */
const heightReporter = `<script>
(function () {
  var lastHeight = 0;
  function report() {
    var height = Math.max(
      document.documentElement ? document.documentElement.scrollHeight : 0,
      document.body ? document.body.scrollHeight : 0
    );
    if (Math.abs(height - lastHeight) > 1) {
      lastHeight = height;
      parent.postMessage({ type: '${HEIGHT_MESSAGE}', height: height }, '*');
    }
  }
  window.addEventListener('load', report);
  if (window.ResizeObserver) {
    new ResizeObserver(report).observe(document.documentElement);
  }
  setTimeout(report, 80);
  setTimeout(report, 500);
})();
</script>`

const htmlBaseStyle = ({ background, text, scheme }: PreviewPalette) => `
html {
  -webkit-text-size-adjust: 100%;
  background: ${background};
  color-scheme: ${scheme};
}
body {
  margin: 0;
  padding: 16px;
  background: ${background};
  color: ${text};
  font: 14px/1.6 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  overflow-wrap: break-word;
}
img, video { max-width: 100%; }
`

const svgBaseStyle = ({ background, text, scheme }: PreviewPalette) => `
html, body { margin: 0; background: ${background}; color-scheme: ${scheme}; }
body {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 16px;
  box-sizing: border-box;
  background: ${background};
  color: ${text};
}
body > svg { max-width: 100%; height: auto; }
`

/** 完整文档只补基础底色，用户自己的样式仍然优先。 */
const documentBaseStyle = ({ background, text, scheme }: PreviewPalette) => `
html { background: ${background}; color-scheme: ${scheme}; }
body { background: ${background}; color: ${text}; }
`

const appendReporter = (html: string) => {
  const closingBody = html.toLowerCase().lastIndexOf('</body>')
  if (closingBody !== -1) {
    return `${html.slice(0, closingBody)}${heightReporter}${html.slice(closingBody)}`
  }
  return `${html}${heightReporter}`
}

/** 把基础样式插到用户样式之前，保证用户显式设置的背景和颜色优先。 */
const injectBaseStyle = (html: string, css: string) => {
  const style = `<style>${css}</style>`
  const head = /<head[^>]*>/i.exec(html)
  if (head) {
    const insertAt = head.index + head[0].length
    return `${html.slice(0, insertAt)}${style}${html.slice(insertAt)}`
  }
  const htmlTag = /<html[^>]*>/i.exec(html)
  if (htmlTag) {
    const insertAt = htmlTag.index + htmlTag[0].length
    return `${html.slice(0, insertAt)}<head>${style}</head>${html.slice(insertAt)}`
  }
  const bodyTag = /<body[^>]*>/i.exec(html)
  if (bodyTag) {
    return `${html.slice(0, bodyTag.index)}${style}${html.slice(bodyTag.index)}`
  }
  const doctype = /<!doctype[^>]*>/i.exec(html)
  if (doctype) {
    const insertAt = doctype.index + doctype[0].length
    return `${html.slice(0, insertAt)}${style}${html.slice(insertAt)}`
  }
  return `${style}${html}`
}

const buildDocument = (code: string, kind: PreviewKind, palette: PreviewPalette) => {
  if (kind === 'svg') {
    const svg = code
      .replace(/^\s*<\?xml[^>]*\?>/i, '')
      .replace(/^\s*<!doctype\s+svg[^>]*>/i, '')
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="${palette.scheme}"><style>${svgBaseStyle(palette)}</style></head><body>${svg}${heightReporter}</body></html>`
  }

  const isFullDocument = /<!doctype\s+html|<html[\s>]|<body[\s>]/i.test(code)
  if (isFullDocument) {
    return appendReporter(injectBaseStyle(code, documentBaseStyle(palette)))
  }

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="${palette.scheme}"><style>${htmlBaseStyle(palette)}</style></head><body>${code}${heightReporter}</body></html>`
}

const PREVIEW_PALETTES: Record<'light' | 'dark', PreviewPalette> = {
  light: { background: 'rgb(255, 255, 255)', text: 'rgb(15, 17, 21)', scheme: 'light' },
  dark: { background: 'rgb(21, 21, 23)', text: 'rgb(249, 250, 251)', scheme: 'dark' },
}

/** HTML / SVG 代码预览：sandbox iframe，隔离脚本与父页面，自动按内容高度撑开。 */
export const WebPreview = memo(function WebPreview({
  code,
  kind,
  loading,
}: {
  code: string
  kind: PreviewKind
  loading: boolean
}) {
  const t = useTranslate()
  const theme = useTheme()
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(kind === 'svg' ? 240 : 320)
  const [renderedCode, setRenderedCode] = useState(code)
  const palette = PREVIEW_PALETTES[theme]

  // 流式输出时合并更新，避免每个 token 都重建 iframe；结束后立即使用完整内容。
  useEffect(() => {
    if (!loading) {
      setRenderedCode(code)
      return
    }
    const timer = setTimeout(() => setRenderedCode(code), 400)
    return () => clearTimeout(timer)
  }, [code, loading])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) {
        return
      }
      if (event.data?.type !== HEIGHT_MESSAGE) {
        return
      }
      const next = Number(event.data.height)
      if (!Number.isFinite(next)) {
        return
      }
      const maxHeight = Math.max(320, Math.min(720, Math.round(window.innerHeight * 0.72)))
      setHeight(Math.max(96, Math.min(maxHeight, Math.round(next))))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const srcDoc = useMemo(
    () => buildDocument(renderedCode, kind, palette),
    [renderedCode, kind, palette]
  )

  if (!renderedCode.trim()) {
    return (
      <div className="md-web-preview-status" role="status">
        {t('previewEmpty')}
      </div>
    )
  }

  return (
    <iframe
      ref={frameRef}
      className="md-web-preview-frame"
      title={kind === 'svg' ? t('previewSvgTitle') : t('previewHtmlTitle')}
      sandbox="allow-scripts allow-forms allow-modals"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      style={{ height, backgroundColor: palette.background, colorScheme: palette.scheme }}
    />
  )
})
