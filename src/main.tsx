import './capacitor-bootstrap.js'
import './tauri-bootstrap.js'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { initSettings } from './services/settings.js'
import './app/theme.css'
import './app/global.css'

// 先从本地后端加载设置，避免主题/语言闪变；后端不可达时用默认值。
void initSettings().finally(() => {
  setupTheme()
  createRoot(document.getElementById('root') as HTMLElement).render(<App />)
  // 等两帧确保首屏已绘制，再显示 Tauri 窗口，避免白屏。
  requestAnimationFrame(() => {
    requestAnimationFrame(() => window.__DSH_REVEAL__?.())
  })
})
