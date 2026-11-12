// Financial reporting: on-screen tables + PDF/CSV exports.
import { api, download } from '../api.js';
import { badge, barChart, emptyState, errorBox, field, icon, label, pageHeader, skeleton } from '../components.js';
import { setQuery } from '../router.js';
import { scopedMount } from '../shell.js';
import { acct, qs, state } from '../state.js';
import { esc, fmtDate, fmtMoney, fmtTime, setBusy, toast } from '../ui.js';

const TABS = [
  ['revenue', 'Monthly revenue', 'monthly_revenue'],
  ['defaulters', 'Defaulters', 'defaulters'],
  ['maintenance', 'Maintenance', 'maintenance_overhead'],
  ['occupancy', 'Occupancy', 'occupancy'],
  ['units', 'Unit balances', null],
  ['exports', 'Downloads', null],
];

const table = (head, rows, foot = '') => `<div class="kodi-card p-0"><div class="table-responsive" tabindex="0" role="region" aria-label="Report table"><table class="table table-kodi table-hover align-middle mb-0">
  <thead><tr>${head.map((h) => `<th class="${h.endsWith('#') ? 'text-end' : ''}">${esc(h.replace('#', ''))}</th>`).join('')}</tr></thead>
  <tbody>${rows}</tbody>${foot ? `<tfoot>${foot}</tfoot>` : ''}</table></div></div>`;
const r = (v) => `<td class="text-end kodi-amount">${esc(fmtMoney(v))}</td>`;
const month = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-KE', { month: 'short', year: 'numeric' });

export async function reportsView(_, query) {
  const mount = scopedMount();
  if (!state.canFinance) {
    mount(`${pageHeader('Reports')}${emptyState('shield', 'Reports are for owners, managers and accountants')}`);
    return;
  }
  const tab = query.tab || 'revenue';
  const current = TABS.find((t) => t[0] === tab) || TABS[0];
  const main = mount(`${pageHeader('Reports & statements', { subtitle: 'Download clean PDF and CSV files for your records or KRA' })}
    <ul class="nav kodi-tabs mb-3 flex-nowrap overflow-auto">${TABS.map(([k, t]) => `<li class="nav-item"><a class="nav-link text-nowrap ${k === tab ? 'active' : ''}" href="#/reports?tab=${k}">${t}</a></li>`).join('')}</ul>
    ${['revenue', 'maintenance'].includes(tab) ? `<form class="kodi-card kodi-filters mb-3 d-flex gap-2 flex-wrap align-items-end" id="range">
      ${field('date_from', 'From', { type: 'date', value: query.date_from || '', col: '' })}${field('date_to', 'To', { type: 'date', value: query.date_to || '', col: '' })}
      <button class="btn btn-light mb-0">Apply</button></form>` : ''}
    ${current[2] ? `<div class="d-flex gap-2 justify-content-end mb-3"><button class="btn btn-light" data-export="csv">${icon('download', 16)} CSV</button>
      <button class="btn btn-primary" data-export="pdf">${icon('download', 16)} PDF</button></div>` : ''}
    <div id="report">${skeleton(5)}</div>`);
  const box = main.querySelector('#report');
  const range = () => {
    const f = main.querySelector('#range');
    return f ? { date_from: f.date_from.value, date_to: f.date_to.value } : {};
  };

  const loaders = {
    async revenue() {
      const rows = await api(acct(`/reports/monthly-revenue${qs({ month_from: range().date_from, month_to: range().date_to })}`));
      if (!rows.length) return emptyState('chart', 'No revenue yet');
      const months = [...new Set(rows.map((x) => x.month))].sort().slice(-12);
      const sum = (m, k) => rows.filter((x) => x.month === m).reduce((a, x) => a + Number(x[k]), 0);
      const totals = ['invoiced', 'collected', 'mpesa_collected', 'maintenance_cost', 'net_operating_income'].map((k) => rows.reduce((a, x) => a + Number(x[k]), 0));
      return `<section class="kodi-card mb-3">${barChart(months.map(month), [
          { name: 'Billed', color: 'var(--kodi-chart-1)', values: months.map((m) => sum(m, 'invoiced')) },
          { name: 'Collected', color: 'var(--kodi-chart-2)', values: months.map((m) => sum(m, 'collected')) },
          { name: 'Maintenance', color: 'var(--kodi-chart-4)', values: months.map((m) => sum(m, 'maintenance_cost')) }], { height: 220 })}</section>
        ${table(['Month', 'Property', 'Billed#', 'Collected#', 'M-Pesa#', 'Maintenance#', 'Net#', 'Rate#'], rows.map((x) => `<tr>
          <td class="text-nowrap">${esc(month(x.month))}</td><td>${esc(x.property_name || 'Unmatched')}</td>${r(x.invoiced)}${r(x.collected)}${r(x.mpesa_collected)}
          ${r(x.maintenance_cost)}${r(x.net_operating_income)}<td class="text-end">${x.collection_rate_pct != null ? `${esc(x.collection_rate_pct)}%` : '-'}</td></tr>`).join(''),
          `<tr class="fw-bold"><td colspan="2">Total</td>${totals.map(r).join('')}<td></td></tr>`)}`;
    },
    async defaulters() {
      const rows = await api(acct('/reports/defaulters'));
      if (!rows.length) return emptyState('check', 'No tenants in arrears', 'Everyone has paid what is due.');
      return table(['Tenant', 'Unit', 'Overdue#', 'Oldest due', 'Days#', 'Aging', 'Action'], rows.map((x) => `<tr>
        <td><a href="#/tenants/${x.tenant_id}"><strong>${esc(x.tenant_name)}</strong></a><div class="small text-secondary">+${esc(x.tenant_phone)}</div></td>
        <td>${esc(x.unit_number)}<div class="small text-secondary">${esc(x.property_name)}</div></td>${r(x.amount_overdue)}
        <td>${esc(fmtDate(x.oldest_due_date))}</td><td class="text-end">${esc(x.max_days_overdue)}</td>
        <td>${badge(x.aging_bucket, x.aging_bucket === '90+' ? 'danger' : x.aging_bucket === '1-30' ? 'warning' : 'danger')}</td>
        <td class="text-end"><a class="btn btn-sm btn-success" href="#/invoices?tenant_id=${x.tenant_id}">${icon('phone', 14)} Collect</a></td></tr>`).join(''),
        `<tr class="fw-bold"><td colspan="2">Total</td>${r(rows.reduce((a, x) => a + Number(x.amount_overdue), 0))}<td colspan="4"></td></tr>`);
    },
    async maintenance() {
      const [rows, expenses] = await Promise.all([
        api(acct(`/reports/maintenance-overhead${qs({ month_from: range().date_from, month_to: range().date_to })}`)),
        api(acct(`/expenses${qs(range())}`)).catch(() => []),
      ]);
      if (!rows.length) return emptyState('wrench', 'No maintenance costs recorded', 'Log costs from a repair ticket once it is fixed.');
      return `${table(['Month', 'Property', 'Category', 'Items#', 'Cost#'], rows.map((x) => `<tr><td>${esc(month(x.month))}</td><td>${esc(x.property_name)}</td>
        <td>${esc(label(x.category))}</td><td class="text-end">${esc(x.expense_count)}</td>${r(x.total_cost)}</tr>`).join(''))}
        ${expenses.length ? `<h2 class="h6 fw-bold mt-4">Expense entries</h2>${table(['Date', 'Description', 'Contractor', 'Amount#'], expenses.map((x) => `<tr>
          <td>${esc(fmtDate(x.incurred_on))}</td><td>${esc(x.description)}</td><td>${esc(x.contractor_name || '-')}</td>${r(x.amount)}</tr>`).join(''))}` : ''}`;
    },
    async occupancy() {
      const rows = await api(acct('/reports/occupancy'));
      if (!rows.length) return emptyState('building', 'No properties yet');
      return table(['Property', 'Units#', 'Occupied#', 'Vacant#', 'Rate#', 'Rent roll#', 'Potential#'], rows.map((x) => `<tr>
        <td><a href="#/properties/${x.property_id}">${esc(x.property_name)}</a><div class="small text-secondary">${esc(x.area)}</div></td>
        <td class="text-end">${esc(x.total_units)}</td><td class="text-end">${esc(x.occupied)}</td><td class="text-end text-success">${esc(x.vacant)}</td>
        <td class="text-end">${esc(x.occupancy_rate_pct ?? 0)}%</td>${r(x.actual_rent_roll)}${r(x.potential_rent_roll)}</tr>`).join(''));
    },
    async units() {
      const rows = await api(acct('/reports/unit-financials'));
      if (!rows.length) return emptyState('door', 'No units yet');
      return table(['Unit', 'Tenant', 'State', 'Billed#', 'Paid#', 'Balance#'], rows.map((x) => `<tr>
        <td><a href="#/units/${x.unit_id}">${esc(x.unit_number)}</a></td><td>${esc(x.tenant_name || '-')}</td><td>${badge(x.financial_state)}</td>
        ${r(x.total_invoiced)}${r(x.total_paid)}<td class="text-end kodi-amount ${Number(x.outstanding_balance) > 0 ? 'text-danger' : ''}">${esc(fmtMoney(x.outstanding_balance))}</td></tr>`).join(''));
    },
    async exports() {
      const rows = await api(acct('/reports/exports'));
      if (!rows.length) return emptyState('download', 'No downloads yet', 'Files you generate from the other tabs are kept here.');
      return table(['Requested', 'Report', 'Format', 'Status', ''], rows.map((x) => `<tr><td class="text-nowrap">${esc(fmtTime(x.requested_at))}</td>
        <td>${esc(label(x.report_type))}</td><td class="text-uppercase">${esc(x.format)}</td><td>${badge(x.status === 'ready' ? 'completed' : x.status)}</td>
        <td class="text-end">${x.status === 'ready' ? `<button class="btn btn-sm btn-light" data-get="${x.id}" data-name="${esc(x.filename)}" aria-label="Download ${esc(x.filename)}">${icon('download', 14)}</button>` : esc(x.error || '')}</td></tr>`).join(''));
    },
  };

  const load = async () => {
    box.innerHTML = skeleton(5);
    try { box.innerHTML = await (loaders[tab] || loaders.revenue)(); } catch (err) { box.innerHTML = errorBox(err); }
  };
  main.querySelector('#range')?.addEventListener('submit', (e) => { e.preventDefault(); setQuery(range()); load(); });
  main.addEventListener('click', async (e) => {
    const ex = e.target.closest('[data-export]');
    if (ex) {
      setBusy(ex, true, 'Preparing…');
      try {
        const out = await api(acct('/reports/exports'), { method: 'POST', body: { report_type: current[2], format: ex.dataset.export, ...Object.fromEntries(Object.entries(range()).filter(([, v]) => v)) } });
        await download(acct(`/reports/exports/${out.id}/download`), out.filename);
      } catch (err) { toast(err.message, { variant: 'danger' }); } finally { setBusy(ex, false); }
    }
    const get = e.target.closest('[data-get]');
    if (get) download(acct(`/reports/exports/${get.dataset.get}/download`), get.dataset.name).catch((err) => toast(err.message, { variant: 'danger' }));
  });
  await load();
}
