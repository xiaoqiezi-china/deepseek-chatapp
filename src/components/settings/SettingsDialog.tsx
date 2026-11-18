import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  IconDarkOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  IconSettingsOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  importHistory,
} from '../../services/chat/backup.js'
import { useChatStore } from '../../services/chat/store.js'
import { regionCodes, getRegionName, provinces } from '../../services/location.js'
import {
  isChineseBrowser,
  setLocale,
  setLocation,
  setThemePreference,
  setTtsVoice,
  type ThemePreference,
} from '../../services/settings.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { IconFolderOutline16 } from '../base/icons.js'
import { storageFetch } from '../../services/storage/bridge.js'
import { getBalance, getModels, type BalanceInfo, type ModelInfo } from '../../services/api/client.js'
import { classifyApiError } from '../../services/api/errors.js'
import { DeepSeekWhaleIcon } from '../base/icons.js'
import { IconAccountOutline16 } from '../base/icons.js'
import { openAccountDialog } from '../account/accountState.js'
import {  setSystemPrompt,
  setSystemPromptMode,
  setModel,
  useSettings,
} from '../../services/settings.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { closeSettings, useSettingsDialog, type SettingsSection } from './settingsDialogState.js'
import styles from './Settings.module.css'

/**
 * 设置弹窗：分「通用设置」（主题、语言、朗读音色、位置）与「数据管理」（API Key、导入、导出、删除）。
 * 桌面端为居中弹窗、左侧导航；移动端为底部弹层、导航横排在内容上方
 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  return open ? <SettingsContent /> : null
}

const sections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: <IconSettingsOutline16 />,
  },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },
  { value: 'account', label: 'settingDialogAsideAccountOptionLabel', icon: <IconAccountOutline16 /> },
]

const SettingsContent = () => {
  const t = useTranslate()
  // 打开时按调用方指定的分组选中，之后在弹窗内切换
  const [section, setSection] = useState(() => useSettingsDialog.getState().section)
  // 切换分组不丢失导入状态
  const historyImport = useHistoryImport()
  const historyDelete = useHistoryDelete()
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory
  return (
    <>
      <Modal
        title={t('settings')}
        closable
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        onClose={() => {
          if (!historyDelete.busy) {
            closeSettings()
          }
        }}
      >
        <div role="tablist" className={styles.navigation}>
          {sections.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={section === item.value}
              className={clsx(styles.navItem, section === item.value && styles.navItemActive)}
              onClick={() => setSection(item.value)}
            >
              {item.icon}
              {t(item.label)}
            </button>
          ))}
        </div>
        <div role="tabpanel" className={styles.content}>
          {section === 'general' ? (
            <>
              <ThemeSetting />
              <LocaleSetting />
              <TtsVoiceSetting />
              <LocationSetting />
              <ModelSetting />
              <SystemPromptSetting />
            </>
          ) : section === 'data' ? (
            <>
              <ImportHistory historyImport={historyImport} disabled={historyBusy} />
              <ExportHistory disabled={historyBusy} />
              <OpenDataDir />
              <SettingCell
                label={t('deleteAllSessions')}
                status={null}
                action={
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    className={styles.cellButton}
                    disabled={historyBusy}
                    onClick={historyDelete.open}
                  >
                    {t('delete')}
                  </Button>
                }
              />
            </>
          ) : (
            <AccountSetting />
          )}
        </div>
      </Modal>
      {historyImport.file ? <ImportConfirm historyImport={historyImport} /> : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
    </>
  )
}

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('deleteAllSessionsModalTitle')}
      className={styles.deleteConfirm}
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={historyDelete.busy}>
          <Button
            variant="outlined"
            autoFocus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={historyDelete.busy}
            onClick={() => void historyDelete.confirm()}
          >
            {t(historyDelete.busy ? 'historyDeleting' : 'deleteAllSessions')}
          </Button>
        </div>
      }
    >
      {t('deleteAllSessionsModalDescription')}
    </Modal>
  )
}

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    setBusy(true)
    try {
      await clearHistory()
      setOpened(false)
      showToast({ key: 'historyDeleted' })
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false)
      }
    },
    confirm,
  }
}

const LocationSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const location = useSettings((state) => state.location)
  const province =
    location?.region === 'CN'
      ? provinces.find((item) => item.code === location.province)
      : undefined

  return (
    <SettingCell
      label={t('settingsLocation')}
      status={null}
      className={styles.locationCell}
      action={
        <div className={styles.locationSelectors}>
          {isChineseBrowser() ? (
            <>
              <Select
                ariaLabel={t('settingsLocationProvince')}
                className={styles.provinceSelect}
                value={province?.code ?? ''}
                placeholder={t('settingsLocationProvince')}
                options={provinces.map((item) => ({ value: item.code, label: item.name }))}
                onChange={(value) => {
                  if (value !== province?.code) {
                    setLocation({ region: 'CN', province: value })
                  }
                }}
              />
              <Select
                ariaLabel={t('settingsLocationCity')}
                className={styles.citySelect}
                value={province ? (location?.city ?? '') : ''}
                disabled={!province?.cities.length}
                placeholder={t('settingsLocationCity')}
                options={
                  province?.cities.map((item) => ({ value: item.code, label: item.name })) ?? []
                }
                onChange={(value) => {
                  if (province) {
                    setLocation({ region: 'CN', province: province.code, city: value })
                  }
                }}
              />
            </>
          ) : (
            <Select
              ariaLabel={t('settingsLocationRegion')}
              className={styles.regionSelect}
              value={location?.region ?? ''}
              placeholder={t('settingsLocationRegion')}
              options={regionCodes
                .map((code) => ({ value: code, label: getRegionName(code, locale) }))
                .sort((a, b) => a.label.localeCompare(b.label, locale))}
              onChange={(value) => setLocation({ region: value })}
            />
          )}
        </div>
      }
    />
  )
}

const LocaleSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <SettingCell
      label={t('settingsLocalePreference')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsLocalePreference')}
          value={locale}
          options={[
            { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
            { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
          ]}
          onChange={setLocale}
        />
      }
    />
  )
}

/** 朗读音色：stella（海星，女声）/ tide（暗潮，男声） */
const TtsVoiceSetting = () => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  return (
    <SettingCell
      label={t('settingsTtsVoice')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsTtsVoice')}
          value={ttsVoice}
          options={[
            { value: 'stella', label: t('settingsTtsVoiceStella') },
            { value: 'tide', label: t('settingsTtsVoiceTide') },
          ]}
          onChange={setTtsVoice}
        />
      }
    />
  )
}

/** 覆盖导入的二次确认，叠在设置弹窗上 */
const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('historyImportConfirmTitle')}
      className={styles.importConfirm}
      onClose={historyImport.cancel}
      footer={
        <>
          <Button variant="outlined" size="m" autoFocus onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button variant="dangerOutlined" size="m" onClick={() => void historyImport.confirm()}>
            {t('historyImportConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>{t('historyImportConfirmDescription')}</div>
    </Modal>
  )
}

const themeOptions: { value: ThemePreference; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'avatarMenuSettingsDialogThemeSelectLightOption',
    icon: <IconLightOutline16 />,
  },
  {
    value: 'dark',
    label: 'avatarMenuSettingsDialogThemeSelectDarkOption',
    icon: <IconDarkOutline16 />,
  },
  {
    value: 'system',
    label: 'avatarMenuSettingsDialogThemeSelectSystemOption',
    icon: <IconFollowsystemOutline16 />,
  },
]

/**
 * 主题项：标题下方浅色 / 深色 / 跟随系统三个选块。
 * 与下方语言选项连续排列。
 */
const ThemeSetting = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  const label = t('avatarMenuSettingsDialogThemeItemLabel')
  return (
    <div className={styles.theme}>
      {label}
      <div role="radiogroup" aria-label={label} className={styles.themeOptions}>
        {themeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={themePreference === option.value}
            className={clsx(
              styles.themeOption,
              themePreference === option.value && styles.themeOptionSelected
            )}
            onClick={() => setThemePreference(option.value)}
          >
            {option.icon}
            {t(option.label)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** `reason` 为失败原因的文案 key，展示时按当前语言翻译后填入 `message` 参数。 */
type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

/** 导出失败附带原因：预期的错误用对应文案作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
})

const SettingCell = ({
  label,
  description,
  status,
  action,
  className,
}: {
  label: string
  description?: string
  status: Status
  action: ReactNode
  className?: string
}) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.cell, styles.row, className)}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        {status || description ? (
          <div className={clsx(styles.description, status?.error && styles.error)}>
            {status
              ? t(status.key, status.reason ? { message: t(status.reason) } : status.params)
              : description}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  )
}

/** 选文件后先提示覆盖；确认后才检查文件并执行导入，任何错误都提示导入失败。 */
const useHistoryImport = () => {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const importing = useRef(false)

  const confirm = async () => {
    if (!file || importing.current) {
      return
    }
    importing.current = true
    setFile(null)
    setBusy(true)
    setStatus(null)
    try {
      const count = await importHistory(file)
      setStatus({ key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } })
    } catch {
      setStatus({ key: 'historyImportFailed', error: true })
    } finally {
      importing.current = false
      setBusy(false)
    }
  }

  return { file, busy, status, select: setFile, cancel: () => setFile(null), confirm }
}

/** 导入 = 覆盖：用选中文件替换本地全部会话与附件。 */
const ImportHistory = ({
  historyImport,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <SettingCell
      label={t('historyImport')}
      description={t('historyImportDescription')}
      status={historyImport.status}
      action={
        <>
          <Button
            variant="outlined"
            size="m"
            className={clsx(styles.cellButton, styles.uploadButton)}
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            <IconUploadOutline14 />
            {t('upload')}
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) {
                historyImport.select(file)
              }
            }}
          />
        </>
      }
    />
  )
}

/** 将全部会话及图片导出为 ZIP 文件并下载 */
const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const empty = useChatStore((state) => state.sessions.length === 0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const onExport = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const { name, blob } = await exportHistory()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (error) {
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingCell
      label={t('exportAllLabel')}
      description={t('historyExportDescription')}
      status={status}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || busy || empty}
          onClick={() => void onExport()}
        >
          <IconDownloadOutline16 />
          {t('exportAllDownload')}
        </Button>
      }
    />
  )
}


/** 系统提示词：默认 / 自定义两态；自定义内容为空即请求中不发送 system。 */
const SystemPromptSetting = () => {
  const t = useTranslate()
  const mode = useSettings((state) => state.systemPromptMode)
  const value = useSettings((state) => state.systemPrompt)
  return (
    <div className={styles.systemPrompt}>
      <div className={styles.label}>{t('systemPromptLabel')}</div>
      <Select
        ariaLabel={t('systemPromptLabel')}
        value={mode}
        options={[
          { value: 'default', label: t('systemPromptDefault') },
          { value: 'custom', label: t('systemPromptCustom') },
        ]}
        onChange={(next) => setSystemPromptMode(next === 'custom' ? 'custom' : 'default')}
      />
      {mode === 'custom' ? (
        <>
          <textarea
            className={styles.systemPromptTextarea}
            aria-label={t('systemPromptLabel')}
            placeholder={t('systemPromptPlaceholder')}
            value={value}
            onChange={(event) => setSystemPrompt(event.target.value)}
          />
          <div className={styles.systemPromptFooter}>
            <span>{t('systemPromptCharacterCount', { count: value.length })}</span>
            <button
              type="button"
              className={styles.systemPromptRestore}
              onClick={() => {
                setSystemPromptMode('default')
                setSystemPrompt('')
              }}
            >
              {t('systemPromptRestore')}
            </button>
          </div>
        </>
      ) : (
        <div className={styles.systemPromptDefaultText}>{t('systemPromptBuiltIn')}</div>
      )}
    </div>
  )
}

/** 账号管理：展示当前密钥状态与登录入口，实际信息在登录弹窗里。 */
const AccountSetting = () => {
  const t = useTranslate()
  const apiKey = useSettings((state) => state.apiKey)
  const [info, setInfo] = useState<{ balance: BalanceInfo[]; available: boolean | null; models: ModelInfo[] } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async (key: string) => {
    setLoading(true)
    setError(null)
    try {
      const [balance, models] = await Promise.all([getBalance(key), getModels(key)])
      setInfo({ balance: balance.balance_infos ?? [], available: balance.is_available ?? null, models })
    } catch (cause) {
      setError(classifyApiError(cause) === 'unauthorized' ? t('accountKeyInvalid') : t('accountLoadFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (apiKey) { void load(apiKey) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey])

  // 未登录：鲸鱼登录卡片
  if (!apiKey) {
    return (
      <div className={styles.accountGate}>
        <div className={styles.accountGateWhale}><DeepSeekWhaleIcon /></div>
        <div className={styles.accountGateTitle}>{t('welcomeLoginTitle')}</div>
        <div className={styles.accountGateDescription}>{t('welcomeLoginDescription')}</div>
        <Button variant="primary" size="m" className={styles.accountGateButton} onClick={openAccountDialog}>
          {t('accountLogin')}
        </Button>
      </div>
    )
  }

  // 已登录：账户余额与模型
  return (
    <div className={styles.accountContent}>
      {loading ? <div className={styles.accountStatus}>{t('accountLoading')}</div> : null}
      {error ? <div className={styles.error}>{error}</div> : null}
      {info ? (
        <>
          <div className={styles.accountSectionTitle}>{t('accountBalanceSection')}</div>
          {info.available !== null ? (
            <div className={styles.accountRow}>
              <span>{t('accountAvailable')}</span>
              <span className={info.available ? styles.accountValue : styles.error}>
                {info.available ? t('accountAvailableYes') : t('accountAvailableNo')}
              </span>
            </div>
          ) : null}
          {info.balance.map((b) => (
            <div key={b.currency}>
              <div className={styles.accountRow}><span>{t('accountCurrency')}</span><span className={styles.accountValue}>{b.currency}</span></div>
              <div className={styles.accountRow}><span>{t('accountTotalBalance')}</span><span className={styles.accountValue}>{b.total_balance}</span></div>
              <div className={styles.accountRow}><span>{t('accountGrantedBalance')}</span><span className={styles.accountValue}>{b.granted_balance}</span></div>
              <div className={styles.accountRow}><span>{t('accountToppedUpBalance')}</span><span className={styles.accountValue}>{b.topped_up_balance}</span></div>
            </div>
          ))}
          <div className={styles.accountSectionTitle}>{t('accountModelsSection')}</div>
          {info.models.length ? (
            <div className={styles.accountModels}>
              {info.models.map((m) => <span key={m.id} className={styles.accountModel}>{m.id}</span>)}
            </div>
          ) : <div className={styles.accountStatus}>{t('accountModelsEmpty')}</div>}
        </>
      ) : null}
      <div className={styles.accountActions}>
        <Button variant="outlined" size="m" onClick={() => { if (apiKey) { void load(apiKey) } }} disabled={loading}>{t('accountRefresh')}</Button>
        <Button variant="outlined" size="m" onClick={openAccountDialog}>{t('accountChangeKey')}</Button>
      </div>
    </div>
  )
}


/** 聊天模型选择：默认 deepseek-flash，可切换 deepseek-v4-pro。 */
const ModelSetting = () => {
  const t = useTranslate()
  const model = useSettings((state) => state.model)
  return (
    <SettingCell
      label={t('settingsModel')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsModel')}
          value={model}
          options={[
            { value: 'deepseek-flash', label: 'deepseek-flash' },
            { value: 'deepseek-v4-pro', label: 'deepseek-v4-pro' },
          ]}
          onChange={(next) => setModel(next === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-flash')}
        />
      }
    />
  )
}

/** 打开本地数据目录：网页版由本地服务调用系统文件管理器，桌面版走 Tauri 命令。 */
const OpenDataDir = () => {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const onOpen = async () => {
    setBusy(true)
    try {
      const response = await storageFetch('/open-data-dir', { method: 'POST' })
      if (!response.ok) {
        throw new Error('status ' + response.status)
      }
    } catch {
      showToast({ key: 'openDataDirFailed', type: 'error' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingCell
      label={t('openDataDir')}
      description={t('openDataDirDescription')}
      status={null}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={busy}
          onClick={() => void onOpen()}
        >
          <IconFolderOutline16 />
          {t('open')}
        </Button>
      }
    />
  )
}
