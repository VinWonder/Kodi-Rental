// Natural-language house search, understood on the device (works offline):
//   "2 bedroom in Kilimani under 40k"   -> two_bedroom, max 40,000, q=kilimani
//   "bedsitter near TRM below ksh 9,000" -> bedsitter, max 9,000, q=trm
//   "cheap studio nairobi"               -> studio, county Nairobi
// Returns the filters it recognised plus the leftover words as a place query.

const TYPES = [
  [/\bbed\s?-?sitters?\b/, 'bedsitter', 'Bedsitter'],
  [/\bsingle\s?-?rooms?\b|\bsingles\b/, 'single_room', 'Single room'],
  [/\bstudios?\b/, 'studio', 'Studio'],
  [/\b(?:1|one)\s?-?(?:bed(?:room)?s?|br|bd)\b/, 'one_bedroom', '1 bedroom'],
  [/\b(?:2|two)\s?-?(?:bed(?:room)?s?|br|bd)\b/, 'two_bedroom', '2 bedrooms'],
  [/\b(?:3|three)\s?-?(?:bed(?:room)?s?|br|bd)\b/, 'three_bedroom', '3 bedrooms'],
  [/\b(?:[4-9]|four|five|six)\s?\+?\s?-?(?:bed(?:room)?s?|br|bd)\b/, 'four_plus_bedroom', '4+ bedrooms'],
  [/\bhostels?\b/, 'shared_hostel_room', 'Hostel'],
  [/\bshops?\b|\bstalls?\b/, 'shop', 'Shop'],
  [/\boffices?\b/, 'office', 'Office'],
];
const BUDGET = /\b(?:under|below|less than|max(?:imum)?|up to|within|at most|not more than|budget(?: of)?|<)\s*(?:ksh|kes|sh)?\.?\s*(\d[\d,.]*)\s*(k|thousand)?\b/;
const BARE_BUDGET = /\b(?:ksh|kes)\.?\s*(\d[\d,.]*)\s*(k)?\b|\b(\d+(?:\.\d+)?)\s*k\b/;
const STOP = new Set(('in at near around next to close by for a an the house houses home homes apartment apartments flat flats unit units to let rent '
  + 'rental cheap affordable find me i want looking need with per month monthly pm kes ksh please show some any that is am of on').split(' '));

const amount = (num, k) => {
  const n = Number(String(num).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(k ? n * 1000 : n);
};

export function parseSearch(text, counties = []) {
  let s = ` ${String(text || '').toLowerCase()} `;
  const out = { chips: [] };
  for (const [re, value, name] of TYPES) {
    if (re.test(s)) { out.unit_type = value; out.chips.push(name); s = s.replace(re, ' '); break; }
  }
  let m = s.match(BUDGET);
  if (m) { out.max_rent = amount(m[1], m[2]); s = s.replace(m[0], ' '); }
  else if ((m = s.match(BARE_BUDGET))) { out.max_rent = amount(m[1] || m[3], m[2] || (m[3] ? 'k' : '')); s = s.replace(m[0], ' '); }
  if (out.max_rent) out.chips.push(`Under Ksh ${out.max_rent.toLocaleString('en-KE')}`);
  const county = [...counties].sort((a, b) => b.name.length - a.name.length)
    .find((c) => new RegExp(`\\b${c.name.toLowerCase().replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`).test(s));
  if (county) { out.county_id = county.id; out.chips.push(county.name); s = s.replace(new RegExp(`\\b${county.name.toLowerCase()}\\b`), ' '); }
  const words = s.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));
  out.q = words.join(' ');
  if (out.q) out.chips.push(words.map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(' '));
  out.understood = Boolean(out.unit_type || out.max_rent || out.county_id);
  return out;
}
