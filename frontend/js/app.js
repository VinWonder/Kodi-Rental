// App shell: routing, sign-in, and the Phase 3 screens (home, offline
// statement, notifications & offline settings). Phase 4 adds the full UI.
import { api, ApiError, authEvents, download, login, logout, session } from './api.js';
import {
  canInstall, currentPushSubscription, disablePush, enablePush, isStandalone, promptInstall, pushSupport,
  pwaEvents, registerServiceWorker, setupConnectivity, setupInstallBanners, syncPushSubscription,
} from './pwa.js';
import { clearOfflineData, guardCacheOwner, offlineStatus, refreshOfflinePack, requestPersistentStorage } from './offline.js';
import { esc, fmtDate, fmtMoney, fmtTime, setBusy, timeAgo, toast } from './ui.js';

const main = document.getElementById('main');
const PHASE4_ROUTES = new Set(['invoices', 'payments', 'issues', 'chat', 'units', 'leases', 'reports', 'notifications']);

// ------------------------------------------------------------------ helpers
function savedNote(meta) {
  if (!meta || !meta.offline) return '';
  return `<p class="kodi-offline-note mb-2">Offline: showing the copy saved ${esc(timeAgo(meta.cachedAt))}.</p>`;
}

function errorCard(err) {
  const offline = err instanceof ApiError && err.offline;
  return `<div class="kodi-card text-center">
    <h2 class="h6 mb-1">${offline ? 'Not saved for offline use yet' : 'Something went wrong'}</h2>
    <p class="text-secondary small mb-0">${esc(offline ? 'Open this screen once while online and Kodi will keep a copy.' : err.message)}</p>
  </div>`;
}

const activeTenancy = (profile) => profile.tenancies[0] || null;
const activeMembership = (profile) => profile.memberships[0] || null;

// ------------------------------------------------------------------ views
function renderLogin() {
  main.innerHTML = `
    <section class="row justify-content-center pt-3 pt-md-5">
      <div class="col-12 col-sm-10 col-md-7 col-lg-5">
        <div class="kodi-card p-4">
          <div class="text-center mb-4">
            <img src="/icons/icon-192.png" alt="" width="64" height="64" class="rounded-4 shadow-sm mb-3">
            <h1 class="h4 fw-bold mb-1">Welcome to Kodi</h1>
            <p class="text-secondary small mb-0">Rent, receipts and repairs without a caretaker.</p>
          </div>
          <form id="login-form" novalidate>
            <div class="mb-3">
              <label class="form-label small fw-semibold" for="phone">M-Pesa phone number</label>
              <input class="form-control form-control-lg" id="phone" name="phone" type="tel" inputmode="tel"
                     autocomplete="tel" placeholder="0712 345 678" required>
            </div>
            <div class="mb-3">
              <label class="form-label small fw-semibold" for="password">Password</label>
              <input class="form-control form-control-lg" id="password" name="password" type="password"
                     autocomplete="current-password" required minlength="8">
            </div>
            <div class="text-danger small mb-3 d-none" id="login-error" role="alert"></div>
            <button class="btn btn-primary btn-lg w-100" type="submit">Sign in</button>
          </form>
        </div>
      </div>
    </section>`;
  const form = document.getElementById('login-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type=submit]');
    const errorBox = document.getElementById('login-error');
    errorBox.classList.add('d-none');
    setBusy(button, true, 'Signing in…');
    try {
      await login(form.phone.value, form.password.value);
      window.location.hash = '#/';
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.classList.remove('d-none');
    } finally {
      setBusy(button, false);
    }
  });
}

async function renderTenantHome(profile) {
  const tenancy = activeTenancy(profile);
  main.innerHTML = `
    <h1 class="h4 fw-bold mb-1">Hello, ${esc(profile.user.full_name.split(' ')[0])}</h1>
    <p class="text-secondary small mb-3">${esc(tenancy.property_name || tenancy.business_name)}${tenancy.unit_number ? `, unit ${esc(tenancy.unit_number)}` : ''}</p>
    <div class="kodi-grid">
      <section class="kodi-card" id="balance-card"><div class="placeholder-glow"><span class="placeholder col-6"></span></div></section>
      <section class="kodi-card" id="payments-card"><div class="placeholder-glow"><span class="placeholder col-8"></span></div></section>
    </div>`;

  try {
    const { data: rows, ...meta } = await api('/api/v1/me/statement', { withMeta: true });
    const balance = rows.length ? Number(rows[rows.length - 1].running_balance) : 0;
    document.getElementById('balance-card').innerHTML = `
      ${savedNote(meta)}
      <div class="text-secondary small">${balance > 0 ? 'Balance due' : balance < 0 ? 'Credit on your account' : 'You are all paid up'}</div>
      <div class="kodi-stat ${balance > 0 ? 'text-danger' : 'text-success'}">${esc(fmtMoney(Math.abs(balance)))}</div>
      <div class="d-flex gap-2 mt-3 flex-wrap">
        <a class="btn btn-primary btn-sm" href="#/statement">View statement</a>
        <button class="btn btn-light btn-sm" data-download="/api/v1/me/statement/export?format=pdf" data-name="my-statement.pdf">Statement PDF</button>
      </div>`;
  } catch (err) {
    document.getElementById('balance-card').innerHTML = errorCard(err);
  }

  try {
    const { data: payments, ...meta } = await api('/api/v1/me/payments', { withMeta: true });
    document.getElementById('payments-card').innerHTML = `
      ${savedNote(meta)}
      <h2 class="h6 fw-bold">Recent payments</h2>
      ${payments.length ? `<ul class="kodi-list">${payments.slice(0, 5).map((p) => `
        <li>
          <span><span class="d-block">${esc(fmtDate(p.paid_at))}</span>
            <span class="text-secondary small">${esc(p.mpesa_receipt_number || p.method.replace(/_/g, ' '))}</span></span>
          <span class="text-end"><span class="kodi-amount d-block">${esc(fmtMoney(p.amount))}</span>
            ${p.receipt_id ? `<button class="btn btn-link btn-sm p-0" data-download="/api/v1/me/receipts/${esc(p.receipt_id)}/pdf"
              data-name="${esc(p.receipt_number || 'receipt')}.pdf">Receipt</button>` : ''}</span>
        </li>`).join('')}</ul>` : '<p class="text-secondary small mb-0">No payments yet.</p>'}`;
  } catch (err) {
    document.getElementById('payments-card').innerHTML = errorCard(err);
  }
}

async function renderLandlordHome(profile) {
  const m = activeMembership(profile);
  const base = `/api/v1/accounts/${m.account_id}`;
  main.innerHTML = `
    <h1 class="h4 fw-bold mb-1">${esc(m.business_name)}</h1>
    <p class="text-secondary small mb-3">Signed in as ${esc(m.role)}</p>
    <div id="dash" class="kodi-grid"><section class="kodi-card placeholder-glow"><span class="placeholder col-7"></span></section></div>
    <section class="kodi-card mt-3">
      <h2 class="h6 fw-bold">Download statements</h2>
      <p class="text-secondary small">PDF for printing and sharing, CSV for Excel.</p>
      <div class="d-flex flex-wrap gap-2" id="exports">
        ${[['monthly_revenue', 'Monthly revenue'], ['defaulters', 'Defaulters'], ['maintenance_overhead', 'Maintenance'], ['occupancy', 'Occupancy']]
          .map(([type, label]) => `<div class="btn-group">
            <button class="btn btn-light btn-sm" data-export="${type}" data-format="pdf">${label} PDF</button>
            <button class="btn btn-light btn-sm" data-export="${type}" data-format="csv">CSV</button></div>`).join('')}
      </div>
    </section>`;

  try {
    const { data: d, ...meta } = await api(`${base}/dashboard`, { withMeta: true });
    document.getElementById('dash').innerHTML = `
      <section class="kodi-card">${savedNote(meta)}<div class="text-secondary small">Occupancy</div>
        <div class="kodi-stat">${esc(d.occupancy.occupancy_rate_pct)}%</div>
        <div class="small text-secondary">${esc(d.occupancy.occupied)} of ${esc(d.occupancy.total_units)} units · ${esc(d.occupancy.vacant)} vacant</div></section>
      <section class="kodi-card"><div class="text-secondary small">Collected this month</div>
        <div class="kodi-stat text-success">${esc(fmtMoney(d.this_month.collected))}</div>
        <div class="small text-secondary">of ${esc(fmtMoney(d.this_month.invoiced))} invoiced</div></section>
      <section class="kodi-card"><div class="text-secondary small">In arrears</div>
        <div class="kodi-stat text-danger">${esc(fmtMoney(d.arrears.amount_overdue))}</div>
        <div class="small text-secondary">${esc(d.arrears.defaulters)} tenant(s)</div></section>`;
  } catch (err) {
    document.getElementById('dash').innerHTML = errorCard(err);
  }

  document.getElementById('exports').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-export]');
    if (!button) return;
    setBusy(button, true, 'Preparing…');
    try {
      const exp = await api(`${base}/reports/exports`, { method: 'POST',
        body: { report_type: button.dataset.export, format: button.dataset.format } });
      await download(`${base}/reports/exports/${exp.id}/download`, exp.filename);
    } catch (err) {
      toast(err.message, { variant: 'danger' });
    } finally {
      setBusy(button, false);
    }
  });
}

async function renderStatement(profile) {
  if (!profile.tenancies.length) {
    main.innerHTML = '<div class="kodi-card">Statements for your tenants are under each tenant (Phase 4).</div>';
    return;
  }
  main.innerHTML = `<div class="d-flex align-items-center gap-2 mb-3">
      <h1 class="h4 fw-bold mb-0 me-auto">My statement</h1>
      <button class="btn btn-light btn-sm" data-download="/api/v1/me/statement/export?format=csv" data-name="my-statement.csv">CSV</button>
      <button class="btn btn-primary btn-sm" data-download="/api/v1/me/statement/export?format=pdf" data-name="my-statement.pdf">PDF</button>
    </div><section class="kodi-card" id="statement"><div class="placeholder-glow"><span class="placeholder col-10"></span></div></section>`;
  try {
    const { data: rows, ...meta } = await api('/api/v1/me/statement', { withMeta: true });
    document.getElementById('statement').innerHTML = `${savedNote(meta)}
      ${rows.length ? `
        <ul class="kodi-list d-md-none">${rows.map((r) => `
          <li><span><span class="d-block">${esc(r.description)}</span>
            <span class="text-secondary small">${esc(fmtDate(r.entry_date))}${r.reference ? ` · ${esc(r.reference)}` : ''}</span></span>
            <span class="text-end"><span class="kodi-amount d-block ${Number(r.credit) ? 'text-success' : ''}">${Number(r.credit) ? `−${esc(fmtMoney(r.credit))}` : esc(fmtMoney(r.debit))}</span>
            <span class="text-secondary small kodi-amount">Bal ${esc(fmtMoney(r.running_balance))}</span></span></li>`).join('')}</ul>
        <div class="table-responsive d-none d-md-block"><table class="table table-kodi table-sm align-middle mb-0">
        <thead><tr><th>Date</th><th>Details</th><th class="text-end">Charged</th><th class="text-end">Paid</th><th class="text-end">Balance</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td class="text-nowrap">${esc(fmtDate(r.entry_date))}</td>
          <td><span class="d-block">${esc(r.description)}</span><span class="text-secondary small">${esc(r.reference || '')}</span></td>
          <td class="text-end kodi-amount">${Number(r.debit) ? esc(fmtMoney(r.debit)) : ''}</td>
          <td class="text-end kodi-amount">${Number(r.credit) ? esc(fmtMoney(r.credit)) : ''}</td>
          <td class="text-end kodi-amount fw-semibold">${esc(fmtMoney(r.running_balance))}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="text-secondary mb-0">No entries yet.</p>'}`;
  } catch (err) {
    document.getElementById('statement').innerHTML = errorCard(err);
  }
}

async function renderSettings() {
  const push = pushSupport();
  const sub = await currentPushSubscription().catch(() => null);
  const status = await offlineStatus();
  main.innerHTML = `
    <h1 class="h4 fw-bold mb-3">Notifications &amp; offline</h1>
    <div class="kodi-grid">
      <section class="kodi-card">
        <h2 class="h6 fw-bold">Notifications</h2>
        <p class="text-secondary small">Rent reminders, M-Pesa confirmations, repair updates and messages, even when Kodi is closed.</p>
        ${push.supported ? `
          <div class="form-check form-switch mb-2">
            <input class="form-check-input" type="checkbox" role="switch" id="push-toggle" ${sub && push.permission === 'granted' ? 'checked' : ''}>
            <label class="form-check-label" for="push-toggle">Notifications on this device</label>
          </div>
          <button class="btn btn-light btn-sm" id="push-test" ${sub ? '' : 'disabled'}>Send a test notification</button>`
        : `<p class="small text-warning mb-0">${esc(push.reason)}</p>`}
      </section>
      <section class="kodi-card">
        <h2 class="h6 fw-bold">Install</h2>
        ${isStandalone() ? '<p class="small mb-0 text-success">Kodi is installed on this device.</p>'
          : canInstall() ? '<p class="small text-secondary">Add Kodi to your home screen for full-screen use and offline access.</p><button class="btn btn-primary btn-sm" id="install-now">Install Kodi</button>'
          : '<p class="small text-secondary mb-0">Use your browser menu: <strong>Install app</strong> or <strong>Add to Home Screen</strong> (Safari: Share, then Add to Home Screen).</p>'}
      </section>
      <section class="kodi-card">
        <h2 class="h6 fw-bold">Saved for offline</h2>
        <p class="small text-secondary mb-2">Last updated ${esc(timeAgo(status.lastSync))}. ${status.data.length} records and ${status.files.length} files on this device.</p>
        <ul class="kodi-list small mb-3">${[...status.files, ...status.data].slice(0, 8).map((e) => `
          <li><span class="text-truncate">${esc(e.url.replace(/^\/api\/v1\//, ''))}</span><span class="text-secondary text-nowrap">${esc(fmtTime(e.cachedAt))}</span></li>`).join('')}</ul>
        <div class="d-flex gap-2">
          <button class="btn btn-primary btn-sm" id="offline-refresh">Update now</button>
          <button class="btn btn-light btn-sm" id="offline-clear">Remove from device</button>
        </div>
        <p class="small text-secondary mt-2 mb-0">App version ${esc(status.version || 'not installed')}</p>
      </section>
    </div>`;

  document.getElementById('push-toggle')?.addEventListener('change', async (event) => {
    const input = event.target;
    input.disabled = true;
    try {
      if (input.checked) { await enablePush(); toast('Notifications are on.', { variant: 'success' }); }
      else { await disablePush(); toast('Notifications are off for this device.'); }
    } catch (err) {
      input.checked = !input.checked;
      toast(err.message, { variant: 'danger' });
    } finally {
      input.disabled = false;
      renderSettings();
    }
  });
  document.getElementById('push-test')?.addEventListener('click', async (event) => {
    setBusy(event.target, true, 'Sending…');
    try {
      const { devices } = await api('/api/v1/push/test', { method: 'POST' });
      toast(devices ? 'Test sent. Check your notifications.' : 'No device accepted the notification.', { variant: devices ? 'success' : 'warning' });
    } catch (err) { toast(err.message, { variant: 'danger' }); } finally { setBusy(event.target, false); }
  });
  document.getElementById('install-now')?.addEventListener('click', () => promptInstall().then(renderSettings));
  document.getElementById('offline-refresh').addEventListener('click', async (event) => {
    setBusy(event.target, true, 'Saving…');
    try {
      const result = await refreshOfflinePack({ force: true });
      toast(result ? `Saved ${result.ok} of ${result.total} items for offline use.` : 'Connect to the internet to update.',
        { variant: result ? 'success' : 'warning' });
    } catch (err) { toast(err.message, { variant: 'danger' }); } finally { renderSettings(); }
  });
  document.getElementById('offline-clear').addEventListener('click', async () => {
    await clearOfflineData();
    toast('Saved data removed from this device.');
    renderSettings();
  });
}

function renderComingSoon(route) {
  main.innerHTML = `<div class="kodi-card text-center py-5">
    <h1 class="h5 fw-bold text-capitalize">${esc(route)}</h1>
    <p class="text-secondary small mb-3">This screen is part of the full interface (Phase 4).</p>
    <a class="btn btn-primary btn-sm" href="#/">Back home</a></div>`;
}

// ------------------------------------------------------------------ router
async function route() {
  const path = (window.location.hash.replace(/^#\/?/, '') || '').split(/[/?]/)[0];
  const profile = session.profile;
  const signedIn = session.isSignedIn && profile;
  document.getElementById('user-menu').classList.toggle('d-none', !signedIn);
  if (!signedIn) { renderLogin(); return; }
  document.getElementById('user-menu-button').textContent = profile.user.full_name.split(' ')[0];

  if (path === 'settings') return renderSettings();
  if (path === 'statement') return renderStatement(profile);
  if (PHASE4_ROUTES.has(path)) return renderComingSoon(path);
  if (profile.memberships.length) return renderLandlordHome(profile);
  if (profile.tenancies.length) return renderTenantHome(profile);
  main.innerHTML = `<div class="kodi-card"><h1 class="h5 fw-bold">Welcome, ${esc(profile.user.full_name)}</h1>
    <p class="text-secondary mb-0">Your account is not linked to a property yet. Landlords: create your business account.
    Tenants: open the invite link your landlord sent you.</p></div>`;
}

// File downloads from any screen (receipts, statements).
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-download]');
  if (!button) return;
  setBusy(button, true, 'Downloading…');
  try {
    const { offline } = await download(button.dataset.download, button.dataset.name);
    if (offline) toast('Opened the copy saved on this device.', { variant: 'warning' });
  } catch (err) {
    toast(err.message, { variant: 'danger' });
  } finally {
    setBusy(button, false);
  }
});

// ------------------------------------------------------------------ boot
async function afterSignIn(profile) {
  await guardCacheOwner(profile.user.id);
  requestPersistentStorage().catch(() => {});
  syncPushSubscription().catch(() => {});
  refreshOfflinePack().catch(() => {});
}

authEvents.addEventListener('login', (e) => afterSignIn(e.detail));
authEvents.addEventListener('logout', () => { clearOfflineData(); window.location.hash = '#/'; route(); });
authEvents.addEventListener('expired', () => { toast('Please sign in again.', { variant: 'warning' }); route(); });
pwaEvents.addEventListener('online', () => refreshOfflinePack({ force: true }).catch(() => {}));
pwaEvents.addEventListener('push', (e) => toast(`${e.detail.title}: ${e.detail.body}`, { variant: 'primary',
  action: e.detail.url ? { label: 'Open', onClick: () => window.location.assign(e.detail.url) } : null }));

document.getElementById('logout-button').addEventListener('click', () => logout());
window.addEventListener('hashchange', route);

setupConnectivity();
setupInstallBanners();
registerServiceWorker().then(() => {
  if (session.isSignedIn && session.profile) afterSignIn(session.profile);
});
route();

// Keep the cached profile fresh (names, new tenancies) when online.
if (session.isSignedIn && navigator.onLine) {
  api('/api/v1/auth/me').then((p) => { session.profile = p; }).catch(() => {});
}
