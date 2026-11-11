// WebRTC voice/video calls signalled over the Kodi WebSocket.
// Flow: caller call.invite -> callee call.incoming -> callee call.accept ->
// caller sends rtc.offer -> callee rtc.answer -> both trickle rtc.ice.
import { icon } from './components.js';
import { rt } from './realtime.js';
import { esc, toast } from './ui.js';

let active = null;   // { call, pc, local, role, pendingIce, remoteSet, timer, startedAt, facing }
let ringtone = null;

const root = () => document.getElementById('call-root');

// ------------------------------------------------------------------ ringtone (WebAudio, no asset needed)
function startRing(incoming) {
  stopRing();
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const beep = () => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = incoming ? 880 : 440;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + (incoming ? 0.5 : 1.0));
      o.connect(g).connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + (incoming ? 0.55 : 1.05));
    };
    beep();
    const id = setInterval(beep, incoming ? 1200 : 3000);
    ringtone = { stop: () => { clearInterval(id); ctx.close().catch(() => {}); } };
    if (incoming && navigator.vibrate && navigator.userActivation?.hasBeenActive) navigator.vibrate([400, 200, 400, 200, 400]);
  } catch { /* autoplay blocked */ }
}
function stopRing() { ringtone?.stop(); ringtone = null; if (navigator.vibrate && navigator.userActivation?.hasBeenActive) navigator.vibrate(0); }

// ------------------------------------------------------------------ UI
function render({ title, subtitle, state, video, incoming }) {
  const r = root();
  r.innerHTML = `<div class="kodi-call ${video ? 'is-video' : 'is-audio'} ${state}" role="dialog" aria-label="Call">
    <video class="kodi-call-remote" autoplay playsinline></video>
    <audio class="kodi-call-audio" autoplay></audio>
    <video class="kodi-call-local" autoplay playsinline muted></video>
    <div class="kodi-call-info">
      <div class="kodi-call-avatar">${esc((title || '?')[0])}</div>
      <h2 class="h4 fw-bold mb-1">${esc(title)}</h2>
      <p class="mb-0" data-call-status>${esc(subtitle)}</p>
    </div>
    <div class="kodi-call-controls">
      ${incoming ? `<button class="kodi-call-btn danger" data-act="reject" aria-label="Decline">${icon('phone', 26, 'rot-135')}</button>
        <button class="kodi-call-btn success" data-act="accept" aria-label="Answer">${icon(video ? 'video' : 'phone', 26)}</button>`
      : `<button class="kodi-call-btn" data-act="mute" aria-label="Mute">${icon('mic', 24)}</button>
        ${video ? `<button class="kodi-call-btn" data-act="camera" aria-label="Camera off">${icon('video', 24)}</button>
        <button class="kodi-call-btn" data-act="flip" aria-label="Switch camera">${icon('flip', 24)}</button>` : ''}
        <button class="kodi-call-btn danger" data-act="end" aria-label="End call">${icon('phone', 26, 'rot-135')}</button>`}
    </div></div>`;
  r.querySelector('.kodi-call').addEventListener('click', onControl);
  if (active?.local) attachLocal();
}

function setStatus(text) {
  const el = root().querySelector('[data-call-status]');
  if (el) el.textContent = text;
}

function attachLocal() {
  const v = root().querySelector('.kodi-call-local');
  if (v && active?.local) v.srcObject = active.local;
}

function attachRemote(stream) {
  const r = root();
  const v = r.querySelector('.kodi-call-remote');
  const a = r.querySelector('.kodi-call-audio');
  if (v) v.srcObject = stream;
  if (a) a.srcObject = stream;
  r.querySelector('.kodi-call')?.classList.add('has-remote');
}

function tickTimer() {
  if (!active?.startedAt) return;
  const s = Math.floor((Date.now() - active.startedAt) / 1000);
  setStatus(`${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`);
}

async function onControl(e) {
  const b = e.target.closest('[data-act]');
  if (!b || !active) return;
  const act = b.dataset.act;
  if (act === 'accept') return accept();
  if (act === 'reject') { rt.post('call.reject', { call_id: active.call.id }); return cleanup('Call declined'); }
  if (act === 'end') { rt.post('call.end', { call_id: active.call.id }); return cleanup('Call ended'); }
  if (act === 'mute') {
    const track = active.local?.getAudioTracks()[0];
    if (track) { track.enabled = !track.enabled; b.classList.toggle('off', !track.enabled); b.innerHTML = icon(track.enabled ? 'mic' : 'micOff', 24); }
  }
  if (act === 'camera') {
    const track = active.local?.getVideoTracks()[0];
    if (track) { track.enabled = !track.enabled; b.classList.toggle('off', !track.enabled); b.innerHTML = icon(track.enabled ? 'video' : 'videoOff', 24); }
  }
  if (act === 'flip') await flipCamera();
}

// ------------------------------------------------------------------ media & peer connection
async function getMedia(video, facing = 'environment') {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Calls need a secure (https) page and a modern browser.');
  // Tenants usually call to *show* damage: start on the rear camera.
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: video ? { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } } : false,
  });
}

async function flipCamera() {
  if (!active?.local) return;
  active.facing = active.facing === 'environment' ? 'user' : 'environment';
  try {
    const fresh = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: active.facing } } });
    const newTrack = fresh.getVideoTracks()[0];
    const sender = active.pc?.getSenders().find((s) => s.track?.kind === 'video');
    if (sender) await sender.replaceTrack(newTrack);
    active.local.getVideoTracks().forEach((t) => { active.local.removeTrack(t); t.stop(); });
    active.local.addTrack(newTrack);
    attachLocal();
  } catch { toast('Could not switch camera', { variant: 'warning' }); }
}

function createPeer() {
  const pc = new RTCPeerConnection({ iceServers: rt.iceServers });
  active.pc = pc;
  active.local.getTracks().forEach((t) => pc.addTrack(t, active.local));
  const remote = new MediaStream();
  pc.addEventListener('track', (e) => { remote.addTrack(e.track); attachRemote(remote); });
  pc.addEventListener('icecandidate', (e) => {
    if (e.candidate) rt.post('rtc.ice', { call_id: active.call.id, candidate: e.candidate.toJSON() });
  });
  pc.addEventListener('connectionstatechange', async () => {
    if (!active) return;
    if (pc.connectionState === 'connected' && !active.startedAt) {
      active.startedAt = Date.now();
      active.timer = setInterval(tickTimer, 1000);
      reportCandidateType(pc);
    }
    if (pc.connectionState === 'failed') {
      setStatus('Connection failed');
      rt.post('call.end', { call_id: active.call.id, reason: 'ice_failed' });
      cleanup('Call failed: the network blocked the connection.');
    }
    if (pc.connectionState === 'disconnected') setStatus('Reconnecting…');
  });
  return pc;
}

async function reportCandidateType(pc) {
  try {
    const stats = await pc.getStats();
    let pairId = null;
    stats.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId; });
    let localId = null;
    stats.forEach((s) => { if (s.type === 'candidate-pair' && (s.id === pairId || (!pairId && s.nominated && s.state === 'succeeded'))) localId = s.localCandidateId; });
    stats.forEach((s) => { if (s.id === localId) rt.post('call.stats', { call_id: active.call.id, ice_candidate_type: s.candidateType }); });
  } catch { /* optional */ }
}

async function flushIce() {
  for (const c of active.pendingIce.splice(0)) await active.pc.addIceCandidate(c).catch(() => {});
}

// ------------------------------------------------------------------ outgoing
export async function startCall(conversationId, callType = 'video', { title = 'Calling…', issueId = null } = {}) {
  if (active) { toast('You are already on a call', { variant: 'warning' }); return; }
  const video = callType === 'video';
  active = { role: 'caller', pendingIce: [], remoteSet: false, facing: 'environment', call: { id: null } };
  render({ title, subtitle: 'Starting camera…', state: 'is-outgoing', video });
  try {
    active.local = await getMedia(video);
    attachLocal();
    setStatus('Ringing…');
    startRing(false);
    const res = await rt.request('call.invite', { conversation_id: conversationId, call_type: callType, ...(issueId ? { issue_id: issueId } : {}) });
    active.call = res.call;
    if (!res.callee_online) setStatus('Ringing… (they may be offline; they will get a missed-call alert)');
  } catch (err) {
    cleanup(err.message || 'Could not start the call');
  }
}

// ------------------------------------------------------------------ incoming
async function accept() {
  stopRing();
  const video = active.call.call_type === 'video';
  render({ title: active.title, subtitle: 'Connecting…', state: 'is-connecting', video });
  try {
    active.local = await getMedia(video, 'user');
    attachLocal();
    createPeer();
    await rt.request('call.accept', { call_id: active.call.id });
  } catch (err) {
    rt.post('call.reject', { call_id: active.call.id, reason: 'media_error' });
    cleanup(err.name === 'NotAllowedError' ? 'Allow camera and microphone to take calls.' : (err.message || 'Could not answer'));
  }
}

function cleanup(message) {
  stopRing();
  if (active) {
    clearInterval(active.timer);
    active.local?.getTracks().forEach((t) => t.stop());
    active.pc?.close();
  }
  active = null;
  root().innerHTML = '';
  if (message) toast(message);
}

// ------------------------------------------------------------------ signalling handlers
export function setupCalls() {
  rt.on('call.incoming', (msg) => {
    if (active) { rt.post('call.reject', { call_id: msg.call.id, reason: 'busy' }); return; }
    active = { role: 'callee', call: msg.call, title: msg.caller_name, pendingIce: [], remoteSet: false, facing: 'user' };
    const video = msg.call.call_type === 'video';
    render({ title: msg.caller_name, subtitle: `Incoming ${video ? 'video' : 'voice'} call${msg.call.issue_id ? ' about a repair' : ''}`, state: 'is-incoming', video, incoming: true });
    startRing(true);
    if (document.visibilityState !== 'visible' && 'Notification' in window && Notification.permission === 'granted') {
      navigator.serviceWorker?.ready.then((reg) => reg.showNotification(`${msg.caller_name} is calling`, {
        body: 'Tap to answer in Kodi', tag: `call-${msg.call.id}`, icon: '/icons/icon-192.png', requireInteraction: true, data: { url: '/#/chat' } }));
    }
  });

  rt.on('call.accepted', async (msg) => {
    if (!active || active.call.id !== msg.call.id || active.role !== 'caller') return;
    stopRing();
    setStatus('Connecting…');
    root().querySelector('.kodi-call')?.classList.replace('is-outgoing', 'is-connecting');
    const pc = createPeer();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    rt.post('rtc.offer', { call_id: active.call.id, sdp: pc.localDescription.toJSON() });
  });

  rt.on('rtc.offer', async (msg) => {
    if (!active || active.call.id !== msg.call_id || !active.pc) return;
    await active.pc.setRemoteDescription(msg.sdp);
    active.remoteSet = true;
    await flushIce();
    const answer = await active.pc.createAnswer();
    await active.pc.setLocalDescription(answer);
    rt.post('rtc.answer', { call_id: active.call.id, sdp: active.pc.localDescription.toJSON() });
  });

  rt.on('rtc.answer', async (msg) => {
    if (!active || active.call.id !== msg.call_id || !active.pc) return;
    await active.pc.setRemoteDescription(msg.sdp);
    active.remoteSet = true;
    await flushIce();
  });

  rt.on('rtc.ice', async (msg) => {
    if (!active || active.call.id !== msg.call_id || !msg.candidate) return;
    if (active.pc && active.remoteSet) await active.pc.addIceCandidate(msg.candidate).catch(() => {});
    else active.pendingIce.push(msg.candidate);
  });

  const ended = (text) => (msg) => {
    if (!active || active.call.id !== msg.call.id) return;
    const reason = msg.call.end_reason;
    cleanup(reason === 'no_answer' || msg.call.status === 'missed' ? 'No answer' : text);
  };
  rt.on('call.rejected', ended('Call declined'));
  rt.on('call.ended', ended('Call ended'));
  rt.on('status', ({ connected }) => { if (!connected && active) cleanup('Call dropped: connection lost'); });
  window.addEventListener('pagehide', () => { if (active?.call?.id) rt.post('call.end', { call_id: active.call.id }); });
}

export const inCall = () => Boolean(active);
