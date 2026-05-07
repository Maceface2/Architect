import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/jetbrains-mono'
import '@xyflow/react/dist/style.css'
import './index.css'
import App from './App'
import { installConsoleRingBuffer } from './lib/consoleRingBuffer'

installConsoleRingBuffer(500)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
