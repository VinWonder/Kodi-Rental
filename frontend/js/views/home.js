// Tenant home and the notifications page.
import { api } from '../api.js';
import { badge, emptyState, errorBox, icon, pageHeader, skeleton } from '../components.js';
import { live, scopedMount, setUnread } from '../shell.js';
import { state } from '../state.js';
import { esc, fmtDate, fmtMoney, timeAgo } from '../ui.js';
import { stkPushFlow } from './billing.js';

export async function tenantHomeView() {
  const mount = scopedMount();
  const t = state.tenancy;
  const main = mount(`<section class="kodi-hero mb-3">
      <div><p class="mb-1 opacity-75 small">${esc(t?.business_name || '')}</p>
        <h1 class="h4 fw-bold mb-0">Hello, ${esc(state.user.full_name.split(' ')[0])}</h1>
        <p class="mb-0 opacity-75 small">${t?.unit_number ? `Unit ${esc(t.unit_number)} · ${esc(t.property_name)}` : 'Welcome to Kodi'}</p></div>
      <div class="kodi-hero-balance" id="balance"><span class="placeholder col-8"></span></div>
    </section>
    <div id="lease-alert"></div>
    <div class="kodi-quick mb-3">
      <a href="#/invoices">${icon('cash')}<span>Pay rent</span></a>
      <a href="#/issues?new=1">${icon('wrench')}<span>Report a problem</span></a>
      <a href="#/chat">${icon('chat')}<span>Message landlord</span></a>
      <a href="#/statement">${icon('receipt')}<span>Statement</span></a>
    </div>
    <div class="row g-3">
      <div class="col-lg-6"><section class="kodi-card h-100" id="due">${skeleton(2)}</section></div>
      <div class="col-lg-6"><section class="kodi-card h-100" id="repairs">${skeleton(2)}</section></div>
    </div>`);

  const load = async () => {
    try {
      const [invoicesRes, leases, issues, statement] = await Promise.all([
        api('/api/v1/me/invoices', { withMeta: true }),
        api('/api/v1/me/leases').catch(() => []),
        api('/api/v1/me/issues').catch(() => []),
        api('/api/v1/me/statement').catch(() => []),
      ]);
      const invoices = invoicesRes.data;
      const open = invoices.filter((i) => ['issued', 'partially_paid', 'overdue'].includes(i.status));
      const balance = statement.length ? Number(statement.at(-1).running_balance) : open.reduce((a, i) => a + Number(i.balance), 0);
      main.querySelector('#balance').innerHTML = `<span class="small opacity-75">${balance > 0 ? 'Balance due' : balance < 0 ? 'Credit' : 'All paid up'}</span>
        <strong>${esc(fmtMoney(Math.abs(balance)))}</strong>${invoicesRes.offline ? '<span class="small opacity-75">Saved copy</span>' : ''}`;
      const pending = leases.find((l) => l.status === 'pending_signature');
      main.querySelector('#lease-alert').innerHTML = pending ? `<a class="kodi-alert kodi-alert-warning mb-3" href="#/lease">${icon('pen', 18)}
        <span><strong>Your lease is ready to sign.</strong> Sign it to activate your tenancy.</span></a>` : '';
      main.querySelector('#due').innerHTML = `<h2 class="h6 fw-bold">Due now</h2>${open.length ? `<ul class="kodi-list">${open.map((i) => `<li>
          <span><strong class="d-block">${esc(fmtMoney(i.balance))}</strong><span class="small ${i.status === 'overdue' ? 'text-danger' : 'text-secondary'}">${esc(i.invoice_number)} · due ${esc(fmtDate(i.due_date))}</span></span>
          <button class="btn btn-success btn-sm" data-pay="${i.id}" ${invoicesRes.offline ? 'disabled' : ''}>${icon('phone', 14)} Pay</button></li>`).join('')}</ul>`
        : `<div class="text-center py-3"><div class="kodi-success-burst sm mx-auto">${icon('check', 24)}</div><p class="small text-secondary mt-2 mb-0">Nothing due. Thank you!</p></div>`}`;
      main.querySelector('#repairs').innerHTML = `<div class="d-flex justify-content-between"><h2 class="h6 fw-bold">My repairs</h2><a class="small" href="#/issues">All</a></div>
        ${issues.length ? `<ul class="kodi-list">${issues.slice(0, 4).map((i) => `<li><a href="#/issues/${i.id}" class="text-decoration-none text-body"><strong class="d-block">${esc(i.title)}</strong>
          <span class="small text-secondary">${esc(i.ticket_number)} · ${esc(timeAgo(i.updated_at))}</span></a>${badge(i.status)}</li>`).join('')}</ul>`
          : '<p class="small text-secondary mb-0">No repairs reported. Something broken? Tap "Report a problem".</p>'}`;
      main.querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', async () => {
        await stkPushFlow(open.find((i) => i.id === b.dataset.pay), { tenantSelf: true });
        load();
      }));
    } catch (err) { main.querySelector('#due').innerHTML = errorBox(err); }
  };
  await load();
  const offs = ['event:invoice_status_changed', 'event:payment_recorded', 'event:issue_status_changed', 'event:lease_status_changed'].map((ev) => live(ev, load));
  return () => offs.forEach((o) => o());
}

const NOTIF_ICONS = {
  payment_received: 'cash', invoice_issued: 'receipt', invoice_overdue: 'alert', issue_created: 'wrench', issue_updated: 'wrench',
  new_message: 'chat', missed_call: 'phone', unit_vacant: 'door', lease_activated: 'key', report_ready: 'download',
};
const NOTIF_LINKS = {
  payment_received: '#/invoices', invoice_issued: '#/invoices', invoice_overdue: '#/invoices', issue_created: '#/issues', issue_updated: '#/issues',
  new_message: '#/chat', missed_call: '#/chat', unit_vacant: '#/properties', lease_activated: '#/lease', report_ready: '#/reports?tab=exports',
};

export async function notificationsView() {
  const mount = scopedMount();
  const main = mount(`${pageHeader('Notifications', { actions: '<button class="btn btn-light btn-sm" data-read-all>Mark all read</button>' })}<div id="notifs">${skeleton(4)}</div>`);
  const load = async () => {
    const box = main.querySelector('#notifs');
    try {
      const rows = await api('/api/v1/notifications?limit=60');
      box.innerHTML = rows.length ? `<div class="kodi-card p-0"><ul class="kodi-rows">${rows.map((n) => `<li><a href="${NOTIF_LINKS[n.type] || '#/'}" class="${n.read_at ? '' : 'unread'}">
        <span class="kodi-avatar">${icon(NOTIF_ICONS[n.type] || 'bell', 16)}</span>
        <span class="flex-grow-1 min-w-0"><strong class="d-block">${esc(n.title)}</strong><span class="small text-secondary d-block">${esc(n.body || '')}</span></span>
        <span class="small text-secondary text-nowrap">${esc(timeAgo(n.created_at))}</span></a></li>`).join('')}</ul></div>`
        : emptyState('bell', 'No notifications yet');
    } catch (err) { box.innerHTML = errorBox(err); }
  };
  main.querySelector('[data-read-all]').addEventListener('click', async () => {
    await api('/api/v1/notifications/read', { method: 'POST', body: { all: true } }).catch(() => {});
    setUnread(0);
    load();
  });
  await load();
  return live('notification', load);
}
