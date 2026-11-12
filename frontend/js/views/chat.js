// Messaging: conversation list + thread with text, photos/videos/files, voice
// notes, typing indicators, read receipts, and voice/video call buttons.
import { api } from '../api.js';
import { startCall } from '../calls.js';
import {
  audioRecorderSupported, emptyState, errorBox, hydrateMedia, icon, pageHeader, skeleton, startAudioRecording, uploadFile,
} from '../components.js';
import { rt } from '../realtime.js';
import { live, scopedMount, setChatUnread } from '../shell.js';
import { state } from '../state.js';
import { esc, fmtDate, timeAgo, toast } from '../ui.js';

const time = (iso) => new Date(iso).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });

async function conversations() {
  const list = await api('/api/v1/conversations');
  // In tenant mode only show the tenant's own threads; in landlord mode only staff threads.
  return list.filter((c) => (state.mode === 'tenant' ? c.i_am_tenant : !c.i_am_tenant));
}

export async function refreshChatBadge() {
  try {
    const list = await conversations();
    setChatUnread(list.reduce((a, c) => a + Number(c.unread_count || 0), 0));
  } catch { /* offline */ }
}

/** Landlord: call a tenant (finds their thread). Tenant: call the landlord. */
export async function startCallForTenant(tenantId, callType, issueId) {
  try {
    const list = await conversations();
    const conv = tenantId ? list.find((c) => c.tenant_id === tenantId) : list[0];
    if (!conv) { toast(tenantId ? 'This tenant is not on the app yet. Invite them first.' : 'No conversation with your landlord yet.', { variant: 'warning' }); return; }
    startCall(conv.id, callType, { title: state.mode === 'tenant' ? conv.business_name : conv.tenant_name, issueId });
  } catch (err) { toast(err.message, { variant: 'danger' }); }
}

function convTitle(c) { return state.mode === 'tenant' ? c.business_name : c.tenant_name; }

function bubble(m, me) {
  if (m.message_type === 'system' || m.message_type === 'call_log') {
    return `<div class="kodi-msg-system" data-id="${m.id}">${icon(m.message_type === 'call_log' ? 'phone' : 'bell', 14)} ${esc(m.body || '')} · ${esc(time(m.created_at))}</div>`;
  }
  const mine = String(m.sender_id) === String(me);
  let content = '';
  if (m.deleted_at) content = '<em class="text-secondary">Message deleted</em>';
  else if (m.message_type === 'image') content = `<img class="kodi-msg-img" data-media="${m.media_id}" alt="Photo" data-open-media="${m.media_id}">`;
  else if (m.message_type === 'video') content = `<video class="kodi-msg-img" data-media="${m.media_id}" controls playsinline preload="metadata"></video>`;
  else if (m.message_type === 'audio_note') content = `<div class="kodi-voice">${icon('mic', 16)}<audio data-media="${m.media_id}" controls preload="none"></audio>
    ${m.media_duration_ms ? `<span class="small">${Math.round(m.media_duration_ms / 1000)}s</span>` : ''}</div>`;
  else if (m.message_type === 'file') content = `<button class="btn btn-sm btn-light" data-file="${m.media_id}">${icon('file', 16)} Open file</button>`;
  return `<div class="kodi-msg ${mine ? 'mine' : 'theirs'} ${m.pending ? 'pending' : ''}" data-id="${m.id || ''}" data-client="${m.client_message_id || ''}">
    ${!mine ? `<span class="kodi-msg-author">${esc(m.sender_name || '')}</span>` : ''}
    ${content}${m.body && !m.deleted_at && m.message_type !== 'text' ? `<div>${esc(m.body)}</div>` : ''}${m.message_type === 'text' && !m.deleted_at ? `<div>${esc(m.body)}</div>` : ''}
    <span class="kodi-msg-time">${esc(time(m.created_at))}${mine ? ` <span class="kodi-ticks" data-ticks>${m.pending ? icon('clock', 12) : icon('check', 12)}</span>` : ''}</span></div>`;
}

function withDays(messages, me) {
  let lastDay = '';
  return messages.map((m) => {
    const day = new Date(m.created_at).toDateString();
    const sep = day !== lastDay ? `<div class="kodi-day"><span>${esc(day === new Date().toDateString() ? 'Today' : fmtDate(m.created_at))}</span></div>` : '';
    lastDay = day;
    return sep + bubble(m, me);
  }).join('');
}

export async function chatView(params) {
  const mount = scopedMount();
  const desktop = window.innerWidth >= 992;
  const convId = params.id || null;
  const main = mount(`<div class="kodi-chat ${convId ? 'has-thread' : ''}">
    <aside class="kodi-chat-list ${convId && !desktop ? 'd-none' : ''}">
      ${pageHeader('Messages')}
      <div id="conv-list">${skeleton(3)}</div>
    </aside>
    <section class="kodi-chat-thread ${!convId ? 'd-none d-lg-flex' : ''}" id="thread">
      ${convId ? skeleton(4) : emptyState('chat', 'Choose a conversation', 'Messages with your tenants and landlord, with photos, voice notes and calls.')}
    </section></div>`);

  const renderList = async () => {
    const box = main.querySelector('#conv-list');
    try {
      const list = await conversations();
      setChatUnread(list.reduce((a, c) => a + Number(c.unread_count || 0), 0));
      box.innerHTML = list.length ? `<ul class="kodi-convs">${list.map((c) => `<li><a href="#/chat/${c.id}" class="${c.id === convId ? 'active' : ''}">
        <span class="kodi-avatar">${esc(convTitle(c)[0])}</span>
        <span class="flex-grow-1 min-w-0"><span class="d-flex justify-content-between"><strong class="text-truncate">${esc(convTitle(c))}</strong>
          <span class="small text-secondary">${c.last_message_at ? esc(timeAgo(c.last_message_at)) : ''}</span></span>
          <span class="d-flex justify-content-between gap-2"><span class="small text-secondary text-truncate">${esc(c.last_message_preview || c.unit_label || 'Say hello')}</span>
          ${Number(c.unread_count) ? `<span class="kodi-unread">${c.unread_count}</span>` : ''}</span></span></a></li>`).join('')}</ul>`
        : emptyState('chat', 'No conversations yet', state.mode === 'tenant' ? 'Your landlord\'s thread appears once your tenancy is linked.' : 'Threads open automatically when a tenant joins the app.');
      return list;
    } catch (err) { box.innerHTML = errorBox(err); return []; }
  };
  const list = await renderList();
  const offs = [live('chat.message', () => renderList())];
  if (!convId) return () => offs.forEach((o) => o());

  const conv = list.find((c) => c.id === convId);
  if (!conv) { main.querySelector('#thread').innerHTML = errorBox(new Error('Conversation not found')); return () => offs.forEach((o) => o()); }
  const accountId = conv.account_id;
  const me = rt.userId || state.user.id;
  const thread = main.querySelector('#thread');
  thread.innerHTML = `<header class="kodi-thread-head">
      <a class="btn btn-icon btn-light d-lg-none" href="#/chat" aria-label="Back">${icon('back')}</a>
      <span class="kodi-avatar">${esc(convTitle(conv)[0])}</span>
      <div class="flex-grow-1 min-w-0"><h1 class="h6 fw-bold mb-0 text-truncate">${esc(convTitle(conv))}</h1>
        <span class="small text-secondary" data-typing>${esc(conv.unit_label || '')}</span></div>
      <button class="btn btn-icon btn-light" data-call="audio" aria-label="Voice call">${icon('phone')}</button>
      <button class="btn btn-icon btn-primary" data-call="video" aria-label="Video call">${icon('video')}</button>
    </header>
    <div class="kodi-messages" id="messages" tabindex="0" role="log" aria-live="polite" aria-label="Messages"><div class="text-center py-3"><span class="spinner-border spinner-border-sm"></span></div></div>
    <form class="kodi-composer" id="composer" autocomplete="off">
      <label class="btn btn-icon btn-light mb-0" aria-label="Attach">${icon('clip')}<input type="file" class="visually-hidden" accept="image/*,video/*,application/pdf" data-attach></label>
      <textarea class="form-control" rows="1" name="body" placeholder="Message" maxlength="4000" aria-label="Message"></textarea>
      <button type="button" class="btn btn-icon btn-light ${audioRecorderSupported() ? '' : 'd-none'}" data-record aria-label="Record voice note">${icon('mic')}</button>
      <button class="btn btn-icon btn-primary" type="submit" aria-label="Send">${icon('send')}</button>
    </form>`;

  const box = thread.querySelector('#messages');
  let messages = [];
  let loadingOlder = false;
  let reachedStart = false;
  const scrollBottom = () => { box.scrollTop = box.scrollHeight; };
  const paint = (keepPosition = false) => {
    const prevHeight = box.scrollHeight;
    box.innerHTML = (reachedStart ? '<div class="kodi-day"><span>Start of conversation</span></div>' : '') + withDays(messages, me);
    hydrateMedia(box);
    if (keepPosition) box.scrollTop = box.scrollHeight - prevHeight; else scrollBottom();
  };
  const markRead = () => {
    const last = [...messages].reverse().find((m) => m.id && String(m.sender_id) !== String(me));
    if (last && document.visibilityState === 'visible') rt.post('chat.read', { conversation_id: convId, last_read_message_id: last.id });
  };
  try {
    messages = await api(`/api/v1/conversations/${convId}/messages?limit=50`);
    reachedStart = messages.length < 50;
    paint();
    markRead();
    renderList();
  } catch (err) { box.innerHTML = errorBox(err); }

  box.addEventListener('scroll', async () => {
    if (box.scrollTop > 40 || loadingOlder || reachedStart || !messages.length) return;
    loadingOlder = true;
    try {
      const older = await api(`/api/v1/conversations/${convId}/messages?limit=50&before_id=${messages[0].id}`);
      reachedStart = older.length < 50;
      messages = [...older, ...messages];
      paint(true);
    } finally { loadingOlder = false; }
  });

  // Live updates
  offs.push(live('chat.message', ({ message }) => {
    if (message.conversation_id !== convId) return;
    const idx = messages.findIndex((m) => (message.client_message_id && m.client_message_id === message.client_message_id) || m.id === message.id);
    if (idx >= 0) messages[idx] = message; else messages.push(message);
    paint();
    markRead();
  }));
  let typingTimer;
  offs.push(live('chat.typing', (msg) => {
    if (msg.conversation_id !== convId) return;
    const el = thread.querySelector('[data-typing]');
    el.innerHTML = '<span class="kodi-typing"><i></i><i></i><i></i></span> typing';
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => { el.textContent = conv.unit_label || ''; }, 3500);
  }));
  offs.push(live('chat.read', (msg) => {
    if (msg.conversation_id !== convId) return;
    box.querySelectorAll('.kodi-msg.mine').forEach((el) => {
      if (Number(el.dataset.id) <= Number(msg.last_read_message_id)) el.querySelector('[data-ticks]')?.classList.add('read');
    });
  }));
  const onVisible = () => markRead();
  document.addEventListener('visibilitychange', onVisible);

  // Sending
  const send = async (payload) => {
    const clientId = crypto.randomUUID();
    const optimistic = { ...payload, id: null, client_message_id: clientId, sender_id: me, created_at: new Date().toISOString(), pending: true };
    messages.push(optimistic);
    paint();
    try {
      const { message } = await rt.request('chat.send', { conversation_id: convId, client_message_id: clientId, ...payload });
      const idx = messages.findIndex((m) => m.client_message_id === clientId);
      if (idx >= 0) messages[idx] = message;
      paint();
    } catch (err) {
      // Socket down: fall back to REST (idempotent thanks to client_message_id).
      try {
        const message = await api(`/api/v1/conversations/${convId}/messages`, { method: 'POST', body: { client_message_id: clientId, ...payload } });
        const idx = messages.findIndex((m) => m.client_message_id === clientId);
        if (idx >= 0) messages[idx] = message;
        paint();
      } catch (err2) {
        messages = messages.filter((m) => m.client_message_id !== clientId);
        paint();
        toast(err2.message || err.message, { variant: 'danger' });
      }
    }
  };
  const composer = thread.querySelector('#composer');
  const textarea = composer.body;
  let lastTyping = 0;
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 140)}px`;
    if (Date.now() - lastTyping > 2500) { lastTyping = Date.now(); rt.post('chat.typing', { conversation_id: convId }); }
  });
  textarea.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && window.innerWidth >= 768) { e.preventDefault(); composer.requestSubmit(); } });
  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const body = textarea.value.trim();
    if (!body) return;
    textarea.value = '';
    textarea.style.height = 'auto';
    send({ message_type: 'text', body });
  });
  composer.querySelector('[data-attach]').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const type = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'file';
    toast('Uploading…', { delay: 1500 });
    try {
      const media = await uploadFile(file, 'chat_attachment', accountId);
      send({ message_type: type, media_id: media.id, body: textarea.value.trim() || null });
      textarea.value = '';
    } catch (err) { toast(err.message, { variant: 'danger' }); }
  });

  // Voice notes: tap to start, tap again to send (long-press is unreliable on some phones).
  let recording = null;
  const recBtn = composer.querySelector('[data-record]');
  recBtn.addEventListener('click', async () => {
    if (!recording) {
      try {
        recording = await startAudioRecording();
        recBtn.classList.add('recording');
        recBtn.innerHTML = `${icon('send')}`;
        textarea.placeholder = 'Recording… tap the button again to send';
        textarea.disabled = true;
      } catch { toast('Allow microphone access to record voice notes.', { variant: 'warning' }); }
      return;
    }
    const rec = recording;
    recording = null;
    recBtn.classList.remove('recording');
    recBtn.innerHTML = icon('mic');
    textarea.placeholder = 'Message';
    textarea.disabled = false;
    const { blob, durationMs } = await rec.stop();
    if (durationMs < 700) { toast('Voice note too short'); return; }
    try {
      const media = await uploadFile(blob, 'chat_attachment', accountId, durationMs);
      send({ message_type: 'audio_note', media_id: media.id });
    } catch (err) { toast(err.message, { variant: 'danger' }); }
  });

  thread.addEventListener('click', async (e) => {
    const call = e.target.closest('[data-call]');
    if (call) startCall(convId, call.dataset.call, { title: convTitle(conv) });
    const file = e.target.closest('[data-file]');
    if (file) {
      const blob = await api(`/api/v1/media/${file.dataset.file}`);
      window.open(URL.createObjectURL(blob), '_blank', 'noopener');
    }
    const img = e.target.closest('[data-open-media]');
    if (img?.src) window.open(img.src, '_blank', 'noopener');
  });

  return () => {
    offs.forEach((o) => o());
    document.removeEventListener('visibilitychange', onVisible);
    recording?.cancel();
  };
}

