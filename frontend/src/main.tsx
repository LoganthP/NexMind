import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useSettings } from './lib/store'
import './index.css'

if (typeof window !== 'undefined') {
  window.__NEXMIND_BUILD__ = typeof __BUILD__ !== 'undefined' ? __BUILD__ : 'dev'
}

document.documentElement.dataset.solid = String(useSettings.getState().solid)
document.documentElement.dataset.perf = String(useSettings.getState().perf)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label="NexMind could not start">
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)
