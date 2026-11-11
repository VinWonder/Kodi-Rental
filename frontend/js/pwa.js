// PWA plumbing: service worker registration & updates, install banners
// (Android/desktop prompt + iOS instructions), connectivity, Web Push.
import { CONFIG } from './config.js';
import { api, ApiError, netEvents } from './api.js';
import { toast } from './ui.js';

const DISMISS_KEY = 'kodi.install.dismissedAt';
let deferredPrompt = null;
let registration = null;

export const pwaEvents = new EventTarget();

// ------------------------------------------------------------------ environment
export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

export const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const isIOSSafari = () => isIOS() && /safari/i.test(navigator.userAgent) && !/crios|fxios|edgios/i.test(navigator.userAgent);

// ------------------------------------------------------------------ service worker
export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch (err) {
    console.warn('Service worker registration failed', err);
    return null;
  }

  const promptUpdate = (worker) => {
    toast('A new version of Kodi is ready.', {
      variant: 'primary', autohide: false,
      action: { label: 'Update', onClick: () => worker.postMessage({ type: 'SKIP_WAITING' }) },
    });
  };
  if (registration.waiting && navigator.serviceWorker.controller) promptUpdate(registration.waiting);
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) promptUpdate(worker);
    });
  });

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  navigator.serviceWorker.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type === 'NAVIGATE' && msg.url) window.location.assign(msg.url);
    if (msg.type === 'PUSH') pwaEvents.dispatchEvent(new CustomEvent('push', { detail: msg.payload }));
    if (msg.type === 'PUSH_SUBSCRIPTION_CHANGED') syncPushSubscription().catch(() => {});
  });

  // Check for a new version when the app comes back to the foreground.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') registration.update().catch(() => {});
  });
  return registration;
}

/** Send a message to the active service worker and await its reply. */
export async function postToSW(message, timeoutMs = 30000) {
  if (!('serviceWorker' in navigator)) throw new Error('Service workers are not supported in this browser');
  const reg = await navigator.serviceWorker.ready;
  const worker = navigator.serviceWorker.controller || reg.active;
  if (!worker) throw new Error('Service worker not active yet');
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => reject(new Error('Service worker did not answer')), timeoutMs);
    channel.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data); };
    worker.postMessage(message, [channel.port2]);
  });
}

// ------------------------------------------------------------------ install banners
function recentlyDismissed() {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY) || 0);
    return Date.now() - at < CONFIG.installDismissDays * 86400000;
  } catch { return false; }
}

function dismiss(el) {
  el.classList.add('d-none');
  try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* ignore */ }
}

export function canInstall() { return Boolean(deferredPrompt); }

export async function promptInstall() {
  if (!deferredPrompt) return 'unavailable';
  const promptEvent = deferredPrompt;
  deferredPrompt = null;
  document.getElementById('install-banner')?.classList.add('d-none');
  promptEvent.prompt();
  const { outcome } = await promptEvent.userChoice;
  pwaEvents.dispatchEvent(new CustomEvent('installchange'));
  return outcome;
}

export function setupInstallBanners() {
  const banner = document.getElementById('install-banner');
  const iosBanner = document.getElementById('ios-install-banner');

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();               // show our own banner instead of the mini-infobar
    deferredPrompt = event;
    pwaEvents.dispatchEvent(new CustomEvent('installchange'));
    if (!recentlyDismissed() && !isStandalone()) banner.classList.remove('d-none');
  });
  document.getElementById('install-accept').addEventListener('click', () => promptInstall());
  document.getElementById('install-dismiss').addEventListener('click', () => dismiss(banner));

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    banner.classList.add('d-none');
    pwaEvents.dispatchEvent(new CustomEvent('installchange'));
    toast('Kodi is installed. Open it from your home screen.', { variant: 'success' });
  });

  if (isIOSSafari() && !isStandalone() && !recentlyDismissed()) {
    setTimeout(() => iosBanner.classList.remove('d-none'), 2500);
  }
  document.getElementById('ios-install-dismiss').addEventListener('click', () => dismiss(iosBanner));
}

// ------------------------------------------------------------------ connectivity
export function setupConnectivity() {
  const pill = document.getElementById('net-status');
  let serverReachable = true;
  const update = () => {
    const online = navigator.onLine;
    const live = online && serverReachable;
    document.body.classList.toggle('is-offline', !live);
    pill.textContent = !online ? 'Offline' : live ? 'Online' : 'Saved data';
    pill.title = live ? 'Connected' : online ? 'Kodi is unreachable: showing data saved on this device' : 'Showing saved data';
  };
  netEvents.addEventListener('reachable', () => {
    const recovered = !serverReachable;
    serverReachable = true;
    update();
    if (recovered && navigator.onLine) pwaEvents.dispatchEvent(new CustomEvent('online'));
  });
  netEvents.addEventListener('unreachable', () => { serverReachable = false; update(); });
  window.addEventListener('online', () => {
    update();
    toast('Back online. Refreshing your data…', { variant: 'success', delay: 2500 });
    pwaEvents.dispatchEvent(new CustomEvent('online'));
  });
  window.addEventListener('offline', () => {
    update();
    toast('You are offline. Saved statements and receipts are still available.', { variant: 'warning' });
  });
  update();
}

// ------------------------------------------------------------------ Web Push
export function pushSupport() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return { supported: false, reason: isIOS() && !isStandalone()
      ? 'On iPhone/iPad, add Kodi to your Home Screen first, then enable notifications from the installed app.'
      : 'This browser does not support push notifications.' };
  }
  return { supported: true, permission: Notification.permission };
}

function keyToBytes(base64url) {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function sameKey(subscription, keyBytes) {
  const current = subscription.options && subscription.options.applicationServerKey;
  if (!current) return true;
  const a = new Uint8Array(current);
  return a.length === keyBytes.length && a.every((b, i) => b === keyBytes[i]);
}

async function serverKey() {
  const cfg = await api('/api/v1/push/config', { auth: false });
  if (!cfg.enabled) throw new ApiError(503, 'Notifications are not set up on the server yet.');
  return keyToBytes(cfg.public_key);
}

async function saveSubscription(sub) {
  const json = sub.toJSON();
  await api('/api/v1/push-subscriptions', { method: 'POST', body: { endpoint: json.endpoint, keys: json.keys } });
}

export async function currentPushSubscription() {
  if (!pushSupport().supported) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** Ask permission (must run from a tap/click) and register this device. */
export async function enablePush() {
  const support = pushSupport();
  if (!support.supported) throw new Error(support.reason);
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied'
      ? 'Notifications are blocked. Allow them for this site in your browser settings.'
      : 'Notifications were not enabled.');
  }
  const key = await serverKey();
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, key)) { await sub.unsubscribe(); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await saveSubscription(sub);
  return sub;
}

export async function disablePush() {
  const sub = await currentPushSubscription();
  if (!sub) return;
  await api('/api/v1/push-subscriptions', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe();
}

/** On every sign-in/app start: make sure the server knows this device's
 * current subscription (browsers rotate them; the user may have switched). */
export async function syncPushSubscription() {
  if (!pushSupport().supported || Notification.permission !== 'granted') return false;
  const key = await serverKey();
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, key)) { await sub.unsubscribe(); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await saveSubscription(sub);
  return true;
}
