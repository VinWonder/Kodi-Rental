// Tenant home and the notifications page.
import { api } from '../api.js';
import { badge, emptyState, errorBox, icon, pageHeader, sectionHead, skeleton } from '../components.js';
import { live, scopedMount, setUnread } from '../shell.js';
import { state } from '../state.js';
import { esc, fmtDate, fmtMoney, timeAgo } from '../ui.js';
import { stkPushFlow } from './billing.js';
import { countUp } from '../fx.js';
import { rateNudge } from './reviews.js';

export async function tenantHomeView() {
  const mount = scopedMount();
  const t = state.tenancy;
  const first = state.user.full_name.split(' ')[0];
  const main = mount(`<header class="kodi-greet">
      <span class="kodi-avatar" aria-hidden="true">${esc(first[0] || '?')}</span>
      <div class="min-w-0"><h1 class="text-truncate">Hello, ${esc(first)}</h1>
        <p class="text-truncate">${t?.unit_number ? `Unit ${esc(t.unit_number)} · ${esc(t.property_name)}` : 'Welcome to Kodi'}</p></div>
    </header>
    <div class="kodi-tenant-top">
      <div class="kodi-rentcard-wrap">
        <section class="kodi-rentcard" data-tilt="9" aria-label="Rent balance">
          <div class="kodi-rentcard-top"><span class="d-flex align-items-center gap-2 min-w-0"><span class="kodi-rentcard-chip" aria-hidden="true"></span>
            <span class="text-truncate">${esc(t?.business_name || 'Kodi')}</span></span><span id="due-ring"></span></div>
          <div class="kodi-rentcard-balance" id="balance"><span>Balance</span><strong><span class="placeholder col-6"></span></strong></div>
          <div class="kodi-rentcard-foot"><span><span class="d-block">Home</span><strong>${t?.unit_number ? `Unit ${esc(t.unit_number)}` : '-'}</strong></span>
            <span id="balance-action"></span></div>
        </section>
      </div>
      <div>
        <div id="lease-alert"></div>
        <div id="rate-nudge"></div>
        <div class="kodi-quick">
          <a href="#/invoices">${icon('cash')}<span>Pay rent</span></a>
          <a href="#/issues?new=1">${icon('wrench')}<span>Report a problem</span></a>
          <a href="#/chat">${icon('chat')}<span>Message landlord</span></a>
          <a href="#/statement">${icon('receipt')}<span>Statement</span></a>
        </div>
      </div>
    </div>
    <div class="row g-3">
      <div class="col-lg-6">${sectionHead('Due now', '#/invoices')}<section class="kodi-card" id="due">${skeleton(2)}</section></div>
      <div class="col-lg-6">${sectionHead('My repairs', '#/issues')}<section class="kodi-card" id="repairs">${skeleton(2)}</section></div>
    </div>`);

  rateNudge(main.querySelector('#rate-nudge'));
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
      main.querySelector('#balance').innerHTML = `<span>${balance > 0 ? 'Balance due' : balance < 0 ? 'Credit on your account' : 'All paid up'}${invoicesRes.offline ? ' · saved copy' : ''}</span>
        <strong data-count="${Math.abs(balance)}" data-format="money">${esc(fmtMoney(Math.abs(balance)))}</strong>`;
      countUp(main.querySelector('#balance'));
      const next = open.map((i) => i.due_date).sort()[0];
      const ring = main.querySelector('#due-ring');
      if (next) {
        const days = Math.round((new Date(`${next}T00:00:00`) - new Date(new Date().toDateString())) / 864e5);
        const frac = Math.max(0, Math.min(1, days / 30));
        const text = days > 1 ? `${days} days` : days === 1 ? '1 day' : days === 0 ? 'Today' : `${-days}d late`;
        ring.innerHTML = `<span class="kodi-due-ring ${days < 0 ? 'is-late' : days <= 3 ? 'is-soon' : ''}" role="img"
            aria-label="${days < 0 ? `Rent is ${-days} days overdue` : days === 0 ? 'Rent is due today' : `Rent due in ${days} days`}">
          <svg viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15.5" class="bg"/>
            <circle cx="18" cy="18" r="15.5" class="fg" pathLength="100" style="stroke-dasharray:${days < 0 ? 100 : Math.max(4, frac * 100)} 100"/></svg>
          <span><b>${esc(text)}</b>${days >= 0 && days !== 0 ? '<i>to due</i>' : ''}</span></span>`;
      } else ring.innerHTML = '';
      main.querySelector('#balance-action').innerHTML = balance > 0 && !invoicesRes.offline
        ? `<a class="btn btn-white btn-sm" href="#/invoices">${icon('phone', 16)} Pay now</a>`
        : balance <= 0 ? `<span class="d-inline-flex align-items-center gap-1">${icon('check', 16)} Up to date</span>` : '';
      const pending = leases.find((l) => l.status === 'pending_signature');
      main.querySelector('#lease-alert').innerHTML = pending ? `<a class="kodi-alert kodi-alert-warning mb-3" href="#/lease">${icon('pen', 18)}
        <span><strong>Your lease is ready to sign.</strong> Sign it to activate your tenancy.</span></a>` : '';
      main.querySelector('#due').innerHTML = `${open.length ? `<ul class="kodi-list">${open.map((i) => `<li>
          <span><strong class="d-block">${esc(fmtMoney(i.balance))}</strong><span class="small ${i.status === 'overdue' ? 'text-danger' : 'text-secondary'}">${esc(i.invoice_number)} · due ${esc(fmtDate(i.due_date))}</span></span>
          <button class="btn btn-success btn-sm" data-pay="${i.id}" ${invoicesRes.offline ? 'disabled' : ''}>${icon('phone', 14)} Pay</button></li>`).join('')}</ul>`
        : `<div class="text-center py-3"><div class="kodi-success-burst sm mx-auto">${icon('check', 24)}</div><p class="small text-secondary mt-2 mb-0">Nothing due. Thank you!</p></div>`}`;
      main.querySelector('#repairs').innerHTML = `${issues.length ? `<ul class="kodi-list">${issues.slice(0, 4).map((i) => `<li><a href="#/issues/${i.id}" class="text-decoration-none text-body"><strong class="d-block">${esc(i.title)}</strong>
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
