// Kodi app entry: routes, auth guard, realtime, chrome and global UI wiring.
import { authEvents, download, logout, reloadProfile, session } from './api.js';
import { setupCalls } from './calls.js';
import { emptyState } from './components.js';
import { guardCacheOwner, clearOfflineData, refreshOfflinePack, requestPersistentStorage } from './offline.js';
import { pwaEvents, registerServiceWorker, setupConnectivity, setupInstallBanners, syncPushSubscription } from './pwa.js';
import { rt } from './realtime.js';
import { fallback, navigate, onBeforeRoute, parseHash, resolve, route, setGuard, startRouter } from './router.js';
import { bumpUnread, loadBellMenu, mount, newScope, refreshUnread, renderChrome } from './shell.js';
import { state } from './state.js';
import { setBusy, toast } from './ui.js';
import { inviteView, loginView, onboardingView, registerView } from './views/auth.js';
import { billingView, invoiceDetailView, myInvoicesView, myPaymentsView, myStatementView } from './views/billing.js';
import { chatView, refreshChatBadge } from './views/chat.js';
import { dashboardView } from './views/dashboard.js';
import { notificationsView, tenantHomeView } from './views/home.js';
import { issueDetailView, issuesBoardView, myIssueDetailView, myIssuesView } from './views/issues.js';
import { leaseDetailView, leasesView, myLeaseView } from './views/leases.js';
import { propertiesView, propertyDetailView, unitDetailView } from './views/properties.js';
import { reportsView } from './views/reports.js';
import { settingsView } from './views/settings.js';
import { tenantDetailView, tenantsView } from './views/tenants.js';
import { vacanciesView, vacancyDetailView } from './views/vacancies.js';

// ------------------------------------------------------------------ routes
const byMode = (landlord, tenant) => (params, query) => (state.mode === 'landlord' ? landlord : tenant)(params, query);
const landlordOnly = (view) => (params, query) => (state.mode === 'landlord' ? view(params, query) : navigate('/', { replace: true }));
const noAccount = () => {
  mount(`<div class="kodi-card text-center py-5 kodi-narrow mx-auto mt-4">${emptyState('building', `Welcome, ${state.user.full_name.split(' ')[0]}`,
    'Landlords: set up your business to start. Tenants: open the invite link your landlord sent you.',
    '<a class="btn btn-primary" href="#/onboarding">Set up my business</a>')}</div>`);
};

route('/login', loginView, { public: true, guestOnly: true });
route('/register', registerView, { public: true, guestOnly: true });
route('/invite', inviteView, { public: true });
route('/vacancies', vacanciesView, { public: true });
route('/vacancies/:id', vacancyDetailView, { public: true });
route('/onboarding', onboardingView, { allowNoRole: true });

route('/', (p, q) => {
  if (!state.memberships.length && !state.tenancies.length) return noAccount();
  return state.mode === 'landlord' ? dashboardView(p, q) : tenantHomeView(p, q);
});
route('/properties', landlordOnly(propertiesView));
route('/properties/:id', landlordOnly(propertyDetailView));
route('/units/:id', landlordOnly(unitDetailView));
route('/tenants', landlordOnly(tenantsView));
route('/tenants/:id', landlordOnly(tenantDetailView));
route('/leases', landlordOnly(leasesView));
route('/leases/:id', landlordOnly(leaseDetailView));
route('/invoices', byMode(billingView, myInvoicesView));
route('/invoices/:id', landlordOnly(invoiceDetailView));
route('/payments', byMode((p, q) => billingView(p, { ...q, tab: 'payments' }), myPaymentsView));
route('/issues', byMode(issuesBoardView, myIssuesView));
route('/issues/:id', byMode(issueDetailView, myIssueDetailView));
route('/chat', chatView);
route('/chat/:id', chatView);
route('/reports', landlordOnly(reportsView));
route('/statement', byMode(() => navigate('/reports?tab=units', { replace: true }), myStatementView));
route('/lease', myLeaseView);
route('/settings', settingsView);
route('/notifications', notificationsView);
route('/units', () => navigate('/properties', { replace: true }));
fallback(() => mount(`<div class="kodi-card mt-4">${emptyState('search', 'Page not found', 'That link does not exist.', '<a class="btn btn-primary" href="#/">Go home</a>')}</div>`));

onBeforeRoute(() => newScope());

setGuard((r, path) => {
  const signedIn = session.isSignedIn && state.profile;
  if (!r.public && !signedIn) {
    navigate(`/login${path !== '/' ? `?next=${encodeURIComponent(path)}` : ''}`, { replace: true });
    return false;
  }
  if (r.guestOnly && signedIn) { navigate('/', { replace: true }); return false; }
  return true;
});

// ------------------------------------------------------------------ global UI wiring
document.addEventListener('click', async (event) => {
  // Table rows that act as links.
  const row = event.target.closest('[data-href]');
  if (row && !event.target.closest('a,button')) window.location.hash = row.dataset.href.replace(/^#/, '');

  // File downloads (receipts, statements).
  const dl = event.target.closest('[data-download]');
  if (dl) {
    setBusy(dl, true, 'Downloading…');
    try {
      const { offline } = await download(dl.dataset.download, dl.dataset.name);
      if (offline) toast('Opened the copy saved on this device.', { variant: 'warning' });
    } catch (err) { toast(err.message, { variant: 'danger' }); } finally { setBusy(dl, false); }
  }

  // Error cards: "Go back" / "Try again".
  if (event.target.closest('[data-back]')) window.history.back();
  if (event.target.closest('[data-retry]')) resolve();

  // Landlord <-> tenant view.
  if (event.target.closest('[data-switch-mode]')) {
    state.mode = state.mode === 'landlord' ? 'tenant' : 'landlord';
    renderChrome();
    navigate('/', { replace: true });
  }
});

document.addEventListener('change', (event) => {
  if (event.target.matches('.kodi-account-select')) {
    state.accountId = event.target.value;
    renderChrome();
    navigate('/', { replace: true });
  }
});

// Leaving a screen closes its dialogs (they belong to the page they opened on).
window.addEventListener('hashchange', () => {
  document.querySelectorAll('.modal.show').forEach((m) => window.bootstrap?.Modal.getInstance(m)?.hide());
});

document.getElementById('logout-button').addEventListener('click', () => logout());
document.getElementById('bell').addEventListener('show.bs.dropdown', loadBellMenu);

// ------------------------------------------------------------------ session lifecycle
async function afterSignIn(profile) {
  roleSignature = signature(profile);
  await guardCacheOwner(profile.user.id);
  renderChrome();
  rt.start();
  refreshUnread();
  refreshChatBadge();
  requestPersistentStorage().catch(() => {});
  syncPushSubscription().catch(() => {});
  refreshOfflinePack().catch(() => {});
}

authEvents.addEventListener('login', (e) => afterSignIn(e.detail));
let roleSignature = '';
const signature = (p) => `${p.memberships.map((m) => m.account_id + m.role).join()}|${p.tenancies.map((t) => t.tenant_id).join()}`;
authEvents.addEventListener('profile', (e) => {
  renderChrome();
  // The socket learns the user's accounts/tenancies when it connects: reconnect if they changed.
  const sig = signature(e.detail);
  if (roleSignature && sig !== roleSignature) { rt.stop(); rt.start(); }
  roleSignature = sig;
});
authEvents.addEventListener('logout', () => {
  rt.stop();
  clearOfflineData();
  renderChrome();
  navigate('/login', { replace: true });
});
authEvents.addEventListener('expired', () => {
  rt.stop();
  toast('Please sign in again.', { variant: 'warning' });
  renderChrome();
  navigate('/login', { replace: true });
});
pwaEvents.addEventListener('online', () => refreshOfflinePack({ force: true }).catch(() => {}));
pwaEvents.addEventListener('push', (e) => toast(`${e.detail.title}: ${e.detail.body}`, { variant: 'primary',
  action: e.detail.url ? { label: 'Open', onClick: () => window.location.assign(e.detail.url) } : null }));

// Live notifications over the WebSocket: toast + badge, and refresh the
// profile when a tenancy/lease changes (e.g. a tenant just signed).
rt.on('notification', ({ notification: n }) => {
  bumpUnread();
  const inThisChat = n.type === 'new_message' && parseHash().path.startsWith('/chat');
  if (!inThisChat) {
    const link = { new_message: '#/chat', missed_call: '#/chat', payment_received: '#/invoices', invoice_issued: '#/invoices',
      invoice_overdue: '#/invoices', issue_created: '#/issues', issue_updated: '#/issues' }[n.type];
    toast(`${n.title}${n.body ? `: ${n.body}` : ''}`, { variant: n.type === 'payment_received' ? 'success' : 'primary',
      action: link ? { label: 'View', onClick: () => { window.location.hash = link.slice(1); } } : null });
  }
  if (n.type === 'new_message') refreshChatBadge();
});
rt.on('event:lease_status_changed', () => reloadProfile().catch(() => {}));

// ------------------------------------------------------------------ boot
setupConnectivity();
setupInstallBanners();
setupCalls();
renderChrome();
registerServiceWorker();
startRouter().finally(() => document.getElementById('boot')?.remove());

if (session.isSignedIn && session.profile) {
  afterSignIn(session.profile);
  if (navigator.onLine) reloadProfile().catch(() => {});
}

// Re-render the current screen when coming back online (fresh data).
window.addEventListener('online', () => { if (session.isSignedIn) resolve(); });
