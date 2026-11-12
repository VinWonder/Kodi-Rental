// Billing: invoices, payments, M-Pesa STK prompts (landlord and tenant), receipts.
import { api, download } from '../api.js';
import {
  badge, emptyState, errorBox, field, formModal, icon, label, modal, money, pageHeader, select, skeleton, today,
} from '../components.js';
import { navigate, setQuery } from '../router.js';
import { rt } from '../realtime.js';
import { live, scopedMount } from '../shell.js';
import { acct, qs, state } from '../state.js';
import { esc, fmtDate, fmtMoney, fmtTime, timeAgo, toast } from '../ui.js';
import { statementTable } from './tenants.js';

const INVOICE_FILTERS = ['open', 'overdue', 'partially_paid', 'paid', 'all'];
const ITEM_TYPES = ['rent', 'water', 'electricity', 'garbage', 'service_charge', 'deposit', 'late_fee', 'other'];

// ------------------------------------------------------------------ M-Pesa STK prompt (shared)
/**
 * Ask for amount/phone, send the STK Push, then show a live "waiting for PIN"
 * panel that resolves from the Safaricom callback (via WebSocket) or polling.
 */
export async function stkPushFlow(invoice, { tenantSelf = false } = {}) {
  const base = tenantSelf ? `/api/v1/me/invoices/${invoice.id}` : acct(`/invoices/${invoice.id}`);
  const statusUrl = (id) => (tenantSelf ? `/api/v1/me/stk-requests/${id}` : acct(`/stk-requests/${id}`));
  const balance = Math.ceil(Number(invoice.balance));
  const stk = await formModal({
    title: tenantSelf ? 'Pay with M-Pesa' : 'Send M-Pesa payment prompt',
    submitLabel: tenantSelf ? 'Send prompt to my phone' : 'Send prompt',
    fields: `<div class="kodi-mpesa-head mb-3"><span class="kodi-mpesa-logo">M-PESA</span><span class="small">${esc(invoice.invoice_number)} · balance ${esc(fmtMoney(invoice.balance))}</span></div>
      ${field('amount', 'Amount (KES)', { type: 'number', required: true, value: balance, dataType: 'number', attrs: `min="1" max="${Math.max(balance, 1)}" step="1"` })}
      ${field('phone', 'M-Pesa number', { type: 'tel', placeholder: tenantSelf ? 'Your registered number' : 'Tenant\'s registered number',
        hint: 'Leave blank to use the number on the tenancy.' })}
      <p class="small text-secondary mb-0">${tenantSelf ? 'You will get a prompt on your phone. Enter your M-Pesa PIN to pay.' : 'The tenant gets a prompt on their phone and enters their PIN. You will see the result here.'}</p>`,
    onSubmit: (v) => api(`${base}/stk-push`, { method: 'POST', body: { amount: v.amount, ...(v.phone ? { phone: v.phone } : {}) } }),
  });
  if (!stk) return null;

  return modal({
    title: 'Waiting for M-Pesa',
    body: `<div class="text-center py-2" data-stk-body>
      <div class="kodi-phone-pulse">${icon('phone', 34)}</div>
      <p class="mt-3 mb-1 fw-semibold">${esc(stk.customer_message || 'Prompt sent')}</p>
      <p class="small text-secondary">${tenantSelf ? 'Check your phone and enter your M-Pesa PIN.' : `Waiting for the tenant to enter their PIN on +${esc(stk.phone)}.`}</p>
      <div class="kodi-countdown" data-countdown>3:00</div></div>`,
    footer: '<button class="btn btn-light w-100" data-bs-dismiss="modal">Close (keeps waiting in the background)</button>',
    onReady: (el, close) => {
      const body = el.querySelector('[data-stk-body]');
      let finished = false;
      let remaining = 180;
      const finish = (s) => {
        if (finished) return;
        finished = true;
        clearInterval(tick); clearInterval(poll); offs.forEach((o) => o());
        const ok = s.status === 'success';
        body.innerHTML = `<div class="${ok ? 'kodi-success-burst' : 'kodi-fail-burst'}">${icon(ok ? 'check' : 'x', 40)}</div>
          <p class="mt-3 mb-1 fw-semibold">${ok ? 'Payment received' : 'Payment not completed'}</p>
          <p class="small text-secondary mb-0">${ok ? `M-Pesa code <strong>${esc(s.mpesa_receipt_number || '')}</strong>. A receipt has been issued.`
            : esc(s.result_desc || label(s.status))}</p>`;
        if (ok) toast('Payment received. Receipt issued.', { variant: 'success' });
      };
      const check = async () => {
        try {
          const s = await api(statusUrl(stk.id));
          if (!['initiated', 'pending'].includes(s.status)) finish(s);
        } catch { /* keep waiting */ }
      };
      const tick = setInterval(() => {
        remaining -= 1;
        const c = el.querySelector('[data-countdown]');
        if (c) c.textContent = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
        if (remaining <= 0) check();
      }, 1000);
      const poll = setInterval(check, 5000);
      const offs = ['event:invoice_status_changed', 'event:payment_recorded'].map((ev) => rt.on(ev, check));
      el.addEventListener('hidden.bs.modal', () => { clearInterval(tick); clearInterval(poll); offs.forEach((o) => o()); });
      void close;
    },
  });
}

// ------------------------------------------------------------------ landlord: invoices & payments
async function recordPaymentModal(prefill = {}) {
  const tenants = await api(acct('/tenants?limit=200'));
  return formModal({
    title: 'Record a payment', submitLabel: 'Record payment',
    fields: `<p class="small text-secondary">For cash, bank or cheque payments. M-Pesa payments are recorded automatically.</p>
      ${select('tenant_id', 'Tenant', tenants.map((t) => [t.id, `${t.full_name}${Number(t.balance) ? ` · owes ${fmtMoney(t.balance)}` : ''}`]), { required: true, value: prefill.tenant_id || '' })}
      <div class="row g-3">${field('amount', 'Amount (KES)', { type: 'number', required: true, dataType: 'number', value: prefill.amount || '', col: 'col-6', attrs: 'min="1" step="1"' })}
      ${select('method', 'Method', [['cash', 'Cash'], ['bank_transfer', 'Bank transfer'], ['cheque', 'Cheque'], ['adjustment', 'Adjustment / waiver']], { value: 'cash', col: 'col-6', placeholder: null })}
      ${field('external_reference', 'Reference', { col: 'col-6', placeholder: 'Bank ref / cheque no.' })}
      ${field('paid_at', 'Date paid', { type: 'date', value: today(), col: 'col-6' })}</div>
      ${field('notes', 'Notes', { type: 'textarea', attrs: 'rows="2"', col: 'mt-3' })}
      ${prefill.target_invoice_id ? `<input type="hidden" name="target_invoice_id" value="${esc(prefill.target_invoice_id)}">` : ''}`,
    onSubmit: (v) => {
      const body = { ...v };
      if (body.paid_at) body.paid_at = `${body.paid_at}T12:00:00+03:00`;
      Object.keys(body).forEach((k) => body[k] === null && delete body[k]);
      return api(acct('/payments'), { method: 'POST', body });
    },
  });
}

async function newInvoiceModal() {
  const leases = await api(acct('/leases?status=active&limit=500'));
  if (!leases.length) { toast('You need an active lease to invoice.', { variant: 'warning' }); return null; }
  const row = (i) => `<div class="row g-2 align-items-end kodi-item-row" data-item="${i}">
    ${select(`item_type_${i}`, i ? '' : 'Item', ITEM_TYPES, { value: i ? 'water' : 'rent', col: 'col-4', placeholder: null })}
    ${field(`description_${i}`, i ? '' : 'Description', { col: 'col-5', required: true, value: i ? 'Water bill' : 'Rent' })}
    ${field(`amount_${i}`, i ? '' : 'Amount', { type: 'number', col: 'col-3', required: true, dataType: 'number', attrs: 'min="0" step="1"' })}</div>`;
  let items = 1;
  return formModal({
    title: 'New invoice', size: 'lg', submitLabel: 'Issue invoice',
    fields: `${select('lease_id', 'Tenant / unit', leases.map((l) => [l.id, `${l.tenant_name} · ${l.unit_number}, ${l.property_name}`]), { required: true })}
      <div class="row g-3 mb-3">${field('period_start', 'Period from', { type: 'date', required: true, value: today(), col: 'col-md-4' })}
        ${field('period_end', 'Period to', { type: 'date', required: true, col: 'col-md-4' })}${field('due_date', 'Due date', { type: 'date', required: true, col: 'col-md-4' })}</div>
      <div data-items>${row(0)}</div>
      <button type="button" class="btn btn-light btn-sm mt-2" data-add-item>${icon('plus', 14)} Add line</button>
      ${field('notes', 'Notes', { type: 'textarea', attrs: 'rows="2"', col: 'mt-3' })}`,
    onReady: (form) => {
      form.querySelector('[data-add-item]').addEventListener('click', () => {
        form.querySelector('[data-items]').insertAdjacentHTML('beforeend', row(items));
        items += 1;
      });
    },
    onSubmit: (v) => {
      const lines = [];
      for (let i = 0; i < items; i += 1) {
        if (v[`amount_${i}`] == null) continue;
        lines.push({ item_type: v[`item_type_${i}`], description: v[`description_${i}`], quantity: 1, unit_price: v[`amount_${i}`] });
      }
      return api(acct('/invoices'), { method: 'POST', body: { lease_id: v.lease_id, period_start: v.period_start,
        period_end: v.period_end, due_date: v.due_date, notes: v.notes, items: lines } });
    },
  });
}

export async function billingView(_, query) {
  const mount = scopedMount();
  const tab = query.tab || 'invoices';
  const main = mount(`${pageHeader('Billing', { subtitle: 'Invoices are generated automatically every cycle',
    actions: state.canFinance ? `<div class="dropdown"><button class="btn btn-light" data-bs-toggle="dropdown" aria-label="More billing actions">${icon('more')}</button><ul class="dropdown-menu dropdown-menu-end">
        <li><button class="dropdown-item" data-new-invoice>${icon('receipt', 16)} New invoice</button></li>
        <li><a class="dropdown-item" href="#/leases">${icon('key', 16)} Leases</a></li>
        ${state.isOwner ? `<li><button class="dropdown-item" data-run-billing>${icon('bolt', 16)} Run billing now</button></li>` : ''}</ul></div>
      <button class="btn btn-primary" data-record>${icon('cash', 18)} Record payment</button>` : '' })}
    <ul class="nav kodi-tabs mb-3">${[['invoices', 'Invoices'], ['payments', 'Payments'], ['mpesa', 'M-Pesa prompts']].map(([k, t]) =>
      `<li class="nav-item"><a class="nav-link ${k === tab ? 'active' : ''}" href="#/invoices?tab=${k}">${t}</a></li>`).join('')}</ul>
    <div id="billing-body"></div>`);
  const body = main.querySelector('#billing-body');

  const loaders = {
    async invoices() {
      let filter = query.status || 'open';
      body.innerHTML = `<div class="kodi-chips mb-3">${INVOICE_FILTERS.map((s) => `<button class="kodi-filter ${s === filter ? 'active' : ''}" data-filter="${s}">${esc(s === 'open' ? 'Unpaid' : s === 'all' ? 'All' : label(s))}</button>`).join('')}</div>
        <div id="inv-list">${skeleton(4)}</div>`;
      const load = async () => {
        const box = body.querySelector('#inv-list');
        try {
          let rows = await api(acct(`/invoices${qs({ status: ['open', 'all'].includes(filter) ? '' : filter, lease_id: query.lease_id, tenant_id: query.tenant_id, limit: 300 })}`));
          if (filter === 'open') rows = rows.filter((r) => ['issued', 'partially_paid', 'overdue'].includes(r.status));
          const total = rows.reduce((a, r) => a + Number(r.balance), 0);
          box.innerHTML = rows.length ? `<div class="small text-secondary mb-2">${rows.length} invoice(s) · ${esc(fmtMoney(total))} outstanding</div>
            <div class="kodi-card p-0"><ul class="kodi-rows">${rows.map((i) => `<li><a href="#/invoices/${i.id}">
              <span class="kodi-avatar">${esc(i.tenant_name[0])}</span>
              <span class="flex-grow-1 min-w-0"><strong class="d-block text-truncate">${esc(i.tenant_name)}</strong>
                <span class="small text-secondary">${esc(i.invoice_number)} · ${esc(i.unit_number)} · due ${esc(fmtDate(i.due_date))}</span></span>
              <span class="text-end"><span class="d-block fw-semibold">${esc(fmtMoney(Number(i.balance) ? i.balance : i.total_amount))}</span>${badge(i.status)}</span></a>
              ${state.canFinance && Number(i.balance) > 0 ? `<button class="btn btn-success btn-sm kodi-collect me-3" data-collect="${i.id}"
                aria-label="Send M-Pesa prompt to ${esc(i.tenant_name)}">${icon('phone', 14)}<span class="kodi-label-md"> Collect</span></button>` : ''}</li>`).join('')}</ul></div>`
            : emptyState('receipt', filter === 'open' ? 'Everyone is paid up' : 'No invoices', 'Invoices appear here on each tenant\'s billing date.');
        } catch (err) { box.innerHTML = errorBox(err); }
      };
      body.addEventListener('click', async (e) => {
        const collect = e.target.closest('[data-collect]');
        if (collect) {
          const inv = await api(acct(`/invoices/${collect.dataset.collect}`)).catch((err) => { toast(err.message, { variant: 'danger' }); return null; });
          if (inv) { await stkPushFlow(inv); load(); }
          return;
        }
        const chip = e.target.closest('[data-filter]');
        if (!chip) return;
        filter = chip.dataset.filter;
        setQuery({ status: filter });
        body.querySelectorAll('[data-filter]').forEach((c) => c.classList.toggle('active', c === chip));
        load();
      });
      await load();
      return load;
    },
    async payments() {
      const unmatched = query.unmatched === '1';
      body.innerHTML = `<div class="form-check form-switch mb-3"><input class="form-check-input" type="checkbox" id="unm" ${unmatched ? 'checked' : ''}>
        <label class="form-check-label small" for="unm">Only unmatched M-Pesa payments</label></div><div id="pay-list">${skeleton(4)}</div>`;
      const load = async () => {
        const only = body.querySelector('#unm').checked;
        setQuery({ unmatched: only ? '1' : '' });
        const box = body.querySelector('#pay-list');
        try {
          const rows = await api(acct(`/payments${qs({ unmatched: only, tenant_id: query.tenant_id, limit: 300 })}`));
          box.innerHTML = rows.length ? `<div class="kodi-card p-0"><ul class="kodi-rows">${rows.map((p) => `<li><div class="kodi-row-inner">
            <span class="kodi-avatar ${p.method.startsWith('mpesa') ? 'mpesa' : ''}">${icon(p.method.startsWith('mpesa') ? 'phone' : 'cash', 16)}</span>
            <span class="flex-grow-1 min-w-0"><strong class="d-block text-truncate">${esc(p.tenant_name || p.payer_name || 'Unknown payer')}</strong>
              <span class="small text-secondary">${esc(label(p.method))}${p.mpesa_receipt_number ? ` · ${esc(p.mpesa_receipt_number)}` : ''}${p.bill_ref_number ? ` · Acc ${esc(p.bill_ref_number)}` : ''} · ${esc(fmtTime(p.paid_at))}</span></span>
            <span class="text-end"><span class="d-block fw-semibold ${p.status === 'reversed' ? 'text-decoration-line-through' : 'text-success'}">${esc(fmtMoney(p.amount))}</span>
              ${!p.tenant_id ? `<button class="btn btn-sm btn-warning mt-1" data-assign="${p.id}">Assign</button>`
                : p.receipt_id ? `<button class="btn btn-sm btn-link p-0" data-receipt="${p.receipt_id}" data-name="${esc(p.receipt_number)}.pdf">${icon('download', 14)} Receipt</button>` : badge(p.status)}</span></div></li>`).join('')}</ul></div>`
            : emptyState('cash', only ? 'No unmatched payments' : 'No payments yet');
        } catch (err) { box.innerHTML = errorBox(err); }
      };
      body.querySelector('#unm').addEventListener('change', load);
      body.addEventListener('click', async (e) => {
        const r = e.target.closest('[data-receipt]');
        if (r) download(acct(`/receipts/${r.dataset.receipt}/pdf`), r.dataset.name).catch((err) => toast(err.message, { variant: 'danger' }));
        const a = e.target.closest('[data-assign]');
        if (a) {
          const tenants = await api(acct('/tenants?active_only=true&limit=200'));
          const done = await formModal({ title: 'Assign payment to a tenant', submitLabel: 'Assign',
            fields: `<p class="small text-secondary">The payer typed an account number that matched no unit. Choose who it belongs to; it will clear their oldest invoices first.</p>
              ${select('tenant_id', 'Tenant', tenants.map((t) => [t.id, `${t.full_name} · ${t.unit_number || ''}`]), { required: true })}`,
            onSubmit: (v) => api(acct(`/payments/${a.dataset.assign}/assign`), { method: 'POST', body: v }) });
          if (done) { toast('Payment assigned', { variant: 'success' }); load(); }
        }
      });
      await load();
      return load;
    },
    async mpesa() {
      body.innerHTML = `<div id="stk-list">${skeleton(4)}</div>`;
      const load = async () => {
        const box = body.querySelector('#stk-list');
        try {
          const rows = await api(acct('/stk-requests?limit=100'));
          box.innerHTML = rows.length ? `<div class="kodi-card p-0"><div class="table-responsive"><table class="table table-kodi align-middle mb-0">
            <thead><tr><th>Sent</th><th>Phone</th><th class="text-end">Amount</th><th>Status</th><th>Result</th></tr></thead><tbody>
            ${rows.map((s) => `<tr><td class="text-nowrap">${esc(fmtTime(s.created_at))}</td><td>+${esc(s.phone)}</td><td class="text-end">${esc(fmtMoney(s.amount))}</td>
              <td>${badge(s.status)}</td><td class="small">${esc(s.mpesa_receipt_number || s.result_desc || s.customer_message || '')}</td></tr>`).join('')}</tbody></table></div></div>`
            : emptyState('phone', 'No payment prompts sent yet', 'Open an unpaid invoice and tap "Send M-Pesa prompt".');
        } catch (err) { box.innerHTML = errorBox(err); }
      };
      await load();
      return load;
    },
  };
  let reload = null;

  main.addEventListener('click', async (e) => {
    if (e.target.closest('[data-record]')) {
      const p = await recordPaymentModal({ tenant_id: query.tenant_id });
      if (p) { toast(`Payment recorded${p.receipt_number ? `. Receipt ${p.receipt_number}` : ''}`, { variant: 'success' }); reload?.(); }
    }
    if (e.target.closest('[data-new-invoice]')) { const inv = await newInvoiceModal(); if (inv) navigate(`/invoices/${inv.id}`); }
    if (e.target.closest('[data-run-billing]')) {
      try { const r = await api(acct('/billing/run'), { method: 'POST' }); toast(`Billing run complete${r?.invoices_created != null ? `: ${r.invoices_created} invoice(s) issued` : ''}`, { variant: 'success' }); reload?.(); }
      catch (err) { toast(err.message, { variant: 'danger' }); }
    }
  });
  // Listeners are attached first so deep links like ?record=1 can open the dialog.
  reload = await (loaders[tab] || loaders.invoices)();
  if (query.record) main.querySelector('[data-record]')?.click();
  const offs = ['event:invoice_status_changed', 'event:payment_recorded'].map((ev) => live(ev, () => reload?.()));
  return () => offs.forEach((o) => o());
}

export async function invoiceDetailView({ id }) {
  const mount = scopedMount();
  mount(skeleton(5));
  let inv;
  try { inv = await api(acct(`/invoices/${id}`)); } catch (err) { mount(errorBox(err)); return; }
  const open = ['issued', 'partially_paid', 'overdue'].includes(inv.status);
  const pct = Number(inv.total_amount) ? Math.min(100, Math.round((100 * inv.amount_paid) / inv.total_amount)) : 0;
  const main = mount(`${pageHeader(`Invoice ${inv.invoice_number}`, { back: '#/invoices', subtitle: `${esc(inv.tenant_name)} · Unit ${esc(inv.unit_number)}, ${esc(inv.property_name)}`,
    actions: state.canFinance && open ? `<button class="btn btn-light" data-record>${icon('cash', 18)}<span class="kodi-label-md"> Record payment</span></button>
      <button class="btn btn-success" data-stk>${icon('phone', 18)} Send M-Pesa prompt</button>` : '' })}
    <div class="row g-3">
      <div class="col-lg-5">
        <section class="kodi-card mb-3">
          <div class="d-flex justify-content-between align-items-center mb-2"><span class="small text-secondary">Balance</span>${badge(inv.status)}</div>
          <div class="kodi-stat ${Number(inv.balance) > 0 ? 'text-danger' : 'text-success'}">${esc(fmtMoney(inv.balance))}</div>
          <div class="kodi-progress my-2"><span style="width:${pct}%"></span></div>
          <p class="small text-secondary mb-3">${esc(fmtMoney(inv.amount_paid))} paid of ${esc(fmtMoney(inv.total_amount))}</p>
          <ul class="kodi-list small">
            <li><span>Period</span><span>${esc(fmtDate(inv.period_start))} to ${esc(fmtDate(inv.period_end))}</span></li>
            <li><span>Issued</span><span>${esc(fmtDate(inv.issue_date))}</span></li>
            <li><span>Due</span><span>${esc(fmtDate(inv.due_date))}</span></li>
            <li><span>Tenant</span><a href="#/tenants/${inv.tenant_id}">${esc(inv.tenant_name)}</a></li>
            ${inv.void_reason ? `<li><span>Voided</span><span>${esc(inv.void_reason)}</span></li>` : ''}
          </ul>
          ${state.canFinance && open ? `<div class="d-flex gap-2 mt-3"><button class="btn btn-light btn-sm" data-add-item>${icon('plus', 14)} Add charge</button>
            ${Number(inv.amount_paid) === 0 ? `<button class="btn btn-light btn-sm text-danger" data-void>${icon('x', 14)} Void</button>` : ''}</div>` : ''}
        </section>
      </div>
      <div class="col-lg-7">
        <section class="kodi-card mb-3"><h2 class="h6 fw-bold">Charges</h2>
          <ul class="kodi-list">${inv.items.map((it) => `<li><span>${esc(it.description)}<span class="small text-secondary d-block">${esc(label(it.item_type))}${Number(it.quantity) !== 1 ? ` × ${esc(it.quantity)}` : ''}</span></span>${money(it.amount)}</li>`).join('')}
            ${Number(inv.tax_amount) ? `<li><span>VAT (${esc(inv.vat_rate)}%)</span>${money(inv.tax_amount)}</li>` : ''}
            <li class="fw-bold"><span>Total</span>${money(inv.total_amount)}</li></ul></section>
        <section class="kodi-card mb-3"><h2 class="h6 fw-bold">Payments</h2>
          ${inv.payments.length ? `<ul class="kodi-list">${inv.payments.map((p) => `<li><span>${esc(label(p.method))}${p.mpesa_receipt_number ? ` · <strong>${esc(p.mpesa_receipt_number)}</strong>` : ''}
            <span class="small text-secondary d-block">${esc(fmtTime(p.paid_at))}${p.receipt_number ? ` · ${esc(p.receipt_number)}` : ''}</span></span><span class="text-success">${money(p.allocated)}</span></li>`).join('')}</ul>`
            : '<p class="small text-secondary mb-0">No payments yet.</p>'}</section>
        ${inv.stk_requests?.length ? `<section class="kodi-card"><h2 class="h6 fw-bold">M-Pesa prompts</h2><ul class="kodi-list small">${inv.stk_requests.map((s) => `<li>
          <span>+${esc(s.phone)} · ${esc(fmtMoney(s.amount))}<span class="d-block text-secondary">${esc(timeAgo(s.created_at))}${s.result_desc ? ` · ${esc(s.result_desc)}` : ''}</span></span>${badge(s.status)}</li>`).join('')}</ul></section>` : ''}
      </div>
    </div>`);
  const reload = () => invoiceDetailView({ id });
  main.addEventListener('click', async (e) => {
    if (e.target.closest('[data-stk]')) { await stkPushFlow(inv); reload(); }
    if (e.target.closest('[data-record]')) { if (await recordPaymentModal({ tenant_id: inv.tenant_id, amount: inv.balance, target_invoice_id: inv.id })) reload(); }
    if (e.target.closest('[data-add-item]')) {
      const done = await formModal({ title: 'Add a charge', fields: `${select('item_type', 'Type', ITEM_TYPES, { value: 'water', placeholder: null })}
        ${field('description', 'Description', { required: true, value: 'Water bill', attrs: 'minlength="2"' })}
        ${field('unit_price', 'Amount (KES)', { type: 'number', required: true, dataType: 'number', attrs: 'min="0" step="1"' })}`,
        onSubmit: (v) => api(acct(`/invoices/${id}/items`), { method: 'POST', body: { ...v, quantity: 1 } }) });
      if (done) reload();
    }
    if (e.target.closest('[data-void]')) {
      const done = await formModal({ title: 'Void invoice', submitLabel: 'Void invoice', fields: field('reason', 'Reason', { type: 'textarea', required: true, attrs: 'minlength="3"' }),
        onSubmit: (v) => api(acct(`/invoices/${id}/void`), { method: 'POST', body: v }) });
      if (done) reload();
    }
  });
  const offs = ['event:invoice_status_changed', 'event:payment_recorded'].map((ev) => live(ev, (d) => { if (!d.invoice_id || d.invoice_id === id) reload(); }));
  return () => offs.forEach((o) => o());
}

// ------------------------------------------------------------------ tenant: pay, payments, statement
export async function myInvoicesView() {
  const mount = scopedMount();
  const main = mount(`${pageHeader('Pay rent', { subtitle: 'Invoices from your landlord' })}<div id="mine">${skeleton(3)}</div>`);
  const load = async () => {
    const box = main.querySelector('#mine');
    try {
      const { data: rows, offline } = await api('/api/v1/me/invoices', { withMeta: true });
      const open = rows.filter((r) => ['issued', 'partially_paid', 'overdue'].includes(r.status));
      const paid = rows.filter((r) => r.status === 'paid').slice(0, 6);
      box.innerHTML = `${offline ? '<p class="kodi-offline-note">Offline: showing your saved invoices. Payments need a connection.</p>' : ''}
        ${open.length ? open.map((i) => `<section class="kodi-card kodi-invoice mb-3 ${i.status === 'overdue' ? 'is-overdue' : ''}">
          <div class="d-flex justify-content-between align-items-start"><div><span class="small text-secondary">${esc(i.invoice_number)}</span>
            <div class="kodi-stat">${esc(fmtMoney(i.balance))}</div><span class="small ${i.status === 'overdue' ? 'text-danger' : 'text-secondary'}">
            ${i.status === 'overdue' ? 'Overdue since' : 'Due'} ${esc(fmtDate(i.due_date))}</span></div>${badge(i.status)}</div>
          <p class="small text-secondary my-2">For ${esc(fmtDate(i.period_start))} to ${esc(fmtDate(i.period_end))}</p>
          <button class="btn btn-success btn-lg w-100" data-pay="${i.id}" ${offline ? 'disabled' : ''}>${icon('phone', 20)} Pay with M-Pesa</button>
        </section>`).join('') : `<section class="kodi-card text-center py-4 mb-3"><div class="kodi-success-burst mx-auto">${icon('check', 36)}</div>
          <h2 class="h5 fw-bold mt-3 mb-1">You're all paid up</h2><p class="small text-secondary mb-0">We'll notify you when the next invoice is issued.</p></section>`}
        <div data-paybill></div>
        ${paid.length ? `<section class="kodi-card"><h2 class="h6 fw-bold">Recently paid</h2><ul class="kodi-list">${paid.map((i) => `<li><span>${esc(i.invoice_number)}
          <span class="small text-secondary d-block">${esc(fmtDate(i.period_start))}</span></span><span class="text-success">${money(i.total_amount)}</span></li>`).join('')}</ul>
          <a class="btn btn-light btn-sm mt-2" href="#/payments">Receipts</a></section>` : ''}`;
      box.querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', async () => {
        const inv = rows.find((r) => r.id === b.dataset.pay);
        await stkPushFlow(inv, { tenantSelf: true });
        load();
      }));
      const leases = await api('/api/v1/me/leases').catch(() => []);
      const current = leases.find((l) => ['active', 'notice_given', 'pending_signature'].includes(l.status));
      if (current?.paybill_number) {
        const till = current.paybill_type === 'till';
        box.querySelector('[data-paybill]').innerHTML = `<section class="kodi-card mb-3"><h2 class="h6 fw-bold">Or pay from the M-Pesa menu</h2>
          <p class="small text-secondary mb-2">M-Pesa → Lipa na M-Pesa → ${till ? 'Buy Goods and Services' : 'Pay Bill'}.</p>
          <div class="d-flex gap-2"><div class="kodi-paycode flex-fill"><span class="small text-secondary d-block">${till ? 'Till number' : 'Business number'}</span><strong>${esc(current.paybill_number)}</strong></div>
          ${till ? '' : `<div class="kodi-paycode flex-fill"><span class="small text-secondary d-block">Account number</span><strong>${esc(current.payment_code)}</strong></div>`}</div>
          ${till ? '' : '<p class="small text-secondary mt-2 mb-0">Use exactly this account number so the payment is matched to you automatically.</p>'}</section>`;
      }
    } catch (err) { box.innerHTML = errorBox(err); }
  };
  await load();
  const offs = ['event:invoice_status_changed', 'event:payment_recorded'].map((ev) => live(ev, load));
  return () => offs.forEach((o) => o());
}

export async function myPaymentsView() {
  const mount = scopedMount();
  const main = mount(`${pageHeader('Payments & receipts', { back: '#/invoices' })}<div id="mp">${skeleton(3)}</div>`);
  try {
    const { data: rows, offline } = await api('/api/v1/me/payments', { withMeta: true });
    main.querySelector('#mp').innerHTML = `${offline ? '<p class="kodi-offline-note">Offline: receipts you opened before still download.</p>' : ''}
      ${rows.length ? `<div class="kodi-card p-0"><ul class="kodi-rows">${rows.map((p) => `<li><div class="kodi-row-inner">
        <span class="kodi-avatar mpesa">${icon(p.method.startsWith('mpesa') ? 'phone' : 'cash', 16)}</span>
        <span class="flex-grow-1"><strong class="d-block">${esc(fmtMoney(p.amount))}</strong><span class="small text-secondary">${esc(fmtTime(p.paid_at))} · ${esc(p.mpesa_receipt_number || label(p.method))}</span></span>
        ${p.receipt_id ? `<button class="btn btn-light btn-sm" data-download="/api/v1/me/receipts/${p.receipt_id}/pdf" data-name="${esc(p.receipt_number)}.pdf">${icon('download', 14)} Receipt</button>` : ''}
      </div></li>`).join('')}</ul></div>` : emptyState('receipt', 'No payments yet')}`;
  } catch (err) { main.querySelector('#mp').innerHTML = errorBox(err); }
}

export async function myStatementView() {
  const mount = scopedMount();
  const main = mount(`${pageHeader('My statement', { actions: `<button class="btn btn-light btn-sm" data-download="/api/v1/me/statement/export?format=csv" data-name="my-statement.csv">CSV</button>
    <button class="btn btn-primary btn-sm" data-download="/api/v1/me/statement/export?format=pdf" data-name="my-statement.pdf">${icon('download', 14)} PDF</button>` })}
    <section class="kodi-card" id="statement">${skeleton(3)}</section>`);
  try {
    const { data: rows, offline, cachedAt } = await api('/api/v1/me/statement', { withMeta: true });
    main.querySelector('#statement').innerHTML = `${offline ? `<p class="kodi-offline-note">Offline: showing the copy saved ${esc(timeAgo(cachedAt))}.</p>` : ''}
      ${rows.length ? statementTable(rows) : '<p class="text-secondary mb-0">No entries yet.</p>'}`;
  } catch (err) { main.querySelector('#statement').innerHTML = errorBox(err); }
}

