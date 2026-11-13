// Public vacancy search (no sign-in): the "auto-listed when vacant" side of
// the unit state engine. Explore layout borrows proven patterns from travel
// marketplaces: one search pill, a category bar, photo-first cards you can
// swipe, a save heart, a photo collage and a sticky contact bar.
import { api } from '../api.js';
import {
  copyText, counties, emptyState, errorBox, house3d, icon, label, modal, select, skeleton,
} from '../components.js';
import { setQuery } from '../router.js';
import { scopedMount } from '../shell.js';
import { esc, fmtMoney, toast } from '../ui.js';
import { CONFIG } from '../config.js';

const img = (url) => (url ? `${CONFIG.apiBase}${url}` : '');
const NEW_DAYS = 7;

const CATEGORIES = [
  ['', 'All homes', 'home'],
  ['bedsitter', 'Bedsitters', 'bed'],
  ['single_room', 'Single rooms', 'door'],
  ['studio', 'Studios', 'sparkle'],
  ['one_bedroom', '1 bedroom', 'bed'],
  ['two_bedroom', '2 bedrooms', 'bed'],
  ['three_bedroom', '3 bedrooms', 'home'],
  ['four_plus_bedroom', '4+ bedrooms', 'building'],
  ['shared_hostel_room', 'Hostels', 'users'],
  ['shop', 'Shops', 'store'],
  ['office', 'Offices', 'building'],
  ['saved', 'Saved', 'heart'],
];

// ------------------------------------------------------------------ saved homes (this device)
const SAVED_KEY = 'kodi.saved';
function savedIds() {
  try { return new Set(JSON.parse(localStorage.getItem(SAVED_KEY) || '[]')); } catch { return new Set(); }
}
function toggleSaved(id) {
  const ids = savedIds();
  const on = !ids.has(id);
  if (on) ids.add(id); else ids.delete(id);
  try { localStorage.setItem(SAVED_KEY, JSON.stringify([...ids])); } catch { /* private mode */ }
  return on;
}
function heartButton(id, name, cls = 'kodi-heart') {
  const on = savedIds().has(id);
  return `<button type="button" class="${cls}" data-save="${esc(id)}" aria-pressed="${on}" aria-label="Save ${esc(name)}">${icon('heart', cls === 'kodi-heart' ? 26 : 20)}</button>`;
}
function wireSaving(root) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-save]');
    if (!b) return;
    e.preventDefault();
    const on = toggleSaved(b.dataset.save);
    root.querySelectorAll(`[data-save="${CSS.escape(b.dataset.save)}"]`).forEach((x) => x.setAttribute('aria-pressed', String(on)));
    toast(on ? 'Saved. Find it under "Saved".' : 'Removed from saved homes.', { variant: on ? 'success' : 'dark', delay: 2500 });
  });
}

const isNew = (iso) => iso && Date.now() - new Date(iso).getTime() < NEW_DAYS * 864e5;
const title = (v) => `${label(v.unit_type)} at ${v.property_name}`;
function specs(v) {
  const bits = [];
  if (v.bedrooms != null) bits.push(`${v.bedrooms} bed${Number(v.bedrooms) === 1 ? '' : 's'}`);
  if (v.bathrooms != null) bits.push(`${v.bathrooms} bath${Number(v.bathrooms) === 1 ? '' : 's'}`);
  if (v.size_sqm) bits.push(`${Number(v.size_sqm)} m²`);
  return bits.join(' · ');
}

// ------------------------------------------------------------------ listing card
function stayCard(v) {
  const photos = (v.photos?.length ? v.photos : v.cover_url ? [v.cover_url] : v.gallery || []).slice(0, 5);
  const href = `#/vacancies/${v.unit_id}`;
  const name = title(v);
  const media = photos.length
    ? photos.map((u, i) => `<a href="${href}" tabindex="-1" aria-hidden="true"><img src="${esc(img(u))}" alt="" loading="lazy" decoding="async"
        ${i ? '' : 'fetchpriority="low"'}></a>`).join('')
    : `<a href="${href}" tabindex="-1" aria-hidden="true" class="kodi-stay-art">${house3d('md')}</a>`;
  const where = v.distance_km != null ? `${v.distance_km} km away` : v.sub_county_name || v.county_name;
  return `<article class="kodi-stay">
    <div class="kodi-stay-media">
      <div class="kodi-stay-track" data-track ${photos.length > 1 ? `tabindex="0" role="group" aria-label="${photos.length} photos of ${esc(name)}"` : ''}>${media}</div>
      ${isNew(v.listed_at) ? '<span class="kodi-stay-badge">New on Kodi</span>' : v.landmark ? `<span class="kodi-stay-badge">Near ${esc(v.landmark)}</span>` : ''}
      ${heartButton(v.unit_id, name)}
      ${photos.length > 1 ? `<button type="button" class="kodi-stay-nav prev" data-step="-1" aria-label="Previous photo" disabled>${icon('back', 16)}</button>
        <button type="button" class="kodi-stay-nav next" data-step="1" aria-label="Next photo">${icon('back', 16, 'flip-x')}</button>
        <div class="kodi-dots" aria-hidden="true">${photos.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>` : ''}
    </div>
    <div class="kodi-stay-body">
      <h2 class="kodi-stay-title"><a href="${href}"><span>${esc(v.area)}, ${esc(v.county_name)}</span></a>
        ${isNew(v.listed_at) ? `<span class="kodi-new">${icon('sparkle', 14)} New</span>` : ''}</h2>
      <p class="kodi-stay-sub">${esc(name)}</p>
      <p class="kodi-stay-sub">${esc([specs(v), where].filter(Boolean).join(' · '))}</p>
      <p class="kodi-stay-price"><strong>${esc(fmtMoney(v.monthly_rent))}</strong> month</p>
    </div>
  </article>`;
}

/** Card carousels: arrow buttons, and dots that follow swipes. */
function wireCarousels(root) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-step]');
    if (!b) return;
    e.preventDefault();
    const track = b.closest('.kodi-stay-media').querySelector('[data-track]');
    track.scrollBy({ left: Number(b.dataset.step) * track.clientWidth });
  });
  root.addEventListener('scroll', (e) => {
    const track = e.target;
    if (!(track instanceof Element) || !track.matches('[data-track]')) return;
    const media = track.closest('.kodi-stay-media');
    const i = Math.round(track.scrollLeft / Math.max(track.clientWidth, 1));
    media.querySelectorAll('.kodi-dots i').forEach((d, n) => d.classList.toggle('on', n === i));
    const count = track.children.length;
    const prev = media.querySelector('.prev');
    const next = media.querySelector('.next');
    if (prev) prev.disabled = i <= 0;
    if (next) next.disabled = i >= count - 1;
  }, true);
}

// ------------------------------------------------------------------ explore
export async function vacanciesView(_, query) {
  const mount = scopedMount();
  const list = await counties().catch(() => []);
  const active = query.saved ? 'saved' : query.unit_type || '';
  const main = mount(`<h1 class="visually-hidden">Houses to let</h1>
    <form class="kodi-explore-top" id="vac-filters" role="search" aria-label="Find a house">
      <div class="kodi-search-pill">
        ${icon('search', 20)}
        <label for="vq"><span>Where?</span>
          <input id="vq" name="q" type="search" value="${esc(query.q || '')}" placeholder="Estate, landmark or building" autocomplete="off"></label>
        <button type="button" class="kodi-pill-btn" data-toggle-filters aria-expanded="false" aria-controls="vac-more" aria-label="Filters">
          ${icon('sliders', 18)}<span class="kodi-count-dot d-none" data-filter-count></span></button>
        <button type="submit" class="kodi-pill-btn go" aria-label="Search">${icon('search', 18)}</button>
      </div>
      <div class="kodi-filter-panel d-none" id="vac-more"><div class="row g-2 align-items-end">
        ${select('county_id', 'County', list.map((c) => [c.id, c.name]), { value: query.county_id || '', col: 'col-6 col-md-4', placeholder: 'All counties' })}
        <div class="col-6 col-md-4"><label class="form-label small fw-semibold" for="vmax">Max rent (KES)</label>
          <input class="form-control" id="vmax" name="max_rent" type="number" min="0" step="500" inputmode="numeric" value="${esc(query.max_rent || '')}" placeholder="Any"></div>
        ${select('sort', 'Sort by', [['newest', 'Newest'], ['price_asc', 'Lowest rent'], ['price_desc', 'Highest rent'], ['nearest', 'Nearest to me']],
          { value: query.sort || 'newest', col: 'col-12 col-md-4', placeholder: null })}
        <div class="col-12 d-flex justify-content-between pt-1">
          <button type="button" class="btn btn-link px-0" data-clear>Clear all</button>
          <button type="button" class="btn btn-primary" data-apply>Show homes</button></div>
      </div></div>
      <input type="hidden" name="unit_type" value="${esc(active === 'saved' ? '' : active)}">
      <nav class="kodi-cats" aria-label="Home types">${CATEGORIES.map(([v, text, ic]) => `
        <button type="button" class="kodi-cat-tab" data-cat="${v}" aria-pressed="${v === active}">${icon(ic, 24)}<span>${text}</span></button>`).join('')}
      </nav>
    </form>
    <p class="kodi-results-meta" id="vac-meta" aria-live="polite"></p>
    <div id="vac-results" class="kodi-stays">${skeleton(3)}</div>`);

  const form = main.querySelector('#vac-filters');
  const panel = form.querySelector('#vac-more');
  const toggle = form.querySelector('[data-toggle-filters]');
  let category = active;
  let coords = null;

  const countFilters = () => {
    const n = ['county_id', 'max_rent'].filter((k) => form[k].value).length + (form.sort.value !== 'newest' ? 1 : 0);
    const dot = form.querySelector('[data-filter-count]');
    dot.textContent = String(n);
    dot.classList.toggle('d-none', !n);
  };

  const load = async () => {
    countFilters();
    const params = Object.fromEntries([...new FormData(form)].filter(([, v]) => v));
    setQuery({ ...params, saved: category === 'saved' ? '1' : '' });
    const box = main.querySelector('#vac-results');
    const meta = main.querySelector('#vac-meta');
    try {
      let rows;
      if (category === 'saved') {
        const ids = [...savedIds()];
        rows = (await Promise.all(ids.map((id) => api(`/api/v1/public/vacancies/${id}`, { auth: false }).catch(() => null)))).filter(Boolean);
      } else {
        if (params.sort === 'nearest') {
          if (!coords) {
            try {
              coords = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
                (p) => resolve(p.coords), reject, { timeout: 8000, maximumAge: 600000 }));
            } catch { params.sort = 'newest'; form.sort.value = 'newest'; toast('Location is off, so homes are sorted by newest.'); }
          }
          if (coords) { params.lat = coords.latitude.toFixed(5); params.lng = coords.longitude.toFixed(5); }
        }
        rows = await api(`/api/v1/public/vacancies?${new URLSearchParams(params)}`, { auth: false });
      }
      meta.textContent = rows.length
        ? `${rows.length} ${rows.length === 1 ? 'home' : 'homes'}${category === 'saved' ? ' saved on this device' : ' available now'}`
        : '';
      box.innerHTML = rows.length ? rows.map(stayCard).join('')
        : `<div style="grid-column:1/-1">${category === 'saved'
          ? emptyState('heart', 'No saved homes yet', 'Tap the heart on any home to keep it here.', '<button type="button" class="btn btn-primary" data-cat-jump="">Explore homes</button>')
          : emptyState('search', 'No homes match', 'Try another estate, home type or a higher budget.', '<button type="button" class="btn btn-light" data-cat-jump="">Show all homes</button>')}</div>`;
    } catch (err) { box.innerHTML = `<div style="grid-column:1/-1">${errorBox(err)}</div>`; meta.textContent = ''; }
  };

  const setCategory = (value) => {
    category = value;
    form.unit_type.value = value === 'saved' ? '' : value;
    form.querySelectorAll('[data-cat]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cat === value)));
    load();
  };
  form.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => setCategory(b.dataset.cat)));
  main.addEventListener('click', (e) => {
    const jump = e.target.closest('[data-cat-jump]');
    if (jump) { form.q.value = ''; setCategory(jump.dataset.catJump); }
  });
  toggle.addEventListener('click', () => {
    const open = panel.classList.toggle('d-none') === false;
    toggle.setAttribute('aria-expanded', String(open));
  });
  form.querySelector('[data-apply]').addEventListener('click', () => { panel.classList.add('d-none'); toggle.setAttribute('aria-expanded', 'false'); load(); });
  form.querySelector('[data-clear]').addEventListener('click', () => { form.county_id.value = ''; form.max_rent.value = ''; form.sort.value = 'newest'; load(); });
  let t;
  form.q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 400); });
  form.addEventListener('submit', (e) => { e.preventDefault(); load(); });
  wireCarousels(main);
  wireSaving(main);
  load();
}

// ------------------------------------------------------------------ listing detail
const AMENITY_ICONS = [
  [/wi-?fi|internet|fibre|fiber/i, 'wifi'], [/park/i, 'car'], [/cctv|security|guard|gate|fence|alarm/i, 'shield'],
  [/water|borehole|tank/i, 'drop'], [/generator|backup|power|token|electric|solar/i, 'bolt'], [/lift|elevator/i, 'layers'],
  [/balcony|view|garden|lawn/i, 'sun'], [/tile|kitchen|cabinet|wardrobe|finish/i, 'sparkle'], [/shop|market|mall/i, 'store'],
  [/lock|key/i, 'lock'], [/bath|shower|hot water/i, 'bath'], [/bed/i, 'bed'],
];
const amenityIcon = (text) => (AMENITY_ICONS.find(([re]) => re.test(text)) || [null, 'check'])[1];

export async function vacancyDetailView({ id }) {
  const mount = scopedMount();
  mount(skeleton(4));
  try {
    const v = await api(`/api/v1/public/vacancies/${id}`, { auth: false });
    const phone = String(v.landlord_phone || '');
    const name = title(v);
    const msg = encodeURIComponent(`Hello, I saw ${label(v.unit_type)} unit ${v.unit_number} at ${v.property_name} (${v.area}) on Kodi. Is it still available?`);
    const amenities = [...new Set([...(v.amenities || []), ...(v.features || [])])];
    const photos = v.gallery || [];
    const tel = phone ? `tel:+${esc(phone)}` : '';
    const wa = phone ? `https://wa.me/${esc(phone)}?text=${msg}` : '';
    const highlight = (ic, value, text) => `<div class="kodi-highlight">${icon(ic, 22)}<strong>${esc(value)}</strong><span>${esc(text)}</span></div>`;
    const actions = `<button type="button" class="kodi-round" data-share aria-label="Share this home">${icon('share', 18)}</button>${heartButton(v.unit_id, name, 'kodi-round')}`;

    const main = mount(`<article class="kodi-detail">
      <a class="d-none d-md-inline-flex align-items-center gap-1 small fw-semibold text-decoration-none mb-2" href="#/vacancies">${icon('back', 16)} All homes</a>
      <div class="kodi-collage">
        ${photos.length ? `<div class="kodi-collage-track n${Math.min(photos.length, 5)}" data-track role="group" aria-label="Photos">${photos.map((g, i) => `
            <button type="button" data-photo="${i}" aria-label="Open photo ${i + 1} of ${photos.length}"><img src="${esc(img(g))}" alt="" ${i ? 'loading="lazy"' : ''}></button>`).join('')}</div>
          <span class="kodi-collage-count" data-count>1 / ${photos.length}</span>
          ${photos.length > 1 ? `<button type="button" class="btn btn-light btn-sm kodi-collage-all" data-photo="0">${icon('grid', 16)} Show all ${photos.length} photos</button>` : ''}`
          : `<div class="kodi-collage-empty">${house3d('lg')}</div>`}
        <div class="kodi-collage-top"><a class="kodi-round" href="#/vacancies" aria-label="Back to all homes">${icon('back', 18)}</a><div>${actions}</div></div>
      </div>
      <div class="kodi-detail-body">
        <div class="kodi-detail-head">
          <div class="min-w-0"><h1>${esc(name)}</h1>
            <p class="text-secondary mb-0">${icon('map', 15)} ${esc(v.area)}${v.sub_county_name ? `, ${esc(v.sub_county_name)}` : ''}, ${esc(v.county_name)} · Unit ${esc(v.unit_number)}</p></div>
          <div class="kodi-detail-actions">${actions}</div>
        </div>
        <div class="kodi-detail-grid">
          <div>
            <section class="kodi-detail-section">
              <div class="kodi-highlights">
                ${v.bedrooms != null ? highlight('bed', v.bedrooms, Number(v.bedrooms) === 1 ? 'Bedroom' : 'Bedrooms') : highlight('door', label(v.unit_type), 'Home type')}
                ${v.bathrooms != null ? highlight('bath', v.bathrooms, Number(v.bathrooms) === 1 ? 'Bathroom' : 'Bathrooms') : ''}
                ${v.size_sqm ? highlight('ruler', `${Number(v.size_sqm)} m²`, 'Floor area') : ''}
                ${highlight('key', fmtMoney(v.deposit_amount), 'Deposit')}
              </div>
            </section>
            <section class="kodi-detail-section kodi-host">
              <span class="kodi-avatar" aria-hidden="true">${esc((v.landlord_name || 'K')[0])}</span>
              <div><h2 class="h6 fw-bold mb-1">Listed by ${esc(v.landlord_name)}</h2>
                <p class="small text-secondary mb-0">Manages this home on Kodi: rent by M-Pesa, instant receipts and repairs reported from your phone.</p></div>
            </section>
            ${v.description ? `<section class="kodi-detail-section"><h2>About this home</h2><p class="mb-0" style="white-space:pre-line">${esc(v.description)}</p></section>` : ''}
            ${amenities.length ? `<section class="kodi-detail-section"><h2>What this place offers</h2>
              <ul class="kodi-amenities">${amenities.map((a) => `<li>${icon(amenityIcon(a), 24)}<span>${esc(a)}</span></li>`).join('')}</ul></section>` : ''}
            <section class="kodi-detail-section"><h2>Where you'll be</h2>
              <p class="mb-2">${esc(v.area)}, ${esc(v.county_name)}${v.landmark ? ` · near ${esc(v.landmark)}` : ''}</p>
              ${v.latitude ? `<a class="btn btn-light" target="_blank" rel="noopener" href="https://www.google.com/maps?q=${esc(v.latitude)},${esc(v.longitude)}">${icon('map', 18)} Open in Maps</a>` : ''}
            </section>
          </div>
          <div>
            <div class="kodi-book" data-tilt="3">
              <div class="kodi-book-price">${esc(fmtMoney(v.monthly_rent))} <small>month</small></div>
              <ul class="kodi-list my-3">
                <li><span>Deposit</span><strong>${esc(fmtMoney(v.deposit_amount))}</strong></li>
                <li><span>Rent paid by</span><strong>M-Pesa</strong></li>
              </ul>
              <div class="d-grid gap-2">
                ${tel ? `<a class="btn btn-primary btn-lg" href="${tel}">${icon('phone', 18)} Call landlord</a>` : ''}
                ${wa ? `<a class="btn btn-light btn-lg" href="${wa}" target="_blank" rel="noopener">${icon('chat', 18)} WhatsApp</a>` : ''}
              </div>
              <p class="small text-secondary text-center mt-3 mb-0">You contact the landlord directly. Kodi charges tenants nothing.</p>
            </div>
          </div>
        </div>
      </div>
      <div class="kodi-reserve-bar">
        <div><strong>${esc(fmtMoney(v.monthly_rent))} <small class="fw-normal">month</small></strong><span>Deposit ${esc(fmtMoney(v.deposit_amount))}</span></div>
        <div class="d-flex gap-2">
          ${tel ? `<a class="kodi-round" href="${tel}" aria-label="Call landlord">${icon('phone', 18)}</a>` : ''}
          ${wa ? `<a class="btn btn-primary" href="${wa}" target="_blank" rel="noopener">${icon('chat', 18)} WhatsApp</a>` : ''}
        </div>
      </div>
    </article>`);

    wireSaving(main);
    const track = main.querySelector('[data-track]');
    track?.addEventListener('scroll', () => {
      const i = Math.round(track.scrollLeft / Math.max(track.clientWidth, 1));
      main.querySelector('[data-count]').textContent = `${i + 1} / ${photos.length}`;
    }, { passive: true });
    main.addEventListener('click', async (e) => {
      const ph = e.target.closest('[data-photo]');
      if (ph) {
        modal({
          title: `${photos.length} photos`, size: 'lg',
          body: `<div class="kodi-photo-viewer">${photos.map((g, i) => `<img src="${esc(img(g))}" alt="Photo ${i + 1} of ${name}" loading="lazy" id="ph-${i}">`).join('')}</div>`,
          onReady: (el) => el.addEventListener('shown.bs.modal', () => el.querySelector(`#ph-${ph.dataset.photo}`)?.scrollIntoView(), { once: true }),
        });
      }
      if (e.target.closest('[data-share]')) {
        const url = window.location.href;
        if (navigator.share) navigator.share({ title: name, text: `${name}, ${fmtMoney(v.monthly_rent)} a month`, url }).catch(() => {});
        else { await copyText(url); toast('Link copied. Paste it to share.', { variant: 'success' }); }
      }
    });
  } catch (err) { mount(errorBox(err)); }
}
