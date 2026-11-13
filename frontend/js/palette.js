// Command palette (Ctrl/Cmd + K, or the search button in the top bar): jump to
// any screen, run a quick action, or find a tenant or unit by typing a few
// letters. Built on the ARIA combobox + listbox pattern for keyboard and
// screen-reader users.
import { api, session } from './api.js';
import { icon } from './components.js';
import { navigate } from './router.js';
import { acct, state } from './state.js';
import { esc, fmtMoney } from './ui.js';

const LANDLORD = [
  ['Dashboard', '/', 'home', 'Go to'], ['Properties and units', '/properties', 'building', 'Go to'],
  ['Tenants', '/tenants', 'users', 'Go to'], ['Billing and invoices', '/invoices', 'receipt', 'Go to'],
  ['Payments', '/invoices?tab=payments', 'cash', 'Go to'], ['Repairs board', '/issues', 'wrench', 'Go to'],
  ['Messages', '/chat', 'chat', 'Go to'], ['Reports and statements', '/reports', 'chart', 'Go to'],
  ['Defaulters', '/reports?tab=defaulters', 'alert', 'Go to'], ['Leases', '/leases', 'key', 'Go to'],
  ['Settings', '/settings', 'settings', 'Go to'], ['M-Pesa setup', '/settings?tab=mpesa', 'phone', 'Go to'],
  ['Add a property', '/properties?new=1', 'plus', 'Action'], ['Add a tenant', '/tenants?new=1', 'plus', 'Action'],
  ['Record a payment', '/invoices?tab=payments&record=1', 'cash', 'Action'], ['Allocate a unit', '/leases?new=1', 'key', 'Action'],
  ['Public vacancy listings', '/vacancies', 'search', 'Go to'],
];
const TENANT = [
  ['Home', '/', 'home', 'Go to'], ['Pay rent', '/invoices', 'cash', 'Action'], ['My payments', '/payments', 'receipt', 'Go to'],
  ['Report a problem', '/issues?new=1', 'wrench', 'Action'], ['My repairs', '/issues', 'wrench', 'Go to'],
  ['Message my landlord', '/chat', 'chat', 'Go to'], ['Statement', '/statement', 'receipt', 'Go to'],
  ['My lease', '/lease', 'pen', 'Go to'], ['Settings', '/settings', 'settings', 'Go to'], ['Find a house', '/vacancies', 'search', 'Go to'],
];

let el = null;
let lastFocus = null;

const score = (text, q) => {
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 3;
  if (t.split(/\s+/).some((w) => w.startsWith(q))) return 2;
  return t.includes(q) ? 1 : 0;
};

function build() {
  el = document.createElement('div');
  el.className = 'kodi-palette';
  el.hidden = true;
  el.innerHTML = `<div class="kodi-palette-scrim" data-close></div>
    <div class="kodi-palette-box" role="dialog" aria-modal="true" aria-label="Search Kodi">
      <div class="kodi-palette-input">${icon('search', 20)}
        <input type="text" role="combobox" aria-expanded="true" aria-controls="kp-list" aria-autocomplete="list"
          placeholder="Search screens, tenants, units or actions…" autocomplete="off" spellcheck="false" aria-label="Search">
        <kbd>Esc</kbd></div>
      <ul class="kodi-palette-list" id="kp-list" role="listbox" aria-label="Results"></ul>
      <div class="kodi-palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Ctrl</kbd><kbd>K</kbd> anytime</span></div>
    </div>`;
  document.body.append(el);
  const input = el.querySelector('input');
  const list = el.querySelector('ul');
  let items = [];
  let active = 0;
  let seq = 0;

  const paint = () => {
    list.innerHTML = items.length ? items.map((it, i) => `<li role="option" id="kp-${i}" aria-selected="${i === active}" data-i="${i}">
        <span class="kodi-palette-ic">${icon(it.icon, 18)}</span>
        <span class="flex-grow-1 min-w-0"><strong class="d-block text-truncate">${esc(it.title)}</strong>${it.sub ? `<span class="d-block small text-secondary text-truncate">${esc(it.sub)}</span>` : ''}</span>
        <span class="kodi-palette-kind">${esc(it.kind)}</span></li>`).join('')
      : '<li class="kodi-palette-empty" role="presentation">No matches. Try a tenant\'s name, a unit number or a screen.</li>';
    input.setAttribute('aria-activedescendant', items.length ? `kp-${active}` : '');
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  };

  const search = async () => {
    const q = input.value.trim().toLowerCase();
    const base = (state.mode === 'landlord' ? LANDLORD : TENANT).map(([title, href, ic, kind]) => ({ title, href, icon: ic, kind }));
    items = q ? base.map((it) => ({ it, s: score(it.title, q) })).filter((x) => x.s).sort((a, b) => b.s - a.s).map((x) => x.it) : base.slice(0, 8);
    active = 0;
    paint();
    if (q.length < 2 || state.mode !== 'landlord' || !state.accountId) return;
    const mine = ++seq;
    const [tenants, units] = await Promise.all([
      api(acct(`/tenants?q=${encodeURIComponent(q)}&limit=5`)).catch(() => []),
      api(acct(`/units?q=${encodeURIComponent(q)}&limit=5`)).catch(() => []),
    ]);
    if (mine !== seq || el.hidden) return;
    items = [
      ...items,
      ...tenants.map((t) => ({ title: t.full_name, sub: [t.unit_number && `Unit ${t.unit_number}`, t.property_name, Number(t.balance) ? `${fmtMoney(t.balance)} due` : ''].filter(Boolean).join(' · '),
        href: `/tenants/${t.id}`, icon: 'users', kind: 'Tenant' })),
      ...units.map((u) => ({ title: `Unit ${u.unit_number}`, sub: [u.property_name, u.tenant_name || 'No tenant'].filter(Boolean).join(' · '),
        href: `/units/${u.id}`, icon: 'door', kind: 'Unit' })),
    ];
    paint();
  };

  const go = (it) => { if (!it) return; close(); navigate(it.href); };
  let t;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(search, 120); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); go(items[active]); }
  });
  list.addEventListener('click', (e) => { const li = e.target.closest('[data-i]'); if (li) go(items[Number(li.dataset.i)]); });
  list.addEventListener('mousemove', (e) => {
    const li = e.target.closest('[data-i]');
    if (li && Number(li.dataset.i) !== active) { active = Number(li.dataset.i); paint(); }
  });
  el.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Tab') { e.preventDefault(); input.focus(); } // focus stays in the dialog
  });
  el.search = search;
}

export function openPalette() {
  if (!session.isSignedIn || !state.profile) return;
  if (!el) build();
  lastFocus = document.activeElement;
  el.hidden = false;
  document.body.classList.add('kodi-palette-open');
  const input = el.querySelector('input');
  input.value = '';
  el.search();
  requestAnimationFrame(() => input.focus());
}

export function close() {
  if (!el || el.hidden) return;
  el.hidden = true;
  document.body.classList.remove('kodi-palette-open');
  lastFocus?.focus?.();
}

export function setupPalette() {
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (el && !el.hidden) close(); else openPalette();
    }
  });
  document.addEventListener('click', (e) => { if (e.target.closest('[data-palette]')) openPalette(); });
  window.addEventListener('hashchange', close);
}
