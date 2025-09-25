import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { logger } from './utils/logger'
import { useStore } from './store'

// Стили wallet-adapter UI — без этого Vite упадёт, если пакета нет
import '@solana/wallet-adapter-react-ui/styles.css'

import './index.css'

// Bridge logger -> store so logs appear in UI even before rehydrate
try {
  const unsub = logger.subscribe((entry) => {
    try {
      (globalThis as any).__fromLoggerBridge = true;
      useStore.getState().addLog((entry.level === 'error' ? 'err' : (entry.level as any)), entry.msg)
    } finally {
      (globalThis as any).__fromLoggerBridge = false;
    }
  })
  ;(window as any).__logger_unsub = unsub
} catch {}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
