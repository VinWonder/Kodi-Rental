// Settings: business profile, M-Pesa Daraja, team, contractors, and the
// device panel (notifications, install, offline data).
import { api, reloadProfile } from '../api.js';
import {
  badge, confirmDialog, copyText, counties, emptyState, errorBox, field, formModal, icon, label, pageHeader, select, skeleton,
} from '../components.js';
import { offlineStatus, clearOfflineData, refreshOfflinePack } from '../offline.js';
import {
  canInstall, currentPushSubscription, disablePush, enablePush, isStandalone, promptInstall, pushSupport,
} from '../pwa.js';
import { renderChrome, scopedMount } from '../shell.js';
import { acct, state } from '../state.js';
import { esc, fmtTime, setBusy, timeAgo, toast } from '../ui.js';
import { contractorModal } from './issues.js';

const TABS_LANDLORD = [['device', 'This device'], ['business', 'Business'], ['mpesa', 'M-Pesa'], ['team', 'Team'], ['contractors', 'Contractors']];

export async function settingsView(_, query) {
  const mount = scopedMount();
  const landlord = state.mode === 'landlord';
  const tab = landlord ? (query.tab || 'device') : 'device';
  const main = mount(`${pageHeader('Settings')}
    ${landlord ? `<ul class="nav kodi-tabs mb-3 flex-nowrap overflow-auto">${TABS_LANDLORD.map(([k, t]) => `<li class="nav-item"><a class="nav-link text-nowrap ${k === tab ? 'active' : ''}" href="#/settings?tab=${k}">${t}</a></li>`).join('')}</ul>` : ''}
    <div id="settings">${skeleton(3)}</div>`);
  const box = main.querySelector('#settings');
  const panels = { device: devicePanel, business: businessPanel, mpesa: mpesaPanel, team: teamPanel, contractors: contractorsPanel };
  try { await (panels[tab] || devicePanel)(box); } catch (err) { box.innerHTML = errorBox(err); }
}

// ------------------------------------------------------------------ device: notifications / install / offline
async function devicePanel(box) {
  const push = pushSupport();
  const sub = await currentPushSubscription().catch(() => null);
  const status = await offlineStatus();
  box.innerHTML = `<div class="kodi-grid">
    <section class="kodi-card">
      <h2 class="h6 fw-bold">${icon('bell', 18)} Notifications</h2>
      <p class="text-secondary small">Rent reminders, M-Pesa confirmations, repair updates, messages and missed calls, even when Kodi is closed.</p>
      ${push.supported ? `<div class="form-check form-switch mb-2"><input class="form-check-input" type="checkbox" role="switch" id="push-toggle" ${sub && push.permission === 'granted' ? 'checked' : ''}>
          <label class="form-check-label" for="push-toggle">Notifications on this device</label></div>
        <button class="btn btn-light btn-sm" id="push-test" ${sub ? '' : 'disabled'}>Send a test notification</button>`
        : `<p class="small text-warning mb-0">${esc(push.reason)}</p>`}
    </section>
    <section class="kodi-card">
      <h2 class="h6 fw-bold">${icon('download', 18)} Install</h2>
      ${isStandalone() ? '<p class="small mb-0 text-success">Kodi is installed on this device.</p>'
        : canInstall() ? '<p class="small text-secondary">Add Kodi to your home screen for full-screen use and offline access.</p><button class="btn btn-primary btn-sm" id="install-now">Install Kodi</button>'
          : '<p class="small text-secondary mb-0">Use your browser menu: <strong>Install app</strong> or <strong>Add to Home Screen</strong> (iPhone: Share, then Add to Home Screen).</p>'}
    </section>
    <section class="kodi-card">
      <h2 class="h6 fw-bold">${icon('layers', 18)} Saved for offline</h2>
      <p class="small text-secondary mb-2">Last updated ${esc(timeAgo(status.lastSync))}. ${status.data.length} records and ${status.files.length} files on this device.</p>
      <div class="d-flex gap-2"><button class="btn btn-primary btn-sm" id="offline-refresh">Update now</button>
        <button class="btn btn-light btn-sm" id="offline-clear">Remove from device</button></div>
      <p class="small text-secondary mt-2 mb-0">App version ${esc(status.version || 'not installed')}</p>
    </section>
    <section class="kodi-card">
      <h2 class="h6 fw-bold">${icon('users', 18)} Your profile</h2>
      <ul class="kodi-list small"><li><span>Name</span><span>${esc(state.user.full_name)}</span></li>
        <li><span>Phone</span><span>+${esc(state.user.phone)}</span></li>${state.user.email ? `<li><span>Email</span><span>${esc(state.user.email)}</span></li>` : ''}</ul>
      ${state.canSwitchMode ? `<button class="btn btn-light btn-sm mt-2" data-switch-mode>${icon('swap', 16)} Switch to ${state.mode === 'landlord' ? 'tenant' : 'landlord'} view</button>` : ''}
      ${!state.memberships.length ? `<a class="btn btn-light btn-sm mt-2" href="#/onboarding">${icon('building', 16)} I'm also a landlord</a>` : ''}
    </section></div>`;

  box.querySelector('#push-toggle')?.addEventListener('change', async (e) => {
    const input = e.target;
    input.disabled = true;
    try {
      if (input.checked) { await enablePush(); toast('Notifications are on.', { variant: 'success' }); }
      else { await disablePush(); toast('Notifications are off for this device.'); }
    } catch (err) { input.checked = !input.checked; toast(err.message, { variant: 'danger' }); }
    devicePanel(box);
  });
  box.querySelector('#push-test')?.addEventListener('click', async (e) => {
    setBusy(e.target, true, 'Sending…');
    try {
      const { devices } = await api('/api/v1/push/test', { method: 'POST' });
      toast(devices ? 'Test sent. Check your notifications.' : 'No device accepted the notification.', { variant: devices ? 'success' : 'warning' });
    } catch (err) { toast(err.message, { variant: 'danger' }); } finally { setBusy(e.target, false); }
  });
  box.querySelector('#install-now')?.addEventListener('click', () => promptInstall().then(() => devicePanel(box)));
  box.querySelector('#offline-refresh').addEventListener('click', async (e) => {
    setBusy(e.target, true, 'Saving…');
    try {
      const r = await refreshOfflinePack({ force: true });
      toast(r ? `Saved ${r.ok} of ${r.total} items for offline use.` : 'Connect to the internet to update.', { variant: r ? 'success' : 'warning' });
    } catch (err) { toast(err.message, { variant: 'danger' }); }
    devicePanel(box);
  });
  box.querySelector('#offline-clear').addEventListener('click', async () => { await clearOfflineData(); toast('Saved data removed from this device.'); devicePanel(box); });
}

// ------------------------------------------------------------------ business profile
async function businessPanel(box) {
  const [a, list] = await Promise.all([api(acct('')), counties()]);
  box.innerHTML = `<section class="kodi-card kodi-narrow"><form id="biz" class="kodi-form" novalidate>
    ${field('business_name', 'Business name', { required: true, value: a.business_name, attrs: 'minlength="2"' })}
    <div class="row g-3">${field('contact_phone', 'Contact phone', { type: 'tel', value: `0${String(a.contact_phone).slice(3)}`, col: 'col-md-6' })}
    ${field('contact_email', 'Contact email', { type: 'email', value: a.contact_email || '', col: 'col-md-6' })}
    ${select('county_id', 'County', list.map((c) => [c.id, c.name]), { value: a.county_id || '', col: 'col-md-6', dataType: 'number' })}
    ${field('kra_pin', 'KRA PIN', { value: a.kra_pin || '', col: 'col-md-6', attrs: 'pattern="[APap][0-9]{9}[A-Za-z]"' })}
    ${field('default_payment_due_days', 'Days to pay after an invoice', { type: 'number', value: a.default_payment_due_days, col: 'col-md-6', attrs: 'min="0" max="28"' })}</div>
    <button class="btn btn-primary mt-3" ${state.isOwner ? '' : 'disabled'}>Save</button>${state.isOwner ? '' : '<p class="small text-secondary mt-2 mb-0">Only the owner can change these.</p>'}
  </form></section>`;
  box.querySelector('#biz').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { business_name: f.business_name.value.trim(), contact_phone: f.contact_phone.value || null, contact_email: f.contact_email.value || null,
      county_id: f.county_id.value ? Number(f.county_id.value) : null, kra_pin: f.kra_pin.value ? f.kra_pin.value.toUpperCase() : null,
      default_payment_due_days: Number(f.default_payment_due_days.value) };
    try { await api(acct(''), { method: 'PATCH', body }); await reloadProfile(); renderChrome(); toast('Saved', { variant: 'success' }); }
    catch (err) { toast(err.message, { variant: 'danger' }); }
  });
}

// ------------------------------------------------------------------ M-Pesa Daraja
async function mpesaPanel(box) {
  if (!state.isStaff) { box.innerHTML = emptyState('shield', 'Only owners and managers can view M-Pesa settings'); return; }
  const s = await api(acct('/mpesa'));
  box.innerHTML = `<div class="row g-3"><div class="col-lg-7"><section class="kodi-card">
      <div class="kodi-mpesa-head mb-3"><span class="kodi-mpesa-logo">M-PESA</span><span class="small">${s.configured ? `${badge(s.environment === 'production' ? 'active' : 'pending', s.environment === 'production' ? 'success' : 'warning')} ${esc(label(s.environment))} · ${esc(label(s.shortcode_type))} ${esc(s.business_shortcode)}` : 'Not connected yet'}</span></div>
      <p class="small text-secondary">Connect your Paybill or Till through Safaricom's Daraja portal (developer.safaricom.co.ke). Keys are encrypted before they are stored.</p>
      <form id="mpesa" class="kodi-form" novalidate><div class="row g-3">
        ${select('environment', 'Environment', [['sandbox', 'Sandbox (testing)'], ['production', 'Production (live money)']], { value: s.environment || 'sandbox', col: 'col-md-6', placeholder: null })}
        ${select('shortcode_type', 'Type', [['paybill', 'Paybill'], ['till', 'Till (Buy Goods)']], { value: s.shortcode_type || 'paybill', col: 'col-md-6', placeholder: null })}
        ${field('business_shortcode', 'Business shortcode', { required: true, value: s.business_shortcode || '', col: 'col-md-6', attrs: 'pattern="[0-9]{5,7}"', placeholder: '174379 in sandbox' })}
        ${field('stk_party_b', 'Till number (Buy Goods only)', { value: s.stk_party_b || '', col: 'col-md-6', attrs: 'pattern="[0-9]{5,7}"' })}
        ${field('consumer_key', 'Consumer key', { required: true, col: 'col-12', attrs: 'minlength="10" autocomplete="off"', placeholder: s.configured ? '•••••••• (enter to replace)' : '' })}
        ${field('consumer_secret', 'Consumer secret', { type: 'password', required: true, col: 'col-md-6', attrs: 'minlength="10" autocomplete="off"' })}
        ${field('passkey', 'Lipa na M-Pesa passkey', { type: 'password', required: true, col: 'col-md-6', attrs: 'minlength="10" autocomplete="off"' })}
      </div><button class="btn btn-primary mt-3" ${state.isOwner ? '' : 'disabled'}>Save M-Pesa settings</button></form></section></div>
    <div class="col-lg-5"><section class="kodi-card">
      <h2 class="h6 fw-bold">Callback URLs</h2>
      ${s.configured ? `<p class="small text-secondary">Safaricom sends payment confirmations here. Each URL has a secret token unique to your business.</p>
        ${['stk_callback_url', 'c2b_confirmation_url', 'c2b_validation_url'].filter((k) => s[k]).map((k) => `<label class="small fw-semibold">${esc(label(k.replace('_url', '')))}</label>
          <div class="input-group input-group-sm mb-2"><input class="form-control" readonly value="${esc(s[k])}"><button class="btn btn-light" data-copy="${esc(s[k])}">${icon('copy', 14)}</button></div>`).join('')}
        ${String(s.stk_callback_url || '').startsWith('https://') ? '' : '<div class="alert alert-warning small">Safaricom needs a public <strong>https</strong> address. In development, run a tunnel (cloudflared/ngrok) and set KODI_PUBLIC_BASE_URL.</div>'}
        <button class="btn btn-success w-100" data-register ${state.isOwner ? '' : 'disabled'}>${icon('check', 16)} Register Paybill URLs with Safaricom</button>
        <p class="small text-secondary mt-2 mb-0">Do this once so payments made from the M-Pesa menu (not just prompts) reach Kodi.</p>`
        : '<p class="small text-secondary mb-0">Save your settings to get your callback URLs.</p>'}
    </section></div></div>`;
  box.querySelector('#mpesa').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (!f.checkValidity()) { f.classList.add('was-validated'); return; }
    const body = Object.fromEntries(new FormData(f));
    if (!body.stk_party_b) delete body.stk_party_b;
    const button = f.querySelector('button');
    setBusy(button, true, 'Saving…');
    try { await api(acct('/mpesa'), { method: 'PUT', body }); toast('M-Pesa connected', { variant: 'success' }); mpesaPanel(box); }
    catch (err) { toast(err.message, { variant: 'danger' }); setBusy(button, false); }
  });
  box.onclick = async (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) toast(await copyText(c.dataset.copy) ? 'Copied' : 'Copy failed');
    const reg = e.target.closest('[data-register]');
    if (reg) {
      setBusy(reg, true, 'Registering…');
      try { await api(acct('/mpesa/register-c2b'), { method: 'POST' }); toast('Registered with Safaricom', { variant: 'success' }); }
      catch (err) { toast(err.message, { variant: 'danger' }); } finally { setBusy(reg, false); }
    }
  };
}

// ------------------------------------------------------------------ team
async function teamPanel(box) {
  const members = await api(acct('/members'));
  box.innerHTML = `<section class="kodi-card kodi-narrow">
    <div class="d-flex justify-content-between align-items-center mb-2"><h2 class="h6 fw-bold mb-0">People with access</h2>
      ${state.isOwner ? `<button class="btn btn-primary btn-sm" data-add>${icon('plus', 14)} Add member</button>` : ''}</div>
    <p class="small text-secondary">Managers run day-to-day operations, accountants see finances only, viewers can only look. They must first register on Kodi with their phone number.</p>
    <ul class="kodi-list">${members.map((m) => `<li><span><strong class="d-block">${esc(m.full_name)}</strong><span class="small text-secondary">+${esc(m.phone)} · since ${esc(fmtTime(m.created_at))}</span></span>
      <span class="d-flex align-items-center gap-2">${badge(m.role, m.role === 'owner' ? 'primary' : 'secondary')}
      ${state.isOwner && m.user_id !== state.user.id ? `<button class="btn btn-sm btn-link text-danger" data-remove="${m.user_id}" aria-label="Remove">${icon('trash', 14)}</button>` : ''}</span></li>`).join('')}</ul></section>`;
  box.onclick = async (e) => {
    if (e.target.closest('[data-add]')) {
      const done = await formModal({ title: 'Add team member', submitLabel: 'Add',
        fields: `${field('phone', 'Their Kodi phone number', { type: 'tel', required: true })}${select('role', 'Role', [['manager', 'Manager'], ['accountant', 'Accountant'], ['viewer', 'Viewer'], ['owner', 'Co-owner']], { value: 'manager', placeholder: null })}`,
        onSubmit: (v) => api(acct('/members'), { method: 'POST', body: v }) });
      if (done) teamPanel(box);
    }
    const rm = e.target.closest('[data-remove]');
    if (rm && await confirmDialog('Remove this person\'s access?', { danger: true, confirmLabel: 'Remove' })) {
      try { await api(acct(`/members/${rm.dataset.remove}`), { method: 'DELETE' }); teamPanel(box); } catch (err) { toast(err.message, { variant: 'danger' }); }
    }
  };
}

// ------------------------------------------------------------------ contractors
async function contractorsPanel(box) {
  const list = await api(acct('/contractors?include_inactive=true'));
  box.innerHTML = `<section class="kodi-card">
    <div class="d-flex justify-content-between align-items-center mb-2"><h2 class="h6 fw-bold mb-0">Contractors (fundis)</h2>
      ${state.isStaff ? `<button class="btn btn-primary btn-sm" data-add>${icon('plus', 14)} Add contractor</button>` : ''}</div>
    ${list.length ? `<ul class="kodi-list">${list.map((c) => `<li><span><strong class="d-block">${esc(c.name)}${c.company_name ? ` · ${esc(c.company_name)}` : ''}</strong>
      <span class="small text-secondary">${(c.specialties || []).map((s) => esc(label(s))).join(', ') || 'General'} · <a href="tel:+${esc(c.phone)}">+${esc(c.phone)}</a></span></span>
      <span class="d-flex gap-1 align-items-center">${c.is_active ? '' : badge('inactive')}${state.isStaff ? `<button class="btn btn-sm btn-light" data-edit="${c.id}">${icon('pen', 14)}</button>` : ''}</span></li>`).join('')}</ul>`
      : emptyState('wrench', 'No contractors yet', 'Save your plumber, electrician and other fundis to dispatch them from repair tickets.')}</section>`;
  box.onclick = async (e) => {
    if (e.target.closest('[data-add]')) { if (await contractorModal()) contractorsPanel(box); }
    const ed = e.target.closest('[data-edit]');
    if (ed) { if (await contractorModal(list.find((c) => c.id === ed.dataset.edit))) contractorsPanel(box); }
  };
}
