import { useEffect, useRef, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { getBalance, getModels, verifyApiKey, type BalanceInfo, type ModelInfo } from '../../services/api/client.js'
import { classifyApiError } from '../../services/api/errors.js'
import { setApiKey, useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { IconWarningOutline16 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import styles from './AccountDialog.module.css'
import { closeAccountDialog, useAccountDialog, type DeepSeekKeyReason } from './accountState.js'

const KEY_REQUIRED_TEXT: Record<DeepSeekKeyReason, TranslationKey> = {
  chat: 'deepSeekKeyRequiredChat',
  search: 'deepSeekKeyRequiredSearch',
  tts: 'deepSeekKeyRequiredTts',
  voice: 'deepSeekKeyRequiredVoice',
  attachment: 'deepSeekKeyRequiredAttachment',
}

type Info = { balance: BalanceInfo[]; available: boolean | null; models: ModelInfo[] }

/** 登录 / 账号信息弹窗：未登录时输入 Key；已登录时展示余额与可用模型。 */
export const AccountDialog = () => {
  const open = useAccountDialog((state) => state.open)
  return open ? <AccountDialogContent /> : null
}

const AccountDialogContent = () => {
  const t = useTranslate()
  const apiKey = useSettings((state) => state.apiKey)
  const reason = useAccountDialog((state) => state.reason)
  const loggedIn = !!apiKey
  const [value, setValue] = useState('')
  const [editing, setEditing] = useState(!loggedIn)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<Info | null>(null)
  const [loadingInfo, setLoadingInfo] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const loadInfo = async (key: string) => {
    setLoadingInfo(true)
    setError(null)
    try {
      const [balance, models] = await Promise.all([getBalance(key), getModels(key)])
      if (!mounted.current) { return }
      setInfo({
        balance: balance.balance_infos ?? [],
        available: balance.is_available ?? null,
        models,
      })
    } catch (cause) {
      if (!mounted.current) { return }
      setError(classifyApiError(cause) === 'unauthorized' ? t('accountKeyInvalid') : t('accountLoadFailed'))
    } finally {
      if (mounted.current) { setLoadingInfo(false) }
    }
  }

  useEffect(() => {
    if (loggedIn && !editing && apiKey) {
      void loadInfo(apiKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn, editing, apiKey])

  const submit = async () => {
    const key = value.trim()
    if (!key || busy) {
      if (!key) { setError(t('accountKeyRequired')) }
      return
    }
    setBusy(true)
    setError(null)
    try {
      await verifyApiKey(key)
      if (!mounted.current) { return }
      setApiKey(key)
      setValue('')
      setEditing(false)
      void loadInfo(key)
    } catch (cause) {
      if (!mounted.current) { return }
      setError(classifyApiError(cause) === 'unauthorized' ? t('accountKeyInvalid') : t('accountLoadFailed'))
    } finally {
      if (mounted.current) { setBusy(false) }
    }
  }

  return (
    <Modal
      title={
        loggedIn && !editing
          ? t('accountTitle')
          : reason
            ? t('deepSeekKeyRequiredTitle')
            : t('accountLoginTitle')
      }
      closable
      className={styles.accountModal}
      onClose={closeAccountDialog}
    >
      {loggedIn && !editing ? (
        <div className={styles.accountContent}>
          {loadingInfo ? (
            <div className={styles.accountStatus}>{t('accountLoading')}</div>
          ) : null}
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
                  <div className={styles.accountRow}>
                    <span>{t('accountCurrency')}</span>
                    <span className={styles.accountValue}>{b.currency}</span>
                  </div>
                  <div className={styles.accountRow}>
                    <span>{t('accountTotalBalance')}</span>
                    <span className={styles.accountValue}>{b.total_balance}</span>
                  </div>
                  <div className={styles.accountRow}>
                    <span>{t('accountGrantedBalance')}</span>
                    <span className={styles.accountValue}>{b.granted_balance}</span>
                  </div>
                  <div className={styles.accountRow}>
                    <span>{t('accountToppedUpBalance')}</span>
                    <span className={styles.accountValue}>{b.topped_up_balance}</span>
                  </div>
                </div>
              ))}
              <div className={styles.accountSectionTitle}>{t('accountModelsSection')}</div>
              {info.models.length ? (
                <div className={styles.accountModels}>
                  {info.models.map((m) => <span key={m.id} className={styles.accountModel}>{m.id}</span>)}
                </div>
              ) : (
                <div className={styles.accountStatus}>{t('accountModelsEmpty')}</div>
              )}
            </>
          ) : null}
          <div className={styles.accountActions}>
            <Button variant="outlined" size="m" onClick={() => { if (apiKey) { void loadInfo(apiKey) } }} disabled={loadingInfo}>
              {t('accountRefresh')}
            </Button>
            <Button variant="outlined" size="m" onClick={() => { setError(null); setEditing(true) }}>
              {t('accountChangeKey')}
            </Button>
            <Button size="m" onClick={closeAccountDialog}>
              {t('confirm')}
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.accountLogin}>
          {reason && !loggedIn ? (
            <div className={styles.keyNotice} role="alert">
              <IconWarningOutline16 />
              <span>{t(KEY_REQUIRED_TEXT[reason])}</span>
            </div>
          ) : null}
          <div className={styles.accountDescription}>{t('accountLoginDescription')}</div>
          <label className={styles.accountLabel} htmlFor="account-key-input">{t('accountApiKeyLabel')}</label>
          <input
            id="account-key-input"
            type="password"
            className={styles.apiKeyInput}
            placeholder={t('accountApiKeyPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            value={value}
            onChange={(event) => { setValue(event.target.value); setError(null) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) { void submit() }
            }}
          />
          {error ? <div className={styles.error}>{error}</div> : null}
          <div className={styles.accountActions}>
            {loggedIn ? (
              <Button variant="outlined" size="m" onClick={() => { setEditing(false); setError(null) }}>
                {t('cancel')}
              </Button>
            ) : null}
            <Button size="m" disabled={busy} onClick={() => void submit()}>
              {busy ? t('accountLoggingIn') : t('accountLoginButton')}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
