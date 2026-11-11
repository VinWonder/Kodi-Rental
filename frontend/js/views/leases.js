// Room allocation (lease creation), lease management, and tenant e-signing.
import { api, reloadProfile } from '../api.js';
import {
  badge, confirmDialog, emptyState, errorBox, field, formModal, icon, label, modal, pageHeader, select, signaturePad,
  skeleton, today, uploadFile,
} from '../components.js';
import { navigate, setQuery } from '../router.js';
import { live, scopedMount } from '../shell.js';
import { acct, qs, state } from '../state.js';
import { esc, fmtDate, fmtMoney, setBusy, toast } from '../ui.js';

const LEASE_FILTERS = ['active', 'pending_signature', 'notice_given', 'terminated', 'all'];

export function defaultTerms({ business, unit, rent, deposit, dueDays, noticeDays }) {
  return `RESIDENTIAL TENANCY AGREEMENT

Landlord: ${business}
Premises: Unit ${unit.unit_number}, ${unit.property_name}

1. RENT. The monthly rent is KES ${Number(rent).toLocaleString('en-KE')}, payable within ${dueDays} days of each invoice through M-Pesa using the account number ${unit.payment_code}, or through the Kodi app. Receipts are issued automatically.
2. DEPOSIT. A refundable deposit of KES ${Number(deposit).toLocaleString('en-KE')} is payable before occupation. It is refunded within 30 days of vacating, less the cost of repairing damage beyond fair wear and tear and any unpaid rent or utilities.
3. UTILITIES. Water, electricity and garbage collection are paid by the tenant unless stated on the invoice.
4. REPAIRS. The tenant shall report any damage or defect through the Kodi app as soon as it is noticed. The landlord is responsible for structural repairs and fixtures; the tenant is responsible for damage caused by the tenant, household members or visitors.
5. USE. The premises shall be used as a private residence only. The tenant shall not sublet, assign or make structural alterations without the landlord's written consent.
6. CONDUCT. The tenant shall respect neighbours, keep the premises clean, and comply with building rules on noise, security and waste disposal.
7. ACCESS. The landlord may inspect the premises at reasonable times after giving at least 24 hours' notice, except in an emergency.
8. NOTICE. Either party may end this tenancy by giving ${noticeDays} days' written notice through the app or in writing.
9. LATE PAYMENT. Rent unpaid after the due date is recorded as arrears and may attract the late fee stated on the invoice.
10. GOVERNING LAW. This agreement is governed by the laws of Kenya.

By signing electronically in the Kodi app the tenant confirms they have read and accepted these terms.`;
}

/** Allocation matrix: map a tenant to a unit; billing starts when the tenant signs. */
export async function allocateModal({ unit = null, tenant = null } = {}) {
  const [units, tenants, account] = await Promise.all([
    unit ? Promise.resolve([unit]) : api(acct('/units?status=vacant&limit=500')),
    tenant ? Promise.resolve([tenant]) : api(acct('/tenants?limit=200')),
    api(acct('')),
  ]);
  if (!units.length) { toast('No vacant units. Mark a unit vacant first.', { variant: 'warning' }); return null; }
  if (!tenants.length) { toast('Add the tenant first.', { variant: 'warning' }); navigate('/tenants?new=1'); return null; }
  const unitById = Object.fromEntries(units.map((u) => [u.id, u]));
  return formModal({
    title: 'Allocate a unit', size: 'lg', submitLabel: 'Send lease for signing',
    fields: `<div class="row g-3">
      ${select('unit_id', 'Unit', units.map((u) => [u.id, `${u.unit_number} · ${u.property_name} · ${fmtMoney(u.monthly_rent)}`]), { required: true, value: unit?.id || '', col: 'col-md-6', placeholder: unit ? null : 'Choose a vacant unit' })}
      ${select('tenant_id', 'Tenant', tenants.map((t) => [t.id, `${t.full_name} · ${t.phone}`]), { required: true, value: tenant?.id || '', col: 'col-md-6', placeholder: tenant ? null : 'Choose tenant' })}
      ${field('start_date', 'Move-in date', { type: 'date', required: true, value: today(), col: 'col-md-4' })}
      ${field('monthly_rent', 'Monthly rent (KES)', { type: 'number', col: 'col-md-4', dataType: 'number', attrs: 'min="1" step="1"' })}
      ${field('deposit_amount', 'Deposit (KES)', { type: 'number', col: 'col-md-4', dataType: 'number', attrs: 'min="0" step="1"' })}
      ${select('billing_cycle', 'Billing cycle', ['every_30_days', 'fixed_monthly_day'], { value: 'every_30_days', col: 'col-md-4', placeholder: null })}
      ${field('billing_day', 'Billing day (1-28)', { type: 'number', col: 'col-md-4', dataType: 'number', attrs: 'min="1" max="28" disabled' })}
      ${field('payment_due_days', 'Days to pay', { type: 'number', value: account.default_payment_due_days, col: 'col-md-4', dataType: 'number', attrs: 'min="0" max="28"' })}
      ${select('late_fee_type', 'Late fee', [['none', 'None'], ['flat', 'Fixed amount'], ['percent', '% of balance']], { value: 'none', col: 'col-md-4', placeholder: null })}
      ${field('late_fee_value', 'Late fee value', { type: 'number', value: 0, col: 'col-md-4', dataType: 'number', attrs: 'min="0"' })}
      ${field('notice_period_days', 'Notice period (days)', { type: 'number', value: 30, col: 'col-md-4', dataType: 'number', attrs: 'min="0" max="365"' })}
      ${field('terms_snapshot', 'Tenancy terms the tenant will sign', { type: 'textarea', required: true, col: 'col-12', attrs: 'minlength="20" rows="10"' })}
      </div><p class="small text-secondary mb-0">${icon('shield', 14)} The tenant gets a notification to sign in the app. Their first invoice (rent + deposit) is generated automatically once they sign.</p>`,
    onReady: (form) => {
      const fill = () => {
        const u = unitById[form.unit_id.value];
        if (!u) return;
        form.monthly_rent.placeholder = u.monthly_rent;
        form.deposit_amount.placeholder = u.deposit_amount;
        form.terms_snapshot.value = defaultTerms({
          business: account.business_name, unit: u,
          rent: form.monthly_rent.value || u.monthly_rent, deposit: form.deposit_amount.value || u.deposit_amount,
          dueDays: form.payment_due_days.value || account.default_payment_due_days, noticeDays: form.notice_period_days.value || 30,
        });
      };
      form.billing_cycle.addEventListener('change', () => { form.billing_day.disabled = form.billing_cycle.value !== 'fixed_monthly_day'; form.billing_day.required = !form.billing_day.disabled; });
      ['unit_id', 'monthly_rent', 'deposit_amount', 'payment_due_days', 'notice_period_days'].forEach((n) => form[n].addEventListener('change', fill));
      fill();
    },
    onSubmit: (v) => {
      const body = { ...v };
      Object.keys(body).forEach((k) => body[k] === null && delete body[k]);
      return api(acct('/leases'), { method: 'POST', body });
    },
  });
}

// ------------------------------------------------------------------ landlord: lease list & detail
export async function leasesView(_, query) {
  const mount = scopedMount();
  let filter = query.status || 'active';
  const main = mount(`${pageHeader('Leases', { subtitle: 'Unit allocations and their signing status', back: '#/invoices',
    actions: state.isStaff ? `<button class="btn btn-primary" data-allocate>${icon('key', 18)} Allocate unit</button>` : '' })}
    <div class="kodi-chips mb-3">${LEASE_FILTERS.map((s) => `<button class="kodi-filter ${s === filter ? 'active' : ''}" data-status="${s}">${esc(s === 'all' ? 'All' : label(s))}</button>`).join('')}</div>
    <div id="leases">${skeleton(3)}</div>`);
  const load = async () => {
    const box = main.querySelector('#leases');
    try {
      const rows = await api(acct(`/leases${qs({ status: filter === 'all' ? '' : filter, limit: 300 })}`));
      box.innerHTML = rows.length ? `<div class="kodi-card p-0"><div class="table-responsive"><table class="table table-kodi table-hover align-middle mb-0">
        <thead><tr><th>Tenant</th><th>Unit</th><th>Start</th><th class="text-end">Rent</th><th>Status</th></tr></thead><tbody>
        ${rows.map((l) => `<tr data-href="#/leases/${l.id}" class="kodi-row-link"><td><strong>${esc(l.tenant_name)}</strong><div class="small text-secondary">${esc(l.lease_number)}</div></td>
          <td>${esc(l.unit_number)}<div class="small text-secondary">${esc(l.property_name)}</div></td><td>${esc(fmtDate(l.start_date))}</td>
          <td class="text-end">${esc(fmtMoney(l.monthly_rent))}</td><td>${badge(l.status)}</td></tr>`).join('')}</tbody></table></div></div>`
        : emptyState('key', 'No leases here', 'Allocate a vacant unit to a tenant to start billing.');
    } catch (err) { box.innerHTML = errorBox(err); }
  };
  main.addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-status]');
    if (chip) { filter = chip.dataset.status; setQuery({ status: filter, new: '' }); main.querySelectorAll('[data-status]').forEach((c) => c.classList.toggle('active', c === chip)); load(); }
    if (e.target.closest('[data-allocate]')) { const lease = await allocateModal(); if (lease) navigate(`/leases/${lease.id}`); }
  });
  await load();
  if (query.new && state.isStaff) main.querySelector('[data-allocate]')?.click();
  return live('event:lease_status_changed', load);
}

export async function leaseDetailView({ id }) {
  const mount = scopedMount();
  mount(skeleton(4));
  let l;
  try { l = await api(acct(`/leases/${id}`)); } catch (err) { mount(errorBox(err)); return; }
  const isLive = ['pending_signature', 'active', 'notice_given'].includes(l.status);
  const main = mount(`${pageHeader(`Lease ${l.lease_number}`, { back: '#/leases', subtitle: `${esc(l.tenant_name)} · Unit ${esc(l.unit_number)}, ${esc(l.property_name)}`,
    actions: state.isStaff && isLive ? `<div class="dropdown"><button class="btn btn-light" data-bs-toggle="dropdown">${icon('more')} Actions</button><ul class="dropdown-menu dropdown-menu-end">
      ${l.status === 'active' ? `<li><button class="dropdown-item" data-notice>${icon('calendar', 16)} Record notice to vacate</button></li>` : ''}
      ${l.status === 'pending_signature' ? `<li><button class="dropdown-item" data-cancel>${icon('x', 16)} Cancel allocation</button></li>` : ''}
      ${l.status !== 'pending_signature' ? `<li><button class="dropdown-item text-danger" data-terminate>${icon('logout', 16)} End tenancy (move out)</button></li>` : ''}
      </ul></div>` : '' })}
    <div class="row g-3">
      <div class="col-lg-4"><section class="kodi-card">
        <div class="d-flex justify-content-between mb-2"><span class="small text-secondary">Status</span>${badge(l.status)}</div>
        <ul class="kodi-list small">
          <li><span>Tenant</span><a href="#/tenants/${l.tenant_id}">${esc(l.tenant_name)}</a></li>
          <li><span>Unit</span><a href="#/units/${l.unit_id}">${esc(l.unit_number)}</a></li>
          <li><span>Rent</span><span>${esc(fmtMoney(l.monthly_rent))}</span></li>
          <li><span>Deposit</span><span>${esc(fmtMoney(l.deposit_amount))}</span></li>
          <li><span>Billing</span><span>${esc(label(l.billing_cycle))}${l.billing_day ? ` (day ${l.billing_day})` : ''}</span></li>
          <li><span>Next invoice</span><span>${esc(fmtDate(l.next_billing_date) || '-')}</span></li>
          <li><span>Move-in</span><span>${esc(fmtDate(l.start_date))}</span></li>
          ${l.end_date ? `<li><span>Move-out</span><span>${esc(fmtDate(l.end_date))}</span></li>` : ''}
          <li><span>Signed</span><span>${l.signed_at ? esc(fmtDate(l.signed_at)) : '<span class="text-warning">Waiting for tenant</span>'}</span></li>
          ${l.termination_reason ? `<li><span>Reason</span><span>${esc(l.termination_reason)}</span></li>` : ''}
        </ul>
        ${l.signature_media_id ? `<div class="mt-3"><span class="small text-secondary d-block mb-1">Tenant signature</span><img class="kodi-signature" data-media="${l.signature_media_id}" alt="Signature"></div>` : ''}
        <a class="btn btn-light w-100 mt-3" href="#/invoices?lease_id=${l.id}">${icon('receipt', 16)} Invoices for this lease</a>
      </section></div>
      <div class="col-lg-8"><section class="kodi-card"><h2 class="h6 fw-bold">Terms (${esc(l.terms_version)})</h2>
        <pre class="kodi-terms">${esc(l.terms_snapshot)}</pre>
        <p class="small text-secondary mb-0">Fingerprint (SHA-256): <code class="small">${esc(l.terms_sha256)}</code></p></section></div>
    </div>`);

  const act = async (path, body, msg) => {
    try { await api(acct(`/leases/${id}/${path}`), { method: 'POST', body }); toast(msg, { variant: 'success' }); leaseDetailView({ id }); }
    catch (err) { toast(err.message, { variant: 'danger' }); }
  };
  main.addEventListener('click', async (e) => {
    if (e.target.closest('[data-notice]')) {
      const done = await formModal({ title: 'Notice to vacate', submitLabel: 'Record notice',
        fields: `${field('move_out_date', 'Move-out date', { type: 'date', required: true })}${field('reason', 'Reason (optional)', { type: 'textarea' })}`,
        onSubmit: (v) => api(acct(`/leases/${id}/notice`), { method: 'POST', body: v }) });
      if (done) { toast('Notice recorded', { variant: 'success' }); leaseDetailView({ id }); }
    }
    if (e.target.closest('[data-cancel]') && await confirmDialog('Cancel this allocation? The unit becomes vacant again.', { danger: true, confirmLabel: 'Cancel allocation' })) act('cancel', undefined, 'Allocation cancelled');
    if (e.target.closest('[data-terminate]')) {
      const done = await formModal({ title: 'End tenancy', submitLabel: 'End tenancy',
        fields: `<p class="small">The unit moves to <strong>Cleaning</strong>, billing stops and the tenant keeps read access to their statement.</p>${field('reason', 'Reason', { type: 'textarea', required: true, attrs: 'minlength="3"' })}`,
        onSubmit: (v) => api(acct(`/leases/${id}/terminate`), { method: 'POST', body: v }) });
      if (done) { toast('Tenancy ended', { variant: 'success' }); leaseDetailView({ id }); }
    }
  });
  return live('event:lease_status_changed', (d) => { if (d.lease_id === id) leaseDetailView({ id }); });
}

// ------------------------------------------------------------------ tenant: view & sign lease
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function myLeaseView() {
  const mount = scopedMount();
  mount(skeleton(4));
  let leases;
  try { leases = await api('/api/v1/me/leases'); } catch (err) { mount(errorBox(err)); return; }
  if (!leases.length) { mount(`${pageHeader('My lease')}${emptyState('pen', 'No lease yet', 'Your landlord will allocate a unit to you.')}`); return; }
  const summary = leases[0];
  const l = await api(`/api/v1/me/leases/${summary.id}`);
  const needsSignature = l.status === 'pending_signature';
  const main = mount(`${pageHeader('My lease', { subtitle: `Unit ${esc(l.unit_number)}, ${esc(l.property_name)}` })}
    ${needsSignature ? `<div class="kodi-alert kodi-alert-warning mb-3">${icon('pen', 18)}<span>Please read the agreement below and sign at the bottom to activate your tenancy.</span></div>` : ''}
    <div class="row g-3">
      <div class="col-lg-4"><section class="kodi-card">
        <div class="d-flex justify-content-between mb-2"><span class="small text-secondary">Status</span>${badge(l.status)}</div>
        <ul class="kodi-list small">
          <li><span>Rent</span><span>${esc(fmtMoney(l.monthly_rent))} / month</span></li>
          <li><span>Deposit</span><span>${esc(fmtMoney(l.deposit_amount))}</span></li>
          <li><span>Move-in</span><span>${esc(fmtDate(l.start_date))}</span></li>
          <li><span>Notice period</span><span>${esc(l.notice_period_days)} days</span></li>
          ${l.signed_at ? `<li><span>Signed</span><span>${esc(fmtDate(l.signed_at))}</span></li>` : ''}
        </ul></section></div>
      <div class="col-lg-8"><section class="kodi-card">
        <pre class="kodi-terms">${esc(l.terms_snapshot)}</pre>
        ${needsSignature ? `<hr><h2 class="h6 fw-bold">Sign here</h2>
          <div class="kodi-sign-wrap"><canvas class="kodi-sign" aria-label="Signature pad"></canvas><button class="btn btn-sm btn-light kodi-sign-clear" type="button" data-clear>Clear</button></div>
          <div class="form-check my-3"><input class="form-check-input" type="checkbox" id="accept"><label class="form-check-label small" for="accept">
            I have read and accept these terms. I understand this electronic signature is binding.</label></div>
          <button class="btn btn-primary btn-lg w-100" data-sign>Sign lease</button>` : ''}
      </section></div></div>`);
  if (!needsSignature) return;
  const pad = signaturePad(main.querySelector('canvas'));
  main.querySelector('[data-clear]').addEventListener('click', () => pad.clear());
  main.querySelector('[data-sign]').addEventListener('click', async (e) => {
    if (pad.isEmpty()) { toast('Draw your signature in the box first.', { variant: 'warning' }); return; }
    if (!main.querySelector('#accept').checked) { toast('Tick the box to accept the terms.', { variant: 'warning' }); return; }
    setBusy(e.target, true, 'Signing…');
    try {
      const blob = await pad.toBlob();
      const media = await uploadFile(new File([blob], 'signature.png', { type: 'image/png' }), 'signature', l.account_id);
      await api(`/api/v1/me/leases/${l.id}/sign`, { method: 'POST', body: {
        accept_terms: true, terms_sha256: await sha256Hex(l.terms_snapshot), signature_media_id: media.id } });
      await reloadProfile().catch(() => {});
      await modal({ title: 'Lease signed', body: `<div class="text-center"><div class="kodi-success-burst">${icon('check', 40)}</div>
        <p class="mt-3">Welcome home! Your first invoice is ready. You can pay it now with M-Pesa.</p></div>`,
        footer: '<button class="btn btn-primary w-100" data-bs-dismiss="modal">See my invoice</button>' });
      navigate('/invoices');
    } catch (err) { toast(err.message, { variant: 'danger' }); setBusy(e.target, false); }
  });
}
