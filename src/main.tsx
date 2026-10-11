import './themes/fonts'
import './styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { initSync } from './sync'

// Optional server sync (docs/SYNC.md). Runs before the first render so changes made on load are told
// apart from the saved copy. A no-op unless this browser connected to a server before.
initSync()

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
