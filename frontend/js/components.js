// Reusable UI building blocks: icons, page chrome, modals & forms, badges,
// charts, authenticated images, uploads, signature pad and audio recorder.
import { api, ApiError } from './api.js';
import { esc, fmtMoney, setBusy } from './ui.js';

// ------------------------------------------------------------------ icons (stroke SVG, 24px grid)
const PATHS = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  building: 'M4 21V5a2 2 0 012-2h8a2 2 0 012 2v16M16 9h2a2 2 0 012 2v10M8 7h4M8 11h4M8 15h4M2 21h20',
  door: 'M5 21V4a1 1 0 011-1h12a1 1 0 011 1v17M3 21h18M15 12h.01',
  users: 'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM22 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75',
  receipt: 'M5 3v18l2-1.5L9 21l2-1.5L13 21l2-1.5L17 21l2-1.5V3l-2 1.5L15 3l-2 1.5L11 3 9 4.5 7 3zM9 8h6M9 12h6M9 16h4',
  wrench: 'M14.7 6.3a4 4 0 00-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 005.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z',
  chat: 'M21 12a8 8 0 01-11.6 7.1L3 21l1.9-6.4A8 8 0 1121 12z',
  chart: 'M3 3v18h18M7 15l4-4 3 3 5-6',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z',
  bell: 'M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0',
  plus: 'M12 5v14M5 12h14',
  phone: 'M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6A19.8 19.8 0 012.1 4.2 2 2 0 014.1 2h3a2 2 0 012 1.7c.1.9.4 1.8.7 2.7a2 2 0 01-.5 2.1L8 9.8a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.4c.9.3 1.8.6 2.7.7a2 2 0 011.7 2z',
  video: 'M23 7l-7 5 7 5V7zM1 5h15v14H1z',
  videoOff: 'M16 16v1a2 2 0 01-2 2H3a2 2 0 01-2-2V7a2 2 0 012-2h2m5 0h4a2 2 0 012 2v3.3l1 1L23 7v10M1 1l22 22',
  mic: 'M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3zM19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8',
  micOff: 'M1 1l22 22M9 9v3a3 3 0 005.1 2.1M15 9.3V4a3 3 0 00-5.9-.6M17 16.9A7 7 0 015 12v-2m14 0v2a7 7 0 01-.1 1.2M12 19v4M8 23h8',
  clip: 'M21.4 11.1l-9.2 9.2a6 6 0 01-8.5-8.5l9.2-9.2a4 4 0 015.7 5.7l-9.2 9.2a2 2 0 01-2.8-2.8l8.5-8.5',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z',
  x: 'M18 6L6 18M6 6l12 12',
  check: 'M20 6L9 17l-5-5',
  search: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3',
  download: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3',
  upload: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12',
  camera: 'M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2zM12 17a4 4 0 100-8 4 4 0 000 8z',
  logout: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9',
  cash: 'M2 6h20v12H2zM12 15a3 3 0 100-6 3 3 0 000 6zM6 12h.01M18 12h.01',
  alert: 'M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0zM12 9v4M12 17h.01',
  clock: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 6v6l4 2',
  star: 'M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z',
  map: 'M12 22s-8-6.5-8-13a8 8 0 0116 0c0 6.5-8 13-8 13zM12 12a3 3 0 100-6 3 3 0 000 6z',
  back: 'M15 18l-6-6 6-6',
  more: 'M12 13a1 1 0 100-2 1 1 0 000 2zM19 13a1 1 0 100-2 1 1 0 000 2zM5 13a1 1 0 100-2 1 1 0 000 2z',
  image: 'M3 3h18v18H3zM8.5 10a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM21 15l-5-5L5 21',
  file: 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6',
  key: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 11-7.8 7.8 5.5 5.5 0 017.8-7.8zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  swap: 'M16 3l4 4-4 4M20 7H4M8 21l-4-4 4-4M4 17h16',
  flip: 'M1 4v6h6M23 20v-6h-6M20.5 9A9 9 0 005.6 5.6L1 10m22 4l-4.6 4.4A9 9 0 013.5 15',
  pen: 'M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z',
  trash: 'M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6',
  copy: 'M9 9h13v13H9zM5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1',
  share: 'M18 8a3 3 0 100-6 3 3 0 000 6zM6 15a3 3 0 100-6 3 3 0 000 6zM18 22a3 3 0 100-6 3 3 0 000 6zM8.6 13.5l6.8 4M15.4 6.5l-6.8 4',
  menu: 'M3 12h18M3 6h18M3 18h18',
  bolt: 'M13 2L3 14h9l-1 8 10-12h-9z',
  drop: 'M12 2.7l5.7 5.7a8 8 0 11-11.3 0z',
  play: 'M5 3l14 9-14 9z',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
  calendar: 'M3 4h18v18H3zM16 2v4M8 2v4M3 10h18',
  layers: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  heart: 'M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 00-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 000-7.8z',
  bed: 'M2 20v-8a2 2 0 012-2h16a2 2 0 012 2v8M2 16h20M6 10V6a2 2 0 012-2h8a2 2 0 012 2v4M12 4v6',
  bath: 'M4 12h16v3a5 5 0 01-5 5H9a5 5 0 01-5-5zM6 12V5a2 2 0 013.5-1.3M7 20l-1 2M17 20l1 2',
  ruler: 'M21.3 8.7L8.7 21.3a1 1 0 01-1.4 0l-4.6-4.6a1 1 0 010-1.4L15.3 2.7a1 1 0 011.4 0l4.6 4.6a1 1 0 010 1.4zM7.5 10.5l2 2M10.5 7.5l2 2M13.5 4.5l2 2M4.5 13.5l2 2',
  wifi: 'M5 12.6a10 10 0 0114 0M1.4 9a15 15 0 0121.2 0M8.5 16.1a5 5 0 017 0M12 20h.01',
  car: 'M5 17h14M5 17a2 2 0 11-4 0v-4l2.5-6h17L23 13v4a2 2 0 11-4 0M5 17a2 2 0 104 0h6a2 2 0 104 0M3 13h18',
  sparkle: 'M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9zM19 3v4M17 5h4M5 17v4M3 19h4',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  sun: 'M12 17a5 5 0 100-10 5 5 0 000 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 018 0v4',
  store: 'M3 9l1.5-5h15L21 9M3 9v11h18V9M3 9h18M9 20v-6h6v6',
};

export function icon(name, size = 20, cls = '') {
  const d = PATHS[name] || PATHS.more;
  return `<svg class="kodi-icon ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}

// ------------------------------------------------------------------ labels
const LABELS = {
  apartment_flats: 'Apartment / flats', storey_building: 'Storey building', hostel: 'Hostel', commercial_plaza: 'Commercial plaza',
  bungalow: 'Bungalow', maisonette: 'Maisonette', mixed_use: 'Mixed use', single_room: 'Single room', bedsitter: 'Bedsitter',
  studio: 'Studio', one_bedroom: '1 bedroom', two_bedroom: '2 bedrooms', three_bedroom: '3 bedrooms',
  four_plus_bedroom: '4+ bedrooms', shared_hostel_room: 'Hostel room (shared)', shared_hostel_bed: 'Hostel bed',
  shop: 'Shop', office: 'Office', warehouse: 'Warehouse', under_maintenance: 'Under maintenance',
  pending_signature: 'Awaiting signature', notice_given: 'Notice given', partially_paid: 'Part paid',
  dispatched_contractor: 'Contractor dispatched', in_progress: 'In progress', under_review: 'Under review',
  mpesa_stk: 'M-Pesa (prompt)', mpesa_c2b: 'M-Pesa Paybill', bank_transfer: 'Bank transfer', pest_control: 'Pest control',
  national_id: 'National ID', alien_id: 'Alien ID', military_id: 'Military ID', every_30_days: 'Every 30 days',
  fixed_monthly_day: 'Same day each month', service_charge: 'Service charge', late_fee: 'Late fee', audio_note: 'Voice note',
};
export const label = (v) => LABELS[v] || String(v ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export const PROPERTY_TYPES = ['apartment_flats', 'storey_building', 'hostel', 'commercial_plaza', 'bungalow', 'maisonette', 'mixed_use', 'other'];
export const UNIT_TYPES = ['bedsitter', 'single_room', 'studio', 'one_bedroom', 'two_bedroom', 'three_bedroom', 'four_plus_bedroom',
  'shared_hostel_room', 'shared_hostel_bed', 'shop', 'office', 'warehouse', 'other'];
export const ISSUE_CATEGORIES = [
  ['plumbing', 'drop', 'Plumbing'], ['electrical', 'bolt', 'Electrical'], ['structural', 'building', 'Structural'],
  ['security', 'shield', 'Security'], ['pest_control', 'alert', 'Pests'], ['appliance', 'settings', 'Appliance'],
  ['sanitation', 'trash', 'Sanitation'], ['internet', 'layers', 'Internet'], ['other', 'more', 'Other'],
];

const TONES = {
  vacant: 'success', occupied: 'primary', reserved: 'info', under_maintenance: 'warning', cleaning: 'info', inactive: 'secondary',
  draft: 'secondary', pending_signature: 'warning', active: 'success', notice_given: 'warning', terminated: 'secondary', expired: 'secondary',
  issued: 'primary', partially_paid: 'warning', paid: 'success', overdue: 'danger', void: 'secondary',
  received: 'info', dispatched_contractor: 'primary', in_progress: 'primary', resolved: 'success', closed: 'secondary', rejected: 'secondary',
  pending: 'warning', completed: 'success', failed: 'danger', reversed: 'secondary', success: 'success', cancelled: 'secondary', timeout: 'secondary', initiated: 'warning',
  low: 'secondary', medium: 'info', high: 'warning', emergency: 'danger',
  clear: 'success', due: 'warning', in_arrears: 'danger',
};
export function badge(value, tone) {
  const t = tone || TONES[value] || 'secondary';
  return `<span class="kodi-badge kodi-badge-${t}">${esc(label(value))}</span>`;
}

// ------------------------------------------------------------------ page chrome
export function pageHeader(title, { subtitle = '', actions = '', back = '' } = {}) {
  return `<header class="kodi-page-header">
    ${back ? `<a class="btn btn-icon btn-light" href="${esc(back)}" aria-label="Back">${icon('back')}</a>` : ''}
    <div class="flex-grow-1 min-w-0">
      <h1 class="h4 fw-bold mb-0 text-truncate">${esc(title)}</h1>
      ${subtitle ? `<p class="text-secondary small mb-0 text-truncate">${subtitle}</p>` : ''}
    </div>
    <div class="d-flex gap-2 flex-wrap justify-content-end">${actions}</div>
  </header>`;
}

/** Section title with an optional "See all" link (Airbnb-style rhythm). */
export function sectionHead(title, href = '', linkText = 'See all') {
  return `<div class="kodi-section-head"><h2>${esc(title)}</h2>${href ? `<a href="${esc(href)}">${esc(linkText)} ${icon('arrow', 14)}</a>` : ''}</div>`;
}

/**
 * A real CSS 3D house (walls, gable roof, lit windows, lawn and a tree built
 * from planes in 3D space) that turns slowly. Pure CSS, works offline, no
 * WebGL. Decorative, so hidden from screen readers. size: 'lg' | 'md' | 'sm'.
 */
export function house3d(size = 'lg') {
  const win = (cls) => `<b class="h3-win ${cls}"></b>`;
  return `<div class="kodi-house3d is-${size}" aria-hidden="true"><div class="h3-float"><div class="h3-spin">
    <i class="h3-lawn"></i>
    <i class="h3-face h3-front"><b class="h3-door"></b>${win('w-a')}${win('w-b')}</i>
    <i class="h3-face h3-back">${win('w-a')}${win('w-b')}${win('w-c')}</i>
    <i class="h3-face h3-side h3-left">${win('w-s')}</i>
    <i class="h3-face h3-side h3-right">${win('w-s')}</i>
    <i class="h3-gable h3-gable-f"><b class="h3-win w-g"></b></i><i class="h3-gable h3-gable-b"></i>
    <i class="h3-roof h3-roof-l"></i><i class="h3-roof h3-roof-r"></i>
    <i class="h3-chimney"></i>
    <i class="h3-tree"></i><i class="h3-tree h3-tree-x"></i>
  </div></div><i class="h3-shadow"></i></div>`;
}

export function emptyState(iconName, title, text = '', action = '') {
  return `<div class="kodi-empty">
    <div class="kodi-empty-icon">${icon(iconName, 30)}</div>
    <h2 class="h6 fw-bold mb-1">${esc(title)}</h2>
    ${text ? `<p class="text-secondary small mb-3">${esc(text)}</p>` : ''}${action}
  </div>`;
}

export const skeleton = (rows = 3) => `<div class="kodi-card placeholder-glow">${Array.from({ length: rows },
  (_, i) => `<p class="mb-2"><span class="placeholder col-${[7, 10, 5, 8][i % 4]} rounded"></span></p>`).join('')}</div>`;

export function stat(labelText, value, { tone = '', hint = '', iconName = '' } = {}) {
  return `<section class="kodi-card kodi-stat-card" data-tilt="5">
    <div class="d-flex align-items-center justify-content-between mb-1">
      <span class="text-secondary small">${esc(labelText)}</span>${iconName ? `<span class="kodi-stat-icon ${tone ? `text-${tone}` : ''}">${icon(iconName, 18)}</span>` : ''}
    </div>
    <div class="kodi-stat ${tone ? `text-${tone}` : ''}">${value}</div>
    ${hint ? `<div class="small text-secondary">${hint}</div>` : ''}
  </section>`;
}

/** Turn API/network errors into plain language; never show raw validation text. */
export function friendlyError(err) {
  const status = err?.status;
  if (err instanceof ApiError && err.offline) return ['Not available offline yet', 'Open this screen once while online and Kodi will keep a copy on this device.'];
  if (status === 404 || status === 422 && /uuid|valid/i.test(err.message)) return ['We couldn’t find that', 'It may have been removed, or the link is incomplete. Go back and try again.'];
  if (status === 403) return ['You don’t have access to this', 'Ask the account owner to give you the right role.'];
  if (status === 401) return ['Please sign in again', 'Your session has ended.'];
  if (status >= 500) return ['Something went wrong on our side', 'Please try again in a moment. Your data is safe.'];
  return ['Could not load this', err?.message || 'Please try again.'];
}

export function errorBox(err) {
  const offline = err instanceof ApiError && err.offline;
  const [title, text] = friendlyError(err);
  return `<div class="kodi-card text-center py-4" role="alert">
    <div class="kodi-empty-icon mx-auto mb-2">${icon(offline ? 'clock' : 'alert', 26)}</div>
    <h1 class="h6 fw-bold mb-1">${esc(title)}</h1>
    <p class="text-secondary small mb-3">${esc(text)}</p>
    <div class="d-flex gap-2 justify-content-center"><button class="btn btn-light btn-sm" type="button" data-back>Go back</button>
      <button class="btn btn-primary btn-sm" type="button" data-retry>Try again</button></div>
  </div>`;
}

export const money = (v) => `<span class="kodi-amount">${esc(fmtMoney(v))}</span>`;

// ------------------------------------------------------------------ modals & forms
function mountModal(html, size) {
  const wrapper = document.createElement('div');
  wrapper.className = 'modal fade';
  wrapper.tabIndex = -1;
  wrapper.innerHTML = `<div class="modal-dialog modal-dialog-centered modal-dialog-scrollable ${size ? `modal-${size}` : ''} modal-fullscreen-sm-down">
    <div class="modal-content kodi-modal">${html}</div></div>`;
  document.body.append(wrapper);
  const instance = new window.bootstrap.Modal(wrapper);
  wrapper.addEventListener('hidden.bs.modal', () => { instance.dispose(); wrapper.remove(); });
  return { el: wrapper, instance };
}

/** Show a modal; resolves when it closes. `onReady(el, close)` wires behaviour. */
export function modal({ title, body, footer = '', size = '', onReady }) {
  return new Promise((resolve) => {
    const titleId = `m-${Math.random().toString(36).slice(2, 8)}`;
    const { el, instance } = mountModal(`
      <div class="modal-header border-0 pb-0"><h2 class="modal-title h5 fw-bold" id="${titleId}">${esc(title)}</h2>
        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>
      <div class="modal-body">${body}</div>${footer ? `<div class="modal-footer border-0 pt-0">${footer}</div>` : ''}`, size);
    el.setAttribute('aria-labelledby', titleId);
    let result;
    let shown = false;
    el.addEventListener('shown.bs.modal', () => { shown = true; }, { once: true });
    // Bootstrap ignores hide() while the modal is still animating in, so a very
    // fast submit would leave it open: wait for 'shown' first.
    const close = (value) => {
      result = value;
      if (shown) instance.hide();
      else el.addEventListener('shown.bs.modal', () => instance.hide(), { once: true });
    };
    el.addEventListener('hidden.bs.modal', () => resolve(result));
    instance.show();
    if (onReady) onReady(el, close);
  });
}

/**
 * Form in a modal. `onSubmit(values, form)` may throw ApiError: the message is
 * shown inside the form. Resolves with onSubmit's return value, or undefined.
 */
export function formModal({ title, fields, submitLabel = 'Save', size = '', onSubmit, onReady }) {
  return modal({
    title, size,
    body: `<form novalidate class="kodi-form">${fields}<div class="alert alert-danger small py-2 d-none mt-3 mb-0" data-form-error role="alert"></div>
      <div class="d-flex gap-2 justify-content-end mt-4"><button type="button" class="btn btn-light" data-bs-dismiss="modal">Cancel</button>
      <button type="submit" class="btn btn-primary">${esc(submitLabel)}</button></div></form>`,
    onReady: (el, close) => {
      const form = el.querySelector('form');
      if (onReady) onReady(form, el);
      setTimeout(() => form.querySelector('input:not([type=hidden]):not([type=checkbox]),select,textarea')?.focus(), 350);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const errorBoxEl = form.querySelector('[data-form-error]');
        errorBoxEl.classList.add('d-none');
        if (!form.checkValidity()) {
          form.classList.add('was-validated');
          // Say what is wrong instead of failing silently.
          const bad = form.querySelector(':invalid');
          const name = bad?.labels?.[0]?.textContent.replace('*', '').trim() || 'A field';
          errorBoxEl.textContent = `${name}: ${bad?.validationMessage || 'please check this value'}`;
          errorBoxEl.classList.remove('d-none');
          bad?.focus();
          return;
        }
        const button = form.querySelector('[type=submit]');
        setBusy(button, true, 'Saving…');
        try {
          const result = await onSubmit(formValues(form), form);
          close(result ?? true);
        } catch (err) {
          errorBoxEl.textContent = err.message;
          errorBoxEl.classList.remove('d-none');
        } finally { setBusy(button, false); }
      });
    },
  });
}

export function confirmDialog(message, { title = 'Are you sure?', confirmLabel = 'Confirm', danger = false } = {}) {
  return modal({
    title, body: `<p class="mb-0">${esc(message)}</p>`,
    footer: `<button class="btn btn-light" data-bs-dismiss="modal">Cancel</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(confirmLabel)}</button>`,
    onReady: (el, close) => el.querySelector('[data-ok]').addEventListener('click', () => close(true)),
  }).then(Boolean);
}

/** Form values with light typing: data-type="number|bool|list|date-or-null"; empty -> null. */
export function formValues(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled || el.type === 'file' || el.type === 'submit') continue;
    if (el.type === 'radio' && !el.checked) continue;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (typeof v === 'string') v = v.trim();
    const type = el.dataset.type;
    if (v === '' && type !== 'bool') v = null;
    else if (type === 'number' && v !== null) v = Number(v);
    else if (type === 'list') v = v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
    out[el.name] = v;
  }
  return out;
}

export function field(name, labelText, { type = 'text', value = '', required = false, placeholder = '', hint = '', attrs = '', col = '', dataType = '' } = {}) {
  const id = `f-${name}-${Math.random().toString(36).slice(2, 7)}`;
  const input = type === 'textarea'
    ? `<textarea class="form-control" id="${id}" name="${name}" rows="4" ${required ? 'required' : ''} placeholder="${esc(placeholder)}" ${attrs}>${esc(value)}</textarea>`
    : `<input class="form-control" id="${id}" name="${name}" type="${type}" value="${esc(value ?? '')}" ${required ? 'required' : ''}
        placeholder="${esc(placeholder)}" ${dataType ? `data-type="${dataType}"` : ''} ${attrs}>`;
  return `<div class="${col || 'mb-3'}"><label class="form-label small fw-semibold" for="${id}">${esc(labelText)}${required ? ' <span class="text-danger">*</span>' : ''}</label>
    ${input}${hint ? `<div class="form-text">${hint}</div>` : ''}</div>`;
}

export function select(name, labelText, options, { value = '', required = false, col = '', placeholder = '', dataType = '', attrs = '' } = {}) {
  const id = `f-${name}-${Math.random().toString(36).slice(2, 7)}`;
  const opts = options.map((o) => {
    const [v, t] = Array.isArray(o) ? o : [o, label(o)];
    return `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(t)}</option>`;
  }).join('');
  return `<div class="${col || 'mb-3'}"><label class="form-label small fw-semibold" for="${id}">${esc(labelText)}${required ? ' <span class="text-danger">*</span>' : ''}</label>
    <select class="form-select" id="${id}" name="${name}" ${required ? 'required' : ''} ${dataType ? `data-type="${dataType}"` : ''} ${attrs}>
      ${placeholder !== null ? `<option value="">${esc(placeholder || 'Choose…')}</option>` : ''}${opts}</select></div>`;
}

// ------------------------------------------------------------------ authenticated media
const blobUrls = new Map();

export async function mediaUrl(mediaId) {
  if (blobUrls.has(mediaId)) return blobUrls.get(mediaId);
  const promise = api(`/api/v1/media/${mediaId}`).then((blob) => URL.createObjectURL(blob));
  blobUrls.set(mediaId, promise);
  promise.catch(() => blobUrls.delete(mediaId));
  return promise;
}

const observer = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
  entries.forEach((e) => { if (e.isIntersecting) { observer.unobserve(e.target); loadMedia(e.target); } });
}, { rootMargin: '200px' }) : null;

async function loadMedia(el) {
  try {
    const url = await mediaUrl(el.dataset.media);
    if (el.tagName === 'IMG' || el.tagName === 'AUDIO' || el.tagName === 'VIDEO') el.src = url;
    else el.style.backgroundImage = `url("${url}")`;
    el.classList.add('is-loaded');
  } catch { el.classList.add('is-broken'); }
}

/** Load every [data-media] element inside root with the user's token (lazy). */
export function hydrateMedia(root = document) {
  root.querySelectorAll('[data-media]:not([data-hydrated])').forEach((el) => {
    el.dataset.hydrated = '1';
    if (observer) observer.observe(el); else loadMedia(el);
  });
}

export async function uploadFile(file, purpose, accountId, durationMs) {
  const form = new FormData();
  form.append('file', file, file.name || `${purpose}.${(file.type.split('/')[1] || 'bin').split(';')[0]}`);
  form.append('purpose', purpose);
  if (accountId) form.append('account_id', accountId);
  if (durationMs) form.append('duration_ms', String(Math.round(durationMs)));
  return api('/api/v1/media', { method: 'POST', body: form });
}

/** Image picker with previews. Returns { el html, files() } via wiring on a container. */
export function photoPicker(name = 'photos', { accept = 'image/*', max = 6, capture = false } = {}) {
  return `<div class="kodi-photo-picker" data-picker="${name}" data-max="${max}">
    <div class="kodi-photo-grid" data-previews></div>
    <label class="kodi-photo-add">${icon('camera', 22)}<span class="small">Add photos</span>
      <input type="file" accept="${accept}" multiple ${capture ? 'capture="environment"' : ''} class="visually-hidden" data-picker-input></label>
  </div>`;
}

export function wirePhotoPicker(root) {
  const picker = root.querySelector('[data-picker]');
  if (!picker) return () => [];
  const files = [];
  const max = Number(picker.dataset.max || 6);
  const previews = picker.querySelector('[data-previews]');
  const render = () => {
    previews.innerHTML = files.map((f, i) => `<figure class="kodi-photo">
      ${f.type.startsWith('image/') ? `<img src="${URL.createObjectURL(f)}" alt="">` : `<div class="kodi-photo-file">${icon('file')}<span>${esc(f.name)}</span></div>`}
      <button type="button" class="kodi-photo-remove" data-remove="${i}" aria-label="Remove">${icon('x', 14)}</button></figure>`).join('');
  };
  picker.querySelector('[data-picker-input]').addEventListener('change', (e) => {
    for (const f of e.target.files) if (files.length < max) files.push(f);
    e.target.value = '';
    render();
  });
  previews.addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (b) { files.splice(Number(b.dataset.remove), 1); render(); }
  });
  return () => files.slice();
}

// ------------------------------------------------------------------ charts (inline SVG)
/** Grouped bar chart. series: [{ name, color, values: [] }], labels: [] */
export function barChart(labels, series, { height = 200 } = {}) {
  if (!labels.length) return emptyState('chart', 'No data yet', 'Figures appear after the first invoices and payments.');
  const max = Math.max(1, ...series.flatMap((s) => s.values.map(Number)));
  const w = 100 / labels.length;
  const barW = (w * 0.7) / series.length;
  const bars = labels.map((l, i) => series.map((s, j) => {
    const v = Number(s.values[i] || 0);
    const h = (v / max) * 82;
    const x = i * w + w * 0.15 + j * barW;
    return `<rect class="kodi-bar" x="${x}%" y="${88 - h}%" width="${barW * 0.92}%" height="${h}%" rx="3" fill="${s.color}"
      style="animation-delay:${(i * series.length + j) * 40}ms"><title>${esc(s.name)} · ${esc(l)}: ${esc(fmtMoney(v))}</title></rect>`;
  }).join('')).join('');
  const axis = labels.map((l, i) => `<text x="${i * w + w / 2}%" y="97%" text-anchor="middle" class="kodi-axis">${esc(l)}</text>`).join('');
  const legend = series.map((s) => `<span class="kodi-legend"><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('');
  const short = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}K` : String(Math.round(v)));
  const grid = [0.5, 1].map((f) => `<line x1="0" x2="100%" y1="${88 - 82 * f}%" y2="${88 - 82 * f}%" class="kodi-gridline dashed"/>
    <text x="0" y="${88 - 82 * f - 1.5}%" class="kodi-axis">${short(max * f)}</text>`).join('');
  const summary = series.map((s) => `${s.name}: ${labels.map((l, i) => `${l} ${fmtMoney(s.values[i] || 0)}`).join(', ')}`).join('. ');
  return `<div class="kodi-chart"><svg width="100%" height="${height}" role="img" aria-label="${esc(summary)}">
    ${grid}<line x1="0" x2="100%" y1="88%" y2="88%" class="kodi-gridline"/>${bars}${axis}</svg><div class="kodi-legends">${legend}</div></div>`;
}

/** Donut chart. segments: [{ label, value, color }] */
export function donut(segments, centerText = '', centerSub = '') {
  const total = segments.reduce((a, s) => a + Number(s.value || 0), 0);
  const r = 15.915;
  let offset = 25;
  const arcs = total ? segments.filter((s) => Number(s.value)).map((s) => {
    const pct = (Number(s.value) / total) * 100;
    const arc = `<circle cx="21" cy="21" r="${r}" fill="transparent" stroke="${s.color}" stroke-width="5"
      stroke-dasharray="${pct} ${100 - pct}" stroke-dashoffset="${offset}" class="kodi-arc"><title>${esc(s.label)}: ${s.value}</title></circle>`;
    offset -= pct;
    return arc;
  }).join('') : `<circle cx="21" cy="21" r="${r}" fill="transparent" stroke="var(--kodi-border)" stroke-width="5"/>`;
  return `<div class="kodi-donut-wrap"><svg viewBox="0 0 42 42" class="kodi-donut" role="img" aria-label="${esc(centerText)} ${esc(centerSub)}">${arcs}
      <text x="21" y="21" text-anchor="middle" class="kodi-donut-value">${esc(centerText)}</text>
      <text x="21" y="26.5" text-anchor="middle" class="kodi-donut-sub">${esc(centerSub)}</text></svg>
    <ul class="kodi-donut-legend">${segments.map((s) => `<li><i style="background:${s.color}"></i>${esc(s.label)}<b>${esc(s.value)}</b></li>`).join('')}</ul></div>`;
}

// ------------------------------------------------------------------ signature pad
export function signaturePad(canvas) {
  const ctx = canvas.getContext('2d');
  let drawing = false;
  let dirty = false;
  let last = null;
  const resize = () => {
    const ratio = window.devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#0b1f4b';
  };
  resize();
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  canvas.addEventListener('pointerdown', (e) => { drawing = true; last = pos(e); canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last = p; dirty = true;
  });
  const stop = () => { drawing = false; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  return {
    clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; },
    isEmpty: () => !dirty,
    toBlob: () => new Promise((resolve) => {
      // White background so the signature is visible on any viewer.
      const out = document.createElement('canvas');
      out.width = canvas.width; out.height = canvas.height;
      const o = out.getContext('2d');
      o.fillStyle = '#fff'; o.fillRect(0, 0, out.width, out.height); o.drawImage(canvas, 0, 0);
      out.toBlob(resolve, 'image/png');
    }),
  };
}

// ------------------------------------------------------------------ audio notes
export function audioRecorderSupported() {
  return Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}

export async function startAudioRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
  const chunks = [];
  const started = performance.now();
  recorder.addEventListener('dataavailable', (e) => e.data.size && chunks.push(e.data));
  recorder.start(250);
  return {
    started,
    stop: () => new Promise((resolve) => {
      recorder.addEventListener('stop', () => {
        stream.getTracks().forEach((t) => t.stop());
        const mime = (recorder.mimeType || type || 'audio/webm').split(';')[0];
        const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
        resolve({ blob: new File(chunks, `voice-note.${ext}`, { type: mime }), durationMs: performance.now() - started });
      }, { once: true });
      recorder.stop();
    }),
    cancel: () => { recorder.stop(); stream.getTracks().forEach((t) => t.stop()); },
  };
}

// ------------------------------------------------------------------ misc
export function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

export const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

let countiesCache = null;
export async function counties() {
  countiesCache ||= api('/api/v1/locations/counties', { auth: false }).catch((e) => { countiesCache = null; throw e; });
  return countiesCache;
}
