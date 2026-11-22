import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { DeepSeekWhaleIcon } from '../base/icons.js'
import { Button } from '../base/Button.js'
import { openAccountDialog } from '../account/accountState.js'
import { MobileHeader } from './MobileHeader.js'
import { useIsMobile } from '../../app/viewport.js'
import styles from './WelcomeGate.module.css'

/** 未登录首屏：整屏替换欢迎页，鲸鱼图标 + 登录按钮。 */
export const WelcomeGate = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const hasKey = useSettings((state) => !!state.apiKey)

  if (hasKey) { return null }

  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.center}>
        <div className={styles.whale}><DeepSeekWhaleIcon /></div>
        <div className={styles.title}>{t('welcomeLoginTitle')}</div>
        <div className={styles.description}>{t('welcomeLoginDescription')}</div>
        <Button variant="primary" size="l" className={styles.loginButton} onClick={() => openAccountDialog()}>
          {t('accountLogin')}
        </Button>
      </div>
    </div>
  )
}
