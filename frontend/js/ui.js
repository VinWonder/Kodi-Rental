// Small DOM helpers shared by the shell. Phase 4 adds the component library.
import { CONFIG } from './config.js';

const money = new Intl.NumberFormat(CONFIG.locale, { style: 'currency', currency: CONFIG.currency, maximumFractionDigits: 2 });
const dateFmt = new Intl.DateTimeFormat(CONFIG.locale, { day: '2-digit', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(CONFIG.locale, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export const fmtMoney = (v) => money.format(Number(v || 0));
export const fmtDate = (v) => (v ? dateFmt.format(new Date(v)) : '');
export const fmtTime = (v) => (v ? timeFmt.format(new Date(v)) : '');

/** Escape text for safe insertion into HTML templates. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function timeAgo(iso) {
  if (!iso) return 'never';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return fmtDate(iso);
}

/** Bootstrap toast. `action` = { label, onClick } adds a button. */
export function toast(message, { variant = 'dark', action = null, autohide = true, delay = 5000 } = {}) {
  const el = document.createElement('div');
  el.className = `toast align-items-center text-bg-${variant} border-0 shadow`;
  el.setAttribute('role', variant === 'danger' ? 'alert' : 'status');
  el.innerHTML = `<div class="d-flex align-items-center">
      <div class="toast-body">${esc(message)}</div>
      ${action ? `<button type="button" class="btn btn-sm btn-light me-2 fw-semibold" data-action>${esc(action.label)}</button>` : ''}
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
    </div>`;
  document.getElementById('toasts').append(el);
  if (action) el.querySelector('[data-action]').addEventListener('click', () => { action.onClick(); window.bootstrap.Toast.getInstance(el)?.hide(); });
  const t = new window.bootstrap.Toast(el, { autohide, delay });
  el.addEventListener('hidden.bs.toast', () => el.remove());
  t.show();
  return t;
}

export function setBusy(button, busy, label = 'Working…') {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>${esc(label)}`;
  } else {
    button.disabled = false;
    if (button.dataset.label) button.innerHTML = button.dataset.label;
  }
}
