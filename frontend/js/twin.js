// "Digital twin": a property drawn as a real 3D building (CSS 3D, no WebGL).
// Every unit is a block on its floor, coloured by state; occupied homes have
// lit windows and units in arrears glow red. Drag to orbit, buttons or wheel
// to zoom, tap a block to open the unit. Blocks are ordinary links, so the
// building is keyboard- and screen-reader-navigable too.
import { icon, label } from './components.js';
import { esc, fmtMoney } from './ui.js';

const W = 54; const D = 44; const H = 38; const G = 6;
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function layout(units) {
  const floors = new Map();
  for (const u of units) {
    const f = Number.isFinite(Number(u.floor_number)) && u.floor_number !== null ? Number(u.floor_number) : 0;
    if (!floors.has(f)) floors.set(f, []);
    floors.get(f).push(u);
  }
  const levels = [...floors.keys()].sort((a, b) => a - b);
  const widest = Math.max(...[...floors.values()].map((l) => l.length));
  const cols = Math.max(1, Math.min(widest, Math.ceil(Math.sqrt(widest * 2.2))));
  const rows = Math.ceil(widest / cols);
  const placed = [];
  levels.forEach((level, li) => {
    floors.get(level).forEach((u, i) => {
      const col = i % cols; const row = Math.floor(i / cols);
      placed.push({
        u, level, li,
        x: (col - (cols - 1) / 2) * (W + G),
        y: -li * (H + G),
        z: ((rows - 1) / 2 - row) * (D + G),
      });
    });
  });
  return { placed, levels, cols, rows };
}

const floorName = (n) => (n === 0 ? 'Ground floor' : n < 0 ? `Basement ${-n}` : `Floor ${n}`);

function block(p) {
  const { u } = p;
  const arrears = u.tenant_name && u.financial_state === 'in_arrears';
  const name = `Unit ${u.unit_number}, ${floorName(p.level)}, ${label(u.status)}${u.tenant_name ? `, ${u.tenant_name}` : ''}${arrears ? `, ${fmtMoney(u.outstanding_balance)} in arrears` : ''}`;
  return `<a class="tw-unit tw-${esc(u.status)}${arrears ? ' tw-arrears' : ''}" href="#/units/${esc(u.id)}" data-unit="${esc(u.id)}"
      style="transform:translate3d(${p.x}px,${p.y}px,${p.z}px)" aria-label="${esc(name)}">
    <i class="tw-f tw-front"><b class="tw-win"></b><b class="tw-win"></b><span>${esc(u.unit_number)}</span></i>
    <i class="tw-f tw-back"><b class="tw-win"></b><b class="tw-win"></b></i>
    <i class="tw-f tw-side tw-left"><b class="tw-win"></b></i><i class="tw-f tw-side tw-right"><b class="tw-win"></b></i>
    <i class="tw-f tw-top"></i>
  </a>`;
}

const LEGEND = [['occupied', 'Occupied'], ['vacant', 'Vacant'], ['reserved', 'Reserved'], ['under_maintenance', 'Repairs'], ['cleaning', 'Cleaning'], ['inactive', 'Inactive']];

/** HTML for the twin; call wireTwin(el, units) after it is in the DOM. */
export function twinHtml(units) {
  if (!units.length) return '';
  const { placed, levels, cols, rows } = layout(units);
  const groundW = cols * (W + G) + 70; const groundD = rows * (D + G) + 70;
  const counts = Object.fromEntries(LEGEND.map(([s]) => [s, units.filter((u) => u.status === s).length]));
  const arrears = units.filter((u) => u.tenant_name && u.financial_state === 'in_arrears').length;
  return `<section class="kodi-twin" aria-label="3D model of the building: ${units.length} units on ${levels.length} floor${levels.length === 1 ? '' : 's'}">
    <div class="tw-stage" data-stage>
      <div class="tw-world" data-world style="--tw-h:${levels.length * (H + G)}px">
        <i class="tw-ground" style="width:${groundW}px;height:${groundD}px;margin:${-groundD / 2}px 0 0 ${-groundW / 2}px"></i>
        ${placed.map(block).join('')}
      </div>
      <div class="tw-tip" data-tip hidden></div>
      <div class="tw-controls">
        <button type="button" class="kodi-round" data-tw="left" aria-label="Turn left">${icon('back', 18)}</button>
        <button type="button" class="kodi-round" data-tw="in" aria-label="Zoom in">${icon('plus', 18)}</button>
        <button type="button" class="kodi-round" data-tw="out" aria-label="Zoom out"><svg class="kodi-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg></button>
        <button type="button" class="kodi-round" data-tw="right" aria-label="Turn right">${icon('back', 18, 'flip-x')}</button>
      </div>
      <p class="tw-hint" aria-hidden="true">${icon('swap', 14)} Drag to turn · tap a unit to open it</p>
    </div>
    <ul class="tw-legend">${LEGEND.filter(([s]) => counts[s]).map(([s, t]) => `<li><i class="tw-sw tw-${s}"></i>${t} <b>${counts[s]}</b></li>`).join('')}
      ${arrears ? `<li><i class="tw-sw tw-sw-arrears"></i>In arrears <b>${arrears}</b></li>` : ''}
      <li class="tw-lit"><i class="tw-sw tw-sw-lit"></i>Lit windows: someone lives here</li></ul>
  </section>`;
}

export function wireTwin(root, units) {
  const stage = root.querySelector('[data-stage]');
  if (!stage) return () => {};
  const world = stage.querySelector('[data-world]');
  const tip = stage.querySelector('[data-tip]');
  const byId = new Map(units.map((u) => [u.id, u]));
  const levels = Number.parseFloat(getComputedStyle(world).getPropertyValue('--tw-h')) || 100;
  const { cols, rows } = layout(units);
  const fit = () => {
    const w = cols * (W + G) * 1.25 + rows * (D + G) * 0.6;
    const h = levels + rows * (D + G) * 0.5 + 60;
    return Math.max(0.35, Math.min(2.1, (stage.clientWidth * 0.7) / w, (stage.clientHeight * 0.62) / h));
  };
  const view = { rx: -24, ry: -34, zoom: fit() };
  let auto = !reduced();
  let raf = 0;
  const paint = () => {
    world.style.transform = `translateY(${levels / 2 - 10}px) scale(${view.zoom}) rotateX(${view.rx}deg) rotateY(${view.ry}deg)`;
  };
  const loop = () => {
    if (!stage.isConnected) return;
    if (auto && !document.hidden) { view.ry += 0.12; paint(); }
    raf = requestAnimationFrame(loop);
  };
  paint();
  raf = requestAnimationFrame(loop);

  // Drag to orbit (horizontal drags; vertical page scrolling still works on touch).
  let drag = null;
  let moved = false;
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.tw-controls')) return;
    drag = { x: e.clientX, y: e.clientY, rx: view.rx, ry: view.ry, id: e.pointerId };
    moved = false;
  });
  stage.addEventListener('pointermove', (e) => {
    if (drag && e.pointerId === drag.id) {
      const dx = e.clientX - drag.x; const dy = e.clientY - drag.y;
      if (!moved && Math.hypot(dx, dy) > 6) { moved = true; auto = false; stage.classList.add('is-dragging'); try { stage.setPointerCapture(e.pointerId); } catch { /* */ } }
      if (moved) {
        view.ry = drag.ry + dx * 0.45;
        view.rx = Math.max(-70, Math.min(-6, drag.rx - dy * 0.3));
        paint();
      }
      return;
    }
    const a = e.target.closest('[data-unit]');
    if (a && e.pointerType === 'mouse') showTip(a, e.clientX, e.clientY); else if (!a) tip.hidden = true;
  });
  const end = () => { drag = null; stage.classList.remove('is-dragging'); };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('pointerleave', () => { tip.hidden = true; });
  // A drag must not count as a tap on the unit under the finger.
  stage.addEventListener('click', (e) => { if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; } }, true);
  stage.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 40) return; // let the page scroll on gentle wheels
    e.preventDefault();
    view.zoom = Math.max(0.3, Math.min(2.2, view.zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
    auto = false; paint();
  }, { passive: false });
  stage.querySelector('.tw-controls').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tw]');
    if (!b) return;
    auto = false;
    stage.classList.add('is-easing');
    if (b.dataset.tw === 'left') view.ry -= 45;
    if (b.dataset.tw === 'right') view.ry += 45;
    if (b.dataset.tw === 'in') view.zoom = Math.min(2.2, view.zoom * 1.2);
    if (b.dataset.tw === 'out') view.zoom = Math.max(0.3, view.zoom / 1.2);
    paint();
    setTimeout(() => stage.classList.remove('is-easing'), 500);
  });

  function showTip(a, x, y) {
    const u = byId.get(a.dataset.unit);
    if (!u) return;
    const r = stage.getBoundingClientRect();
    tip.innerHTML = `<strong>Unit ${esc(u.unit_number)}</strong> <span class="kodi-badge kodi-badge-secondary">${esc(label(u.status))}</span>
      <span class="d-block">${esc(label(u.unit_type))} · ${esc(fmtMoney(u.monthly_rent))}/mo</span>
      ${u.tenant_name ? `<span class="d-block">${icon('users', 13)} ${esc(u.tenant_name)}</span>` : ''}
      ${u.tenant_name && u.financial_state === 'in_arrears' ? `<span class="d-block text-danger fw-semibold">${esc(fmtMoney(u.outstanding_balance))} in arrears</span>` : ''}`;
    tip.hidden = false;
    tip.style.left = `${Math.min(Math.max(x - r.left + 14, 8), r.width - 200)}px`;
    tip.style.top = `${Math.max(y - r.top - 10, 8)}px`;
  }
  // Keyboard: focusing a unit stops the spin and shows its card.
  stage.addEventListener('focusin', (e) => {
    const a = e.target.closest('[data-unit]');
    if (!a) return;
    auto = false;
    const ar = a.getBoundingClientRect();
    showTip(a, ar.right, ar.top);
  });
  stage.addEventListener('focusout', () => { tip.hidden = true; });

  return () => cancelAnimationFrame(raf);
}

/** Dim units that do not match a status filter ('all' shows everything). */
export function filterTwin(root, status) {
  root.querySelectorAll('.tw-unit').forEach((a) => {
    a.classList.toggle('is-dim', status !== 'all' && !a.classList.contains(`tw-${status}`));
  });
}
