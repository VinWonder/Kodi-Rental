// Caretaker elimination engine: tenants report, landlords triage and dispatch.
import { api } from '../api.js';
import {
  badge, emptyState, errorBox, field, formModal, hydrateMedia, icon, ISSUE_CATEGORIES, label, pageHeader, photoPicker,
  select, skeleton, uploadFile, wirePhotoPicker,
} from '../components.js';
import { navigate, setQuery } from '../router.js';
import { rt } from '../realtime.js';
import { live, scopedMount } from '../shell.js';
import { acct, qs, state } from '../state.js';
import { esc, fmtMoney, fmtTime, setBusy, timeAgo, toast } from '../ui.js';
import { startCallForTenant } from './chat.js';

const BOARD = [
  ['received', 'New'], ['under_review', 'Reviewing'], ['dispatched_contractor', 'Dispatched'], ['in_progress', 'In progress'], ['resolved', 'Resolved'],
];
const NEXT_STATUSES = ['received', 'under_review', 'dispatched_contractor', 'in_progress', 'resolved', 'closed', 'rejected'];
const catIcon = (c) => (ISSUE_CATEGORIES.find((x) => x[0] === c) || ISSUE_CATEGORIES.at(-1))[1];

function issueCard(i, href) {
  return `<a class="kodi-issue kodi-prio-${i.priority}" href="${href}">
    <div class="d-flex justify-content-between gap-2"><span class="kodi-issue-cat">${icon(catIcon(i.category), 16)} ${esc(label(i.category))}</span>${badge(i.priority)}</div>
    <strong class="d-block mt-1">${esc(i.title)}</strong>
    <span class="small text-secondary">${esc(i.ticket_number)} · ${i.unit_number ? `Unit ${esc(i.unit_number)} · ` : ''}${esc(timeAgo(i.created_at))}</span>
    ${i.contractor_name ? `<span class="small d-block">${icon('wrench', 12)} ${esc(i.contractor_name)}</span>` : ''}</a>`;
}

function timeline(items) {
  return items.length ? `<ol class="kodi-timeline">${items.map((u) => `<li class="${u.is_internal ? 'is-internal' : ''}">
    <div class="small text-secondary">${esc(fmtTime(u.created_at))}${u.author ? ` · ${esc(u.author)}` : ''}${u.is_internal ? ' · internal note' : ''}</div>
    ${u.to_status ? `<div class="d-flex align-items-center gap-1 flex-wrap">${u.from_status ? badge(u.from_status) : ''} ${u.from_status ? '→' : ''} ${badge(u.to_status)}</div>` : ''}
    ${u.comment ? `<div class="mt-1">${esc(u.comment)}</div>` : ''}</li>`).join('')}</ol>` : '<p class="small text-secondary mb-0">No updates yet.</p>';
}

function attachments(list) {
  return list.length ? `<div class="kodi-thumbs">${list.map((a) => (a.mime_type.startsWith('image/')
    ? `<figure class="kodi-thumb"><img data-media="${a.media_id}" alt="Attachment"></figure>`
    : a.mime_type.startsWith('video/') ? `<figure class="kodi-thumb wide"><video data-media="${a.media_id}" controls playsinline preload="metadata"></video></figure>`
      : `<figure class="kodi-thumb wide"><audio data-media="${a.media_id}" controls></audio></figure>`)).join('')}</div>` : '';
}

// ------------------------------------------------------------------ landlord
export async function issuesBoardView(_, query) {
  const mount = scopedMount();
  const view = query.view || (window.innerWidth >= 992 ? 'board' : 'list');
  const main = mount(`${pageHeader('Repairs', { subtitle: 'Tenant-reported issues, without a caretaker',
    actions: `<div class="btn-group" role="group"><button class="btn btn-light ${view === 'board' ? 'active' : ''}" data-view="board" aria-label="Board">${icon('grid', 18)}</button>
      <button class="btn btn-light ${view === 'list' ? 'active' : ''}" data-view="list" aria-label="List">${icon('list', 18)}</button></div>
      ${state.isStaff ? `<button class="btn btn-primary" data-new>${icon('plus', 18)}<span class="kodi-label-md"> Log issue</span></button>` : ''}` })}
    <div class="d-flex gap-2 mb-3 flex-wrap">
      ${select('priority', 'Priority', ['emergency', 'high', 'medium', 'low'], { value: query.priority || '', col: 'kodi-inline-select', placeholder: 'Any priority' })}
      ${select('category', 'Category', ISSUE_CATEGORIES.map(([v, , t]) => [v, t]), { value: query.category || '', col: 'kodi-inline-select', placeholder: 'Any category' })}
      <div class="form-check form-switch align-self-center ms-1"><input class="form-check-input" type="checkbox" id="show-closed" ${query.closed ? 'checked' : ''}>
        <label class="form-check-label small" for="show-closed">Include closed</label></div>
    </div>
    <div id="issues">${skeleton(4)}</div>`);
  const load = async () => {
    const priority = main.querySelector('[name=priority]').value;
    const category = main.querySelector('[name=category]').value;
    const closed = main.querySelector('#show-closed').checked;
    setQuery({ priority, category, closed: closed ? '1' : '', view });
    const box = main.querySelector('#issues');
    try {
      const rows = await api(acct(`/issues${qs({ priority, category, open_only: closed ? '' : 'true', limit: 300 })}`));
      const resolved = closed ? [] : await api(acct(`/issues${qs({ status: 'resolved', priority, category, limit: 20 })}`)).catch(() => []);
      const all = [...rows, ...resolved.filter((r) => !rows.some((x) => x.id === r.id))];
      if (!all.length) { box.innerHTML = emptyState('wrench', 'No open repairs', 'When tenants report a problem it appears here instantly.'); return; }
      box.innerHTML = view === 'board' ? `<div class="kodi-board">${BOARD.map(([s, t]) => {
        const col = all.filter((i) => i.status === s);
        return `<section class="kodi-board-col"><header><span>${t}</span><span class="kodi-count">${col.length}</span></header>
          ${col.map((i) => issueCard(i, `#/issues/${i.id}`)).join('') || '<p class="small text-secondary text-center my-3">Empty</p>'}</section>`;
      }).join('')}</div>${closed ? `<h2 class="h6 fw-bold mt-4">Closed / rejected</h2><div class="kodi-grid kodi-grid-cards">${all.filter((i) => ['closed', 'rejected'].includes(i.status)).map((i) => issueCard(i, `#/issues/${i.id}`)).join('')}</div>` : ''}`
        : `<div class="kodi-grid kodi-grid-cards">${all.map((i) => `<div>${issueCard(i, `#/issues/${i.id}`)}<div class="mt-1">${badge(i.status)}</div></div>`).join('')}</div>`;
    } catch (err) { box.innerHTML = errorBox(err); }
  };
  main.addEventListener('change', (e) => { if (e.target.matches('select,#show-closed')) load(); });
  main.addEventListener('click', async (e) => {
    const v = e.target.closest('[data-view]');
    if (v) { setQuery({ view: v.dataset.view }); issuesBoardView(_, { ...query, view: v.dataset.view }); }
    if (e.target.closest('[data-new]')) {
      const units = await api(acct('/units?limit=500'));
      let getFiles = () => [];
      const created = await formModal({ title: 'Log an issue', size: 'lg', submitLabel: 'Create ticket',
        fields: `${select('unit_id', 'Unit', units.map((u) => [u.id, `${u.unit_number} · ${u.property_name}${u.tenant_name ? ` · ${u.tenant_name}` : ''}`]), { required: true })}
          <div class="row g-3">${select('category', 'Category', ISSUE_CATEGORIES.map(([c, , t]) => [c, t]), { required: true, col: 'col-6', value: 'plumbing', placeholder: null })}
          ${select('priority', 'Priority', ['low', 'medium', 'high', 'emergency'], { value: 'medium', col: 'col-6', placeholder: null })}</div>
          ${field('title', 'Title', { required: true, col: 'mt-3', attrs: 'minlength="3"' })}${field('description', 'Details', { type: 'textarea', required: true, attrs: 'minlength="5"' })}
          ${photoPicker('photos', { accept: 'image/*,video/*' })}`,
        onReady: (form) => { getFiles = wirePhotoPicker(form); },
        onSubmit: async (vals) => {
          const ids = [];
          for (const f of getFiles()) ids.push((await uploadFile(f, 'issue_attachment', state.accountId)).id);
          return api(acct('/issues'), { method: 'POST', body: { ...vals, attachment_media_ids: ids } });
        } });
      if (created) navigate(`/issues/${created.id}`);
    }
  });
  await load();
  const offs = ['event:issue_created', 'event:issue_status_changed'].map((ev) => live(ev, load));
  return () => offs.forEach((o) => o());
}

export async function issueDetailView({ id }) {
  const mount = scopedMount();
  mount(skeleton(5));
  let i;
  try { i = await api(acct(`/issues/${id}`)); } catch (err) { mount(errorBox(err)); return; }
  const main = mount(`${pageHeader(i.title, { back: '#/issues', subtitle: `${esc(i.ticket_number)} · ${esc(label(i.category))} · Unit ${esc(i.unit_number)}, ${esc(i.property_name)}`,
    actions: i.tenant_id ? `<button class="btn btn-light" data-call="video" title="Video call the tenant">${icon('video', 18)}<span class="kodi-label-md"> See it live</span></button>` : '' })}
    <div class="row g-3">
      <div class="col-lg-7">
        <section class="kodi-card mb-3">
          <div class="d-flex gap-2 mb-2 flex-wrap">${badge(i.status)} ${badge(i.priority)}</div>
          <p class="mb-2">${esc(i.description)}</p>
          <p class="small text-secondary mb-0">Reported ${esc(fmtTime(i.created_at))}${i.tenant_name ? ` by <a href="#/tenants/${i.tenant_id}">${esc(i.tenant_name)}</a> · <a href="tel:+${esc(i.tenant_phone)}">+${esc(i.tenant_phone)}</a>` : ''}</p>
          ${attachments(i.attachments)}
        </section>
        <section class="kodi-card"><h2 class="h6 fw-bold">Timeline</h2>${timeline(i.timeline)}
          ${state.isStaff ? `<form class="mt-3" data-comment><div class="input-group"><input class="form-control" name="comment" placeholder="Add a note or reply to the tenant…" required maxlength="2000">
            <button class="btn btn-primary" aria-label="Send">${icon('send', 16)}</button></div>
            <div class="form-check mt-2"><input class="form-check-input" type="checkbox" name="is_internal" id="internal"><label class="form-check-label small" for="internal">Internal note (hidden from tenant)</label></div></form>` : ''}
        </section>
      </div>
      <div class="col-lg-5">
        ${state.isStaff ? `<section class="kodi-card mb-3"><h2 class="h6 fw-bold">Update ticket</h2>
          <form data-update class="kodi-form">
            ${select('status', 'Status', NEXT_STATUSES, { value: i.status, placeholder: null })}
            ${select('priority', 'Priority', ['low', 'medium', 'high', 'emergency'], { value: i.priority, placeholder: null })}
            <div class="mb-3"><label class="form-label small fw-semibold" for="contractor">Contractor</label>
              <div class="input-group"><select class="form-select" name="assigned_contractor_id" id="contractor"><option value="">Not assigned</option></select>
              <button type="button" class="btn btn-light" data-new-contractor title="New contractor" aria-label="New contractor">${icon('plus', 16)}</button></div></div>
            ${field('scheduled_for', 'Visit scheduled for', { type: 'datetime-local', value: i.scheduled_for ? new Date(i.scheduled_for).toISOString().slice(0, 16) : '' })}
            <div class="row g-2">${field('estimated_cost', 'Estimate (KES)', { type: 'number', value: i.estimated_cost ?? '', dataType: 'number', col: 'col-6', attrs: 'min="0"' })}
              ${field('actual_cost', 'Final cost (KES)', { type: 'number', value: i.actual_cost ?? '', dataType: 'number', col: 'col-6', attrs: 'min="0"' })}</div>
            ${field('resolution_notes', 'Resolution notes', { type: 'textarea', value: i.resolution_notes || '', attrs: 'rows="2"', col: 'mt-3' })}
            ${field('comment', 'Message to tenant (optional)', { placeholder: 'e.g. Plumber arrives tomorrow 10am' })}
            <button class="btn btn-primary w-100">Save update</button>
          </form>
          ${i.actual_cost ? `<button class="btn btn-light w-100 mt-2" data-expense>${icon('cash', 16)} Log ${esc(fmtMoney(i.actual_cost))} as maintenance expense</button>` : ''}
        </section>` : ''}
        ${i.contractor_name ? `<section class="kodi-card mb-3"><h2 class="h6 fw-bold">Contractor</h2><p class="mb-1">${esc(i.contractor_name)}</p>
          <a class="btn btn-light btn-sm" href="tel:+${esc(i.contractor_phone)}">${icon('phone', 14)} +${esc(i.contractor_phone)}</a>
          <a class="btn btn-success btn-sm" target="_blank" rel="noopener" href="https://wa.me/${esc(i.contractor_phone)}?text=${encodeURIComponent(`Job ${i.ticket_number}: ${i.title} at ${i.property_name}, unit ${i.unit_number}. ${i.description}`)}">${icon('chat', 14)} WhatsApp job</a></section>` : ''}
        ${i.tenant_rating ? `<section class="kodi-card"><h2 class="h6 fw-bold">Tenant rating</h2><div class="kodi-stars">${'★'.repeat(i.tenant_rating)}${'☆'.repeat(5 - i.tenant_rating)}</div>
          ${i.tenant_feedback ? `<p class="small mb-0 mt-1">${esc(i.tenant_feedback)}</p>` : ''}</section>` : ''}
      </div>
    </div>`);
  hydrateMedia(main);

  const contractorSelect = main.querySelector('#contractor');
  const loadContractors = async (selected) => {
    if (!contractorSelect) return;
    const list = await api(acct('/contractors')).catch(() => []);
    contractorSelect.innerHTML = `<option value="">Not assigned</option>${list.map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>
      ${esc(c.name)}${c.specialties?.includes(i.category) ? ' ★' : ''}${c.company_name ? ` (${esc(c.company_name)})` : ''}</option>`).join('')}`;
  };
  loadContractors(i.assigned_contractor_id);
  const reload = () => issueDetailView({ id });

  main.querySelector('[data-update]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = {};
    for (const k of ['status', 'priority', 'resolution_notes', 'comment']) if (f[k].value.trim()) body[k] = f[k].value.trim();
    body.assigned_contractor_id = f.assigned_contractor_id.value || null;
    for (const k of ['estimated_cost', 'actual_cost']) if (f[k].value !== '') body[k] = Number(f[k].value);
    if (f.scheduled_for.value) body.scheduled_for = new Date(f.scheduled_for.value).toISOString();
    if (body.status === 'dispatched_contractor' && !body.assigned_contractor_id) { toast('Choose a contractor to dispatch.', { variant: 'warning' }); return; }
    const button = f.querySelector('button:last-of-type');
    setBusy(button, true, 'Saving…');
    try { await api(acct(`/issues/${id}`), { method: 'PATCH', body }); toast('Ticket updated. The tenant has been notified.', { variant: 'success' }); reload(); }
    catch (err) { toast(err.message, { variant: 'danger' }); setBusy(button, false); }
  });
  main.querySelector('[data-comment]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try { await api(acct(`/issues/${id}/comments`), { method: 'POST', body: { comment: f.comment.value, is_internal: f.is_internal.checked } }); reload(); }
    catch (err) { toast(err.message, { variant: 'danger' }); }
  });
  main.addEventListener('click', async (e) => {
    if (e.target.closest('[data-new-contractor]')) {
      const c = await contractorModal({ specialties: [i.category] });
      if (c) loadContractors(c.id);
    }
    if (e.target.closest('[data-call]')) startCallForTenant(i.tenant_id, 'video', i.id);
    if (e.target.closest('[data-expense]')) {
      try {
        await api(acct('/expenses'), { method: 'POST', body: { property_id: i.property_id, unit_id: i.unit_id, contractor_id: i.assigned_contractor_id,
          category: i.category, description: `${i.ticket_number}: ${i.title}`.slice(0, 250), amount: Number(i.actual_cost) } });
        toast('Expense logged. It appears in the maintenance overhead report.', { variant: 'success' });
      } catch (err) { toast(err.message, { variant: 'danger' }); }
    }
  });
  return live('event:issue_status_changed', (d) => { if (d.issue_id === id) reload(); });
}

export function contractorModal(existing = {}) {
  return formModal({ title: existing.id ? 'Edit contractor' : 'New contractor',
    fields: `${field('name', 'Name', { required: true, value: existing.name })}${field('company_name', 'Company', { value: existing.company_name })}
      ${field('phone', 'Phone', { type: 'tel', required: true, value: existing.phone ? `0${String(existing.phone).slice(3)}` : '' })}
      <label class="form-label small fw-semibold">Specialties</label><div class="d-flex flex-wrap gap-2 mb-2">${ISSUE_CATEGORIES.map(([c, , t]) => `
        <input type="checkbox" class="btn-check" id="sp-${c}" name="sp_${c}" ${(existing.specialties || []).includes(c) ? 'checked' : ''}>
        <label class="btn btn-sm btn-outline-primary rounded-pill" for="sp-${c}">${t}</label>`).join('')}</div>`,
    onSubmit: (v) => {
      const body = { name: v.name, company_name: v.company_name, phone: v.phone,
        specialties: ISSUE_CATEGORIES.map(([c]) => c).filter((c) => v[`sp_${c}`]) };
      return existing.id ? api(acct(`/contractors/${existing.id}`), { method: 'PATCH', body }) : api(acct('/contractors'), { method: 'POST', body });
    } });
}

// ------------------------------------------------------------------ tenant
export async function myIssuesView(_, query) {
  const mount = scopedMount();
  const main = mount(`${pageHeader('Repairs', { subtitle: 'Report a problem and follow it to the fix',
    actions: `<button class="btn btn-primary" data-new>${icon('plus', 18)} Report a problem</button>` })}<div id="mine">${skeleton(3)}</div>`);
  const load = async () => {
    const box = main.querySelector('#mine');
    try {
      const rows = await api('/api/v1/me/issues');
      box.innerHTML = rows.length ? `<div class="kodi-grid kodi-grid-cards">${rows.map((i) => `<div>${issueCard(i, `#/issues/${i.id}`)}<div class="mt-1">${badge(i.status)}</div></div>`).join('')}</div>`
        : emptyState('wrench', 'No repairs reported', 'Something broken? Report it with a photo and your landlord is alerted immediately.',
          '<button class="btn btn-primary" data-new>Report a problem</button>');
    } catch (err) { box.innerHTML = errorBox(err); }
  };
  main.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-new]')) return;
    let getFiles = () => [];
    const created = await formModal({ title: 'Report a problem', size: 'lg', submitLabel: 'Send to landlord',
      fields: `<label class="form-label small fw-semibold">What kind of problem?</label>
        <div class="kodi-cat-grid mb-3">${ISSUE_CATEGORIES.map(([c, ic, t], idx) => `<input type="radio" class="btn-check" name="category" id="cat-${c}" value="${c}" ${idx === 0 ? 'checked' : ''}>
          <label class="kodi-cat" for="cat-${c}">${icon(ic, 22)}<span>${t}</span></label>`).join('')}</div>
        <label class="form-label small fw-semibold">How urgent?</label>
        <div class="d-flex gap-2 flex-wrap mb-3">${[['low', 'Can wait'], ['medium', 'Soon'], ['high', 'Urgent'], ['emergency', 'Emergency']].map(([p, t]) => `
          <input type="radio" class="btn-check" name="priority" id="pr-${p}" value="${p}" ${p === 'medium' ? 'checked' : ''}>
          <label class="btn btn-sm btn-outline-${p === 'emergency' ? 'danger' : p === 'high' ? 'warning' : 'secondary'} rounded-pill" for="pr-${p}">${t}</label>`).join('')}</div>
        ${field('title', 'Short title', { required: true, placeholder: 'e.g. Kitchen sink leaking', attrs: 'minlength="3" maxlength="150"' })}
        ${field('description', 'Describe the problem', { type: 'textarea', required: true, placeholder: 'Where is it, when did it start…', attrs: 'minlength="5"' })}
        <label class="form-label small fw-semibold">Photos or a short video</label>${photoPicker('photos', { accept: 'image/*,video/*', capture: false })}`,
      onReady: (form) => { getFiles = wirePhotoPicker(form); },
      onSubmit: async (v) => {
        const accountId = state.tenancy?.account_id;
        const ids = [];
        for (const f of getFiles()) ids.push((await uploadFile(f, 'issue_attachment', accountId)).id);
        return api('/api/v1/me/issues', { method: 'POST', body: { category: v.category, priority: v.priority, title: v.title,
          description: v.description, attachment_media_ids: ids } });
      } });
    if (created) { toast(`Ticket ${created.ticket_number} sent. Your landlord has been notified.`, { variant: 'success' }); navigate(`/issues/${created.id}`); }
  });
  await load();
  if (query.new) main.querySelector('[data-new]')?.click();
  return live('event:issue_status_changed', load);
}

export async function myIssueDetailView({ id }) {
  const mount = scopedMount();
  mount(skeleton(4));
  let i;
  try { i = await api(`/api/v1/me/issues/${id}`); } catch (err) { mount(errorBox(err)); return; }
  const done = ['resolved', 'closed'].includes(i.status);
  const steps = ['received', 'under_review', 'dispatched_contractor', 'in_progress', 'resolved'];
  const at = steps.indexOf(i.status);
  const main = mount(`${pageHeader(i.title, { back: '#/issues', subtitle: `${esc(i.ticket_number)} · ${esc(label(i.category))}`,
    actions: `<button class="btn btn-light" data-call="video">${icon('video', 18)}<span class="kodi-label-md"> Show landlord</span></button>` })}
    <section class="kodi-card mb-3"><ol class="kodi-stepper">${steps.map((s, idx) => `<li class="${idx <= at ? 'done' : ''} ${idx === at ? 'current' : ''}"><span></span>${esc(label(s))}</li>`).join('')}</ol>
      ${i.status === 'rejected' ? '<p class="small text-danger mb-0 mt-2">Your landlord closed this request. See the timeline for details.</p>' : ''}
      ${i.scheduled_for ? `<p class="small mt-2 mb-0">${icon('calendar', 14)} Visit scheduled: <strong>${esc(fmtTime(i.scheduled_for))}</strong></p>` : ''}
      ${i.contractor_name ? `<p class="small mb-0">${icon('wrench', 14)} ${esc(i.contractor_name)} · <a href="tel:+${esc(i.contractor_phone)}">+${esc(i.contractor_phone)}</a></p>` : ''}</section>
    <div class="row g-3">
      <div class="col-lg-7"><section class="kodi-card mb-3"><p>${esc(i.description)}</p>${attachments(i.attachments)}</section>
        <section class="kodi-card"><h2 class="h6 fw-bold">Updates</h2>${timeline(i.timeline)}
          <form class="mt-3" data-comment><div class="input-group"><input class="form-control" name="comment" placeholder="Add a message…" required maxlength="2000">
          <button class="btn btn-primary" aria-label="Send">${icon('send', 16)}</button></div></form></section></div>
      <div class="col-lg-5">${done && !i.tenant_rating ? `<section class="kodi-card"><h2 class="h6 fw-bold">How did it go?</h2>
          <form data-rate><div class="kodi-rate mb-2">${[5, 4, 3, 2, 1].map((n) => `<input type="radio" name="rating" id="r${n}" value="${n}" required><label for="r${n}" title="${n} stars">★</label>`).join('')}</div>
          <textarea class="form-control mb-2" name="feedback" rows="2" placeholder="Optional feedback"></textarea><button class="btn btn-primary w-100">Rate the fix</button></form></section>`
        : i.tenant_rating ? `<section class="kodi-card"><h2 class="h6 fw-bold">Your rating</h2><div class="kodi-stars">${'★'.repeat(i.tenant_rating)}${'☆'.repeat(5 - i.tenant_rating)}</div></section>` : ''}</div>
    </div>`);
  hydrateMedia(main);
  main.querySelector('[data-comment]').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api(`/api/v1/me/issues/${id}/comments`, { method: 'POST', body: { comment: e.target.comment.value } }); myIssueDetailView({ id }); }
    catch (err) { toast(err.message, { variant: 'danger' }); }
  });
  main.querySelector('[data-rate]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try { await api(`/api/v1/me/issues/${id}/rate`, { method: 'POST', body: { rating: Number(f.rating.value), feedback: f.feedback.value || null } }); toast('Thanks for your feedback!', { variant: 'success' }); myIssueDetailView({ id }); }
    catch (err) { toast(err.message, { variant: 'danger' }); }
  });
  main.querySelector('[data-call]').addEventListener('click', () => startCallForTenant(null, 'video', id));
  return live('event:issue_status_changed', (d) => { if (d.issue_id === id) myIssueDetailView({ id }); });
}


