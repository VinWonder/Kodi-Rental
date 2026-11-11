// WebSocket client for /ws: authenticates with the access token, reconnects
// with backoff, correlates replies by `ref`, and re-emits every frame as a DOM
// event ('chat.message', 'call.incoming', 'event:invoice_status_changed', ...).
import { CONFIG } from './config.js';
import { freshToken, session } from './api.js';

class Realtime extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.ready = false;
    this.iceServers = [];
    this.userId = null;
    this.pending = new Map();
    this.refSeq = 0;
    this.backoff = 1000;
    this.stopped = true;
    this.queue = [];
    this.heartbeat = null;
  }

  url() {
    const base = CONFIG.apiBase || window.location.origin;
    return `${base.replace(/^http/, 'ws')}/ws`;
  }

  async start() {
    this.stopped = false;
    if (this.ws && this.ws.readyState <= 1) return;
    if (!session.isSignedIn) return;
    let token;
    try { token = await freshToken(); } catch { this.scheduleReconnect(); return; }
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.addEventListener('message', (e) => this.onFrame(e.data));
    ws.addEventListener('close', (e) => {
      this.ready = false;
      clearInterval(this.heartbeat);
      this.emit('status', { connected: false });
      for (const [, p] of this.pending) p.reject(new Error('Connection lost'));
      this.pending.clear();
      if (this.ws === ws) this.ws = null;
      if (!this.stopped) this.scheduleReconnect(e.code === 4401 ? 2000 : undefined);
    });
  }

  stop() {
    this.stopped = true;
    clearInterval(this.heartbeat);
    if (this.ws) this.ws.close(1000, 'bye');
    this.ws = null;
    this.ready = false;
  }

  scheduleReconnect(delay) {
    if (this.stopped) return;
    const wait = delay ?? this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30000);
    setTimeout(() => { if (!this.stopped && navigator.onLine) this.start(); }, wait);
  }

  onFrame(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.type === 'ready') {
      this.ready = true;
      this.backoff = 1000;
      this.iceServers = msg.ice_servers || [];
      this.userId = msg.user_id;
      this.emit('status', { connected: true });
      this.queue.splice(0).forEach((f) => this.ws.send(f));
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.ws?.readyState === 1 && this.ws.send('{"type":"ping"}'), 25000);
    }
    if (msg.ref && this.pending.has(msg.ref)) {
      const p = this.pending.get(msg.ref);
      this.pending.delete(msg.ref);
      if (msg.type === 'error') {
        const detail = Array.isArray(msg.detail) ? msg.detail.map((d) => d.msg).join('; ') : msg.detail;
        p.reject(Object.assign(new Error(detail || 'Request failed'), { status: msg.status }));
      } else p.resolve(msg);
    }
    this.emit(msg.type, msg);
    if (msg.type === 'event') this.emit(`event:${msg.event}`, msg.data);
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  on(type, fn) {
    const handler = (e) => fn(e.detail);
    this.addEventListener(type, handler);
    return () => this.removeEventListener(type, handler);
  }

  /** Fire-and-forget frame (queued until the socket is authenticated). */
  post(type, payload = {}) {
    const frame = JSON.stringify({ type, ...payload });
    if (this.ready && this.ws?.readyState === 1) this.ws.send(frame);
    else this.queue.push(frame);
  }

  /** Send a frame and wait for the reply that echoes its ref. */
  request(type, payload = {}, timeoutMs = 15000) {
    const ref = `r${Date.now().toString(36)}${(this.refSeq += 1)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(ref); reject(new Error('No response from server')); }, timeoutMs);
      this.pending.set(ref, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.post(type, { ...payload, ref });
    });
  }
}

export const rt = new Realtime();
window.addEventListener('online', () => rt.start());
