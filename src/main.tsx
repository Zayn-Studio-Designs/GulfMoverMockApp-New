import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { reportError } from './lib/monitoring';

window.addEventListener('error', e => reportError(e.error ?? e.message, 'window.error'));
window.addEventListener('unhandledrejection', e => reportError(e.reason, 'unhandledrejection'));

// Installable PWA (production builds on HTTPS or localhost only). The worker caches the
// static app shell, never API data — see public/sw.js.
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => undefined); });
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
