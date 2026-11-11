// API client: bearer tokens with silent refresh, offline-aware responses.
import { CONFIG } from './config.js';

const REFRESH_KEY = 'kodi.refresh';
const PROFILE_KEY = 'kodi.profile';
const ACCESS_KEY = 'kodi.access';

export class ApiError extends Error {
  constructor(status, message, body = null) {
    super(message);
    this.status = status;
    this.body = body;
    this.offline = status === 0 || (body && body.code === 'offline');
  }
}

export const authEvents = new EventTarget();
/** 'reachable' / 'unreachable': whether the Kodi server itself answered (the
 * phone can be online while the server or the route to it is down). */
export const netEvents = new EventTarget();
const reachability = (ok) => netEvents.dispatchEvent(new CustomEvent(ok ? 'reachable' : 'unreachable'));

const store = {
  get(key, storage = localStorage) { try { return storage.getItem(key); } catch { return null; } },
  set(key, value, storage = localStorage) {
    try { value == null ? storage.removeItem(key) : storage.setItem(key, value); } catch { /* private mode */ }
  },
};

let accessToken = store.get(ACCESS_KEY, sessionStorage);
let accessExpiresAt = Number(store.get(`${ACCESS_KEY}.exp`, sessionStorage) || 0);
let refreshing = null;

function saveTokens(data) {
  accessToken = data.access_token;
  accessExpiresAt = Date.now() + (data.expires_in - 30) * 1000;
  store.set(ACCESS_KEY, accessToken, sessionStorage);
  store.set(`${ACCESS_KEY}.exp`, String(accessExpiresAt), sessionStorage);
  store.set(REFRESH_KEY, data.refresh_token);
}

function clearTokens() {
  accessToken = null;
  accessExpiresAt = 0;
  store.set(ACCESS_KEY, null, sessionStorage);
  store.set(`${ACCESS_KEY}.exp`, null, sessionStorage);
  store.set(REFRESH_KEY, null);
}

export const session = {
  get isSignedIn() { return Boolean(store.get(REFRESH_KEY)); },
  get profile() { try { return JSON.parse(store.get(PROFILE_KEY) || 'null'); } catch { return null; } },
  set profile(value) { store.set(PROFILE_KEY, value ? JSON.stringify(value) : null); },
};

async function rawFetch(path, { method = 'GET', body, headers = {}, token } = {}) {
  const init = { method, headers: { Accept: 'application/json', ...headers } };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(`${CONFIG.apiBase}${path}`, init);
    reachability(res.headers.get('X-Kodi-Offline') !== '1');
    return res;
  } catch (err) {
    reachability(false);
    throw new ApiError(0, 'You are offline. Check your connection and try again.');
  }
}

async function refreshAccess() {
  const refreshToken = store.get(REFRESH_KEY);
  if (!refreshToken) throw new ApiError(401, 'Please sign in.');
  if (!refreshing) {
    refreshing = (async () => {
      const res = await rawFetch('/api/v1/auth/refresh', { method: 'POST', body: { refresh_token: refreshToken } });
      if (res.status === 401) {
        clearTokens();
        authEvents.dispatchEvent(new CustomEvent('expired'));
        throw new ApiError(401, 'Your session has ended. Please sign in again.');
      }
      if (!res.ok) throw new ApiError(res.status, 'Could not refresh your session.');
      saveTokens(await res.json());
      return accessToken;
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

/** A valid access token, refreshing it first if it is about to expire. */
export async function freshToken() {
  if (accessToken && Date.now() < accessExpiresAt) return accessToken;
  return refreshAccess();
}

async function parse(res) {
  const type = res.headers.get('Content-Type') || '';
  if (type.includes('application/json')) return res.json();
  return res.blob();
}

/**
 * Call the API. Returns `{ data, offline, cachedAt }` when `withMeta` is set,
 * otherwise just the data. Responses served by the service worker from its
 * offline cache carry `offline: true`.
 */
export async function api(path, { method = 'GET', body, auth = true, withMeta = false } = {}) {
  let token = null;
  if (auth) {
    try { token = await freshToken(); } catch (err) { if (!err.offline) throw err; token = accessToken; }
  }
  let res = await rawFetch(path, { method, body, token });
  if (res.status === 401 && auth) {
    token = await refreshAccess();
    res = await rawFetch(path, { method, body, token });
  }
  const data = res.status === 204 ? null : await parse(res).catch(() => null);
  if (!res.ok) {
    const detail = data && typeof data === 'object' && !(data instanceof Blob) ? data.detail : null;
    const message = Array.isArray(detail) ? detail.map((d) => d.msg).join('; ') : (detail || `Request failed (${res.status})`);
    throw new ApiError(res.status, message, data);
  }
  if (!withMeta) return data;
  return { data, offline: res.headers.get('X-Kodi-Offline') === '1', cachedAt: res.headers.get('X-Kodi-Cached-At') };
}

export async function login(phone, password) {
  const res = await rawFetch('/api/v1/auth/login', { method: 'POST', body: { phone, password } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = Array.isArray(data.detail) ? data.detail.map((d) => d.msg.replace(/^Value error, /, '')).join('; ') : data.detail;
    throw new ApiError(res.status, detail || 'Sign-in failed');
  }
  return adoptSession(data);
}

/** Store tokens from register / login / accept-invite and load the profile. */
export async function adoptSession(data) {
  saveTokens(data);
  const profile = await api('/api/v1/auth/me');
  session.profile = profile;
  authEvents.dispatchEvent(new CustomEvent('login', { detail: profile }));
  return profile;
}

/** Re-read the profile (memberships, tenancies) after they change. */
export async function reloadProfile() {
  const profile = await api('/api/v1/auth/me');
  session.profile = profile;
  authEvents.dispatchEvent(new CustomEvent('profile', { detail: profile }));
  return profile;
}

export async function logout() {
  const refreshToken = store.get(REFRESH_KEY);
  if (refreshToken) {
    rawFetch('/api/v1/auth/logout', { method: 'POST', body: { refresh_token: refreshToken } }).catch(() => {});
  }
  clearTokens();
  session.profile = null;
  authEvents.dispatchEvent(new CustomEvent('logout'));
}

/** Download a file (PDF/CSV) through the API with auth, saving it on the device. */
export async function download(path, fallbackName) {
  const { data, offline } = await api(path, { withMeta: true });
  if (!(data instanceof Blob)) throw new ApiError(500, 'Unexpected response for a file download');
  const url = URL.createObjectURL(data);
  const a = Object.assign(document.createElement('a'), { href: url, download: fallbackName });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return { offline };
}
