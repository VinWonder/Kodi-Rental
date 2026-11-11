// Public vacancy search (no sign-in): the "auto-listed when vacant" side of
// the unit state engine.
import { api } from '../api.js';
import { counties, debounce, emptyState, errorBox, icon, label, pageHeader, select, skeleton, UNIT_TYPES } from '../components.js';
import { setQuery } from '../router.js';
import { scopedMount } from '../shell.js';
import { esc, fmtMoney, timeAgo } from '../ui.js';
import { CONFIG } from '../config.js';

const img = (url) => (url ? `${CONFIG.apiBase}${url}` : '');

export async function vacanciesView(_, query) {
  const mount = scopedMount();
  const list = await counties().catch(() => []);
  const main = mount(`${pageHeader('Houses to let', { subtitle: 'Vacant units listed by Kodi landlords. Updated live.', back: '#/' })}
    <form class="kodi-card kodi-filters mb-3" id="vac-filters">
      <div class="row g-2 align-items-end">
        <div class="col-12 col-md-4"><label class="form-label small fw-semibold" for="vq">Estate, landmark or building</label>
          <input class="form-control" id="vq" name="q" value="${esc(query.q || '')}" placeholder="e.g. Roysambu, Kilimani"></div>
        ${select('county_id', 'County', list.map((c) => [c.id, c.name]), { value: query.county_id || '', col: 'col-6 col-md-2', placeholder: 'All' })}
        ${select('unit_type', 'Type', UNIT_TYPES, { value: query.unit_type || '', col: 'col-6 col-md-2', placeholder: 'Any' })}
        <div class="col-6 col-md-2"><label class="form-label small fw-semibold" for="vmax">Max rent (KES)</label>
          <input class="form-control" id="vmax" name="max_rent" type="number" min="0" step="500" value="${esc(query.max_rent || '')}"></div>
        ${select('sort', 'Sort', [['newest', 'Newest'], ['price_asc', 'Cheapest'], ['price_desc', 'Most expensive'], ['nearest', 'Nearest to me']],
          { value: query.sort || 'newest', col: 'col-6 col-md-2', placeholder: null })}
      </div>
    </form>
    <div id="vac-results" class="kodi-grid kodi-grid-cards">${skeleton(3)}</div>`);

  const form = main.querySelector('#vac-filters');
  let coords = null;
  const load = async () => {
    const params = Object.fromEntries([...new FormData(form)].filter(([, v]) => v));
    setQuery(params);
    if (params.sort === 'nearest') {
      if (!coords) {
        try {
          coords = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
            (p) => resolve(p.coords), reject, { timeout: 8000, maximumAge: 600000 }));
        } catch { params.sort = 'newest'; form.sort.value = 'newest'; }
      }
      if (coords) { params.lat = coords.latitude.toFixed(5); params.lng = coords.longitude.toFixed(5); }
    }
    const box = main.querySelector('#vac-results');
    try {
      const rows = await api(`/api/v1/public/vacancies?${new URLSearchParams(params)}`, { auth: false });
      box.innerHTML = rows.length ? rows.map((v) => `
        <a class="kodi-card kodi-listing" href="#/vacancies/${v.unit_id}">
          <div class="kodi-listing-cover" ${v.cover_url ? `style="background-image:url('${esc(img(v.cover_url))}')"` : ''}>
            ${v.cover_url ? '' : icon('building', 40)}<span class="kodi-listing-price">${esc(fmtMoney(v.monthly_rent))}<small>/mo</small></span></div>
          <div class="p-3">
            <h2 class="h6 fw-bold mb-1">${esc(label(v.unit_type))} · ${esc(v.property_name)}</h2>
            <p class="small text-secondary mb-2">${icon('map', 14)} ${esc(v.area)}, ${esc(v.county_name)}${v.distance_km != null ? ` · ${esc(v.distance_km)} km away` : ''}</p>
            <div class="d-flex flex-wrap gap-1">${(v.amenities || []).slice(0, 4).map((a) => `<span class="kodi-chip">${esc(a)}</span>`).join('')}</div>
            <p class="small text-secondary mt-2 mb-0">Listed ${esc(timeAgo(v.listed_at))}</p>
          </div></a>`).join('')
        : emptyState('search', 'No vacancies match', 'Try another estate, county or a higher budget.');
    } catch (err) { box.innerHTML = errorBox(err); }
  };
  form.addEventListener('input', debounce(load, 400));
  form.addEventListener('submit', (e) => { e.preventDefault(); load(); });
  load();
}

export async function vacancyDetailView({ id }) {
  const mount = scopedMount();
  mount(skeleton(4));
  try {
    const v = await api(`/api/v1/public/vacancies/${id}`, { auth: false });
    const phone = String(v.landlord_phone);
    const msg = encodeURIComponent(`Hello, I saw ${label(v.unit_type)} unit ${v.unit_number} at ${v.property_name} (${v.area}) on Kodi. Is it still available?`);
    mount(`${pageHeader(`${label(v.unit_type)} at ${v.property_name}`, { subtitle: `${esc(v.area)}, ${esc(v.county_name)}`, back: '#/vacancies' })}
      <div class="row g-3">
        <div class="col-lg-7">
          <div class="kodi-gallery">${v.gallery.length ? v.gallery.map((g, i) => `<img src="${esc(img(g))}" alt="Photo ${i + 1}" loading="lazy">`).join('')
            : `<div class="kodi-gallery-empty">${icon('image', 40)}<span>No photos yet</span></div>`}</div>
        </div>
        <div class="col-lg-5">
          <section class="kodi-card">
            <div class="kodi-stat">${esc(fmtMoney(v.monthly_rent))}<small class="text-secondary fs-6"> / month</small></div>
            <p class="small text-secondary">Deposit ${esc(fmtMoney(v.deposit_amount))}</p>
            <ul class="kodi-list mb-3">
              <li><span>Unit</span><span>${esc(v.unit_number)}</span></li>
              ${v.bedrooms != null ? `<li><span>Bedrooms</span><span>${esc(v.bedrooms)}</span></li>` : ''}
              ${v.bathrooms != null ? `<li><span>Bathrooms</span><span>${esc(v.bathrooms)}</span></li>` : ''}
              ${v.landmark ? `<li><span>Landmark</span><span>${esc(v.landmark)}</span></li>` : ''}
            </ul>
            <div class="d-flex flex-wrap gap-1 mb-3">${[...(v.amenities || []), ...(v.features || [])].map((a) => `<span class="kodi-chip">${esc(a)}</span>`).join('')}</div>
            <p class="small mb-2">Listed by <strong>${esc(v.landlord_name)}</strong></p>
            <div class="d-grid gap-2">
              <a class="btn btn-primary" href="tel:+${esc(phone)}">${icon('phone', 18)} Call landlord</a>
              <a class="btn btn-success" href="https://wa.me/${esc(phone)}?text=${msg}" target="_blank" rel="noopener">${icon('chat', 18)} WhatsApp</a>
            </div>
          </section>
          ${v.latitude ? `<a class="btn btn-light w-100 mt-2" target="_blank" rel="noopener" href="https://www.google.com/maps?q=${esc(v.latitude)},${esc(v.longitude)}">${icon('map', 18)} Open in Maps</a>` : ''}
        </div>
      </div>`);
  } catch (err) { mount(errorBox(err)); }
}
