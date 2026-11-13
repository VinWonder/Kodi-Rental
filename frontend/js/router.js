// Hash router: '#/properties/123?tab=units' -> handler({ id: '123' }, { tab: 'units' }).
const routes = [];
let notFound = null;
let current = { path: '', cleanup: null };

export function route(pattern, handler, options = {}) {
  const keys = [];
  const regex = new RegExp(`^${pattern.replace(/\/:([a-z_]+)/gi, (_, key) => { keys.push(key); return '/([^/]+)'; })}/?$`);
  routes.push({ pattern, regex, keys, handler, ...options });
}

export function fallback(handler) { notFound = handler; }

export function parseHash(hash = window.location.hash) {
  const raw = hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  return { path: path.startsWith('/') ? path : `/${path}`, query: Object.fromEntries(new URLSearchParams(query)) };
}

export function navigate(path, { replace = false } = {}) {
  const target = path.startsWith('#') ? path : `#${path}`;
  if (replace) window.history.replaceState(null, '', target);
  else window.location.hash = target;
  if (replace) resolve();
}

/** Update query params of the current route without adding history entries. */
export function setQuery(params) {
  const { path, query } = parseHash();
  const next = { ...query, ...params };
  Object.keys(next).forEach((k) => (next[k] === '' || next[k] == null) && delete next[k]);
  const q = new URLSearchParams(next).toString();
  window.history.replaceState(null, '', `#${path}${q ? `?${q}` : ''}`);
}

export function currentPath() { return parseHash().path; }

let guard = () => true;
let beforeRoute = () => {};
export function onBeforeRoute(fn) { beforeRoute = fn; }
export function setGuard(fn) { guard = fn; }

export async function resolve() {
  const { path, query } = parseHash();
  if (typeof current.cleanup === 'function') {
    try { current.cleanup(); } catch { /* ignore */ }
  }
  current = { path, cleanup: null };
  for (const r of routes) {
    const m = path.match(r.regex);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    if (!guard(r, path)) return;
    await beforeRoute(path);
    if (parseHash().path !== path) return; // the user moved on while the transition started
    const result = await r.handler(params, query);
    if (typeof result === 'function' && current.path === path) current.cleanup = result;
    return;
  }
  await beforeRoute(path);
  if (parseHash().path !== path) return;
  if (notFound) notFound(path);
}

export function startRouter() {
  window.addEventListener('hashchange', resolve);
  return resolve();
}
