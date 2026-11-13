/* Kodi Rentals service worker.
 *
 * Caches
 *   kodi-shell-<VERSION>  app shell, precached at install, replaced on update
 *   kodi-runtime-v1       other same-origin static files (stale-while-revalidate)
 *   kodi-data-v1          API JSON for offline reading (network-first)
 *   kodi-files-v1         receipt / statement / report PDFs & CSVs (cache-first)
 * Data and file caches hold the signed-in user's records: the app clears them
 * on logout and when a different user signs in (CLEAR_USER_DATA message).
 */
'use strict';

const VERSION = '3.0.0';
const SHELL_CACHE = `kodi-shell-${VERSION}`;
const RUNTIME_CACHE = 'kodi-runtime-v1';
const DATA_CACHE = 'kodi-data-v1';
const FILES_CACHE = 'kodi-files-v1';
const KEEP = [SHELL_CACHE, RUNTIME_CACHE, DATA_CACHE, FILES_CACHE];
const NETWORK_TIMEOUT_MS = 6000;
const MAX_FILES = 80;

const SHELL = [
  '/', '/index.html', '/offline.html', '/manifest.json',
  '/css/app.css', '/css/living.css',
  '/js/api.js', '/js/tilt.js', '/js/app.js', '/js/calls.js', '/js/components.js', '/js/config.js', '/js/offline.js', '/js/pwa.js',
  '/js/realtime.js', '/js/router.js', '/js/shell.js', '/js/state.js', '/js/theme.js', '/js/ui.js', '/js/views/auth.js',
  '/js/views/billing.js', '/js/views/chat.js', '/js/views/dashboard.js', '/js/views/home.js', '/js/views/issues.js',
  '/js/views/leases.js', '/js/views/properties.js', '/js/views/reports.js', '/js/views/settings.js',
  '/js/views/tenants.js', '/js/views/vacancies.js',
  '/vendor/bootstrap/bootstrap.min.css', '/vendor/bootstrap/bootstrap.bundle.min.js',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png', '/icons/badge-96.png', '/icons/favicon-32.png', '/icons/favicon.ico',
];

// API GETs worth keeping for offline reading (statements, invoices, receipts, reports).
const OFFLINE_DATA = [
  /^\/api\/v1\/auth\/me$/,
  /^\/api\/v1\/me\/(statement|invoices|payments|leases|issues|receipts)(\/[^/]+)?$/,
  /^\/api\/v1\/notifications$/,
  /^\/api\/v1\/accounts\/[^/]+\/(dashboard|invoices|payments|leases|issues)$/,
  /^\/api\/v1\/accounts\/[^/]+\/invoices\/[^/]+$/,
  /^\/api\/v1\/accounts\/[^/]+\/reports\/(defaulters|monthly-revenue|maintenance-overhead|occupancy|unit-financials|exports)$/,
  /^\/api\/v1\/accounts\/[^/]+\/tenants\/[^/]+\/statement$/,
  /^\/api\/v1\/accounts\/[^/]+\/receipts\/[^/]+$/,
  /^\/api\/v1\/accounts\/[^/]+\/(properties|tenants|units|leases|issues|contractors)(\/[^/]+)?$/,
  /^\/api\/v1\/accounts\/[^/]+$/,
  /^\/api\/v1\/conversations$/,
  /^\/api\/v1\/conversations\/[^/]+\/messages$/,
  /^\/api\/v1\/locations\/counties$/,
];
// Immutable files addressed by id: serve from cache when present.
const IMMUTABLE_FILES = [
  /^\/api\/v1\/media\/[^/]+$/,
  /^\/api\/v1\/me\/receipts\/[^/]+\/pdf$/,
  /^\/api\/v1\/accounts\/[^/]+\/receipts\/[^/]+\/pdf$/,
  /^\/api\/v1\/accounts\/[^/]+\/reports\/exports\/[^/]+\/download$/,
];
// Regenerated on demand: try the network, fall back to the last copy.
const FRESH_FILES = [/^\/api\/v1\/me\/statement\/export$/];
const NEVER_CACHE = [/^\/api\/v1\/auth\//, /^\/hooks\//, /^\/ws/, /^\/docs/, /^\/openapi\.json/, /^\/healthz/];

const matches = (patterns, path) => patterns.some((re) => re.test(path));

// ------------------------------------------------------------------ lifecycle
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })));
    // First install: take over immediately. Updates wait for the user to accept.
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('kodi-') && !KEEP.includes(n)).map((n) => caches.delete(n)));
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});

// ------------------------------------------------------------------ fetch routing
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;                 // writes always go to the network
  const url = new URL(request.url);
  if (!url.protocol.startsWith('http')) return;

  const isApi = url.pathname.startsWith('/api/');
  if (isApi || url.origin === self.location.origin) {
    if (matches(NEVER_CACHE, url.pathname)) return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }
  if (isApi) {
    if (matches(IMMUTABLE_FILES, url.pathname)) return event.respondWith(cacheFirst(request, FILES_CACHE));
    if (matches(FRESH_FILES, url.pathname)) return event.respondWith(networkFirst(request, FILES_CACHE));
    if (matches(OFFLINE_DATA, url.pathname)) return event.respondWith(networkFirst(request, DATA_CACHE));
    return event.respondWith(networkOnlyApi(request));
  }
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

async function handleNavigation(event) {
  try {
    const preloaded = await event.preloadResponse;
    if (preloaded) return preloaded;
    return await fetch(event.request);
  } catch (err) {
    const shell = await caches.match('/index.html', { ignoreSearch: true, ignoreVary: true });
    return shell || (await caches.match('/offline.html', { ignoreVary: true })) || Response.error();
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/** Copy a response, stamping when it was cached (read by the app's "last updated" labels). */
async function stamp(response) {
  const headers = new Headers(response.headers);
  headers.set('X-Kodi-Cached-At', new Date().toISOString());
  return new Response(await response.clone().blob(), { status: response.status, statusText: response.statusText, headers });
}

async function fromCache(cacheName, request, offline) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreVary: true });
  if (!hit || !offline) return hit;
  const headers = new Headers(hit.headers);
  headers.set('X-Kodi-Offline', '1');
  return new Response(await hit.blob(), { status: hit.status, statusText: hit.statusText, headers });
}

async function networkFirst(request, cacheName) {
  try {
    const response = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      await cache.put(request, await stamp(response));
    }
    return response;
  } catch (err) {
    const cached = await fromCache(cacheName, request, true);
    return cached || offlineJson();
  }
}

async function cacheFirst(request, cacheName) {
  const cached = await fromCache(cacheName, request, false);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      await cache.put(request, await stamp(response));
      trimCache(cacheName, MAX_FILES);
    }
    return response;
  } catch (err) {
    return offlineJson('This file has not been saved for offline use yet.');
  }
}

async function networkOnlyApi(request) {
  try {
    return await fetch(request);
  } catch (err) {
    return offlineJson();
  }
}

async function staleWhileRevalidate(request) {
  // ignoreVary: the server adds 'Vary: Origin, Accept-Encoding', and browsers send
  // an Origin header with module scripts but not with the precache requests, so a
  // strict match would miss every ES module offline.
  const shellHit = await caches.match(request, { ignoreSearch: true, ignoreVary: true, cacheName: SHELL_CACHE });
  const runtime = await caches.open(RUNTIME_CACHE);
  const runtimeHit = shellHit ? null : await runtime.match(request, { ignoreVary: true });
  const network = fetch(request).then(async (response) => {
    if (response.ok && response.type === 'basic' && !shellHit) await runtime.put(request, response.clone());
    return response;
  }).catch(() => null);
  return shellHit || runtimeHit || (await network) || Response.error();
}

function offlineJson(detail = 'You are offline and this data has not been saved on this device yet.') {
  return new Response(JSON.stringify({ detail, code: 'offline' }), {
    status: 503, headers: { 'Content-Type': 'application/json', 'X-Kodi-Offline': '1' },
  });
}

async function trimCache(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i += 1) await cache.delete(keys[i]);
}

// ------------------------------------------------------------------ messages from the app
self.addEventListener('message', (event) => {
  const msg = event.data || {};
  const reply = (data) => event.ports[0] && event.ports[0].postMessage(data);
  switch (msg.type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;
    case 'CLEAR_USER_DATA':
      event.waitUntil(Promise.all([caches.delete(DATA_CACHE), caches.delete(FILES_CACHE)]).then(() => reply({ ok: true })));
      break;
    case 'WARM_CACHE':
      event.waitUntil(warmCache(msg.urls || [], msg.token).then(reply));
      break;
    case 'CACHE_STATUS':
      event.waitUntil(cacheStatus().then(reply));
      break;
    case 'GET_VERSION':
      reply({ version: VERSION });
      break;
    default:
      break;
  }
});

/** Background refresh of the offline pack. The app passes a short-lived access
 * token because a service worker cannot read the app's storage. */
async function warmCache(urls, token) {
  const results = [];
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  await Promise.all(urls.map(async (href) => {
    const url = new URL(href, self.location.origin);
    const cacheName = matches(IMMUTABLE_FILES, url.pathname) || matches(FRESH_FILES, url.pathname) ? FILES_CACHE : DATA_CACHE;
    try {
      const request = new Request(url.href, { headers, credentials: 'omit' });
      if (cacheName === FILES_CACHE && matches(IMMUTABLE_FILES, url.pathname)
          && await (await caches.open(FILES_CACHE)).match(request, { ignoreVary: true })) {
        results.push({ url: url.pathname + url.search, ok: true, cached: true });
        return;
      }
      const response = await withTimeout(fetch(request), 20000);
      if (response.ok) await (await caches.open(cacheName)).put(request, await stamp(response));
      results.push({ url: url.pathname + url.search, ok: response.ok, status: response.status });
    } catch (err) {
      results.push({ url: url.pathname + url.search, ok: false, error: String(err && err.message || err) });
    }
  }));
  trimCache(FILES_CACHE, MAX_FILES);
  return { results, at: new Date().toISOString() };
}

async function cacheStatus() {
  const out = {};
  for (const name of [DATA_CACHE, FILES_CACHE]) {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    out[name] = await Promise.all(keys.map(async (req) => {
      const res = await cache.match(req, { ignoreVary: true });
      const u = new URL(req.url);
      return { url: u.pathname + u.search, cachedAt: res && res.headers.get('X-Kodi-Cached-At'),
               type: res && res.headers.get('Content-Type') };
    }));
  }
  return { version: VERSION, data: out[DATA_CACHE], files: out[FILES_CACHE] };
}

// ------------------------------------------------------------------ Web Push
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (err) { payload = { title: 'Kodi', body: event.data && event.data.text() }; }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = windows.find((c) => c.visibilityState === 'visible');
    if (visible) {
      // App is on screen: let it show an in-app toast instead of a system notification.
      visible.postMessage({ type: 'PUSH', payload });
      return;
    }
    if (self.navigator && 'setAppBadge' in self.navigator) {
      try { await self.navigator.setAppBadge(); } catch (err) { /* unsupported */ }
    }
    await self.registration.showNotification(payload.title || 'Kodi Rentals', {
      body: payload.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: payload.tag || undefined,
      renotify: Boolean(payload.tag),
      timestamp: Date.now(),
      vibrate: [120, 60, 120],
      data: { url: payload.url || '/', id: payload.id, type: payload.type },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin);
  event.waitUntil((async () => {
    if (self.navigator && 'clearAppBadge' in self.navigator) {
      try { await self.navigator.clearAppBadge(); } catch (err) { /* unsupported */ }
    }
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((c) => new URL(c.url).origin === self.location.origin);
    if (existing) {
      await existing.focus();
      existing.postMessage({ type: 'NAVIGATE', url: target.pathname + target.search + target.hash });
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});

// The browser rotated the push subscription: subscribe again with the same key
// and ask any open window to register it with the API (which needs auth).
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const options = event.oldSubscription && event.oldSubscription.options;
    if (options && options.applicationServerKey) {
      try { await self.registration.pushManager.subscribe(options); } catch (err) { /* re-synced on next app open */ }
    }
    const windows = await self.clients.matchAll({ type: 'window' });
    windows.forEach((c) => c.postMessage({ type: 'PUSH_SUBSCRIPTION_CHANGED' }));
  })());
});
