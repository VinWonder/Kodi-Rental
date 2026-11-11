// "Offline pack": the statements, invoices, receipts and reports a user is most
// likely to need without data. Fetched in the background through the service
// worker so they can be read later with no connection.
import { api, freshToken, session } from './api.js';
import { postToSW } from './pwa.js';
import { CONFIG } from './config.js';

const LAST_SYNC_KEY = 'kodi.offline.lastSync';
const OWNER_KEY = 'kodi.offline.owner';
const MAX_RECEIPTS = 12;
const FINANCE_ROLES = new Set(['owner', 'manager', 'accountant']);

export const lastSync = () => { try { return localStorage.getItem(LAST_SYNC_KEY); } catch { return null; } };

/** Wipe cached records if they belong to someone else (shared phones are common). */
export async function guardCacheOwner(userId) {
  let owner = null;
  try { owner = localStorage.getItem(OWNER_KEY); } catch { /* ignore */ }
  if (owner && owner !== userId) await clearOfflineData();
  try { localStorage.setItem(OWNER_KEY, userId); } catch { /* ignore */ }
}

export async function clearOfflineData() {
  try { await postToSW({ type: 'CLEAR_USER_DATA' }, 10000); } catch { /* no SW: nothing cached */ }
  try { localStorage.removeItem(LAST_SYNC_KEY); localStorage.removeItem(OWNER_KEY); } catch { /* ignore */ }
}

async function packUrls(profile) {
  const urls = ['/api/v1/auth/me', '/api/v1/notifications'];
  if (profile.tenancies.length) {
    urls.push('/api/v1/me/statement', '/api/v1/me/invoices', '/api/v1/me/payments', '/api/v1/me/leases',
              '/api/v1/me/issues');
    if (profile.tenancies.length === 1) urls.push('/api/v1/me/statement/export?format=pdf');
    try {
      const payments = await api('/api/v1/me/payments');
      payments.filter((p) => p.receipt_id).slice(0, MAX_RECEIPTS)
        .forEach((p) => urls.push(`/api/v1/me/receipts/${p.receipt_id}/pdf`));
    } catch { /* offline: keep what is already cached */ }
  }
  for (const m of profile.memberships) {
    const base = `/api/v1/accounts/${m.account_id}`;
    urls.push(`${base}/dashboard`, `${base}/reports/occupancy`, `${base}/issues`);
    if (FINANCE_ROLES.has(m.role)) {
      urls.push(`${base}/invoices`, `${base}/payments`, `${base}/reports/defaulters`,
                `${base}/reports/monthly-revenue`, `${base}/reports/maintenance-overhead`,
                `${base}/reports/unit-financials`, `${base}/reports/exports`);
    }
  }
  return urls;
}

/** Refresh the offline pack. Safe to call often; skips when offline. */
export async function refreshOfflinePack({ force = false } = {}) {
  const profile = session.profile;
  if (!profile || !navigator.onLine || !('serviceWorker' in navigator)) return null;
  const last = lastSync();
  if (!force && last && Date.now() - new Date(last).getTime() < CONFIG.offlineRefreshMinutes * 60000) return null;
  const token = await freshToken();
  const urls = await packUrls(profile);
  const result = await postToSW({ type: 'WARM_CACHE', urls, token }, 60000);
  const ok = result.results.filter((r) => r.ok).length;
  if (ok) try { localStorage.setItem(LAST_SYNC_KEY, result.at); } catch { /* ignore */ }
  return { ok, total: urls.length, failed: result.results.filter((r) => !r.ok) };
}

export async function offlineStatus() {
  try {
    const status = await postToSW({ type: 'CACHE_STATUS' }, 10000);
    return { ...status, lastSync: lastSync() };
  } catch {
    return { version: null, data: [], files: [], lastSync: lastSync() };
  }
}

/** Ask the browser not to evict our cache under storage pressure. */
export async function requestPersistentStorage() {
  if (!navigator.storage || !navigator.storage.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
