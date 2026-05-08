import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource/commit-mono/400.css'
import '@fontsource/commit-mono/500.css'
import '@fontsource/commit-mono/600.css'
import '@fontsource/commit-mono/700.css'
import '@fontsource/commit-mono/400-italic.css'
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
