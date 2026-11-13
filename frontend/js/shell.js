// App chrome: main content area, sidebar (desktop), bottom tab bar (phones),
// account switcher, notification bell and mode switch.
import { api, session } from './api.js';
import { hydrateMedia, icon } from './components.js';
import { rt } from './realtime.js';
import { currentPath } from './router.js';
import { state } from './state.js';
import { esc, timeAgo } from './ui.js';
import { countUp, mountDone } from './fx.js';

export const $main = () => document.getElementById('main');

let viewSubs = [];
let activeScope = 0;

/** Called by the router before each navigation renders. */
export function newScope() { activeScope += 1; return activeScope; }

/**
 * A mount() bound to the navigation that is current right now. Screens load
 * data asynchronously; if the user has moved on by the time the data arrives,
 * the late render is dropped instead of drawing over the new page.
 */
export function scopedMount() {
  const scope = activeScope;
  return (html) => {
    if (scope === activeScope) return mount(html);
    const detached = document.createElement('div');
    detached.innerHTML = html;
    return detached;
  };
}

/** Subscribe to a realtime event for the current screen only: the handler is
 * removed automatically the next time any screen renders. */
export function live(type, fn) {
  const off = rt.on(type, fn);
  viewSubs.push(off);
  return off;
}

/** Replace the page content (and drop the previous screen's live handlers). */
export function mount(html) {
  viewSubs.splice(0).forEach((off) => off());
  const main = $main();
  main.innerHTML = `<div class="kodi-view">${html}</div>`;
  mountDone();
  hydrateMedia(main);
  countUp(main);
  window.scrollTo({ top: 0, behavior: 'instant' });
  highlightNav();
  // Return the per-screen element, not #main: event listeners that screens
  // attach to it are discarded with it on the next render instead of piling up.
  return main.firstElementChild;
}

const LANDLORD_NAV = [
  ['/', 'home', 'Dashboard', 'Home'],
  ['/properties', 'building', 'Properties', 'Units'],
  ['/tenants', 'users', 'Tenants', 'Tenants'],
  ['/invoices', 'receipt', 'Billing', 'Billing'],
  ['/issues', 'wrench', 'Repairs', 'Repairs'],
  ['/chat', 'chat', 'Messages', null],      // phones: top-bar shortcut keeps the tab bar at 5
  ['/reports', 'chart', 'Reports', null],
  ['/settings', 'settings', 'Settings', null],
];
const TENANT_NAV = [
  ['/', 'home', 'Home', 'Home'],
  ['/invoices', 'cash', 'Pay rent', 'Pay'],
  ['/issues', 'wrench', 'Repairs', 'Repairs'],
  ['/chat', 'chat', 'Messages', 'Chat'],
  ['/statement', 'receipt', 'Statement', 'Statement'],
  ['/lease', 'pen', 'My lease', null],
  ['/settings', 'settings', 'Settings', null],
];

const navItems = () => (state.mode === 'landlord' ? LANDLORD_NAV : TENANT_NAV);

function isActive(href) {
  const path = currentPath();
  if (href === '/') return path === '/';
  if (href === '/properties') return path.startsWith('/properties') || path.startsWith('/units');
  if (href === '/invoices') return ['/invoices', '/payments', '/leases'].some((p) => path.startsWith(p));
  return path.startsWith(href);
}

export function highlightNav() {
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const active = isActive(a.dataset.nav);
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

export function renderChrome() {
  const signedIn = session.isSignedIn && state.profile;
  document.body.classList.toggle('is-signed-in', Boolean(signedIn));
  const side = document.getElementById('sidenav');
  const bottom = document.getElementById('bottomnav');
  const account = document.getElementById('account-switch');
  const userMenu = document.getElementById('user-menu');
  const bell = document.getElementById('bell');
  [userMenu, bell, document.getElementById('palette-btn')].forEach((el) => el.classList.toggle('d-none', !signedIn));
  // Landlords reach Messages from the top bar on phones (tenants have a Chat tab).
  document.getElementById('chat-shortcut').classList.toggle('d-none', !signedIn || state.mode !== 'landlord');
  if (!signedIn) {
    side.innerHTML = '';
    bottom.innerHTML = '';
    account.innerHTML = '';
    return;
  }

  const items = navItems();
  side.innerHTML = `<div class="kodi-sidenav-inner">
    ${items.map(([href, ic, text]) => `<a href="#${href}" data-nav="${href}" class="kodi-navlink">${icon(ic)}<span>${text}</span>
      ${href === '/chat' ? '<span class="kodi-dot d-none" data-unread-chat></span>' : ''}</a>`).join('')}
    ${state.canSwitchMode ? `<button class="kodi-navlink mt-auto" data-switch-mode>${icon('swap')}<span>${state.mode === 'landlord' ? 'Tenant view' : 'Landlord view'}</span></button>` : ''}
  </div>`;
  bottom.innerHTML = items.filter((i) => i[3]).map(([href, ic, , short]) => `
    <a href="#${href}" data-nav="${href}" class="kodi-tab">${icon(ic, 22)}<span>${short}</span>
      ${href === '/chat' ? '<span class="kodi-dot d-none" data-unread-chat></span>' : ''}</a>`).join('');

  // Account switcher for landlords with several businesses.
  if (state.mode === 'landlord' && state.memberships.length) {
    account.innerHTML = state.memberships.length > 1
      ? `<select class="form-select form-select-sm kodi-account-select" aria-label="Business account">
          ${state.memberships.map((m) => `<option value="${m.account_id}" ${m.account_id === state.accountId ? 'selected' : ''}>${esc(m.business_name)}</option>`).join('')}
        </select>`
      : `<span class="kodi-account-name text-truncate">${esc(state.membership?.business_name || '')}</span>`;
  } else {
    account.innerHTML = state.tenancy ? `<span class="kodi-account-name text-truncate">${esc(state.tenancy.business_name)}</span>` : '';
  }
  document.getElementById('user-menu-button').innerHTML = `<span class="kodi-avatar">${esc((state.user.full_name || '?')[0])}</span>
    <span class="d-none d-sm-inline">${esc(state.user.full_name.split(' ')[0])}</span>`;
  document.querySelectorAll('[data-landlord-only]').forEach((el) => el.classList.toggle('d-none', state.mode !== 'landlord'));
  highlightNav();
}

// ------------------------------------------------------------------ notification bell
export async function refreshUnread() {
  if (!session.isSignedIn) return;
  try {
    const { unread } = await api('/api/v1/notifications/unread-count');
    setUnread(unread);
  } catch { /* offline */ }
}

export function setUnread(count) {
  const el = document.getElementById('bell-count');
  el.textContent = count > 99 ? '99+' : String(count);
  el.classList.toggle('d-none', !count);
  if ('setAppBadge' in navigator) (count ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {});
}

export function bumpUnread() {
  const el = document.getElementById('bell-count');
  const n = Number(el.textContent.replace('+', '')) || 0;
  setUnread(n + 1);
}

export async function loadBellMenu() {
  const list = document.getElementById('bell-list');
  list.innerHTML = '<li class="px-3 py-2 small text-secondary">Loading…</li>';
  try {
    const items = await api('/api/v1/notifications?limit=12');
    list.innerHTML = items.length ? items.map((n) => `<li><a class="dropdown-item kodi-notif ${n.read_at ? '' : 'unread'}" href="#/notifications">
        <strong class="d-block text-truncate">${esc(n.title)}</strong>
        <span class="small text-secondary d-block text-truncate">${esc(n.body || '')}</span>
        <span class="small text-secondary">${esc(timeAgo(n.created_at))}</span></a></li>`).join('')
      : '<li class="px-3 py-3 small text-secondary">You are all caught up.</li>';
    if (items.some((n) => !n.read_at)) {
      await api('/api/v1/notifications/read', { method: 'POST', body: { all: true } });
      setUnread(0);
    }
  } catch (err) {
    list.innerHTML = `<li class="px-3 py-2 small text-secondary">${esc(err.message)}</li>`;
  }
}

export function setChatUnread(count) {
  document.querySelectorAll('[data-unread-chat]').forEach((el) => el.classList.toggle('d-none', !count));
}
