import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

// Стили wallet-adapter UI — без этого Vite упадёт, если пакета нет
import '@solana/wallet-adapter-react-ui/styles.css'

import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
