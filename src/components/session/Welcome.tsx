import { useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { DeepSeekWhaleIcon } from '../base/icons.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

/** 固定欢迎语候选；0 保留时段问候，其余为用户提供的文案。 */
const CHAT_GREETINGS: TranslationKey[] = [
  'greetingChat1',
  'greetingChat2',
  'greetingChat3',
  'greetingChat4',
]

/** 新对话首页：桌面端鲸鱼在问候语左侧，窄屏时鲸鱼在上方；移动端输入框吸底 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  // 固定本次挂载的选择，切换语言时只重新翻译、不重新抽签
  const [variant] = useState(() => Math.floor(Math.random() * (CHAT_GREETINGS.length + 1)))
  const hour = new Date().getHours()
  const timeGreeting: TranslationKey =
    hour < 11 ? 'greetingMorning' : hour < 18 ? 'greetingAfternoon' : 'greetingEvening'
  const greeting = t(variant === 0 ? timeGreeting : CHAT_GREETINGS[variant - 1])
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.welcome}>
        <div className={styles.greeting}>
          <DeepSeekWhaleIcon />
          <span>{greeting}</span>
        </div>
        <ChatInput sessionId={null} />
        {isMobile ? <div className={styles.caveat}>{t('contentCaveat')}</div> : null}
      </div>
    </div>
  )
}
