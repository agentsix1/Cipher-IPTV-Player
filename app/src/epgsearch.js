'use strict';

/**
 * Ranks XMLTV channels against a search text (usually a playlist channel name like "US: ESPN 2 HD"),
 * ignoring decorations such as quality and country tags.
 */
const NOISE = new Set(['hd', 'fhd', 'uhd', 'sd', '4k', '8k', 'hevc', 'h265', 'raw', 'tv', 'us', 'usa', 'uk', 'ca', 'backup', 'vip', 'the']);
const DEFAULT_LIMIT = 60;

function tokens(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t && !NOISE.has(t));
}

function score(entry, query, compact) {
  const own = new Set([...tokens(entry.name), ...tokens(entry.id)]);
  if (!own.size) return 0;
  let matched = 0;
  for (const t of query) {
    if (own.has(t)) matched += 1;
    else if (t.length >= 3 && [...own].some((o) => o.startsWith(t))) matched += 0.6;
  }
  const ownCompact = tokens(entry.name).join('');
  const idCompact = tokens(entry.id).join('');
  let s = 0;
  if (matched) s = (matched / query.length) * 100 - Math.max(0, own.size - matched) * 4;
  if (compact && (ownCompact === compact || idCompact === compact)) s += 60;
  else if (compact.length >= 3 && (ownCompact.includes(compact) || idCompact.includes(compact))) s += 25;
  return s;
}

/**
 * entries: [{ key, id, name, icon, source }]; hasData(key) tells whether programmes are loaded.
 * With a search text: best matches first (weak partial matches dropped once good ones exist).
 * Without one: every entry by name, for browsing a source. Returns { results, total }.
 */
function searchEpg(entries, text, hasData, { offset = 0, limit = DEFAULT_LIMIT } = {}) {
  const query = tokens(text);
  let ranked;
  if (!query.length) {
    ranked = [...entries].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  } else {
    const compact = query.join('');
    const scored = [];
    for (const entry of entries) {
      const s = score(entry, query, compact);
      if (s > 0) scored.push({ entry, s: s + (hasData(entry.key) ? 5 : 0) });
    }
    scored.sort((a, b) => b.s - a.s || a.entry.name.localeCompare(b.entry.name));
    const floor = scored.length ? scored[0].s * 0.4 : 0;
    ranked = scored.filter((x) => x.s >= floor).map((x) => x.entry);
  }
  const results = ranked.slice(offset, offset + limit).map((entry) => ({ ...entry, hasData: hasData(entry.key) }));
  return { results, total: ranked.length };
}

module.exports = { searchEpg, tokens };
