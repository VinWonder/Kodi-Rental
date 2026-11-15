// Verified reviews: only tenants who have lived in a building for 30+ days can
// rate it (enforced by the API), so every star on Kodi comes from a real stay.
//   * public: rating chip on cards, a reviews section on the listing page
//   * tenant: "Rate your home" page + a nudge on the home screen
//   * landlord: reviews inbox with public replies
import { api } from '../api.js';
import { emptyState, errorBox, formModal, icon, pageHeader, skeleton, stat } from '../components.js';
import { celebrate, haptic } from '../fx.js';
import { scopedMount } from '../shell.js';
import { acct, state } from '../state.js';
import { esc, fmtDate, toast } from '../ui.js';

const monthYear = (iso) => (iso ? new Date(iso).toLocaleDateString('en-KE', { month: 'short', year: 'numeric' }) : '');

// ------------------------------------------------------------------ display pieces
/** Five stars filled to `value` (0-5, halves shown by width). */
export function stars(value, size = 14) {
  const pct = Math.max(0, Math.min(100, (Number(value) / 5) * 100));
  return `<span class="kodi-stars" style="--pct:${pct}%;--s:${size}px" role="img" aria-label="Rated ${Number(value).toFixed(1)} out of 5">
    <span aria-hidden="true">★★★★★</span><span aria-hidden="true">★★★★★</span></span>`;
}

/** "★ 4.8 (12)" for listing cards; nothing when a building has no reviews yet. */
export function ratingChip(v, { long = false } = {}) {
  if (!v?.rating_count) return '';
  const n = Number(v.rating_count);
  return `<span class="kodi-rating" aria-label="Rated ${Number(v.rating_avg).toFixed(1)} out of 5 by ${n} verified ${n === 1 ? 'tenant' : 'tenants'}">
    <span aria-hidden="true">★</span><b>${Number(v.rating_avg).toFixed(1)}</b>${long
      ? `<span aria-hidden="true"> · ${n} ${n === 1 ? 'review' : 'reviews'}</span>` : `<span aria-hidden="true">(${n})</span>`}</span>`;
}

function reviewCard(r, { landlordActions = false } = {}) {
  const since = r.lived_since ? `${r.current_tenant ? 'Lives here' : 'Lived here'} since ${monthYear(r.lived_since)}` : 'Verified tenant';
  return `<article class="kodi-review" data-review="${esc(r.id)}">
    <header><span class="kodi-avatar sm" aria-hidden="true">${esc((r.author || 'T')[0])}</span>
      <div class="min-w-0 flex-grow-1"><strong class="d-block">${esc(r.author)}</strong>
        <span class="small text-secondary">${r.property_name ? `${esc(r.property_name)} · ` : ''}${esc(since)}</span></div>
      <span class="kodi-verified" title="Lived here at least 30 days">${icon('shield', 13)} Verified</span></header>
    <div class="d-flex align-items-center gap-2 my-2">${stars(r.rating)}<span class="small text-secondary">${esc(fmtDate(r.updated_at || r.created_at))}</span></div>
    ${r.comment ? `<p class="mb-0">${esc(r.comment)}</p>` : '<p class="mb-0 text-secondary fst-italic">Rated without a comment.</p>'}
    ${r.landlord_reply ? `<div class="kodi-review-reply"><strong>${icon('chat', 14)} Landlord's reply</strong><p class="mb-0">${esc(r.landlord_reply)}</p></div>` : ''}
    ${landlordActions ? `<div class="mt-2"><button type="button" class="btn btn-light btn-sm" data-reply="${esc(r.id)}">${icon('chat', 16)} ${r.landlord_reply ? 'Edit reply' : 'Reply publicly'}</button></div>` : ''}
  </article>`;
}

function summaryHtml(s) {
  const total = s.count || 0;
  return `<div class="kodi-review-summary">
    <div class="kodi-review-score"><strong>${Number(s.average).toFixed(1)}</strong>${stars(s.average, 18)}
      <span class="small text-secondary">${total} verified ${total === 1 ? 'review' : 'reviews'}</span></div>
    <ul class="kodi-review-bars" aria-label="Rating breakdown">${[5, 4, 3, 2, 1].map((k) => {
      const n = s.distribution?.[k] || 0;
      return `<li><span>${k} ★</span><i><b style="width:${total ? (n / total) * 100 : 0}%"></b></i><span class="visually-hidden">${n} reviews</span><span aria-hidden="true">${n}</span></li>`;
    }).join('')}</ul>
  </div>`;
}

// ------------------------------------------------------------------ public listing section
/** Fills `el` with the building's reviews. Used by the vacancy detail page. */
export async function loadPublicReviews(el, propertyId) {
  try {
    const s = await api(`/api/v1/public/properties/${propertyId}/reviews?limit=6`, { auth: false });
    if (!el.isConnected) return;
    el.innerHTML = s.count
      ? `${summaryHtml(s)}<div class="kodi-reviews">${s.reviews.map((r) => reviewCard(r)).join('')}</div>`
      : `<div class="kodi-where">${icon('star', 26)}<div><strong class="d-block">No reviews yet</strong>
          <span class="small text-secondary">Only tenants who have lived here at least 30 days can review this building, so every Kodi rating comes from a real stay.</span></div></div>`;
  } catch { el.innerHTML = '<p class="small text-secondary mb-0">Reviews could not load right now.</p>'; }
}

// ------------------------------------------------------------------ tenant
function starInput(value = 0) {
  const words = ['', 'Poor', 'Below average', 'Okay', 'Good', 'Excellent'];
  return `<fieldset class="kodi-star-input mb-3"><legend class="form-label small fw-semibold">Your rating <span class="text-danger">*</span></legend>
    <div class="kodi-star-row">${[1, 2, 3, 4, 5].map((n) => `<input type="radio" class="visually-hidden" name="rating" id="rate-${n}" value="${n}" data-type="number" ${n === value ? 'checked' : ''} required>
      <label for="rate-${n}" title="${words[n]}"><span aria-hidden="true">★</span><span class="visually-hidden">${n} ${n === 1 ? 'star' : 'stars'}, ${words[n]}</span></label>`).join('')}
      <span class="kodi-star-word" aria-hidden="true" data-word>${words[value] || 'Tap a star'}</span></div></fieldset>`;
}

function reviewForm(home) {
  return formModal({
    title: home.review_id ? 'Edit your review' : `Rate ${home.property_name}`,
    submitLabel: home.review_id ? 'Save review' : 'Post review',
    fields: `<p class="small text-secondary">Your first name and last initial are shown, never your unit or phone. Your landlord can reply but cannot change or remove what you write.</p>
      ${starInput(home.rating || 0)}
      <label class="form-label small fw-semibold" for="rv-text">What is it like to live here?</label>
      <textarea class="form-control" id="rv-text" name="comment" rows="4" maxlength="1000"
        placeholder="Water, security, noise, how fast repairs get fixed, the caretaker…">${esc(home.comment || '')}</textarea>`,
    onReady: (form) => {
      const word = form.querySelector('[data-word]');
      form.addEventListener('change', (e) => {
        if (e.target.name !== 'rating') return;
        haptic(8);
        word.textContent = e.target.closest('.kodi-star-row').querySelector(`label[for="${e.target.id}"]`).title;
      });
    },
    onSubmit: (v) => api(`/api/v1/me/reviews/${home.property_id}`, { method: 'PUT', body: { rating: v.rating, comment: v.comment || null } }),
  });
}

export async function myReviewsView() {
  const mount = scopedMount();
  const main = mount(`${pageHeader('Rate your home', { subtitle: 'Help the next tenant choose well' })}<div id="rv-list">${skeleton(2)}</div>`);
  const render = async () => {
    const box = main.querySelector('#rv-list');
    try {
      const homes = await api('/api/v1/me/reviews');
      if (!homes.length) {
        box.innerHTML = emptyState('star', 'Nothing to review yet', 'Once you have signed a lease and lived somewhere for 30 days, you can rate it here.');
        return;
      }
      box.innerHTML = `<div class="kodi-reviews">${homes.map((hm) => `<article class="kodi-review">
          <header><span class="kodi-avatar sm" aria-hidden="true">${icon('building', 16)}</span>
            <div class="min-w-0 flex-grow-1"><strong class="d-block">${esc(hm.property_name)}</strong>
              <span class="small text-secondary">${esc(hm.area)} · ${hm.current_home ? 'Your home' : 'Former home'} since ${esc(monthYear(hm.since))}</span></div></header>
          ${hm.review_id ? `<div class="d-flex align-items-center gap-2 my-2">${stars(hm.rating)}<span class="small text-secondary">${esc(fmtDate(hm.reviewed_at))}</span></div>
              ${hm.comment ? `<p class="mb-2">${esc(hm.comment)}</p>` : ''}
              ${hm.landlord_reply ? `<div class="kodi-review-reply"><strong>${icon('chat', 14)} Landlord's reply</strong><p class="mb-0">${esc(hm.landlord_reply)}</p></div>` : ''}
              <div class="d-flex gap-2 mt-2"><button type="button" class="btn btn-light btn-sm" data-edit="${esc(hm.property_id)}">${icon('pen', 16)} Edit</button>
                <button type="button" class="btn btn-link btn-sm text-danger" data-delete="${esc(hm.property_id)}">Delete</button></div>`
            : hm.eligible ? `<button type="button" class="btn btn-primary mt-2" data-edit="${esc(hm.property_id)}">${icon('star', 18)} Write a review</button>`
              : `<p class="small text-secondary mt-2 mb-0">${icon('clock', 14)} You can review from ${esc(fmtDate(hm.eligible_from))}, after 30 days in your home.</p>`}
        </article>`).join('')}</div>`;
      box.onclick = async (e) => {
        const edit = e.target.closest('[data-edit]');
        const del = e.target.closest('[data-delete]');
        if (edit) {
          const home = homes.find((x) => x.property_id === edit.dataset.edit);
          const saved = await reviewForm(home);
          if (saved) {
            if (!home.review_id) celebrate();
            toast(home.review_id ? 'Review updated.' : 'Thank you! Your review is live.', { variant: 'success' });
            render();
          }
        }
        if (del) {
          await api(`/api/v1/me/reviews/${del.dataset.delete}`, { method: 'DELETE' });
          toast('Review deleted.');
          render();
        }
      };
    } catch (err) { box.innerHTML = errorBox(err); }
  };
  render();
}

/** Home-screen nudge: shown when the tenant can review their home and hasn't. */
export async function rateNudge(el) {
  try {
    const homes = await api('/api/v1/me/reviews');
    const due = homes.find((hm) => hm.eligible && !hm.review_id);
    if (!due || !el.isConnected) return;
    el.innerHTML = `<a class="kodi-rate-nudge" href="#/reviews">
      <span class="kodi-rate-stars" aria-hidden="true">★★★★★</span>
      <span class="flex-grow-1"><strong class="d-block">How is life at ${esc(due.property_name)}?</strong>
        <span class="small">Rate your home in 30 seconds and help the next tenant.</span></span>${icon('arrow', 18)}</a>`;
  } catch { /* optional */ }
}

// ------------------------------------------------------------------ landlord
export async function landlordReviewsView(_, query) {
  const mount = scopedMount();
  const main = mount(`${pageHeader('Reviews', { subtitle: 'What verified tenants say about your buildings' })}<div id="rv-list">${skeleton(3)}</div>`);
  const box = main.querySelector('#rv-list');
  try {
    const rows = await api(acct(`/reviews${query.property_id ? `?property_id=${encodeURIComponent(query.property_id)}` : ''}`));
    if (!rows.length) {
      box.innerHTML = emptyState('star', 'No reviews yet',
        'Tenants can rate a building after living there for 30 days. Ratings appear on your public listings, so good service now fills units faster later.');
      return;
    }
    const byProperty = new Map();
    rows.forEach((r) => {
      const p = byProperty.get(r.property_id) || { name: r.property_name, sum: 0, n: 0 };
      p.sum += r.rating; p.n += 1;
      byProperty.set(r.property_id, p);
    });
    const avg = rows.reduce((a, r) => a + r.rating, 0) / rows.length;
    const unreplied = rows.filter((r) => !r.landlord_reply).length;
    box.innerHTML = `<div class="kodi-kpis">
        ${stat('Average rating', `${avg.toFixed(1)} ★`, { iconName: 'star', hint: 'From verified tenants only' })}
        ${stat('Reviews', String(rows.length), { iconName: 'chat', count: rows.length })}
        ${stat('Awaiting your reply', String(unreplied), { iconName: 'pen', count: unreplied, hint: unreplied ? 'Replies show on your listings' : 'All answered' })}</div>
      ${byProperty.size > 1 ? `<div class="kodi-chipline mb-3">${[...byProperty.entries()].map(([id, p]) => `
        <a class="kodi-tag" href="#/reviews?property_id=${esc(id)}">${esc(p.name)} · ${(p.sum / p.n).toFixed(1)} ★</a>`).join('')}
        ${query.property_id ? '<a class="kodi-tag" href="#/reviews">All buildings</a>' : ''}</div>` : ''}
      <div class="kodi-reviews">${rows.map((r) => reviewCard(r, { landlordActions: state.isStaff })).join('')}</div>`;
    box.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-reply]');
      if (!b) return;
      const r = rows.find((x) => x.id === b.dataset.reply);
      const saved = await formModal({
        title: 'Reply publicly',
        submitLabel: 'Post reply',
        fields: `<p class="small text-secondary">Your reply appears under ${esc(r.author)}'s review on your public listings. Keep it polite; future tenants read it.</p>
          <label class="form-label small fw-semibold" for="rp-text">Your reply <span class="text-danger">*</span></label>
          <textarea class="form-control" id="rp-text" name="reply" rows="4" minlength="2" maxlength="1000" required>${esc(r.landlord_reply || '')}</textarea>`,
        onSubmit: (v) => api(acct(`/reviews/${r.id}/reply`), { method: 'POST', body: { reply: v.reply } }),
      });
      if (saved) {
        Object.assign(r, saved);
        b.closest('[data-review]').outerHTML = reviewCard(r, { landlordActions: true });
        toast('Reply posted.', { variant: 'success' });
      }
    });
  } catch (err) { box.innerHTML = errorBox(err); }
}
