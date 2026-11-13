// Delight layer: page transitions (View Transitions API), count-up numbers,
// confetti, haptics. Every effect is progressive: browsers without the API,
// and users who prefer reduced motion, get the plain instant behaviour.

import { fmtMoney } from './ui.js';

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------------ page transitions
let finishUpdate = null;

/**
 * Called by the router before a new screen renders. Captures the old screen,
 * then resolves so the new one can render; mountDone() completes the morph.
 * Same-screen re-renders (filters, live updates) never animate.
 */
export function beginPageTransition() {
  if (!document.startViewTransition || reduced() || document.hidden) return Promise.resolve();
  return new Promise((ready) => {
    try {
      document.startViewTransition(() => new Promise((done) => {
        finishUpdate = done;
        ready();
        // A screen that takes long before its first paint must not freeze the page.
        setTimeout(() => mountDone(), 400);
      }));
    } catch { ready(); }
  });
}

/** Called by mount(): the new screen is in the DOM. */
export function mountDone() {
  if (finishUpdate) { const f = finishUpdate; finishUpdate = null; f(); }
}

// ------------------------------------------------------------------ count-up numbers
/**
 * Elements with data-count="12345" animate from 0 to that value.
 * data-format="money" | "pct" | "int" chooses how the number is written.
 */
export function countUp(root = document) {
  const fmt = (el, v) => {
    const f = el.dataset.format;
    if (f === 'money') return fmtMoney(Math.round(v));
    if (f === 'pct') return `${Math.round(v)}%`;
    return String(Math.round(v));
  };
  root.querySelectorAll('[data-count]').forEach((el) => {
    const target = Number(el.dataset.count);
    if (!Number.isFinite(target) || el.dataset.counted) return;
    el.dataset.counted = '1';
    const final = el.textContent;
    if (reduced() || target === 0) return;
    const start = performance.now();
    const dur = Math.min(1400, 600 + Math.log10(Math.abs(target) + 1) * 160);
    const step = (now) => {
      if (!el.isConnected) return;
      const t = Math.min((now - start) / dur, 1);
      const eased = 1 - (1 - t) ** 4;
      el.textContent = t < 1 ? fmt(el, target * eased) : final;
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

// ------------------------------------------------------------------ haptics
export function haptic(pattern = 12) {
  try { if (navigator.vibrate && !reduced()) navigator.vibrate(pattern); } catch { /* unsupported */ }
}

// ------------------------------------------------------------------ confetti
/** A short burst of emerald, gold and white confetti (canvas, ~1.6 s). */
export function confetti({ x = 0.5, y = 0.35, count = 140 } = {}) {
  if (reduced()) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'kodi-confetti';
  canvas.setAttribute('aria-hidden', 'true');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const colors = ['#0f6b57', '#2fae8c', '#e0a43a', '#f3c879', '#ffffff', '#e2725b'];
  const parts = Array.from({ length: count }, () => {
    const a = Math.random() * Math.PI * 2;
    const s = 4 + Math.random() * 9;
    return {
      x: innerWidth * x, y: innerHeight * y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 6,
      w: 5 + Math.random() * 6, h: 8 + Math.random() * 8, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4,
      c: colors[(Math.random() * colors.length) | 0], shape: Math.random() > 0.7 ? 'circle' : 'rect',
    };
  });
  const start = performance.now();
  const frame = (now) => {
    const t = now - start;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.32; p.vx *= 0.985; p.vy *= 0.985; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - t / 1700);
      ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
      if (p.shape === 'circle') { ctx.beginPath(); ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2); ctx.fill(); }
      else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)) + 2);
      ctx.restore();
    }
    if (t < 1700) requestAnimationFrame(frame); else canvas.remove();
  };
  requestAnimationFrame(frame);
}

/** Payment success: confetti + a "ka-ching" vibration. */
export function celebrate() {
  confetti();
  haptic([18, 60, 28]);
}

// ------------------------------------------------------------------ time of day
/** 'dawn' | 'day' | 'dusk' | 'night' for the device's local time. */
export function daypart(date = new Date()) {
  const h = date.getHours();
  if (h >= 5 && h < 8) return 'dawn';
  if (h >= 8 && h < 17) return 'day';
  if (h >= 17 && h < 19) return 'dusk';
  return 'night';
}
