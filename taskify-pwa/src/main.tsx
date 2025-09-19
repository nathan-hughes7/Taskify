import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { CashuProvider } from './context/CashuContext.tsx'
import { NwcProvider } from './context/NwcContext.tsx'
import { ToastProvider } from './context/ToastContext.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <NwcProvider>
        <CashuProvider>
          <App />
        </CashuProvider>
      </NwcProvider>
    </ToastProvider>
  </StrictMode>,
)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js');
  });
}
