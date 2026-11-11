// Tenant profiles: onboarding (ID, M-Pesa phone, next of kin), invite links,
// statements, verification and allocation.
import { api, download } from '../api.js';
import {
  badge, confirmDialog, copyText, emptyState, errorBox, field, formModal, icon, modal, pageHeader, photoPicker, select,
  skeleton, uploadFile, wirePhotoPicker,
} from '../components.js';
import { navigate, setQuery } from '../router.js';
import { scopedMount } from '../shell.js';
import { acct, qs, state } from '../state.js';
import { esc, fmtDate, fmtMoney, toast } from '../ui.js';
import { allocateModal } from './leases.js';

const kinFields = (i) => `<fieldset class="kodi-kin" data-kin="${i}"><legend class="small fw-semibold">Next of kin ${i + 1}</legend><div class="row g-2">
  ${field(`kin_name_${i}`, 'Full name', { col: 'col-md-6' })}${field(`kin_rel_${i}`, 'Relationship', { col: 'col-md-6', placeholder: 'e.g. Brother' })}
  ${field(`kin_phone_${i}`, 'Phone', { type: 'tel', col: 'col-md-6', placeholder: '07…' })}${field(`kin_id_${i}`, 'ID number (optional)', { col: 'col-md-6' })}</div></fieldset>`;

export async function tenantFormModal(existing = null) {
  let getFiles = () => [];
  return formModal({
    title: existing ? `Edit ${existing.full_name}` : 'Add a tenant', size: 'lg', submitLabel: existing ? 'Save' : 'Add tenant',
    fields: `<div class="row g-3">
      ${field('first_name', 'First name', { required: true, value: existing?.first_name, col: 'col-md-4' })}
      ${field('middle_name', 'Middle name', { value: existing?.middle_name, col: 'col-md-4' })}
      ${field('last_name', 'Last name', { required: true, value: existing?.last_name, col: 'col-md-4' })}
      ${select('id_document_type', 'ID type', ['national_id', 'passport', 'alien_id', 'military_id'], { value: existing?.id_document_type || 'national_id', col: 'col-md-4', placeholder: null })}
      ${field('id_document_number', 'ID / passport number', { required: true, value: existing?.id_document_number, col: 'col-md-4', attrs: 'minlength="6" maxlength="20"' })}
      ${field('date_of_birth', 'Date of birth', { type: 'date', value: existing?.date_of_birth, col: 'col-md-4' })}
      ${field('phone', 'M-Pesa phone number', { type: 'tel', required: true, value: existing ? `0${String(existing.phone).slice(3)}` : '', col: 'col-md-6',
        placeholder: '0712 345 678', hint: 'Rent payment prompts (STK Push) go to this number.' })}
      ${field('email', 'Email', { type: 'email', value: existing?.email, col: 'col-md-6' })}
      ${field('occupation', 'Occupation', { value: existing?.occupation, col: 'col-md-6' })}
      ${field('employer', 'Employer', { value: existing?.employer, col: 'col-md-6' })}
      ${field('notes', 'Private notes', { type: 'textarea', value: existing?.notes, col: 'col-12', attrs: 'rows="2"' })}
      ${existing ? '' : `<div class="col-12">${kinFields(0)}</div>
        <div class="col-12"><label class="form-label small fw-semibold">ID photos (front/back, optional)</label>${photoPicker('id', { accept: 'image/*,application/pdf', max: 2 })}</div>`}
    </div>`,
    onReady: (form) => { getFiles = wirePhotoPicker(form); },
    onSubmit: async (v) => {
      const body = {};
      ['first_name', 'middle_name', 'last_name', 'id_document_type', 'id_document_number', 'date_of_birth', 'phone', 'email',
        'occupation', 'employer', 'notes'].forEach((k) => { if (v[k] !== null || existing) body[k] = v[k]; });
      if (existing) return api(acct(`/tenants/${existing.id}`), { method: 'PATCH', body });
      if (v.kin_name_0) {
        body.next_of_kin = [{ full_name: v.kin_name_0, relationship: v.kin_rel_0 || 'Relative', phone: v.kin_phone_0,
          id_number: v.kin_id_0, is_primary: true }];
      }
      const files = getFiles();
      for (const [i, f] of files.entries()) {
        const media = await uploadFile(f, 'tenant_id_document', state.accountId);
        body[i === 0 ? 'id_front_media_id' : 'id_back_media_id'] = media.id;
      }
      return api(acct('/tenants'), { method: 'POST', body });
    },
  });
}

export async function inviteModal(tenant) {
  let invite;
  try { invite = await api(acct(`/tenants/${tenant.id}/invite`), { method: 'POST' }); }
  catch (err) { toast(err.message, { variant: 'danger' }); return; }
  const phone = String(tenant.phone);
  await modal({
    title: `Invite ${tenant.first_name} to the app`,
    body: `<p class="small text-secondary">Send this one-time link. It expires on ${esc(fmtDate(invite.expires_at))}. Opening it lets ${esc(tenant.first_name)}
      set a password, sign the lease, pay rent and report repairs.</p>
      <div class="input-group mb-3"><input class="form-control" readonly value="${esc(invite.invite_url)}" id="invite-url">
        <button class="btn btn-light" data-copy>${icon('copy', 16)} Copy</button></div>
      <div class="d-grid gap-2">
        <a class="btn btn-success" target="_blank" rel="noopener" href="https://wa.me/${esc(phone)}?text=${encodeURIComponent(invite.sms_text)}">${icon('chat', 18)} Send on WhatsApp</a>
        <a class="btn btn-light" href="sms:+${esc(phone)}?body=${encodeURIComponent(invite.sms_text)}">${icon('phone', 18)} Send as SMS</a>
        ${navigator.share ? `<button class="btn btn-light" data-share>${icon('share', 18)} Share…</button>` : ''}
      </div>`,
    onReady: (el) => {
      el.querySelector('[data-copy]').addEventListener('click', async () => toast(await copyText(invite.invite_url) ? 'Link copied' : 'Copy failed. Select the link manually.'));
      el.querySelector('[data-share]')?.addEventListener('click', () => navigator.share({ title: 'Kodi invitation', text: invite.sms_text }).catch(() => {}));
    },
  });
}

export async function tenantsView(_, query) {
  const mount = scopedMount();
  const main = mount(`${pageHeader('Tenants', { subtitle: 'Everyone renting from you',
    actions: state.isStaff ? `<button class="btn btn-primary" data-new>${icon('plus', 18)} Add tenant</button>` : '' })}
    <div class="d-flex gap-2 mb-3 flex-wrap">
      <div class="kodi-searchbar flex-grow-1">${icon('search', 18)}<input class="form-control" type="search" id="t-q" placeholder="Name, phone or ID number" value="${esc(query.q || '')}"></div>
      <div class="form-check form-switch align-self-center"><input class="form-check-input" type="checkbox" id="t-active" ${query.active === '0' ? '' : 'checked'}>
        <label class="form-check-label small" for="t-active">Current tenants only</label></div>
    </div>
    <div id="t-list">${skeleton(4)}</div>`);
  const load = async () => {
    const q = main.querySelector('#t-q').value.trim();
    const active = main.querySelector('#t-active').checked;
    setQuery({ q, active: active ? '' : '0', new: '' });
    const box = main.querySelector('#t-list');
    try {
      const rows = await api(acct(`/tenants${qs({ q, active_only: active, limit: 200 })}`));
      box.innerHTML = rows.length ? `<div class="kodi-card p-0"><ul class="kodi-rows">${rows.map((t) => `
        <li><a href="#/tenants/${t.id}"><span class="kodi-avatar">${esc(t.first_name[0])}</span>
          <span class="flex-grow-1 min-w-0"><strong class="d-block text-truncate">${esc(t.full_name)} ${t.is_blacklisted ? badge('blacklisted', 'danger') : ''}</strong>
            <span class="small text-secondary">${t.unit_number ? `${esc(t.unit_number)} · ${esc(t.property_name)}` : 'No current unit'} · +${esc(t.phone)}</span></span>
          <span class="text-end">${Number(t.balance) > 0 ? `<span class="text-danger fw-semibold d-block">${esc(fmtMoney(t.balance))}</span><span class="small text-secondary">owing</span>`
            : '<span class="small text-success">Paid up</span>'}<span class="d-block small">${t.user_id ? `${icon('check', 12)} On app` : '<span class="text-secondary">Not on app</span>'}</span></span></a></li>`).join('')}</ul></div>`
        : emptyState('users', q ? 'No tenant matches' : 'No tenants yet', q ? '' : 'Add a tenant, then allocate them a unit.',
          state.isStaff && !q ? '<button class="btn btn-primary" data-new>Add tenant</button>' : '');
    } catch (err) { box.innerHTML = errorBox(err); }
  };
  let timer;
  main.querySelector('#t-q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 300); });
  main.querySelector('#t-active').addEventListener('change', load);
  main.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-new]')) return;
    const t = await tenantFormModal();
    if (t?.id) { toast('Tenant added', { variant: 'success' }); navigate(`/tenants/${t.id}?welcome=1`); }
  });
  await load();
  if (query.new && state.isStaff) main.querySelector('[data-new]')?.click();
}

export async function tenantDetailView({ id }, query) {
  const mount = scopedMount();
  mount(skeleton(5));
  let t;
  try { t = await api(acct(`/tenants/${id}`)); } catch (err) { mount(errorBox(err)); return; }
  const current = t.leases.find((l) => ['pending_signature', 'active', 'notice_given'].includes(l.status));
  const main = mount(`${pageHeader(t.full_name, { back: '#/tenants',
    subtitle: `${t.identity_verified_at ? `${icon('shield', 14)} ID verified · ` : ''}${current ? `Unit ${esc(current.unit_number)}, ${esc(current.property_name)}` : 'No current unit'}`,
    actions: state.isStaff ? `${!t.user_id ? `<button class="btn btn-light" data-invite>${icon('share', 18)}<span class="d-none d-md-inline"> Invite to app</span></button>` : ''}
      ${!current ? `<button class="btn btn-primary" data-allocate>${icon('key', 18)} Allocate unit</button>` : ''}
      <div class="dropdown"><button class="btn btn-light" data-bs-toggle="dropdown" aria-label="More">${icon('more')}</button><ul class="dropdown-menu dropdown-menu-end">
        <li><button class="dropdown-item" data-edit>${icon('pen', 16)} Edit details</button></li>
        ${!t.identity_verified_at ? `<li><button class="dropdown-item" data-verify>${icon('shield', 16)} Mark ID as verified</button></li>` : ''}
        <li><button class="dropdown-item ${t.is_blacklisted ? '' : 'text-danger'}" data-blacklist>${icon('alert', 16)} ${t.is_blacklisted ? 'Remove from blacklist' : 'Blacklist tenant'}</button></li>
      </ul></div>` : '' })}
    ${query.welcome && !t.user_id && state.isStaff ? `<div class="kodi-alert mb-3">${icon('share', 18)}<span>Next: <button class="btn btn-link p-0 align-baseline" data-invite>invite ${esc(t.first_name)} to the app</button>
      and <button class="btn btn-link p-0 align-baseline" data-allocate>allocate a unit</button>.</span></div>` : ''}
    <div class="row g-3">
      <div class="col-lg-4">
        <section class="kodi-card mb-3">
          <div class="text-center mb-3"><span class="kodi-avatar xl mx-auto">${esc(t.first_name[0])}</span></div>
          <div class="d-flex justify-content-around text-center mb-3">
            <div><div class="small text-secondary">Balance</div><strong class="${Number(t.balance) > 0 ? 'text-danger' : 'text-success'}">${esc(fmtMoney(t.balance))}</strong></div>
            <div><div class="small text-secondary">Credit</div><strong>${esc(fmtMoney(t.credit))}</strong></div>
          </div>
          <ul class="kodi-list small">
            <li><span>Phone</span><a href="tel:+${esc(t.phone)}">+${esc(t.phone)}</a></li>
            <li><span>${esc(t.id_document_type.replace('_', ' '))}</span><span>${esc(t.id_document_number)}</span></li>
            ${t.email ? `<li><span>Email</span><span class="text-truncate">${esc(t.email)}</span></li>` : ''}
            ${t.occupation ? `<li><span>Occupation</span><span>${esc(t.occupation)}${t.employer ? `, ${esc(t.employer)}` : ''}</span></li>` : ''}
            <li><span>App</span><span>${t.user_id ? 'Using Kodi' : 'Not invited yet'}</span></li>
          </ul>
          ${t.is_blacklisted ? `<div class="alert alert-danger small mt-3 mb-0">Blacklisted${t.blacklist_reason ? `: ${esc(t.blacklist_reason)}` : ''}</div>` : ''}
          ${t.id_front_media_id || t.id_back_media_id ? `<div class="kodi-thumbs sm mt-3">${[t.id_front_media_id, t.id_back_media_id].filter(Boolean)
            .map((m) => `<figure class="kodi-thumb"><img data-media="${m}" alt="ID document"></figure>`).join('')}</div>` : ''}
        </section>
        <section class="kodi-card">
          <div class="d-flex justify-content-between align-items-center mb-2"><h2 class="h6 fw-bold mb-0">Next of kin</h2>
            ${state.isStaff ? `<button class="btn btn-light btn-sm" data-add-kin>${icon('plus', 14)}</button>` : ''}</div>
          ${t.next_of_kin.length ? `<ul class="kodi-list small">${t.next_of_kin.map((k) => `<li><span><strong class="d-block">${esc(k.full_name)}${k.is_primary ? ' ★' : ''}</strong>
            <span class="text-secondary">${esc(k.relationship)} · <a href="tel:+${esc(k.phone)}">+${esc(k.phone)}</a></span></span>
            ${state.isStaff ? `<button class="btn btn-sm btn-link text-danger" data-del-kin="${k.id}" aria-label="Remove">${icon('trash', 14)}</button>` : ''}</li>`).join('')}</ul>`
            : '<p class="small text-secondary mb-0">None recorded.</p>'}
        </section>
      </div>
      <div class="col-lg-8">
        <section class="kodi-card mb-3"><h2 class="h6 fw-bold">Leases</h2>
          ${t.leases.length ? `<ul class="kodi-list">${t.leases.map((l) => `<li><a href="#/leases/${l.id}" class="text-decoration-none">
            <strong class="d-block text-body">${esc(l.unit_number)} · ${esc(l.property_name)}</strong>
            <span class="small text-secondary">${esc(fmtDate(l.start_date))}${l.end_date ? ` to ${esc(fmtDate(l.end_date))}` : ''} · ${esc(fmtMoney(l.monthly_rent))}/mo</span></a>${badge(l.status)}</li>`).join('')}</ul>`
            : '<p class="small text-secondary mb-0">No leases yet.</p>'}
        </section>
        <section class="kodi-card">
          <div class="d-flex justify-content-between align-items-center mb-2 gap-2 flex-wrap"><h2 class="h6 fw-bold mb-0">Statement</h2>
            ${state.canFinance ? `<div class="d-flex gap-2"><button class="btn btn-light btn-sm" data-export="csv">${icon('download', 14)} CSV</button>
              <button class="btn btn-light btn-sm" data-export="pdf">${icon('download', 14)} PDF</button>
              <a class="btn btn-primary btn-sm" href="#/invoices?tab=payments&record=1&tenant_id=${t.id}">${icon('cash', 14)} Record payment</a></div>` : ''}</div>
          <div id="statement">${skeleton(3)}</div>
        </section>
      </div>
    </div>`);

  api(acct(`/tenants/${id}/statement`)).then((rows) => {
    main.querySelector('#statement').innerHTML = rows.length ? statementTable(rows) : '<p class="small text-secondary mb-0">No invoices or payments yet.</p>';
  }).catch((err) => { main.querySelector('#statement').innerHTML = errorBox(err); });

  const reload = () => tenantDetailView({ id }, {});
  main.addEventListener('click', async (e) => {
    const el = e.target;
    if (el.closest('[data-invite]')) { await inviteModal(t); }
    if (el.closest('[data-allocate]')) { const lease = await allocateModal({ tenant: t }); if (lease) navigate(`/leases/${lease.id}`); }
    if (el.closest('[data-edit]')) { if (await tenantFormModal(t)) reload(); }
    if (el.closest('[data-verify]')) {
      try { await api(acct(`/tenants/${id}/verify-identity`), { method: 'POST' }); toast('Identity marked as verified', { variant: 'success' }); reload(); }
      catch (err) { toast(err.message, { variant: 'danger' }); }
    }
    if (el.closest('[data-blacklist]')) {
      const done = t.is_blacklisted
        ? await confirmDialog(`Remove ${t.full_name} from the blacklist?`).then((ok) => ok && api(acct(`/tenants/${id}`), { method: 'PATCH', body: { is_blacklisted: false, blacklist_reason: null } }))
        : await formModal({ title: `Blacklist ${t.full_name}`, submitLabel: 'Blacklist', fields: `<p class="small text-secondary">Blacklisted tenants cannot be allocated new units.</p>${field('reason', 'Reason', { type: 'textarea', required: true })}`,
          onSubmit: (v) => api(acct(`/tenants/${id}`), { method: 'PATCH', body: { is_blacklisted: true, blacklist_reason: v.reason } }) });
      if (done) reload();
    }
    if (el.closest('[data-add-kin]')) {
      const done = await formModal({ title: 'Add next of kin', fields: kinFields(0).replace(/<legend.*?<\/legend>/, ''),
        onSubmit: (v) => api(acct(`/tenants/${id}/next-of-kin`), { method: 'POST', body: { full_name: v.kin_name_0, relationship: v.kin_rel_0, phone: v.kin_phone_0, id_number: v.kin_id_0 } }) });
      if (done) reload();
    }
    const del = el.closest('[data-del-kin]');
    if (del && await confirmDialog('Remove this next of kin?', { danger: true, confirmLabel: 'Remove' })) {
      await api(acct(`/tenants/${id}/next-of-kin/${del.dataset.delKin}`), { method: 'DELETE' }).catch((err) => toast(err.message, { variant: 'danger' }));
      reload();
    }
    const exp = el.closest('[data-export]');
    if (exp) {
      try {
        const r = await api(acct('/reports/exports'), { method: 'POST', body: { report_type: 'tenant_statement', format: exp.dataset.export, tenant_id: id } });
        await download(acct(`/reports/exports/${r.id}/download`), r.filename);
      } catch (err) { toast(err.message, { variant: 'danger' }); }
    }
  });
}

export function statementTable(rows) {
  return `<ul class="kodi-list d-md-none">${rows.map((r) => `<li><span><span class="d-block">${esc(r.description)}</span>
      <span class="text-secondary small">${esc(fmtDate(r.entry_date))}${r.reference ? ` · ${esc(r.reference)}` : ''}</span></span>
      <span class="text-end"><span class="kodi-amount d-block ${Number(r.credit) ? 'text-success' : ''}">${Number(r.credit) ? `−${esc(fmtMoney(r.credit))}` : esc(fmtMoney(r.debit))}</span>
      <span class="text-secondary small kodi-amount">Bal ${esc(fmtMoney(r.running_balance))}</span></span></li>`).join('')}</ul>
    <div class="table-responsive d-none d-md-block"><table class="table table-kodi table-sm align-middle mb-0">
      <thead><tr><th>Date</th><th>Details</th><th class="text-end">Charged</th><th class="text-end">Paid</th><th class="text-end">Balance</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td class="text-nowrap">${esc(fmtDate(r.entry_date))}</td>
        <td><span class="d-block">${esc(r.description)}</span><span class="text-secondary small">${esc(r.reference || '')}</span></td>
        <td class="text-end kodi-amount">${Number(r.debit) ? esc(fmtMoney(r.debit)) : ''}</td>
        <td class="text-end kodi-amount text-success">${Number(r.credit) ? esc(fmtMoney(r.credit)) : ''}</td>
        <td class="text-end kodi-amount fw-semibold">${esc(fmtMoney(r.running_balance))}</td></tr>`).join('')}</tbody></table></div>`;
}
