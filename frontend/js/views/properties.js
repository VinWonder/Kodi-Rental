// Properties -> units: lists, forms, unit state engine, gallery, condition logs.
import { api } from '../api.js';
import {
  badge, confirmDialog, counties, emptyState, errorBox, field, formModal, hydrateMedia, icon, label,
  pageHeader, PROPERTY_TYPES, select, skeleton, UNIT_TYPES, uploadFile, wirePhotoPicker, photoPicker,
} from '../components.js';
import { navigate, setQuery } from '../router.js';
import { live, scopedMount } from '../shell.js';
import { acct, state } from '../state.js';
import { esc, fmtDate, fmtMoney, setBusy, timeAgo, toast } from '../ui.js';
import { allocateModal } from './leases.js';

const STATUS_FILTERS = ['all', 'vacant', 'occupied', 'reserved', 'under_maintenance', 'cleaning'];
const MANUAL = ['vacant', 'under_maintenance', 'cleaning', 'inactive'];

// ------------------------------------------------------------------ property form
async function propertyForm(existing = null) {
  const list = await counties();
  return formModal({
    title: existing ? 'Edit property' : 'Add a property',
    size: 'lg',
    submitLabel: existing ? 'Save changes' : 'Add property',
    fields: `<div class="row g-3">
      ${field('name', 'Property name', { required: true, value: existing?.name, placeholder: 'e.g. Sunrise Apartments', col: 'col-md-7' })}
      ${select('property_type', 'Type', PROPERTY_TYPES, { required: true, value: existing?.property_type || 'apartment_flats', col: 'col-md-5', placeholder: null })}
      ${select('county_id', 'County', list.map((c) => [c.id, c.name]), { required: true, value: existing?.county_id || '', col: 'col-md-6', dataType: 'number' })}
      ${select('sub_county_id', 'Sub-county', [], { col: 'col-md-6', dataType: 'number', placeholder: 'Choose county first' })}
      ${field('area', 'Estate / neighbourhood', { required: true, value: existing?.area, placeholder: 'e.g. Roysambu', col: 'col-md-6', attrs: 'minlength="2"' })}
      ${field('landmark', 'Nearest landmark', { value: existing?.landmark, placeholder: 'e.g. Behind TRM', col: 'col-md-6' })}
      ${field('street_address', 'Street / road', { value: existing?.street_address, col: 'col-md-8' })}
      ${field('floors_count', 'Floors', { type: 'number', value: existing?.floors_count, col: 'col-md-4', dataType: 'number', attrs: 'min="1" max="200"' })}
      ${field('amenities', 'Amenities', { value: (existing?.amenities || []).join(', '), dataType: 'list', col: 'col-12',
        placeholder: 'Borehole, CCTV, Parking, Backup generator', hint: 'Separate with commas. Shown on public listings.' })}
      ${field('description', 'Description', { type: 'textarea', value: existing?.description, col: 'col-12' })}
      <div class="col-12"><div class="d-flex align-items-center gap-2">
        <input type="hidden" name="latitude" value="${esc(existing?.latitude ?? '')}"><input type="hidden" name="longitude" value="${esc(existing?.longitude ?? '')}">
        <button type="button" class="btn btn-light btn-sm" data-locate>${icon('map', 16)} Use my current location</button>
        <span class="small text-secondary" data-loc-text>${existing?.latitude ? `${existing.latitude}, ${existing.longitude}` : 'Helps tenants find "nearest" vacancies.'}</span>
      </div></div></div>`,
    onReady: (form) => {
      const sub = form.sub_county_id;
      const loadSubs = async (countyId, selected) => {
        sub.innerHTML = '<option value="">Loading…</option>';
        if (!countyId) { sub.innerHTML = '<option value="">Choose county first</option>'; return; }
        const subs = await api(`/api/v1/locations/counties/${countyId}/sub-counties`, { auth: false }).catch(() => []);
        sub.innerHTML = `<option value="">Optional</option>${subs.map((s) => `<option value="${s.id}" ${s.id === selected ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}`;
      };
      form.county_id.addEventListener('change', () => loadSubs(form.county_id.value));
      if (existing?.county_id) loadSubs(existing.county_id, existing.sub_county_id);
      form.querySelector('[data-locate]').addEventListener('click', () => {
        const text = form.querySelector('[data-loc-text]');
        text.textContent = 'Locating…';
        navigator.geolocation.getCurrentPosition((p) => {
          form.latitude.value = p.coords.latitude.toFixed(6);
          form.longitude.value = p.coords.longitude.toFixed(6);
          text.textContent = `${form.latitude.value}, ${form.longitude.value}`;
        }, () => { text.textContent = 'Location unavailable. You can skip this.'; }, { enableHighAccuracy: true, timeout: 10000 });
      });
    },
    onSubmit: async (v) => {
      const body = { ...v };
      body.latitude = v.latitude ? Number(v.latitude) : null;
      body.longitude = v.longitude ? Number(v.longitude) : null;
      if (!existing) Object.keys(body).forEach((k) => body[k] === null && delete body[k]);
      return existing
        ? api(acct(`/properties/${existing.id}`), { method: 'PATCH', body })
        : api(acct('/properties'), { method: 'POST', body });
    },
  });
}

// ------------------------------------------------------------------ properties list
export async function propertiesView(_, query) {
  const mount = scopedMount();
  const main = mount(`${pageHeader('Properties', {
    subtitle: 'Buildings, hostels and plazas you manage',
    actions: state.isStaff ? `<button class="btn btn-primary" data-new>${icon('plus', 18)} Add property</button>` : '',
  })}
    <div class="kodi-searchbar mb-3">${icon('search', 18)}<input class="form-control" type="search" placeholder="Search by name, estate or landmark" id="prop-q" value="${esc(query.q || '')}"></div>
    <div id="prop-list" class="kodi-grid kodi-grid-cards">${skeleton(3)}</div>`);

  const load = async () => {
    const q = main.querySelector('#prop-q').value.trim();
    setQuery({ q, new: '' });
    const box = main.querySelector('#prop-list');
    try {
      const rows = await api(acct(`/properties${q ? `?q=${encodeURIComponent(q)}` : ''}`));
      box.innerHTML = rows.length ? rows.map((p) => {
        const pct = Number(p.occupancy_rate_pct || 0);
        return `<a class="kodi-card kodi-property" href="#/properties/${p.id}">
          <div class="d-flex justify-content-between align-items-start gap-2">
            <div class="min-w-0"><h2 class="h6 fw-bold mb-0 text-truncate">${esc(p.name)}</h2>
              <p class="small text-secondary mb-0">${icon('map', 14)} ${esc(p.area)}, ${esc(p.county_name)}</p></div>
            <span class="kodi-chip">${esc(label(p.property_type))}</span>
          </div>
          <div class="kodi-progress my-3" role="progressbar" aria-label="Occupancy" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
            <span style="width:${pct}%"></span></div>
          <div class="d-flex justify-content-between small">
            <span><strong>${p.occupied || 0}</strong>/${p.total_units || 0} occupied</span>
            <span class="text-success">${p.vacant || 0} vacant</span>
            <span class="text-secondary">${esc(fmtMoney(p.actual_rent_roll || 0))}/mo</span>
          </div></a>`;
      }).join('') : emptyState('building', q ? 'No property matches' : 'No properties yet',
        q ? 'Try a different name or estate.' : 'Add your first building, then its units (doors).',
        state.isStaff && !q ? '<button class="btn btn-primary" data-new>Add property</button>' : '');
    } catch (err) { box.innerHTML = errorBox(err); }
  };
  let t;
  main.querySelector('#prop-q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 300); });
  main.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-new]')) return;
    const created = await propertyForm();
    if (created?.id) { toast('Property added. Now add its units.', { variant: 'success' }); navigate(`/properties/${created.id}?addunit=1`); }
  });
  await load();
  if (query.new && state.isStaff) main.querySelector('[data-new]')?.click();
}

// ------------------------------------------------------------------ unit forms
function unitFields(u = {}) {
  return `<div class="row g-3">
    ${field('unit_number', 'Unit / door number', { required: true, value: u.unit_number, placeholder: 'e.g. A1', col: 'col-6' })}
    ${select('unit_type', 'Type', UNIT_TYPES, { required: true, value: u.unit_type || 'bedsitter', col: 'col-6', placeholder: null })}
    ${field('monthly_rent', 'Monthly rent (KES)', { type: 'number', required: true, value: u.monthly_rent, col: 'col-6', dataType: 'number', attrs: 'min="1" step="1"' })}
    ${field('deposit_amount', 'Deposit (KES)', { type: 'number', value: u.deposit_amount ?? '', col: 'col-6', dataType: 'number', attrs: 'min="0" step="1"' })}
    ${field('floor_number', 'Floor', { type: 'number', value: u.floor_number, col: 'col-4', dataType: 'number', attrs: 'min="-5" max="200"' })}
    ${field('bedrooms', 'Bedrooms', { type: 'number', value: u.bedrooms, col: 'col-4', dataType: 'number', attrs: 'min="0" max="20"' })}
    ${field('bathrooms', 'Bathrooms', { type: 'number', value: u.bathrooms, col: 'col-4', dataType: 'number', attrs: 'min="0" max="20"' })}
    ${field('features', 'Features', { value: (u.features || []).join(', '), dataType: 'list', col: 'col-12', placeholder: 'Balcony, Tiled floor, Own meter' })}
    ${field('payment_code', 'M-Pesa account number', { value: u.payment_code, col: 'col-12', attrs: 'pattern="[A-Za-z0-9-]{2,20}"',
      hint: 'Tenants type this as the "Account No." when paying via Paybill. Leave blank to generate one.' })}
  </div>`;
}

function cleanBody(v) {
  const body = { ...v };
  Object.keys(body).forEach((k) => body[k] === null && delete body[k]);
  if (body.payment_code) body.payment_code = body.payment_code.toUpperCase();
  return body;
}

async function addUnitModal(property) {
  return formModal({
    title: `Add a unit to ${property.name}`, submitLabel: 'Add unit',
    fields: `${unitFields()}${select('status', 'Current state', ['vacant', 'under_maintenance', 'cleaning'], { value: 'vacant', placeholder: null, col: 'mt-3' })}
      <p class="small text-secondary mb-0">Vacant units are listed publicly straight away so you can find a tenant.</p>`,
    onSubmit: (v) => api(acct(`/properties/${property.id}/units`), { method: 'POST', body: cleanBody(v) }),
  });
}

async function bulkUnitsModal(property) {
  return formModal({
    title: 'Add many units at once', submitLabel: 'Create units',
    fields: `<p class="small text-secondary">Creates numbered doors such as A1 to A12 with the same type and rent. You can edit each one later.</p>
      <div class="row g-3">
        ${field('prefix', 'Prefix', { value: 'A', col: 'col-4', placeholder: 'A' })}
        ${field('from', 'From', { type: 'number', value: 1, required: true, col: 'col-4', dataType: 'number', attrs: 'min="0" max="9999"' })}
        ${field('to', 'To', { type: 'number', value: 10, required: true, col: 'col-4', dataType: 'number', attrs: 'min="0" max="9999"' })}
        ${select('unit_type', 'Type', UNIT_TYPES, { value: 'bedsitter', col: 'col-6', placeholder: null })}
        ${field('monthly_rent', 'Rent (KES)', { type: 'number', required: true, col: 'col-6', dataType: 'number', attrs: 'min="1" step="1"' })}
        ${field('deposit_amount', 'Deposit (KES)', { type: 'number', col: 'col-6', dataType: 'number', attrs: 'min="0" step="1"' })}
        ${field('floor_number', 'Floor', { type: 'number', col: 'col-6', dataType: 'number' })}
      </div><div class="progress mt-3 d-none" data-progress><div class="progress-bar" style="width:0%"></div></div>`,
    onSubmit: async (v, form) => {
      if (v.to < v.from) throw new Error('"To" must be greater than or equal to "From"');
      const count = v.to - v.from + 1;
      if (count > 200) throw new Error('Create at most 200 units at a time');
      const bar = form.querySelector('[data-progress]');
      bar.classList.remove('d-none');
      const failures = [];
      for (let n = v.from; n <= v.to; n += 1) {
        const body = cleanBody({ unit_number: `${v.prefix || ''}${n}`, unit_type: v.unit_type, monthly_rent: v.monthly_rent,
          deposit_amount: v.deposit_amount, floor_number: v.floor_number });
        try { await api(acct(`/properties/${property.id}/units`), { method: 'POST', body }); }
        catch (err) { failures.push(`${body.unit_number}: ${err.message}`); }
        bar.firstElementChild.style.width = `${Math.round(((n - v.from + 1) / count) * 100)}%`;
      }
      if (failures.length === count) throw new Error(failures[0]);
      if (failures.length) toast(`${count - failures.length} created, ${failures.length} skipped (${failures[0]})`, { variant: 'warning' });
      return { created: count - failures.length };
    },
  });
}

// ------------------------------------------------------------------ property detail (units grid)
export async function propertyDetailView({ id }, query) {
  const mount = scopedMount();
  mount(skeleton(4));
  let property;
  try { property = await api(acct(`/properties/${id}`)); } catch (err) { mount(errorBox(err)); return; }
  const main = mount(`${pageHeader(property.name, {
    back: '#/properties',
    subtitle: `${esc(label(property.property_type))} · ${esc(property.area)}, ${esc(property.county_name)}${property.landmark ? ` · ${esc(property.landmark)}` : ''}`,
    actions: state.isStaff ? `<div class="dropdown"><button class="btn btn-light" data-bs-toggle="dropdown" aria-label="More">${icon('more')}</button>
        <ul class="dropdown-menu dropdown-menu-end"><li><button class="dropdown-item" data-edit>${icon('pen', 16)} Edit property</button></li>
        <li><button class="dropdown-item" data-bulk>${icon('layers', 16)} Add many units</button></li>
        <li><hr class="dropdown-divider"></li><li><button class="dropdown-item text-danger" data-archive>${icon('trash', 16)} Archive property</button></li></ul></div>
      <button class="btn btn-primary" data-add>${icon('plus', 18)} Add unit</button>` : '',
  })}
    <div class="kodi-grid kodi-grid-4 mb-3">
      <section class="kodi-card kodi-mini"><span class="small text-secondary">Units</span><strong>${property.total_units || 0}</strong></section>
      <section class="kodi-card kodi-mini"><span class="small text-secondary">Occupied</span><strong>${property.occupancy_rate_pct || 0}%</strong></section>
      <section class="kodi-card kodi-mini"><span class="small text-secondary">Vacant</span><strong class="text-success">${property.vacant || 0}</strong></section>
      <section class="kodi-card kodi-mini"><span class="small text-secondary">Rent roll</span><strong>${esc(fmtMoney(property.actual_rent_roll || 0))}</strong></section>
    </div>
    <div class="kodi-chips mb-3" role="group" aria-label="Filter units by state">${STATUS_FILTERS.map((s) => `<button class="kodi-filter ${s === (query.status || 'all') ? 'active' : ''}" aria-pressed="${s === (query.status || 'all')}" data-status="${s}">${esc(s === 'all' ? 'All' : label(s))}</button>`).join('')}</div>
    <div id="units" class="kodi-unit-grid">${skeleton(2)}</div>`);

  let filter = query.status || 'all';
  const load = async () => {
    const box = main.querySelector('#units');
    try {
      const units = await api(acct(`/units?property_id=${id}${filter !== 'all' ? `&status=${filter}` : ''}&limit=500`));
      box.innerHTML = units.length ? units.map((u) => `
        <a class="kodi-unit kodi-unit-${u.status}" href="#/units/${u.id}">
          <div class="d-flex justify-content-between align-items-start"><strong class="kodi-unit-no">${esc(u.unit_number)}</strong>${badge(u.status)}</div>
          <span class="small text-secondary">${esc(label(u.unit_type))}</span>
          <span class="kodi-unit-rent">${esc(fmtMoney(u.monthly_rent))}</span>
          ${u.tenant_name ? `<span class="small text-truncate">${icon('users', 13)} ${esc(u.tenant_name)}</span>` : '<span class="small text-secondary">No tenant</span>'}
          ${u.financial_state && u.financial_state !== 'clear' && u.tenant_name ? `<span class="small text-${u.financial_state === 'in_arrears' ? 'danger' : 'warning'}">${esc(fmtMoney(u.outstanding_balance))} due</span>` : ''}
        </a>`).join('') : emptyState('door', filter === 'all' ? 'No units yet' : `No ${label(filter).toLowerCase()} units`,
        filter === 'all' ? 'Add each door, room or hostel bed you rent out.' : '',
        state.isStaff && filter === 'all' ? '<button class="btn btn-primary" data-add>Add unit</button> <button class="btn btn-light" data-bulk>Add many</button>' : '');
    } catch (err) { box.innerHTML = errorBox(err); }
  };

  main.addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-status]');
    if (chip) {
      filter = chip.dataset.status;
      main.querySelectorAll('[data-status]').forEach((c) => { c.classList.toggle('active', c === chip); c.setAttribute('aria-pressed', String(c === chip)); });
      setQuery({ status: filter === 'all' ? '' : filter });
      load();
    }
    if (e.target.closest('[data-add]')) { if (await addUnitModal(property)) { toast('Unit added', { variant: 'success' }); propertyDetailView({ id }, {}); } }
    if (e.target.closest('[data-bulk]')) { const r = await bulkUnitsModal(property); if (r?.created) { toast(`${r.created} units created`, { variant: 'success' }); propertyDetailView({ id }, {}); } }
    if (e.target.closest('[data-edit]')) { if (await propertyForm(property)) propertyDetailView({ id }, {}); }
    if (e.target.closest('[data-archive]')) {
      if (await confirmDialog(`Archive ${property.name}? It will be hidden from lists and its vacant units unlisted.`, { danger: true, confirmLabel: 'Archive' })) {
        try { await api(acct(`/properties/${id}`), { method: 'DELETE' }); toast('Property archived'); navigate('/properties'); }
        catch (err) { toast(err.message, { variant: 'danger' }); }
      }
    }
  });
  await load();
  if (query.addunit && state.isStaff) main.querySelector('[data-add]')?.click();
  return live('event:unit_status_changed', (d) => { if (d.property_id === id || !d.property_id) load(); });
}

// ------------------------------------------------------------------ unit detail
export async function unitDetailView({ id }) {
  const mount = scopedMount();
  mount(skeleton(5));
  let unit;
  try { unit = await api(acct(`/units/${id}`)); } catch (err) { mount(errorBox(err)); return; }
  const locked = ['occupied', 'reserved'].includes(unit.status);
  const main = mount(`${pageHeader(`Unit ${unit.unit_number}`, {
    back: `#/properties/${unit.property_id}`,
    subtitle: `${esc(unit.property_name)} · ${esc(label(unit.unit_type))}`,
    actions: state.isStaff ? `<button class="btn btn-light" data-edit>${icon('pen', 18)}<span class="kodi-label-md"> Edit</span></button>
      ${unit.status === 'vacant' ? `<button class="btn btn-primary" data-allocate>${icon('key', 18)} Allocate tenant</button>` : ''}` : '',
  })}
    <div class="row g-3">
      <div class="col-lg-5">
        <section class="kodi-card mb-3">
          <div class="d-flex justify-content-between align-items-center mb-2"><span class="small text-secondary">State</span>${badge(unit.status)}</div>
          <div class="kodi-stat">${esc(fmtMoney(unit.monthly_rent))}<small class="fs-6 text-secondary"> /month</small></div>
          <p class="small text-secondary mb-3">Deposit ${esc(fmtMoney(unit.deposit_amount))} · since ${esc(timeAgo(unit.status_changed_at))}</p>
          <div class="kodi-paycode mb-3"><span class="small text-secondary d-block">M-Pesa account number</span><strong>${esc(unit.payment_code)}</strong></div>
          ${state.isStaff ? `<label class="form-label small fw-semibold" for="unit-status">Change state</label>
            <div class="d-flex gap-2"><select class="form-select" id="unit-status" ${locked ? 'disabled' : ''}>
              ${MANUAL.map((s) => `<option value="${s}" ${s === unit.status ? 'selected' : ''}>${esc(label(s))}</option>`).join('')}</select>
              <button class="btn btn-primary" data-set-status ${locked ? 'disabled' : ''}>Update</button></div>
            ${locked ? '<p class="small text-secondary mt-2 mb-0">Occupied and reserved follow the lease. End the lease to change this.</p>' : ''}
            ${unit.status === 'vacant' ? `<div class="form-check form-switch mt-3"><input class="form-check-input" type="checkbox" role="switch" id="listed" ${unit.is_listed_public ? 'checked' : ''}>
              <label class="form-check-label small" for="listed">Show on public vacancy listings</label></div>` : ''}` : ''}
        </section>
        <section class="kodi-card mb-3">
          <h2 class="h6 fw-bold">Tenant</h2>
          ${unit.tenant_id ? `<a class="d-flex align-items-center gap-2 text-decoration-none" href="#/tenants/${unit.tenant_id}">
              <span class="kodi-avatar lg">${esc(unit.tenant_name[0])}</span><span><strong class="d-block text-body">${esc(unit.tenant_name)}</strong>
              <span class="small ${unit.financial_state === 'in_arrears' ? 'text-danger' : 'text-secondary'}">${unit.outstanding_balance > 0 ? `${esc(fmtMoney(unit.outstanding_balance))} outstanding${unit.days_in_arrears ? ` · ${unit.days_in_arrears} days late` : ''}` : 'Fully paid'}</span></span></a>`
            : '<p class="small text-secondary mb-0">No tenant allocated.</p>'}
        </section>
        <section class="kodi-card">
          <h2 class="h6 fw-bold">Details</h2>
          <ul class="kodi-list small">
            ${unit.floor_number != null ? `<li><span>Floor</span><span>${esc(unit.floor_number)}</span></li>` : ''}
            ${unit.bedrooms != null ? `<li><span>Bedrooms</span><span>${esc(unit.bedrooms)}</span></li>` : ''}
            ${unit.bathrooms != null ? `<li><span>Bathrooms</span><span>${esc(unit.bathrooms)}</span></li>` : ''}
            <li><span>Features</span><span class="text-end">${esc((unit.features || []).join(', ') || '-')}</span></li>
          </ul>
        </section>
      </div>
      <div class="col-lg-7">
        <section class="kodi-card mb-3">
          <div class="d-flex justify-content-between align-items-center mb-2"><h2 class="h6 fw-bold mb-0">Photos</h2>
            ${state.isStaff ? `<label class="btn btn-light btn-sm mb-0">${icon('upload', 16)} Upload<input type="file" accept="image/*" multiple class="visually-hidden" data-gallery-upload></label>` : ''}</div>
          <div class="kodi-thumbs" id="gallery">${unit.gallery.length ? unit.gallery.map((g) => `
            <figure class="kodi-thumb ${g.is_cover ? 'is-cover' : ''}"><img data-media="${g.media_id}" alt="">
              ${g.is_cover ? '<span class="kodi-thumb-tag">Cover</span>' : ''}
              ${state.isStaff ? `<div class="kodi-thumb-actions">${g.is_cover ? '' : `<button data-cover="${g.media_id}" title="Make cover" aria-label="Make cover photo">${icon('star', 14)}</button>`}
                <button data-remove-photo="${g.media_id}" title="Remove" aria-label="Remove photo">${icon('trash', 14)}</button></div>` : ''}</figure>`).join('')
            : '<p class="small text-secondary mb-0">No photos yet. Vacant units with photos get more enquiries.</p>'}</div>
        </section>
        <section class="kodi-card mb-3">
          <div class="d-flex justify-content-between align-items-center mb-2"><h2 class="h6 fw-bold mb-0">Condition log</h2>
            ${state.isStaff ? `<button class="btn btn-light btn-sm" data-log>${icon('plus', 16)} Add entry</button>` : ''}</div>
          <div id="logs">${skeleton(2)}</div>
        </section>
        <section class="kodi-card"><h2 class="h6 fw-bold">State history</h2><div id="history">${skeleton(2)}</div></section>
      </div>
    </div>`);

  const reload = () => unitDetailView({ id });
  api(acct(`/units/${id}/condition-logs`)).then((logs) => {
    main.querySelector('#logs').innerHTML = logs.length ? `<ol class="kodi-timeline">${logs.map((l) => `<li>
      <div class="small text-secondary">${esc(fmtDate(l.logged_at))} · ${esc(l.logged_by || '')}</div>
      <div>${esc(l.notes)}</div>
      <div class="d-flex flex-wrap gap-1 mt-1">${(l.tags || []).map((t) => `<span class="kodi-chip">${esc(t)}</span>`).join('')}</div>
      ${l.media_ids.length ? `<div class="kodi-thumbs sm mt-2">${l.media_ids.map((m) => `<figure class="kodi-thumb"><img data-media="${m}" alt=""></figure>`).join('')}</div>` : ''}
    </li>`).join('')}</ol>` : '<p class="small text-secondary mb-0">Record the state of walls, fittings and meters at move-in and move-out.</p>';
    hydrateMedia(main);
  }).catch((err) => { main.querySelector('#logs').innerHTML = errorBox(err); });
  api(acct(`/units/${id}/history`)).then((rows) => {
    main.querySelector('#history').innerHTML = rows.length ? `<ol class="kodi-timeline">${rows.map((h) => `<li>
      <div class="d-flex gap-2 align-items-center flex-wrap">${h.from_status ? `${badge(h.from_status)} ${icon('back', 14, 'flip-x')}` : ''} ${badge(h.to_status)}</div>
      <div class="small text-secondary">${esc(fmtDate(h.changed_at))}${h.changed_by ? ` · ${esc(h.changed_by)}` : ''}${h.reason ? ` · ${esc(h.reason)}` : ''}</div></li>`).join('')}</ol>`
      : '<p class="small text-secondary mb-0">No changes yet.</p>';
  }).catch(() => {});

  main.addEventListener('change', async (e) => {
    if (e.target.matches('[data-gallery-upload]')) {
      const files = [...e.target.files].slice(0, 10);
      if (!files.length) return;
      const fd = new FormData();
      files.forEach((f) => fd.append('files', f, f.name));
      toast(`Uploading ${files.length} photo(s)…`);
      try { await api(acct(`/units/${id}/media`), { method: 'POST', body: fd }); reload(); }
      catch (err) { toast(err.message, { variant: 'danger' }); }
    }
    if (e.target.id === 'listed') {
      try { await api(acct(`/units/${id}`), { method: 'PATCH', body: { is_listed_public: e.target.checked } }); toast(e.target.checked ? 'Listed publicly' : 'Hidden from public listings'); }
      catch (err) { e.target.checked = !e.target.checked; toast(err.message, { variant: 'danger' }); }
    }
  });
  main.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-set-status]')) {
      const status = main.querySelector('#unit-status').value;
      if (status === unit.status) return;
      const button = t.closest('button');
      setBusy(button, true, '…');
      try { await api(acct(`/units/${id}/status`), { method: 'POST', body: { status } }); toast(`Unit is now ${label(status).toLowerCase()}`, { variant: 'success' }); reload(); }
      catch (err) { toast(err.message, { variant: 'danger' }); setBusy(button, false); }
    }
    if (t.closest('[data-edit]')) {
      const saved = await formModal({ title: `Edit unit ${unit.unit_number}`, fields: unitFields(unit),
        onSubmit: (v) => api(acct(`/units/${id}`), { method: 'PATCH', body: cleanBody(v) }) });
      if (saved) reload();
    }
    if (t.closest('[data-allocate]')) { const lease = await allocateModal({ unit }); if (lease) navigate(`/leases/${lease.id}`); }
    const cover = t.closest('[data-cover]');
    if (cover) { await api(acct(`/units/${id}/media/${cover.dataset.cover}`), { method: 'PATCH', body: { is_cover: true } }).catch((err) => toast(err.message, { variant: 'danger' })); reload(); }
    const rm = t.closest('[data-remove-photo]');
    if (rm && await confirmDialog('Remove this photo?', { danger: true, confirmLabel: 'Remove' })) {
      await api(acct(`/units/${id}/media/${rm.dataset.removePhoto}`), { method: 'DELETE' }).catch((err) => toast(err.message, { variant: 'danger' }));
      reload();
    }
    if (t.closest('[data-log]')) {
      let getFiles = () => [];
      const saved = await formModal({
        title: 'Condition log entry',
        fields: `${field('notes', 'What did you observe?', { type: 'textarea', required: true, attrs: 'minlength="3"', placeholder: 'e.g. Fresh paint, kitchen tap replaced, meter reading 04512' })}
          ${field('tags', 'Tags', { dataType: 'list', placeholder: 'move-in, painted, meter' })}${photoPicker('photos', { accept: 'image/*,video/*' })}`,
        onReady: (form) => { getFiles = wirePhotoPicker(form); },
        onSubmit: async (v) => {
          const ids = [];
          for (const f of getFiles()) ids.push((await uploadFile(f, 'unit_condition', state.accountId)).id);
          return api(acct(`/units/${id}/condition-logs`), { method: 'POST', body: { notes: v.notes, tags: v.tags, media_ids: ids } });
        },
      });
      if (saved) reload();
    }
  });
  return live('event:unit_status_changed', (d) => { if (d.unit_id === id) reload(); });
}

export { propertyForm };
