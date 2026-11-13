// 3D motion: cards marked [data-tilt] lean towards the pointer in real 3D
// perspective with a moving light glare. [data-tilt="8"] sets the maximum
// angle in degrees (default 6). One delegated listener serves every screen.
// Mouse/trackpad only (touch scrolling must never fight a tilt), and off when
// the user prefers reduced motion. Touch devices get CSS press-depth instead.

const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function reset(el) {
  el.classList.remove('is-tilting');
  el.style.removeProperty('--rx');
  el.style.removeProperty('--ry');
}

export function setupTilt() {
  let current = null;
  let frame = 0;
  let last = null;

  const paint = () => {
    frame = 0;
    if (!current || !last) return;
    const r = current.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const x = Math.min(Math.max((last.clientX - r.left) / r.width, 0), 1);
    const y = Math.min(Math.max((last.clientY - r.top) / r.height, 0), 1);
    const max = Number(current.dataset.tilt) || 6;
    current.style.setProperty('--rx', `${((0.5 - y) * max * 2).toFixed(2)}deg`);
    current.style.setProperty('--ry', `${((x - 0.5) * max * 2).toFixed(2)}deg`);
    current.style.setProperty('--gx', `${(x * 100).toFixed(1)}%`);
    current.style.setProperty('--gy', `${(y * 100).toFixed(1)}%`);
    current.classList.add('is-tilting');
  };

  document.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'mouse' || !finePointer.matches || reducedMotion.matches) return;
    const target = event.target instanceof Element ? event.target.closest('[data-tilt]') : null;
    if (current && current !== target) reset(current);
    current = target;
    last = event;
    if (target && !frame) frame = requestAnimationFrame(paint);
  }, { passive: true });

  document.documentElement.addEventListener('mouseleave', () => { if (current) reset(current); current = null; });
  // A tilted card that is replaced by a re-render must not stay "current".
  window.addEventListener('hashchange', () => { current = null; });
}
