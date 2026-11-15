// Maps: Leaflet (vendored, same-origin, so the strict script CSP holds) on
// OpenStreetMap tiles. Leaflet is loaded only the first time a map is shown,
// so screens without a map never download it.
//
// Production note: tile.openstreetmap.org is a donated service with a fair-use
// policy. For real traffic point TILE_URL at a tile provider you have an
// account with (MapTiler, Stadia, Thunderforest...) and add it to img-src.
import { esc, fmtMoney } from './ui.js';

const LEAFLET = '/vendor/leaflet-1.9.4';
export const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
export const NAIROBI = [-1.2864, 36.8172];
export const KENYA_BOUNDS = [[-4.7, 33.9], [5.0, 41.9]];

let loading = null;

/** Resolves to the Leaflet namespace (window.L), loading CSS + JS once. */
export function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${LEAFLET}/leaflet.css`;
    document.head.append(css);
    const js = document.createElement('script');
    js.src = `${LEAFLET}/leaflet.js`;
    js.onload = () => resolve(window.L);
    js.onerror = () => { loading = null; js.remove(); reject(new Error('The map could not load. Check your connection.')); };
    document.head.append(js);
  });
  return loading;
}

/**
 * A Kodi-styled map in `el`. Options: center, zoom, interactive (default true).
 * Returns the Leaflet map; call map.remove() when the screen goes away.
 */
export async function createMap(el, { center = NAIROBI, zoom = 12, interactive = true } = {}) {
  const L = await loadLeaflet();
  const map = L.map(el, {
    center, zoom, zoomControl: interactive, attributionControl: true,
    scrollWheelZoom: interactive ? 'center' : false, dragging: interactive || !L.Browser.mobile,
    tap: false, keyboard: true, zoomSnap: 0.5,
  });
  L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION, crossOrigin: true }).addTo(map);
  map.attributionControl.setPrefix(false);
  el.classList.add('kodi-map');
  // The container is often laid out after the first frame (view transitions, modals).
  requestAnimationFrame(() => map.invalidateSize());
  return map;
}

/** Short price for a pin: 15,000 -> "15K", 1,250,000 -> "1.3M". */
export function shortPrice(n) {
  const v = Number(n);
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e5 ? 0 : 1).replace(/\.0$/, '')}K`;
  return String(Math.round(v));
}

/** Airbnb-style price pill marker. */
export function pricePin(L, v, { active = false } = {}) {
  return L.divIcon({
    className: 'kodi-pin-wrap',
    html: `<span class="kodi-pin${active ? ' is-active' : ''}">${v.count > 1 ? 'from ' : ''}Ksh ${esc(shortPrice(v.monthly_rent))}${
      v.count > 1 ? `<i class="kodi-pin-count">${esc(v.count)}</i>` : ''}</span>`,
    iconSize: null,
    iconAnchor: [0, 0],
  });
}

/** Round "home" marker for a single building (detail pages, property form). */
export function homePin(L) {
  return L.divIcon({
    className: 'kodi-pin-wrap',
    html: '<span class="kodi-home-pin"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 3 2 11h3v9h5v-6h4v6h5v-9h3z"/></svg></span>',
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });
}

export const pinLabel = (v) => `${fmtMoney(v.monthly_rent)} a month, ${v.area}`;
