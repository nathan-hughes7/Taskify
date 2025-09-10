import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { CashuProvider } from './context/CashuContext.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CashuProvider>
      <App />
    </CashuProvider>
  </StrictMode>,
)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js');
  });
}
