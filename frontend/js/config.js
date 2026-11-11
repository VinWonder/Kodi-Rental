// Runtime configuration. When the PWA is served by the API itself (default,
// http://localhost:8000) the API is same-origin. When opened through VS Code
// Live Server (port 5500) it talks to the API on port 8000.
const sameOrigin = location.port !== '5500';

export const CONFIG = Object.freeze({
  appName: 'Kodi Rentals',
  apiBase: sameOrigin ? '' : `${location.protocol}//${location.hostname}:8000`,
  locale: 'en-KE',
  currency: 'KES',
  installDismissDays: 14,
  offlineRefreshMinutes: 30,
});
