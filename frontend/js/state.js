// Who is signed in, which landlord account is selected, and what they may do.
import { session } from './api.js';

const ACCOUNT_KEY = 'kodi.account';
const MODE_KEY = 'kodi.mode';
const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } };

export const state = {
  get profile() { return session.profile; },
  get user() { return session.profile?.user || null; },
  get memberships() { return session.profile?.memberships || []; },
  get tenancies() { return session.profile?.tenancies || []; },

  /** 'landlord' or 'tenant'. People can be both (a landlord who also rents). */
  get mode() {
    const saved = read(MODE_KEY);
    if (saved === 'tenant' && this.tenancies.length) return 'tenant';
    if (saved === 'landlord' && this.memberships.length) return 'landlord';
    return this.memberships.length ? 'landlord' : 'tenant';
  },
  set mode(value) { write(MODE_KEY, value); },
  get canSwitchMode() { return this.memberships.length > 0 && this.tenancies.length > 0; },

  get accountId() {
    const saved = read(ACCOUNT_KEY);
    if (saved && this.memberships.some((m) => m.account_id === saved)) return saved;
    return this.memberships[0]?.account_id || null;
  },
  set accountId(value) { write(ACCOUNT_KEY, value); },
  get membership() { return this.memberships.find((m) => m.account_id === this.accountId) || null; },
  get role() { return this.membership?.role || null; },
  get isStaff() { return ['owner', 'manager'].includes(this.role); },
  get canFinance() { return ['owner', 'manager', 'accountant'].includes(this.role); },
  get isOwner() { return this.role === 'owner'; },
  get tenancy() { return this.tenancies[0] || null; },
};

/** Path under the selected landlord account. */
export const acct = (path = '') => `/api/v1/accounts/${state.accountId}${path}`;

/** Build a query string, dropping empty values. */
export function qs(params = {}) {
  const pairs = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return pairs.length ? `?${new URLSearchParams(pairs).toString()}` : '';
}
