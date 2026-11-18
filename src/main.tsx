import './capacitor-bootstrap.js'
import './tauri-bootstrap.js'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { initSettings } from './services/settings.js'
import { ensureKatex } from './services/markdown/katex.js'
import './app/theme.css'
import './app/global.css'

ensureKatex()

// 先从本地后端加载设置，避免主题/语言闪变；后端不可达时用默认值。
void initSettings().finally(() => {
  setupTheme()
  createRoot(document.getElementById('root') as HTMLElement).render(<App />)
})
