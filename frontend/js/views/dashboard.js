// Landlord dashboard: KPIs, occupancy donut, revenue trend, arrears, live feed.
import { api } from '../api.js';
import { barChart, donut, emptyState, errorBox, icon, label, money, pageHeader, skeleton, stat } from '../components.js';
import { live, scopedMount } from '../shell.js';
import { acct, state } from '../state.js';
import { esc, fmtMoney, timeAgo } from '../ui.js';

const PRIORITY_ORDER = ['emergency', 'high', 'medium', 'low'];

function monthLabel(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-KE', { month: 'short' });
}

export async function dashboardView() {
  const mount = scopedMount();
  const name = state.user.full_name.split(' ')[0];
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const main = mount(`${pageHeader(`${greet}, ${name}`, {
    subtitle: esc(state.membership?.business_name || ''),
    actions: state.isStaff ? `<a class="btn btn-light" href="#/tenants?new=1">${icon('users', 18)}<span class="d-none d-md-inline"> Add tenant</span></a>
      <a class="btn btn-primary" href="#/properties?new=1">${icon('plus', 18)}<span class="d-none d-md-inline"> Add property</span></a>` : '',
  })}
    <div id="dash-body">${skeleton(4)}</div>`);

  const load = async () => {
    const body = main.querySelector('#dash-body');
    try {
      const [d, revenue] = await Promise.all([
        api(acct('/dashboard')),
        state.canFinance ? api(acct('/reports/monthly-revenue')).catch(() => []) : Promise.resolve([]),
      ]);
      const o = d.occupancy;
      const openIssues = Object.values(d.open_issues).reduce((a, b) => a + b, 0);

      // Aggregate revenue across properties per month, last 6 months.
      const byMonth = new Map();
      for (const r of revenue) {
        const m = byMonth.get(r.month) || { invoiced: 0, collected: 0 };
        m.invoiced += Number(r.invoiced); m.collected += Number(r.collected);
        byMonth.set(r.month, m);
      }
      const months = [...byMonth.keys()].sort().slice(-6);
      const collectionRate = Number(d.this_month.invoiced) ? Math.round((100 * d.this_month.collected) / d.this_month.invoiced) : 0;

      body.innerHTML = `
        ${d.unmatched_payments ? `<a class="kodi-alert mb-3" href="#/invoices?tab=payments&unmatched=1">${icon('alert', 18)}
          <span><strong>${d.unmatched_payments} M-Pesa payment(s)</strong> could not be matched to a tenant. Tap to assign them.</span></a>` : ''}
        <div class="kodi-grid kodi-grid-4 mb-3">
          ${stat('Collected this month', esc(fmtMoney(d.this_month.collected)), { tone: 'success', iconName: 'cash',
            hint: `${collectionRate}% of ${esc(fmtMoney(d.this_month.invoiced))} billed` })}
          ${stat('Rent in arrears', esc(fmtMoney(d.arrears.amount_overdue)), { tone: Number(d.arrears.amount_overdue) ? 'danger' : '', iconName: 'alert',
            hint: `<a href="#/reports?tab=defaulters">${d.arrears.defaulters} tenant(s) overdue</a>` })}
          ${stat('Occupancy', `${esc(o.occupancy_rate_pct)}%`, { iconName: 'door', hint: `${o.occupied} of ${o.total_units} units occupied` })}
          ${stat('Open repairs', String(openIssues), { tone: d.open_issues.emergency ? 'danger' : '', iconName: 'wrench',
            hint: PRIORITY_ORDER.filter((p) => d.open_issues[p]).map((p) => `${d.open_issues[p]} ${p}`).join(' · ') || 'Nothing pending' })}
        </div>
        <div class="row g-3">
          <div class="col-lg-8">
            <section class="kodi-card h-100">
              <div class="d-flex justify-content-between align-items-center mb-2"><h2 class="h6 fw-bold mb-0">Billed vs collected</h2>
                <a class="small" href="#/reports">Reports</a></div>
              ${state.canFinance ? barChart(months.map(monthLabel), [
                { name: 'Billed', color: 'var(--kodi-chart-1)', values: months.map((m) => byMonth.get(m).invoiced) },
                { name: 'Collected', color: 'var(--kodi-chart-2)', values: months.map((m) => byMonth.get(m).collected) },
              ]) : '<p class="small text-secondary">Financial figures are visible to owners, managers and accountants.</p>'}
            </section>
          </div>
          <div class="col-lg-4">
            <section class="kodi-card h-100">
              <h2 class="h6 fw-bold mb-2">Units</h2>
              ${Number(o.total_units) ? donut([
                { label: 'Occupied', value: o.occupied, color: 'var(--kodi-chart-1)' },
                { label: 'Vacant', value: o.vacant, color: 'var(--kodi-chart-2)' },
                { label: 'Reserved', value: o.reserved, color: 'var(--kodi-chart-3)' },
                { label: 'Repairs', value: o.under_maintenance, color: 'var(--kodi-chart-4)' },
                { label: 'Cleaning', value: o.cleaning, color: 'var(--kodi-chart-5)' },
              ], `${o.occupancy_rate_pct}%`, 'occupied') : emptyState('door', 'No units yet', 'Add a property and its units.',
                '<a class="btn btn-primary btn-sm" href="#/properties?new=1">Add property</a>')}
              <p class="small text-secondary mt-2 mb-0">Rent roll ${esc(fmtMoney(o.actual_rent_roll))} of ${esc(fmtMoney(o.potential_rent_roll))} potential.</p>
            </section>
          </div>
          <div class="col-lg-7">
            <section class="kodi-card h-100">
              <div class="d-flex justify-content-between align-items-center mb-2"><h2 class="h6 fw-bold mb-0">Latest payments</h2>
                <span class="kodi-live" title="Updates live">${icon('bolt', 14)} Live</span></div>
              ${d.recent_payments.length ? `<ul class="kodi-list">${d.recent_payments.map((p) => `
                <li class="kodi-fade-in"><span><strong class="d-block">${esc(p.tenant_name || 'Unmatched payment')}</strong>
                  <span class="small text-secondary">${esc(label(p.method))}${p.mpesa_receipt_number ? ` · ${esc(p.mpesa_receipt_number)}` : ''} · ${esc(timeAgo(p.paid_at))}</span></span>
                  <span class="text-success fw-semibold">${money(p.amount)}</span></li>`).join('')}</ul>`
                : emptyState('cash', 'No payments yet', 'M-Pesa payments appear here the moment Safaricom confirms them.')}
            </section>
          </div>
          <div class="col-lg-5">
            <section class="kodi-card h-100">
              <h2 class="h6 fw-bold mb-2">Quick actions</h2>
              <div class="kodi-quick">
                <a href="#/invoices?tab=payments&record=1">${icon('cash')}<span>Record payment</span></a>
                <a href="#/leases?new=1">${icon('key')}<span>Allocate unit</span></a>
                <a href="#/issues">${icon('wrench')}<span>Repairs</span></a>
                <a href="#/reports">${icon('download')}<span>Statements</span></a>
                <a href="#/vacancies" target="_blank">${icon('search')}<span>Public listings</span></a>
                <a href="#/settings?tab=mpesa">${icon('phone')}<span>M-Pesa setup</span></a>
              </div>
            </section>
          </div>
        </div>`;
    } catch (err) { body.innerHTML = errorBox(err); }
  };
  await load();

  // Live: refresh when money moves or units change state.
  let timer;
  const refresh = () => { clearTimeout(timer); timer = setTimeout(load, 600); };
  const offs = ['event:payment_recorded', 'event:invoice_status_changed', 'event:unit_status_changed', 'event:issue_created']
    .map((ev) => live(ev, refresh));
  return () => { offs.forEach((off) => off()); clearTimeout(timer); };
}
