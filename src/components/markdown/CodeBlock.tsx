import { useTranslate } from '../../i18n/index.js'
import { memo, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import Prism from 'prismjs'
import {
  getHighlightLang,
  isHighlightLoaded,
  loadHighlight,
} from '../../services/markdown/highlight.js'
import {
  IconCheckOutline16,
  IconCopyOutline16,
  IconDownloadOutline16,
  IconPlayMediaOutline16,
} from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { copyText } from '../../utils/clipboard.js'
import { saveTextFile } from '../../utils/saveFile.js'
import {
  checkRuntime,
  isCodeRunSupported,
  runCode,
  type RunCodeResult,
  type RunLanguage,
  type RuntimeStatus,
} from '../../services/codeRunner.js'
import { MermaidDiagram } from './MermaidDiagram.js'
import { WebPreview } from './WebPreview.js'
import { useStickyBanner } from './useStickyBanner.js'
import styles from './CodeBlock.module.css'

type CodeView = 'preview' | 'code'

type DownloadFile = {
  filename: string
  mimeType: string
  description: string
}

type RunAction = {
  busy: boolean
  running: boolean
  onClick: () => void
}

const RUNNABLE_LANGUAGES: Record<string, RunLanguage> = {
  python: 'python',
  python3: 'python',
  py: 'python',
  javascript: 'js',
  js: 'js',
  node: 'js',
  mjs: 'js',
  cjs: 'js',
  cmd: 'cmd',
  bat: 'cmd',
  batch: 'cmd',
}

const CODE_EXTENSIONS: Record<string, string> = {
  bash: 'sh',
  c: 'c',
  'c++': 'cpp',
  cpp: 'cpp',
  csharp: 'cs',
  cs: 'cs',
  css: 'css',
  diff: 'diff',
  go: 'go',
  html: 'html',
  html5: 'html',
  ini: 'ini',
  java: 'java',
  javascript: 'js',
  js: 'js',
  json: 'json',
  jsonc: 'json',
  jsx: 'jsx',
  less: 'less',
  markdown: 'md',
  md: 'md',
  mermaid: 'mmd',
  plaintext: 'txt',
  powershell: 'ps1',
  ps1: 'ps1',
  py: 'py',
  python: 'py',
  rs: 'rs',
  rust: 'rs',
  scss: 'scss',
  sh: 'sh',
  shell: 'sh',
  sql: 'sql',
  svg: 'svg',
  text: 'txt',
  toml: 'toml',
  ts: 'ts',
  tsx: 'tsx',
  txt: 'txt',
  typescript: 'ts',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
}

const CODE_MIME_TYPES: Record<string, string> = {
  css: 'text/css',
  html: 'text/html',
  json: 'application/json',
  md: 'text/markdown',
  svg: 'image/svg+xml',
  xml: 'application/xml',
}

const getDownloadFile = (
  langName: string,
  isHtml: boolean,
  isSvg: boolean,
  isMermaid: boolean
): DownloadFile => {
  const extension = isSvg
    ? 'svg'
    : isHtml
      ? 'html'
      : isMermaid
        ? 'mmd'
        : CODE_EXTENSIONS[langName] || 'txt'
  const base = isHtml || isSvg ? 'preview' : isMermaid ? 'diagram' : 'code'
  return {
    filename: `${base}.${extension}`,
    mimeType: CODE_MIME_TYPES[extension] || 'text/plain',
    description: `${extension.toUpperCase()} file`,
  }
}

type ViewSwitch = {
  label: string
  previewLabel: string
  codeLabel: string
  active: CodeView
  onChange: (view: CodeView) => void
}

/** 代码块标题栏：左侧语言名或预览/代码切换，右侧运行、下载和复制 */
const CodeInfoRow = ({
  code,
  infostring,
  viewSwitch,
  download,
  run,
}: {
  code: string
  infostring: string
  viewSwitch?: ViewSwitch
  download: DownloadFile
  run?: RunAction
}) => {
  const t = useTranslate()
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)
  const onDownload = async () => {
    if (saving) {
      return
    }
    setSaving(true)
    try {
      const result = await saveTextFile({ content: code, ...download })
      if (result === 'failed') {
        showToast({ key: 'downloadFailed', type: 'error' })
      }
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className={styles.container}>
      {viewSwitch ? (
        <div className="md-code-block-switch" aria-label={viewSwitch.label}>
          <button
            type="button"
            className={styles.button}
            aria-pressed={viewSwitch.active === 'preview'}
            onClick={() => viewSwitch.active !== 'preview' && viewSwitch.onChange('preview')}
          >
            {viewSwitch.previewLabel}
          </button>
          <button
            type="button"
            className={styles.button}
            aria-pressed={viewSwitch.active === 'code'}
            onClick={() => viewSwitch.active !== 'code' && viewSwitch.onChange('code')}
          >
            {viewSwitch.codeLabel}
          </button>
        </div>
      ) : (
        <span className={styles.name}>{infostring}</span>
      )}
      <div className={styles.actions}>
        {run ? (
          <button
            type="button"
            className={styles.button}
            disabled={run.busy}
            aria-busy={run.busy}
            onClick={run.onClick}
          >
            <IconPlayMediaOutline16 />
            <span>{t(run.busy ? (run.running ? 'runRunning' : 'runChecking') : 'run')}</span>
          </button>
        ) : null}
        <button
          type="button"
          className={styles.button}
          disabled={saving}
          onClick={() => void onDownload()}
        >
          <IconDownloadOutline16 />
          <span>{t('download')}</span>
        </button>
        <button
          type="button"
          className={styles.button}
          onClick={async () => {
            if (!(await copyText(code))) {
              showToast({ key: 'copyFailed' })
              return
            }
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
          <span>{t(copied ? 'copied' : 'copy')}</span>
        </button>
      </div>
    </div>
  )
}

/** 代码块：语言包按需加载；Mermaid、HTML、SVG 支持预览。 */
export const CodeBlock = memo(function CodeBlock({
  code,
  infostring,
  loading = false,
}: {
  code: string
  infostring: string
  loading?: boolean
}) {
  const t = useTranslate()
  const langName = infostring.trim().toLowerCase().split(/\s+/)[0]
  const isMermaid = langName === 'mermaid'
  const isSvg = langName === 'svg' || (langName === 'xml' && /<svg[\s>]/i.test(code))
  const isHtml = langName === 'html' || langName === 'html5'
  const previewKind = isSvg ? 'svg' : isHtml ? 'html' : null
  const download = getDownloadFile(langName, isHtml, isSvg, isMermaid)
  const runLanguage = RUNNABLE_LANGUAGES[langName]
  const runSupported = runLanguage !== undefined && isCodeRunSupported()
  // Mermaid 保持默认图表；HTML/SVG 默认代码，按需切到预览。
  const [showMermaidPreview, setShowMermaidPreview] = useState(true)
  const [showWebPreview, setShowWebPreview] = useState(false)
  const [runState, setRunState] = useState<'idle' | 'checking' | 'running'>('idle')
  const [runRuntime, setRunRuntime] = useState<RuntimeStatus | null>(null)
  const [runResult, setRunResult] = useState<RunCodeResult | null>(null)
  const [runConfirmOpen, setRunConfirmOpen] = useState(false)
  const blockRef = useRef<HTMLDivElement>(null)
  const stickySentinelRef = useRef<HTMLDivElement>(null)
  const stuck = useStickyBanner(blockRef, stickySentinelRef)
  // 语言包注册在全局 Prism 上，每次渲染直接判断；加载完成后触发一次重渲染
  const rerender = useReducer((n: number) => n + 1, 0)[1]
  const lang = getHighlightLang(infostring)
  const loaded = lang !== null && isHighlightLoaded(lang)
  useEffect(() => {
    if (lang === null || loaded) {
      return
    }
    let unmounted = false
    loadHighlight(lang).then(() => {
      if (!unmounted) {
        rerender()
      }
    })
    return () => {
      unmounted = true
    }
  }, [lang, loaded, rerender])
  const renderedHtml = useMemo(() => {
    const name = lang !== null && loaded ? lang : 'plaintext'
    return Prism.highlight(code, Prism.languages[name], name)
  }, [code, lang, loaded])

  const viewSwitch: ViewSwitch | undefined = isMermaid
    ? {
        label: t('mermaidSwitchLabel'),
        previewLabel: t('mermaidDiagram'),
        codeLabel: t('mermaidCode'),
        active: showMermaidPreview ? 'preview' : 'code',
        onChange: (view) => setShowMermaidPreview(view === 'preview'),
      }
    : previewKind
      ? {
          label: t('previewSwitchLabel'),
          previewLabel: t('preview'),
          codeLabel: t('previewCode'),
          active: showWebPreview ? 'preview' : 'code',
          onChange: (view) => setShowWebPreview(view === 'preview'),
        }
      : undefined

  const requestRun = async () => {
    if (!runLanguage || runState !== 'idle') {
      return
    }
    setRunResult(null)
    setRunRuntime(null)
    setRunState('checking')
    const runtime = await checkRuntime(runLanguage)
    setRunState('idle')
    if (!runtime.available) {
      const key =
        runLanguage === 'python'
          ? 'pythonNotFound'
          : runLanguage === 'js'
            ? 'nodeNotFound'
            : 'cmdNotSupported'
      setRunResult({ ok: false, error: 'RUNTIME_NOT_FOUND', message: t(key) })
      showToast({ key, type: 'error' })
      return
    }
    setRunRuntime(runtime)
    setRunConfirmOpen(true)
  }

  const confirmRun = async () => {
    if (!runLanguage) {
      return
    }
    setRunConfirmOpen(false)
    setRunResult(null)
    setRunState('running')
    const result = await runCode(runLanguage, code)
    setRunResult(result)
    setRunState('idle')
    if (result.ok) {
      showToast({ key: 'runConsoleStarted' })
    }
  }

  const runStartedInConsole = runResult?.ok === true && runResult.mode === 'console'

  return (
    <div ref={blockRef} className="md-code-block">
      <div ref={stickySentinelRef} className="md-code-block-sticky-sentinel" aria-hidden="true" />
      <div className={`md-code-block-banner${stuck ? ' md-code-block-banner-stuck' : ''}`}>
        <CodeInfoRow
          code={code}
          infostring={infostring}
          viewSwitch={viewSwitch}
          download={download}
          run={
            runSupported
              ? {
                  busy: runState !== 'idle',
                  running: runState === 'running',
                  onClick: () => void requestRun(),
                }
              : undefined
          }
        />
      </div>
      {isMermaid && showMermaidPreview ? (
        <MermaidDiagram code={code} loading={loading} />
      ) : previewKind && showWebPreview ? (
        <WebPreview code={code} kind={previewKind} loading={loading} />
      ) : (
        <pre dangerouslySetInnerHTML={{ __html: renderedHtml }}></pre>
      )}
      {runState === 'running' || runResult ? (
        <div className={styles.runResult}>
          {runStartedInConsole ? (
            <div className={styles.runConsoleStarted}>{t('runConsoleStarted')}</div>
          ) : (
            <>
              <div className={styles.runHeader}>
                <span>{runState === 'running' ? t('runRunning') : t('runFailed')}</span>
              </div>
              <pre className={styles.runOutput}>
                {runState === 'running'
                  ? t('runRunning')
                  : runResult?.message || t('runFailed')}
              </pre>
            </>
          )}
        </div>
      ) : null}
      {runConfirmOpen ? (
        <Modal
          title={t('runConfirmTitle')}
          onClose={() => setRunConfirmOpen(false)}
          footer={
            <>
              <Button variant="outlined" onClick={() => setRunConfirmOpen(false)}>
                {t('cancel')}
              </Button>
              <Button onClick={() => void confirmRun()}>{t('runConfirm')}</Button>
            </>
          }
        >
          <div className={styles.runWarning}>{t('runWarning')}</div>
          <div className={styles.runEnvironment}>{t('runConsoleNote')}</div>
          {runRuntime?.version ? (
            <div className={styles.runEnvironment}>
              {t('runEnvironment', { runtime: runRuntime.version })}
            </div>
          ) : null}
        </Modal>
      ) : null}
    </div>
  )
})
