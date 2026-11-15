// Public vacancy search (no sign-in): the "auto-listed when vacant" side of
// the unit state engine. One smart search pill that understands plain
// English (and voice), category pills, a featured carousel, photo-first cards
// you can swipe and save, a photo collage that morphs in from the card, a
// viewing booker and a sticky contact bar. A map view with price pins, and
// verified tenant ratings on cards and listings.
import { api } from '../api.js';
import {
  copyText, counties, emptyState, errorBox, house3d, icon, label, modal, sectionHead, select, skeleton,
} from '../components.js';
import { haptic } from '../fx.js';
import { createMap, homePin, KENYA_BOUNDS, pinLabel, pricePin } from '../map.js';
import { loadPublicReviews, ratingChip } from './reviews.js';
import { setQuery } from '../router.js';
import { scopedMount } from '../shell.js';
import { parseSearch } from '../smartsearch.js';
import { esc, fmtMoney, toast } from '../ui.js';
import { CONFIG } from '../config.js';

const img = (url) => (url ? `${CONFIG.apiBase}${url}` : '');
const NEW_DAYS = 7;
const seen = new Map(); // search results by unit id: the detail page paints instantly from these

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
    haptic(on ? [10, 30, 10] : 8);
    root.querySelectorAll(`[data-save="${CSS.escape(b.dataset.save)}"]`).forEach((x) => x.setAttribute('aria-pressed', String(on)));
    toast(on ? 'Saved. Find it under "Saved".' : 'Removed from saved homes.', { variant: on ? 'success' : 'dark', delay: 2500 });
  });
}

const isNew = (iso) => iso && Date.now() - new Date(iso).getTime() < NEW_DAYS * 864e5;
const title = (v) => `${label(v.unit_type)} at ${v.property_name}`;
const photosOf = (v) => (v.gallery?.length ? v.gallery : v.photos?.length ? v.photos : v.cover_url ? [v.cover_url] : []);

function specIcons(v) {
  const bits = [];
  if (v.bedrooms != null) bits.push(`<span>${icon('bed', 15)} ${esc(v.bedrooms)}<span class="visually-hidden"> bedrooms</span></span>`);
  if (v.bathrooms != null) bits.push(`<span>${icon('bath', 15)} ${esc(v.bathrooms)}<span class="visually-hidden"> bathrooms</span></span>`);
  if (v.size_sqm) bits.push(`<span>${icon('ruler', 15)} ${esc(Number(v.size_sqm))} m²</span>`);
  return bits.length ? `<p class="kodi-stay-specs">${bits.join('')}</p>` : '';
}

// ------------------------------------------------------------------ listing card
function stayCard(v, { wide = false } = {}) {
  seen.set(v.unit_id, v);
  const photos = photosOf(v).slice(0, 5);
  const href = `#/vacancies/${v.unit_id}`;
  const name = title(v);
  const media = photos.length
    ? photos.map((u) => `<a href="${href}" tabindex="-1" aria-hidden="true" data-open="${esc(v.unit_id)}"><img src="${esc(img(u))}" alt="" loading="lazy" decoding="async"></a>`).join('')
    : `<a href="${href}" tabindex="-1" aria-hidden="true" class="kodi-stay-art" data-open="${esc(v.unit_id)}">${house3d('md')}</a>`;
  const where = v.distance_km != null ? `${v.distance_km} km away` : v.landmark ? `Near ${v.landmark}` : v.county_name;
  return `<article class="kodi-stay ${wide ? 'is-wide' : ''}">
    <div class="kodi-stay-media">
      <div class="kodi-stay-track" data-track ${photos.length > 1 ? `tabindex="0" role="group" aria-label="${photos.length} photos of ${esc(name)}"` : ''}>${media}</div>
      <span class="kodi-stay-badge"><i class="kodi-live-dot"></i>${isNew(v.listed_at) ? 'New on Kodi' : 'Available now'}</span>
      ${heartButton(v.unit_id, name)}
      ${photos.length > 1 ? `<button type="button" class="kodi-stay-nav prev" data-step="-1" aria-label="Previous photo" disabled>${icon('back', 16)}</button>
        <button type="button" class="kodi-stay-nav next" data-step="1" aria-label="Next photo">${icon('back', 16, 'flip-x')}</button>
        <div class="kodi-dots" aria-hidden="true">${photos.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>` : ''}
      ${wide ? `<div class="kodi-stay-price-tag"><strong>${esc(fmtMoney(v.monthly_rent))}</strong><span>/month</span></div>` : ''}
    </div>
    <div class="kodi-stay-body">
      <h2 class="kodi-stay-title"><a href="${href}" data-open="${esc(v.unit_id)}"><span>${esc(v.area)}, ${esc(v.county_name)}</span></a>
        ${ratingChip(v) || (isNew(v.listed_at) ? `<span class="kodi-new">${icon('sparkle', 14)} New</span>` : '')}</h2>
      <p class="kodi-stay-sub">${esc(name)}</p>
      <p class="kodi-stay-sub">${icon('map', 13)} ${esc(where || '')}</p>
      ${specIcons(v)}
      ${wide ? '' : `<p class="kodi-stay-price"><strong>${esc(fmtMoney(v.monthly_rent))}</strong> month</p>`}
    </div>
  </article>`;
}

/** Compact card shown over the map when a price pin is tapped. */
function mapCard(v) {
  seen.set(v.unit_id, v);
  const href = `#/vacancies/${v.unit_id}`;
  const cover = photosOf(v)[0];
  return `<article class="kodi-mapcard">
    <a href="${href}" class="kodi-mapcard-img" tabindex="-1" aria-hidden="true">${cover ? `<img src="${esc(img(cover))}" alt="">` : house3d('sm')}</a>
    <div class="min-w-0 flex-grow-1">
      <h2 class="kodi-stay-title"><a href="${href}"><span>${esc(v.area)}, ${esc(v.county_name)}</span></a>${ratingChip(v)}</h2>
      <p class="kodi-stay-sub text-truncate">${esc(title(v))}</p>
      ${specIcons(v)}
      <p class="kodi-stay-price mb-0"><strong>${esc(fmtMoney(v.monthly_rent))}</strong> month</p>
    </div>
    <div class="kodi-mapcard-actions">${heartButton(v.unit_id, title(v), 'kodi-round')}
      <button type="button" class="kodi-round" data-map-close aria-label="Close">${icon('x', 16)}</button></div>
  </article>`;
}

/** Card carousels: arrow buttons, dots that follow swipes, and the photo morph. */
function wireCarousels(root) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-step]');
    if (b) {
      e.preventDefault();
      const track = b.closest('.kodi-stay-media').querySelector('[data-track]');
      track.scrollBy({ left: Number(b.dataset.step) * track.clientWidth });
      return;
    }
    // Name the tapped card's photo so the View Transition morphs it into the detail hero.
    const open = e.target.closest('[data-open]');
    if (open) {
      root.querySelectorAll('.kodi-stay-media').forEach((m) => { m.style.viewTransitionName = ''; });
      const media = open.closest('.kodi-stay')?.querySelector('.kodi-stay-media');
      if (media) media.style.viewTransitionName = 'kodi-photo';
    }
  });
  root.addEventListener('scroll', (e) => {
    const track = e.target;
    if (!(track instanceof Element) || !track.matches('[data-track]')) return;
    const media = track.closest('.kodi-stay-media');
    const i = Math.round(track.scrollLeft / Math.max(track.clientWidth, 1));
    media.querySelectorAll('.kodi-dots i').forEach((d, n) => d.classList.toggle('on', n === i));
    const prev = media.querySelector('.prev');
    const next = media.querySelector('.next');
    if (prev) prev.disabled = i <= 0;
    if (next) next.disabled = i >= track.children.length - 1;
  }, true);
}

// ------------------------------------------------------------------ voice
const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;

function wireVoice(button, input, onDone) {
  if (!Speech) { button.remove(); return; }
  let rec = null;
  button.addEventListener('click', () => {
    if (rec) { rec.stop(); return; }
    rec = new Speech();
    rec.lang = 'en-KE';
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    button.classList.add('is-listening');
    button.setAttribute('aria-pressed', 'true');
    input.placeholder = 'Listening… e.g. "bedsitter in Roysambu under 10k"';
    haptic(10);
    rec.onresult = (ev) => { input.value = [...ev.results].map((r) => r[0].transcript).join(' '); };
    rec.onerror = (ev) => { if (ev.error === 'not-allowed') toast('Allow the microphone to search by voice.', { variant: 'warning' }); };
    rec.onend = () => {
      rec = null;
      button.classList.remove('is-listening');
      button.setAttribute('aria-pressed', 'false');
      input.placeholder = 'Try "2 bedroom in Kilimani under 40k"';
      if (input.value.trim()) onDone();
    };
    try { rec.start(); } catch { rec = null; button.classList.remove('is-listening'); }
  });
}

// ------------------------------------------------------------------ explore
export async function vacanciesView(_, query) {
  const mount = scopedMount();
  const list = await counties().catch(() => []);
  const active = query.saved ? 'saved' : query.unit_type || '';
  let view = query.view === 'map' ? 'map' : 'list';
  let map = null;
  const dropMap = () => { if (map) { map.remove(); map = null; } };
  const main = mount(`<h1 class="visually-hidden">Houses to let</h1>
    <form class="kodi-explore-top" id="vac-filters" role="search" aria-label="Find a house">
      <div class="kodi-search-pill">
        ${icon('search', 20)}
        <label for="vq"><span>Find your next home</span>
          <input id="vq" name="q" type="search" value="${esc(query.q || '')}" placeholder='Try "2 bedroom in Kilimani under 40k"' autocomplete="off" enterkeyhint="search"></label>
        <button type="button" class="kodi-pill-btn kodi-mic" data-voice aria-pressed="false" aria-label="Search by voice">${icon('mic', 18)}</button>
        <button type="button" class="kodi-pill-btn" data-toggle-filters aria-expanded="false" aria-controls="vac-more" aria-label="Filters">
          ${icon('sliders', 18)}<span class="kodi-count-dot d-none" data-filter-count></span></button>
      </div>
      <div class="kodi-understood" id="vac-understood" aria-live="polite"></div>
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
        <button type="button" class="kodi-cat-tab" data-cat="${v}" aria-pressed="${v === active}">${icon(ic, 18)}<span>${text}</span></button>`).join('')}
      </nav>
    </form>
    <div id="vac-results">${skeleton(3)}</div>
    <button type="button" class="kodi-map-toggle" data-view-toggle aria-pressed="${view === 'map'}"></button>`);

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
    setQuery({ ...params, saved: category === 'saved' ? '1' : '', view: view === 'map' ? 'map' : '' });
    paintToggle();
    // Plain English: pull out home type, budget and county; the rest is the place.
    const said = parseSearch(form.q.value, list);
    const understood = main.querySelector('#vac-understood');
    if (said.understood) {
      if (said.unit_type) params.unit_type = said.unit_type;
      if (said.max_rent && !form.max_rent.value) params.max_rent = said.max_rent;
      if (said.county_id && !form.county_id.value) params.county_id = said.county_id;
      if (said.q) params.q = said.q; else delete params.q;
      understood.innerHTML = `<span>${icon('sparkle', 14)} Showing</span>${said.chips.map((c) => `<b>${esc(c)}</b>`).join('')}`;
    } else understood.innerHTML = '';
    const box = main.querySelector('#vac-results');
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
      if (!rows.length) {
        dropMap();
        box.innerHTML = category === 'saved'
          ? emptyState('heart', 'No saved homes yet', 'Tap the heart on any home to keep it here.', '<button type="button" class="btn btn-primary" data-cat-jump="">Explore homes</button>')
          : emptyState('search', 'No homes match', 'Try another estate, home type or a higher budget.', '<button type="button" class="btn btn-light" data-cat-jump="">Show all homes</button>');
        return;
      }
      if (view === 'map') { await renderMap(box, rows); return; }
      dropMap();
      const browsing = category === '' && !params.q && !params.county_id && !params.max_rent && !said.understood;
      const featured = browsing ? rows.filter((r) => r.photos?.length).slice(0, 6) : [];
      const count = `${rows.length} ${rows.length === 1 ? 'home' : 'homes'}${category === 'saved' ? ' saved on this device' : ' available now'}`;
      box.innerHTML = `${featured.length >= 2 ? `${sectionHead('New on Kodi')}
          <div class="kodi-featured" role="list">${featured.map((v) => `<div role="listitem">${stayCard(v, { wide: true })}</div>`).join('')}</div>` : ''}
        ${featured.length >= 2 ? sectionHead('All homes') : ''}
        <p class="kodi-results-meta" aria-live="polite">${count}</p>
        <div class="kodi-stays">${rows.map((v) => stayCard(v)).join('')}</div>`;
    } catch (err) { box.innerHTML = errorBox(err); }
  };

  function paintToggle() {
    const b = main.querySelector('[data-view-toggle]');
    b.innerHTML = view === 'map' ? `${icon('list', 18)} Show list` : `${icon('map', 18)} Show map`;
    b.setAttribute('aria-pressed', String(view === 'map'));
  }

  // Map view: price pins like a property portal; tap one for a mini card.
  async function renderMap(box, rows) {
    const pinned = rows.filter((r) => r.latitude != null && r.longitude != null);
    const unpinned = rows.length - pinned.length;
    dropMap();
    box.innerHTML = `<div class="kodi-mapview">
        <div class="kodi-mapview-map" role="region" aria-label="Map of ${pinned.length} homes. Price pins can be reached with Tab; Show list gives the same homes as text."></div>
        <p class="kodi-mapview-meta" aria-live="polite">${pinned.length} ${pinned.length === 1 ? 'home' : 'homes'} on the map${unpinned ? ` · ${unpinned} without a map pin (see the list)` : ''}</p>
        <div class="kodi-mapview-card" data-map-card hidden></div>
      </div>`;
    const el = box.querySelector('.kodi-mapview-map');
    const cardBox = box.querySelector('[data-map-card]');
    let m;
    try { m = await createMap(el); } catch (err) { el.outerHTML = errorBox(err); return; }
    if (!el.isConnected) { m.remove(); return; }
    map = m;
    const L = window.L;
    let current = null;
    const closeCard = () => {
      cardBox.hidden = true;
      if (current) { current.marker.setIcon(pricePin(L, current.v)); current.marker.setZIndexOffset(0); current = null; }
    };
    // One pin per building (units in a building share its coordinates), priced "from" the cheapest.
    const buildings = new Map();
    pinned.forEach((v) => {
      const list = buildings.get(v.property_id) || [];
      list.push(v);
      buildings.set(v.property_id, list);
    });
    buildings.forEach((list) => {
      list.sort((a, b) => Number(a.monthly_rent) - Number(b.monthly_rent));
      const v = list[0];
      const pin = { ...v, count: list.length };
      const marker = L.marker([v.latitude, v.longitude], {
        icon: pricePin(L, pin), keyboard: true, riseOnHover: true,
        title: list.length > 1 ? `${list.length} homes at ${v.property_name}, from ${pinLabel(v)}` : pinLabel(v),
      }).addTo(m);
      marker.on('click', () => {
        closeCard();
        current = { v: pin, marker };
        marker.setIcon(pricePin(L, pin, { active: true }));
        marker.setZIndexOffset(1000);
        cardBox.innerHTML = list.length > 1
          ? `<p class="kodi-mapview-group"><b>${list.length} homes</b> at ${esc(v.property_name)}</p><div class="kodi-mapview-cards">${list.map(mapCard).join('')}</div>`
          : mapCard(v);
        cardBox.hidden = false;
        haptic(6);
      });
    });
    m.on('click', closeCard);
    cardBox.addEventListener('click', (e) => { if (e.target.closest('[data-map-close]')) closeCard(); });
    if (pinned.length) m.fitBounds(L.latLngBounds(pinned.map((v) => [v.latitude, v.longitude])), { padding: [56, 56], maxZoom: 15 });
    else m.fitBounds(KENYA_BOUNDS);
  }

  const setCategory = (value) => {
    category = value;
    form.unit_type.value = value === 'saved' ? '' : value;
    form.querySelectorAll('[data-cat]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cat === value)));
    haptic(6);
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
  form.q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 450); });
  form.addEventListener('submit', (e) => { e.preventDefault(); form.q.blur(); load(); });
  wireVoice(form.querySelector('[data-voice]'), form.q, load);
  wireCarousels(main);
  wireSaving(main);
  main.querySelector('[data-view-toggle]').addEventListener('click', () => {
    view = view === 'map' ? 'list' : 'map';
    haptic(8);
    window.scrollTo({ top: 0 });
    load();
  });
  load();
  return dropMap;
}

// ------------------------------------------------------------------ listing detail
const AMENITY_ICONS = [
  [/wi-?fi|internet|fibre|fiber/i, 'wifi'], [/park/i, 'car'], [/cctv|security|guard|gate|fence|alarm/i, 'shield'],
  [/water|borehole|tank/i, 'drop'], [/generator|backup|power|token|electric|solar/i, 'bolt'], [/lift|elevator/i, 'layers'],
  [/balcony|view|garden|lawn/i, 'sun'], [/tile|kitchen|cabinet|wardrobe|finish/i, 'sparkle'], [/shop|market|mall/i, 'store'],
  [/lock|key/i, 'lock'], [/bath|shower|hot water/i, 'bath'], [/bed/i, 'bed'],
];
const amenityIcon = (text) => (AMENITY_ICONS.find(([re]) => re.test(text)) || [null, 'check'])[1];

function collageHtml(v, photos, actions) {
  const n = photos.length;
  return `<div class="kodi-collage" style="view-transition-name:kodi-photo">
    ${n ? `<div class="kodi-collage-track n${Math.min(n, 5)}" data-track role="group" aria-label="Photos">${photos.map((g, i) => `
        <button type="button" data-photo="${i}" aria-label="Open photo ${i + 1} of ${n}"><img src="${esc(img(g))}" alt="" ${i ? 'loading="lazy"' : ''}></button>`).join('')}</div>
      <span class="kodi-collage-count" data-count-label>1 / ${n}</span>
      ${n > 1 ? `<button type="button" class="btn btn-light btn-sm kodi-collage-all" data-photo="0">${icon('grid', 16)} Show all ${n} photos</button>` : ''}`
      : `<div class="kodi-collage-empty">${house3d('lg')}</div>`}
    <div class="kodi-collage-top"><a class="kodi-round" href="#/vacancies" aria-label="Back to all homes">${icon('back', 18)}</a><div>${actions}</div></div>
  </div>
  ${n > 1 ? `<div class="kodi-thumbstrip" aria-hidden="true">${photos.slice(0, 5).map((g, i) => `
      <button type="button" tabindex="-1" data-thumb="${i}" class="${i ? '' : 'on'}"><img src="${esc(img(g))}" alt="" loading="lazy">${i === 4 && n > 5 ? `<b>+${n - 5}</b>` : ''}</button>`).join('')}</div>` : ''}`;
}

/** "Book a viewing": pick a day and a time; the request goes to the landlord on WhatsApp or SMS. */
function viewingSheet(v, phone) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() + i);
    return { iso: d.toISOString().slice(0, 10), top: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString('en-KE', { weekday: 'short' }),
      num: d.getDate(), mon: d.toLocaleDateString('en-KE', { month: 'short' }), text: d.toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long' }) };
  });
  const slots = [['Morning', '9am to 12pm'], ['Afternoon', '12pm to 4pm'], ['Evening', '4pm to 7pm']];
  return modal({
    title: 'Book a viewing',
    body: `<p class="small text-secondary">${esc(title(v))}, ${esc(v.area)}. Choose when you can come; the landlord confirms by phone.</p>
      <fieldset class="mb-3"><legend class="form-label small fw-semibold">Day</legend>
        <div class="kodi-daypick">${days.map((d, i) => `<label><input type="radio" class="btn-check" name="vday" value="${i}" ${i === 1 ? 'checked' : ''}>
          <span><small>${esc(d.top)}</small><b>${d.num}</b><small>${esc(d.mon)}</small></span></label>`).join('')}</div></fieldset>
      <fieldset class="mb-3"><legend class="form-label small fw-semibold">Time</legend>
        <div class="kodi-slotpick">${slots.map(([a, b], i) => `<label><input type="radio" class="btn-check" name="vslot" value="${i}" ${i === 0 ? 'checked' : ''}>
          <span><b>${a}</b><small>${b}</small></span></label>`).join('')}</div></fieldset>
      <label class="form-label small fw-semibold" for="vname">Your name</label>
      <input class="form-control mb-1" id="vname" autocomplete="name" placeholder="So the landlord knows who is coming">`,
    footer: `${phone ? `<a class="btn btn-light" data-send="sms" href="#">${icon('chat', 18)} SMS</a>
      <a class="btn btn-primary flex-grow-1" data-send="wa" href="#" target="_blank" rel="noopener">${icon('calendar', 18)} Send on WhatsApp</a>` : ''}`,
    onReady: (el, close) => {
      const message = () => {
        const d = days[Number(el.querySelector('[name=vday]:checked').value)];
        const [slot, hours] = slots[Number(el.querySelector('[name=vslot]:checked').value)];
        const who = el.querySelector('#vname').value.trim();
        return `Hello${v.landlord_name ? ` ${v.landlord_name}` : ''}, ${who ? `my name is ${who}. ` : ''}I would like to view the ${label(v.unit_type).toLowerCase()} unit ${v.unit_number} at ${v.property_name} (${v.area}) on ${d.text}, in the ${slot.toLowerCase()} (${hours}). Is that okay? (Found on Kodi)`;
      };
      el.querySelectorAll('[data-send]').forEach((a) => a.addEventListener('click', () => {
        const text = encodeURIComponent(message());
        a.href = a.dataset.send === 'wa' ? `https://wa.me/${phone}?text=${text}` : `sms:+${phone}?body=${text}`;
        haptic([10, 40, 10]);
        setTimeout(() => close(true), 50);
      }));
    },
  });
}

export async function vacancyDetailView({ id }) {
  const mount = scopedMount();
  let io = null;
  let miniMap = null;
  const cleanup = () => { io?.disconnect(); miniMap?.remove(); };
  const cached = seen.get(id);
  // Paint the photos straight away from the card the user tapped; details follow.
  const main = mount(`<article class="kodi-detail">
      <a class="d-none d-md-inline-flex align-items-center gap-1 small fw-semibold text-decoration-none mb-2" href="#/vacancies">${icon('back', 16)} All homes</a>
      <div data-collage>${cached ? collageHtml(cached, photosOf(cached), '') : ''}</div>
      <div data-rest>${skeleton(4)}</div></article>`);
  try {
    const v = await api(`/api/v1/public/vacancies/${id}`, { auth: false });
    if (!main.isConnected) return;
    const phone = String(v.landlord_phone || '').replace(/\D/g, '');
    const name = title(v);
    const msg = encodeURIComponent(`Hello, I saw ${label(v.unit_type)} unit ${v.unit_number} at ${v.property_name} (${v.area}) on Kodi. Is it still available?`);
    const amenities = [...new Set([...(v.amenities || []), ...(v.features || [])])];
    const photos = v.gallery || [];
    const tel = phone ? `tel:+${phone}` : '';
    const wa = phone ? `https://wa.me/${phone}?text=${msg}` : '';
    const highlight = (ic, value, text) => `<div class="kodi-highlight">${icon(ic, 22)}<strong>${esc(value)}</strong><span>${esc(text)}</span></div>`;
    const actions = `<button type="button" class="kodi-round" data-share aria-label="Share this home">${icon('share', 18)}</button>${heartButton(v.unit_id, name, 'kodi-round')}`;

    main.querySelector('[data-collage]').innerHTML = collageHtml(v, photos, actions);
    main.querySelector('[data-rest]').outerHTML = `<div class="kodi-detail-body">
        <div class="kodi-detail-head">
          <div class="min-w-0">
            <div class="d-flex flex-wrap gap-2 mb-2"><span class="kodi-tag is-live"><i class="kodi-live-dot"></i>Available now</span><span class="kodi-tag">${esc(label(v.unit_type))}</span>
              ${isNew(v.listed_at) ? `<span class="kodi-tag">${icon('sparkle', 13)} New</span>` : ''}</div>
            <h1>${esc(name)}</h1>
            ${v.rating_count ? `<a href="#d-reviews" class="d-inline-block mb-1 text-reset" data-goto-link="d-reviews">${ratingChip(v, { long: true })}</a>` : ''}
            <p class="text-secondary mb-0">${icon('map', 15)} ${esc(v.area)}${v.sub_county_name ? `, ${esc(v.sub_county_name)}` : ''}, ${esc(v.county_name)} · Unit ${esc(v.unit_number)}</p></div>
          <div class="text-end flex-shrink-0"><div class="kodi-detail-price">${esc(fmtMoney(v.monthly_rent))}<small>/month</small></div>
            <div class="kodi-detail-actions mt-2 justify-content-end">${actions}</div></div>
        </div>
        <nav class="kodi-detail-tabs" aria-label="Sections">
          <button type="button" data-goto="d-about" aria-current="true">About</button>
          ${amenities.length ? '<button type="button" data-goto="d-offers">What\'s included</button>' : ''}
          <button type="button" data-goto="d-reviews">Reviews${v.rating_count ? ` (${esc(v.rating_count)})` : ''}</button>
          <button type="button" data-goto="d-where">Location</button>
        </nav>
        <div class="kodi-detail-grid">
          <div>
            <section class="kodi-detail-section" id="d-about">
              <div class="kodi-highlights">
                ${v.bedrooms != null ? highlight('bed', v.bedrooms, Number(v.bedrooms) === 1 ? 'Bedroom' : 'Bedrooms') : highlight('door', label(v.unit_type), 'Home type')}
                ${v.bathrooms != null ? highlight('bath', v.bathrooms, Number(v.bathrooms) === 1 ? 'Bathroom' : 'Bathrooms') : ''}
                ${v.size_sqm ? highlight('ruler', `${Number(v.size_sqm)} m²`, 'Floor area') : ''}
                ${highlight('key', fmtMoney(v.deposit_amount), 'Deposit')}
              </div>
              ${v.description ? `<p class="mt-3 mb-0" style="white-space:pre-line">${esc(v.description)}</p>` : ''}
            </section>
            <section class="kodi-detail-section kodi-host">
              <span class="kodi-avatar" aria-hidden="true">${esc((v.landlord_name || 'K')[0])}</span>
              <div class="flex-grow-1"><h2 class="h6 fw-bold mb-1">Listed by ${esc(v.landlord_name)}</h2>
                <p class="small text-secondary mb-0">Manages this home on Kodi: rent by M-Pesa, instant receipts and repairs reported from your phone.</p></div>
              ${wa ? `<a class="kodi-round" href="${wa}" target="_blank" rel="noopener" aria-label="Message ${esc(v.landlord_name)} on WhatsApp">${icon('chat', 18)}</a>` : ''}
            </section>
            ${amenities.length ? `<section class="kodi-detail-section" id="d-offers"><h2>What this place offers</h2>
              <ul class="kodi-amenities">${amenities.map((a) => `<li>${icon(amenityIcon(a), 24)}<span>${esc(a)}</span></li>`).join('')}</ul></section>` : ''}
            <section class="kodi-detail-section" id="d-reviews"><h2>${v.rating_count ? `★ ${Number(v.rating_avg).toFixed(1)} · ` : ''}What tenants say</h2>
              <div data-reviews>${skeleton(1)}</div></section>
            <section class="kodi-detail-section" id="d-where"><h2>Where you'll be</h2>
              ${v.latitude ? '<div class="kodi-minimap" data-minimap role="region" aria-label="Map showing the area around this home"></div>' : ''}
              <div class="kodi-where">${icon('map', 26)}<div><strong class="d-block">${esc(v.area)}, ${esc(v.county_name)}</strong>
                <span class="small text-secondary">${v.landmark ? `Near ${esc(v.landmark)}` : 'Exact location shared by the landlord'}</span></div></div>
              ${v.latitude ? `<a class="btn btn-light mt-3" target="_blank" rel="noopener" href="https://www.google.com/maps?q=${esc(v.latitude)},${esc(v.longitude)}">${icon('map', 18)} Open in Maps</a>` : ''}
            </section>
          </div>
          <div>
            <div class="kodi-book" data-tilt="3">
              <div class="kodi-book-price">${esc(fmtMoney(v.monthly_rent))} <small>month</small></div>
              <ul class="kodi-list my-3">
                <li><span>Deposit</span><strong>${esc(fmtMoney(v.deposit_amount))}</strong></li>
                <li><span>Move-in total</span><strong>${esc(fmtMoney(Number(v.monthly_rent) + Number(v.deposit_amount || 0)))}</strong></li>
                <li><span>Rent paid by</span><strong>M-Pesa</strong></li>
              </ul>
              <div class="d-grid gap-2">
                ${phone ? `<button type="button" class="btn btn-primary btn-lg" data-viewing>${icon('calendar', 18)} Book a viewing</button>` : ''}
                <div class="d-flex gap-2">
                  ${tel ? `<a class="btn btn-light flex-fill" href="${tel}">${icon('phone', 18)} Call</a>` : ''}
                  ${wa ? `<a class="btn btn-light flex-fill" href="${wa}" target="_blank" rel="noopener">${icon('chat', 18)} WhatsApp</a>` : ''}
                </div>
              </div>
              <p class="small text-secondary text-center mt-3 mb-0">You deal with the landlord directly. Kodi charges tenants nothing.</p>
            </div>
          </div>
        </div>
      </div>
      <div class="kodi-reserve-bar">
        <div><strong>${esc(fmtMoney(v.monthly_rent))} <small class="fw-normal">month</small></strong><span>Move in with ${esc(fmtMoney(Number(v.monthly_rent) + Number(v.deposit_amount || 0)))}</span></div>
        <div class="d-flex gap-2">
          ${tel ? `<a class="kodi-round" href="${tel}" aria-label="Call landlord">${icon('phone', 18)}</a>` : ''}
          ${phone ? `<button type="button" class="btn btn-primary" data-viewing>${icon('calendar', 18)} Book a viewing</button>` : ''}
        </div>
      </div>`;

    wireSaving(main);
    loadPublicReviews(main.querySelector('[data-reviews]'), v.property_id);
    // The location map loads only when scrolled near, so the listing stays light on data.
    const mini = main.querySelector('[data-minimap]');
    if (mini) {
      io = new IntersectionObserver(async ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        try {
          const m = await createMap(mini, { center: [v.latitude, v.longitude], zoom: 15, interactive: false });
          if (!mini.isConnected) { m.remove(); return; }
          miniMap = m;
          const L = window.L;
          L.circle([v.latitude, v.longitude], { radius: 220, color: '#0f6b57', weight: 1, fillColor: '#2fae8c', fillOpacity: 0.16, interactive: false }).addTo(m);
          L.marker([v.latitude, v.longitude], { icon: homePin(L), keyboard: false, interactive: false }).addTo(m);
        } catch (err) { mini.outerHTML = errorBox(err); }
      }, { rootMargin: '300px' });
      io.observe(mini);
    }
    const track = main.querySelector('[data-track]');
    track?.addEventListener('scroll', () => {
      const i = Math.round(track.scrollLeft / Math.max(track.clientWidth, 1));
      const c = main.querySelector('[data-count-label]');
      if (c) c.textContent = `${i + 1} / ${photos.length}`;
      main.querySelectorAll('[data-thumb]').forEach((b) => b.classList.toggle('on', Number(b.dataset.thumb) === i));
    }, { passive: true });
    main.addEventListener('click', async (e) => {
      const th = e.target.closest('[data-thumb]');
      if (th && track) track.scrollTo({ left: Number(th.dataset.thumb) * track.clientWidth, behavior: 'smooth' });
      const ph = e.target.closest('[data-photo]');
      if (ph) {
        modal({
          title: `${photos.length} photos`, size: 'lg',
          body: `<div class="kodi-photo-viewer">${photos.map((g, i) => `<img src="${esc(img(g))}" alt="Photo ${i + 1} of ${esc(name)}" loading="lazy" id="ph-${i}">`).join('')}</div>`,
          onReady: (el) => el.addEventListener('shown.bs.modal', () => el.querySelector(`#ph-${ph.dataset.photo}`)?.scrollIntoView(), { once: true }),
        });
      }
      const link = e.target.closest('[data-goto-link]');
      if (link) {
        e.preventDefault();
        main.querySelector(`[data-goto="${link.dataset.gotoLink}"]`)?.click();
      }
      const go = e.target.closest('[data-goto]');
      if (go) {
        main.querySelectorAll('[data-goto]').forEach((b) => b.setAttribute('aria-current', String(b === go)));
        main.querySelector(`#${go.dataset.goto}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      if (e.target.closest('[data-viewing]')) viewingSheet(v, phone);
      if (e.target.closest('[data-share]')) {
        const url = window.location.href;
        if (navigator.share) navigator.share({ title: name, text: `${name}, ${fmtMoney(v.monthly_rent)} a month`, url }).catch(() => {});
        else { await copyText(url); toast('Link copied. Paste it to share.', { variant: 'success' }); }
      }
    });
  } catch (err) { mount(errorBox(err)); }
  return cleanup;
}
