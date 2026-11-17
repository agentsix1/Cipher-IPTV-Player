import { get, post } from '../api.js';
import { h, esc, toast, debounce, fmtTime, fmtRange, dayLabel, prefs, store } from '../util.js';
import { navigate } from '../app.js';
import { focusEl, moveFocus, isTextInput, keyAction, topModal } from '../nav.js';
import { openMenu } from '../menu.js';
import { topbar } from './common.js';
import { channelMenu } from './channelmanage.js';
import { channelLogoEl, defaultLogoUrl } from '../chlogo.js';

/**
 * Search: channels, groups, guide programmes, and on-demand movies and TV shows.
 * searches, recent searches, recently watched channels and favorites on the start screen.
 */

const enc = encodeURIComponent;
const RECENT_KEY = 'search.recent';
const RECENT_MAX = 12;
const LONG_PRESS_MS = 600;
const PREVIEW_COUNTS = { channels: 8, shows: 12, groups: 6, movies: 8, series: 8 };

const TYPES = [
  { id: 'all', label: 'All' },
  { id: 'channels', label: 'Channels' },
  { id: 'shows', label: 'Guide' },
  { id: 'movies', label: 'Movies' },
  { id: 'series', label: 'TV Shows' },
  { id: 'groups', label: 'Groups' },
];
const WHENS = [
  { id: 'all', label: 'Any time' },
  { id: 'now', label: 'On now' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'past', label: 'Catch-up' },
];
const TYPE_LABEL = { mag: 'MAG', xtream: 'Xtream', m3u: 'M3U' };

function scopeOptions(view) {
  const list = (view && view.playlists) || [];
  if (list.length < 2) return [];
  const types = new Set(list.map((p) => p.type));
  const out = [{ id: 'all', label: 'All playlists' }];
  for (const t of ['mag', 'xtream', 'm3u']) {
    if (types.has(t)) out.push({ id: `type:${t}`, label: TYPE_LABEL[t] });
  }
  for (const p of list) out.push({ id: p.id, label: p.name });
  return out;
}

const QUICK = [
  { label: 'Sports', icon: '🏈', q: 'sports sport nfl nba mlb nhl ncaa soccer football basketball baseball hockey ufc boxing wwe golf tennis racing nascar espn' },
  { label: 'News', icon: '📰', q: 'news cnn msnbc cnbc bloomberg headline headlines' },
  { label: 'Movies', icon: '🎬', q: 'movie movies film films cinema hbo showtime starz cinemax' },
  { label: 'Kids', icon: '🧸', q: 'kids kid cartoon cartoons disney nick nickelodeon junior boomerang animation' },
  { label: 'Music', icon: '🎵', q: 'music mtv vh1 concert hits' },
  { label: 'Documentary', icon: '🌍', q: 'documentary documentaries discovery history geographic science nature' },
  { label: 'Comedy', icon: '😂', q: 'comedy sitcom standup' },
  { label: 'Weather', icon: '⛅', q: 'weather forecast' },
];

const recentSearches = () => prefs.get(RECENT_KEY, []);
function rememberSearch(entry) {
  if (!entry.q.trim()) return;
  const key = `${entry.label || entry.q}`.toLowerCase();
  const list = recentSearches().filter((x) => `${x.label || x.q}`.toLowerCase() !== key);
  list.unshift({ q: entry.q, label: entry.label || '', any: !!entry.any });
  prefs.set(RECENT_KEY, list.slice(0, RECENT_MAX));
}

/** Escaped HTML with the query words marked where they start a word. */
function highlight(text, words) {
  const raw = String(text || '');
  if (!words.length) return esc(raw);
  const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|');
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${pattern})`, 'giu');
  let out = '';
  let last = 0;
  for (const m of raw.matchAll(re)) {
    const at = m.index + m[1].length;
    out += esc(raw.slice(last, at)) + `<mark>${esc(m[2])}</mark>`;
    last = at + m[2].length;
  }
  return out + esc(raw.slice(last));
}

const queryWords = (q) => String(q || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter(Boolean);

function whenLabel(p, now = Date.now()) {
  if (p.start <= now && p.end > now) return `Live · until ${fmtTime(p.end)}`;
  return `${dayLabel(p.start)} · ${fmtRange(p.start, p.end)}`;
}

function progress(p, now = Date.now()) {
  if (!p || p.start > now || p.end <= now) return null;
  const frac = Math.max(0, Math.min(1, (now - p.start) / (p.end - p.start)));
  return h('div.s-progress', {}, h('div', { style: `width:${(frac * 100).toFixed(1)}%` }));
}

const logoEl = (src, name = '') => {
  if (!src) {
    const img = document.createElement('img');
    img.className = 'logo ch-logo';
    img.alt = '';
    img.src = defaultLogoUrl(name);
    return img;
  }
  return channelLogoEl({ logo: src, name });
};

export async function mount(root, params) {
  const saved = store.get('search.state', {});
  const state = {
    q: params.q !== undefined ? params.q : saved.q || '',
    label: params.q !== undefined ? '' : saved.label || '',
    any: params.q !== undefined ? false : !!saved.any,
    type: saved.type || 'all',
    when: saved.when || 'all',
    desc: !!saved.desc,
    scope: saved.scope || 'all',
    result: null,
    focusKey: params.q !== undefined ? null : saved.focusKey || null,
  };
  let req = 0;
  let destroyed = false;
  let press = null;
  let view = { playlists: [] };

  const input = h('input.s-input.focusable', {
    type: 'search',
    value: state.label || state.q,
    placeholder: 'Search channels, movies, TV shows and groups',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
    maxlength: '120',
  });
  const clearBtn = h('button.s-clear.focusable', { type: 'button', title: 'Clear', text: '✕' });
  const form = h('form.s-form', {}, h('span.s-icon', { text: '🔍' }), input, clearBtn);
  const typeChips = h('div.chips.s-types');
  const scopeChips = h('div.chips.s-scopes');
  const whenChips = h('div.chips.s-whens');
  const filters = h('div.s-filters', {}, scopeChips, typeChips, whenChips);
  const statusEl = h('div.s-status');
  const body = h('div.s-body');
  const scroll = h('div.scroll.s-scroll', {}, body);
  root.append(topbar('Search'), h('div.s-head', {}, form, filters, statusEl), scroll);

  function persist() {
    const active = document.activeElement;
    const item = active && active.closest && active.closest('[data-key]');
    store.set('search.state', {
      q: state.q, label: state.label, any: state.any, type: state.type, when: state.when, desc: state.desc, scope: state.scope,
      focusKey: item && body.contains(item) ? item.dataset.key : null,
    });
  }

  // ---------------- filters ----------------
  function chip(label, active, onClick, count) {
    const b = h('button.chip.focusable', { type: 'button' },
      h('span', { text: label }),
      count !== undefined && count !== null ? h('span.chip-count', { text: count.toLocaleString() }) : null);
    b.classList.toggle('active', !!active);
    b.addEventListener('click', onClick);
    return b;
  }

  function renderFilters() {
    const counts = state.result ? state.result.counts : null;
    const total = counts
      ? counts.channels + counts.shows + counts.groups + (counts.movies || 0) + (counts.series || 0)
      : null;
    typeChips.innerHTML = '';
    for (const t of TYPES) {
      const count = !counts ? null : t.id === 'all' ? total : counts[t.id];
      typeChips.append(chip(t.label, state.type === t.id, () => setType(t.id), state.q ? count : null));
    }
    typeChips.append(chip('Descriptions', state.desc, () => {
      state.desc = !state.desc;
      refresh({ keepFocus: true });
    }));
    whenChips.innerHTML = '';
    const showsVisible = state.type === 'all' || state.type === 'shows';
    whenChips.style.display = showsVisible ? '' : 'none';
    for (const w of WHENS) whenChips.append(chip(w.label, state.when === w.id, () => setWhen(w.id)));
    scopeChips.innerHTML = '';
    const scopes = scopeOptions(view);
    scopeChips.style.display = scopes.length ? '' : 'none';
    for (const s of scopes) {
      scopeChips.append(chip(s.label, state.scope === s.id, () => setScope(s.id)));
    }
  }

  function setType(type) {
    if (state.type === type) return;
    state.type = type;
    renderFilters();
    if (state.result) render({ keepFocus: true });
    persist();
  }

  function setWhen(when) {
    if (state.when === when) return;
    state.when = when;
    refresh({ keepFocus: true });
  }

  function setScope(scope) {
    if (state.scope === scope) return;
    state.scope = scope;
    suggest = null;
    refresh({ keepFocus: true });
  }

  // ---------------- actions ----------------
  async function useSourcePlaylist(ch) {
    const id = ch && ch.playlistId;
    if (!id) return;
    try {
      await post('/playlist-view', { id });
    } catch { /* stay on the current playlist if switching is not allowed */ }
  }

  const watch = (id, ch) => {
    commitSearch();
    persist();
    const go = () => navigate(`player?ch=${enc((ch && ch.srcId) || id)}`);
    if (ch && ch.playlistId) useSourcePlaylist(ch).then(go, go);
    else go();
  };
  const watchFrom = (id, start, end, ch) => {
    commitSearch();
    persist();
    const go = () => navigate(`player?ch=${enc((ch && ch.srcId) || id)}&start=${start}${end ? `&end=${end}` : ''}`);
    if (ch && ch.playlistId) useSourcePlaylist(ch).then(go, go);
    else go();
  };
  const openGuide = (ch, t) => {
    commitSearch();
    persist();
    const go = () => navigate(`guide?group=${enc(ch.groupId || '')}&name=${enc(ch.groupName || '')}&ch=${enc(ch.srcId || ch.id)}&t=${Math.round(t || Date.now())}&from=search`);
    if (ch.playlistId) useSourcePlaylist(ch).then(go, go);
    else go();
  };
  const openChannels = (groupId, name, chId, ch) => {
    commitSearch();
    persist();
    const go = () => navigate(`channels?group=${enc(groupId)}&name=${enc(name || '')}${chId ? `&ch=${enc(chId)}` : ''}&from=search`);
    if (ch && ch.playlistId) useSourcePlaylist(ch).then(go, go);
    else go();
  };
  const openVod = (item) => {
    commitSearch();
    persist();
    if (item.kind === 'series') navigate(`shows?show=${enc(item.id)}${item.playlistId ? `&playlist=${enc(item.playlistId)}` : ''}`);
    else navigate(`movies?id=${enc(item.id)}${item.playlistId ? `&playlist=${enc(item.playlistId)}` : ''}`);
  };

  function vodMenuItems(item) {
    return [
      { label: item.kind === 'series' ? 'Open TV show' : 'Open movie', onSelect: () => openVod(item) },
      { label: `Search "${item.name}"`, onSelect: () => runQuery({ q: item.name, type: item.kind }) },
    ];
  }
  async function toggleFav(ch, onDone) {
    try {
      const res = await post(`/favorites/${enc(ch.id)}`);
      ch.fav = res.fav;
      toast(res.fav ? `Added "${ch.name}" to favorites` : `Removed "${ch.name}" from favorites`);
      if (onDone) onDone();
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  function commitSearch() {
    if (state.q.trim()) rememberSearch({ q: state.q, label: state.label, any: state.any });
  }

  function channelQuickItems(ch) {
    return [
      { label: '▶ Watch live', onSelect: () => watch(ch.id, ch) },
      ch.now && ch.catchup && { label: '⟲ Watch from the start', hint: fmtTime(ch.now.start), onSelect: () => watchFrom(ch.id, ch.now.start, null, ch) },
      { label: 'View in TV Guide', onSelect: () => openGuide(ch) },
      ch.groupId && { label: 'Open group', hint: ch.groupName || '', onSelect: () => openChannels(ch.groupId, ch.groupName, ch.srcId || ch.id, ch) },
      { label: ch.fav ? '★ Remove from favorites' : '☆ Add to favorites', onSelect: () => toggleFav(ch, () => { suggest = null; rerenderSoon(); }) },
      ch.next && { label: `Next: ${ch.next.title}`, hint: fmtTime(ch.next.start), onSelect: () => openGuide(ch, ch.next.start) },
    ];
  }

  function openChannelContextMenu(ch, at) {
    return channelMenu(ch, at, {
      groupId: ch.groupId,
      onChanged: () => { suggest = null; rerenderSoon(); },
    }, channelQuickItems(ch));
  }

  function showMenuItems(p) {
    const ch = p.channel;
    const now = Date.now();
    const live = p.start <= now && p.end > now;
    return [
      p.catchup && { label: '⟲ Watch (catch-up)', onSelect: () => watchFrom(ch.id, p.start, p.end, ch) },
      live && { label: '▶ Watch live', onSelect: () => watch(ch.id, ch) },
      live && ch.catchup && { label: '⟲ Watch from the start', hint: fmtTime(p.start), onSelect: () => watchFrom(ch.id, p.start, null, ch) },
      !live && !p.past && { label: '▶ Watch the channel now', onSelect: () => watch(ch.id, ch) },
      { label: 'View in TV Guide', onSelect: () => openGuide(ch, p.start) },
      { label: `Search "${p.title}"`, onSelect: () => runQuery({ q: p.title, type: 'shows' }) },
      ch.groupId && { label: 'Open group', hint: ch.groupName || '', onSelect: () => openChannels(ch.groupId, ch.groupName, ch.srcId || ch.id, ch) },
      { separator: true },
      { label: ch.fav ? '★ Remove channel from favorites' : '☆ Add channel to favorites', onSelect: () => toggleFav(ch) },
    ];
  }

  function groupMenuItems(g) {
    return [
      { label: 'Open channels', onSelect: () => openChannels(g.id, g.name) },
      { label: 'Open in TV Guide', onSelect: () => openGroupGuide(g) },
    ];
  }

  function activateShow(p) {
    const now = Date.now();
    const ch = p.channel;
    if (p.catchup) watchFrom(ch.id, p.start, p.end, ch);
    else if (p.start <= now && p.end > now) watch(ch.id, ch);
    else if (p.start > now) openGuide(ch, p.start);
    else {
      toast('Catch-up is not available for this programme. Playing the channel live.');
      watch(ch.id, ch);
    }
  }

  // ---------------- items ----------------
  const handlers = new WeakMap(); // element -> { activate, menu }

  function item(key, cls, children, { activate, menu, channel = null }) {
    const el = h(`button.list-item.s-item.focusable${cls}`, { type: 'button', 'data-key': key }, ...children);
    handlers.set(el, { activate, menu, channel });
    el.addEventListener('click', () => {
      if (!press) activate();
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (topModal()) return;
      el.focus({ preventScroll: true });
      if (channel) openChannelContextMenu(channel, { x: e.clientX, y: e.clientY });
      else openMenu(menu(), { x: e.clientX, y: e.clientY });
    });
    return el;
  }

  function channelItem(ch, words, prefix = 'c') {
    const nowLine = ch.now ? `${ch.now.title}` : 'No guide information';
    return item(`${prefix}:${ch.id}`, '.s-channel', [
      logoEl(ch.logo, ch.name),
      h('span.meta.s-num', { text: String(ch.num) }),
      h('span.s-text', {},
        h('span.n', { html: highlight(ch.name, words) }),
        h('span.m', { text: [ch.renamed && words.length ? `was ${ch.originalName}` : '', ch.groupName, ch.playlistName].filter(Boolean).join(' · ') }),
        h('span.s-now', {}, ch.now ? h('span.live-dot') : null, h('span', { text: nowLine }), ch.now ? h('span.s-when', { text: ` · until ${fmtTime(ch.now.end)}` }) : null),
        progress(ch.now)),
      ch.catchup ? h('span.meta', { text: '⟲', title: 'Catch-up available' }) : null,
      ch.fav ? h('span.meta.s-fav', { text: '★' }) : null,
    ], { activate: () => watch(ch.id, ch), channel: ch });
  }

  function showItem(p, words, prefix = 's') {
    const now = Date.now();
    const live = p.start <= now && p.end > now;
    const badges = [];
    if (live) badges.push(h('span.badge.live', { text: 'Live' }));
    else if (p.catchup) badges.push(h('span.badge.cu', { text: 'Catch-up' }));
    else if (p.start > now && p.start - now < 60 * 60000) badges.push(h('span.badge.soon', { text: `In ${Math.max(1, Math.round((p.start - now) / 60000))} min` }));
    if (p.inDesc) badges.push(h('span.badge', { text: 'In description' }));
    if (p.alsoOn) badges.push(h('span.badge', { text: `+${p.alsoOn} channel${p.alsoOn === 1 ? '' : 's'}`, title: `Also on ${p.alsoOnNames.join(', ')}${p.alsoOn > p.alsoOnNames.length ? '…' : ''}` }));
    const el = item(`${prefix}:${p.channel.id}@${p.start}`, '.s-show', [
      logoEl(p.channel.logo, p.channel.name),
      h('span.s-text', {},
        h('span.n', { html: highlight(p.title, words) }),
        h('span.m', { text: `${whenLabel(p, now)} · ${p.channel.num} ${p.channel.name}${p.channel.playlistName ? ` · ${p.channel.playlistName}` : ''}` }),
        progress(p, now)),
      h('span.s-badges', {}, ...badges),
    ], { activate: () => activateShow(p), menu: () => showMenuItems(p) });
    if (p.past && !p.catchup) el.classList.add('is-past');
    return el;
  }

  function vodItem(row, words, prefix) {
    const kindLabel = row.kind === 'series' ? 'TV show' : 'Movie';
    const meta = [kindLabel, row.year, row.category, row.playlistName].filter(Boolean).join(' · ');
    const badges = [];
    if (row.inDesc) badges.push(h('span.badge', { text: 'In description' }));
    return item(`${prefix}:${row.kind}:${row.playlistId || ''}:${row.id}`, '.s-vod', [
      row.poster
        ? h('img.logo.s-poster', { src: row.poster, loading: 'lazy', alt: '', referrerpolicy: 'no-referrer', onerror: (e) => { e.target.style.visibility = 'hidden'; } })
        : h('span.ch-logo.s-poster'),
      h('span.s-text', {},
        h('span.n', { html: highlight(row.name, words) }),
        h('span.m', { text: meta })),
      h('span.s-badges', {}, ...badges),
      h('span.chev', { text: '›' }),
    ], { activate: () => openVod(row), menu: () => vodMenuItems(row) });
  }

  function groupItem(g, words) {
    return item(`g:${g.id}`, '.s-group', [
      h('span.s-gicon', { text: g.pinned ? '★' : g.custom ? '✦' : '▦' }),
      h('span.s-text', {},
        h('span.n', { html: highlight(g.name, words) }),
        h('span.m', { text: `${g.count.toLocaleString()} channel${g.count === 1 ? '' : 's'}${g.custom ? ' · custom group' : ''}` })),
      h('span.chev', { text: '›' }),
    ], { activate: () => openChannels(g.id, g.name), menu: () => groupMenuItems(g) });
  }

  function section(title, count, items, { more = null, cls = '' } = {}) {
    const head = h('div.s-section-head', {},
      h('h2', { text: title }),
      count !== undefined && count !== null ? h('span.chip-count', { text: count.toLocaleString() }) : null,
      h('span.spacer'),
      more ? h('button.btn.small.focusable', { type: 'button', text: more.label, onclick: more.onClick }) : null);
    return h(`section.s-section${cls}`, {}, head, h('div.s-list', {}, ...items));
  }

  // ---------------- start screen ----------------
  let suggest = null;

  async function renderStart() {
    body.innerHTML = '';
    statusEl.textContent = '';
    const recent = recentSearches();
    if (recent.length) {
      const chips = h('div.chips.s-recent', {}, ...recent.map((r) => chip(r.label || r.q, false, () => runQuery(r))));
      body.append(h('section.s-section', {},
        h('div.s-section-head', {}, h('h2', { text: 'Recent searches' }), h('span.spacer'),
          h('button.btn.small.focusable', { type: 'button', text: 'Clear', onclick: () => { prefs.set(RECENT_KEY, []); renderStart(); } })),
        chips));
    }
    body.append(h('section.s-section', {},
      h('div.s-section-head', {}, h('h2', { text: 'Quick searches' })),
      h('div.s-quick', {}, ...QUICK.map((qs) => h('button.s-quick-tile.focusable', {
        type: 'button',
        onclick: () => runQuery({ q: qs.q, label: qs.label, any: true }),
      }, h('span.s-quick-icon', { text: qs.icon }), h('span', { text: qs.label }))))));

    const holder = h('div');
    body.append(holder);
    if (!suggest) {
      holder.append(h('div.empty.s-loading', { text: 'Loading…' }));
      try {
        suggest = await get(`/search/suggest?recent=${enc(prefs.get('recent.channels', []).join(','))}${state.scope && state.scope !== 'all' ? `&scope=${enc(state.scope)}` : ''}`);
      } catch (err) {
        holder.innerHTML = '';
        holder.append(h('div.empty', { text: err.message }));
        return;
      }
      if (destroyed || state.q) return;
      holder.innerHTML = '';
    }
    if (suggest.recent.length) holder.append(section('Recently watched', null, suggest.recent.slice(0, 8).map((ch) => channelItem(ch, [], 'r'))));
    if (suggest.startingSoon.length) holder.append(section('Starting soon on your favorites', null, suggest.startingSoon.map((p) => showItem(p, [], 'ss'))));
    if (suggest.favorites.length) holder.append(section('Favorites', suggest.favorites.length, suggest.favorites.slice(0, 12).map((ch) => channelItem(ch, [], 'f'))));
    holder.append(h('p.hint.s-tips', {
      text: `Search ${suggest.stats.channels.toLocaleString()} channels and ${suggest.stats.groups.toLocaleString()} groups`
        + `${suggest.hasGuide ? ' plus the TV guide' : ''}`
        + `${suggest.hasVod ? ' and on-demand movies and TV shows' : ''}. Type a channel number to jump to it. `
        + 'Press Menu (or right-click / hold OK) on a result for more options.',
    }));
    restoreFocus();
  }

  // ---------------- results ----------------
  function render({ keepFocus = false } = {}) {
    const res = state.result;
    if (!res) return;
    const focusKey = keepFocus ? currentKey() : null;
    body.innerHTML = '';
    const words = queryWords(state.q);
    const all = state.type === 'all';
    const counts = res.counts;
    const nothing = !counts.channels && !counts.shows && !counts.groups && !(counts.movies || 0) && !(counts.series || 0);

    const notes = [];
    if (state.label) notes.push(`Quick search: ${state.label}`);
    if (!res.hasGuide) notes.push('No TV guide loaded, so live listings skip programme titles.');
    if (res.loading) notes.push('The guide is still loading; results may be incomplete.');
    if (res.vodLoading) notes.push('The on-demand catalog is still loading; movie and TV show results may be incomplete.');
    if (!res.hasVod && !res.vodLoading && (state.type === 'movies' || state.type === 'series')) {
      notes.push('This playlist has no on-demand movies or TV shows to search.');
    }
    statusEl.textContent = notes.join(' · ');

    if (nothing) {
      body.append(h('div.empty', {},
        h('div', { text: `Nothing found for "${state.label || state.q}".` }),
        h('div.hint', { text: state.when !== 'all' ? 'Try "Any time" or turn on Descriptions.' : 'Check the spelling, try fewer words, or turn on Descriptions to search plots and programme descriptions.' })));
      return;
    }

    const seeAll = (type, n) => (all && n > PREVIEW_COUNTS[type] ? { label: `See all ${n.toLocaleString()}`, onClick: () => setType(type) } : null);
    const cap = (list, type) => (all ? list.slice(0, PREVIEW_COUNTS[type]) : list);

    if ((all || state.type === 'shows') && res.titles.length > 1 && !state.any) {
      body.append(h('section.s-section', {},
        h('div.s-section-head', {}, h('h2', { text: 'Matching shows' })),
        h('div.chips.s-titles', {}, ...res.titles.slice(0, all ? 8 : 16).map((t) => {
          const parts = [`${t.airings} airing${t.airings === 1 ? '' : 's'}`];
          if (t.live) parts.push(`${t.live} live`);
          const b = h('button.chip.focusable.s-title-chip', { type: 'button', title: parts.join(' · ') },
            h('span', { html: highlight(t.title, words) }),
            h('span.chip-count', { text: t.live ? `● ${t.airings}` : String(t.airings) }));
          b.addEventListener('click', () => runQuery({ q: t.title, type: 'shows' }));
          return b;
        }))));
    }
    if ((all || state.type === 'channels') && res.channels.length) {
      body.append(section('Channels', counts.channels, cap(res.channels, 'channels').map((ch) => channelItem(ch, words)), { more: seeAll('channels', counts.channels) }));
    }
    if ((all || state.type === 'shows') && res.shows.length) {
      const shows = cap(res.shows, 'shows');
      body.append(section('On TV', counts.shows, shows.map((p) => showItem(p, words)), { more: seeAll('shows', counts.shows) }));
      if (!all && counts.shows > res.shows.length) body.append(h('p.hint.s-tips', { text: `Showing the first ${res.shows.length} of ${counts.shows.toLocaleString()}. Add words or pick On now / Upcoming / Catch-up to narrow it down.` }));
    }
    if ((all || state.type === 'movies') && (res.movies || []).length) {
      body.append(section('Movies', counts.movies, cap(res.movies, 'movies').map((row) => vodItem(row, words, 'm')), { more: seeAll('movies', counts.movies) }));
    }
    if ((all || state.type === 'series') && (res.series || []).length) {
      body.append(section('TV Shows', counts.series, cap(res.series, 'series').map((row) => vodItem(row, words, 't')), { more: seeAll('series', counts.series) }));
    }
    if ((all || state.type === 'groups') && res.groups.length) {
      body.append(section('Groups', counts.groups, cap(res.groups, 'groups').map((g) => groupItem(g, words)), { more: seeAll('groups', counts.groups) }));
    }
    if (!body.querySelector('.s-item')) {
      const label = TYPES.find((t) => t.id === state.type).label.toLowerCase();
      body.append(h('div.empty', { text: `No ${label} match "${state.label || state.q}". Other types have results; pick All.` }));
    }
    if (focusKey) focusByKey(focusKey);
    else restoreFocus();
  }

  function currentKey() {
    const active = document.activeElement;
    const el = active && active.closest && active.closest('[data-key]');
    return el && body.contains(el) ? el.dataset.key : null;
  }

  function focusByKey(key) {
    const el = key && body.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (el) focusEl(el);
    return !!el;
  }

  function restoreFocus() {
    if (!state.focusKey) return;
    const key = state.focusKey;
    state.focusKey = null;
    focusByKey(key);
  }

  async function refresh({ keepFocus = false } = {}) {
    renderFilters();
    persist();
    const q = state.q.trim();
    if (!q) {
      state.result = null;
      renderFilters();
      renderStart();
      return;
    }
    const id = ++req;
    statusEl.textContent = 'Searching…';
    body.classList.add('busy');
    let res;
    try {
      const qs = `q=${enc(q)}&when=${state.when}${state.desc ? '&desc=1' : ''}${state.any ? '&any=1' : ''}&limit=${state.type === 'all' ? 60 : 200}${state.type !== 'all' ? `&types=${enc(state.type)}` : ''}${state.scope && state.scope !== 'all' ? `&scope=${enc(state.scope)}` : ''}`;
      res = await get(`/search?${qs}`);
    } catch (err) {
      if (id === req) {
        statusEl.textContent = err.message;
        body.classList.remove('busy');
      }
      return;
    }
    if (id !== req || destroyed) return;
    body.classList.remove('busy');
    state.result = res;
    renderFilters();
    render({ keepFocus });
  }
  const refreshSoon = debounce(() => refresh(), 280);
  const rerenderSoon = debounce(() => refresh({ keepFocus: true }), 50);

  function runQuery({ q, label = '', any = false, type = null }) {
    state.q = q;
    state.label = label;
    state.any = any;
    if (type) state.type = type;
    input.value = label || q;
    rememberSearch({ q, label, any });
    refreshSoon.cancel();
    refresh().then(() => {
      const first = body.querySelector('.s-item');
      if (first) focusEl(first);
    });
  }

  // ---------------- input ----------------
  input.addEventListener('input', () => {
    state.q = input.value;
    state.label = '';
    state.any = false;
    clearBtn.style.visibility = input.value ? '' : 'hidden';
    refreshSoon();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    refreshSoon.cancel();
    commitSearch();
    refresh().then(() => {
      const first = body.querySelector('.s-item');
      if (first) focusEl(first);
      else input.blur();
    });
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    state.q = '';
    state.label = '';
    state.any = false;
    clearBtn.style.visibility = 'hidden';
    refresh();
    input.focus();
  });
  clearBtn.style.visibility = input.value ? '' : 'hidden';

  function onKeyUp(e) {
    if (!press || keyAction(e) !== 'enter') return;
    clearTimeout(press.timer);
    const { el } = press;
    press = null;
    const hnd = handlers.get(el);
    if (hnd && document.contains(el)) hnd.activate();
  }
  document.addEventListener('keyup', onKeyUp);

  renderFilters();
  try {
    view = await get('/playlist-view') || view;
  } catch { /* chips fall back to the current playlist */ }
  renderFilters();
  await refresh();
  if (!state.q) {
    focusEl(input);
  } else if (!body.contains(document.activeElement)) {
    focusEl(input);
  }

  return {
    manageFocus: true,
    onKey(action, e) {
      const active = document.activeElement;
      const el = active && active.closest && active.closest('.s-item');
      const hnd = el && handlers.get(el);
      if (action === 'menu' && hnd) {
        if (hnd.channel) openChannelContextMenu(hnd.channel, { anchor: el, keyboard: true });
        else openMenu(hnd.menu(), { anchor: el, keyboard: true });
        return true;
      }
      if (action === 'enter' && hnd) {
        if (e.repeat || press) return true;
        press = {
          el,
          timer: setTimeout(() => {
            press = null;
            if (hnd.channel) openChannelContextMenu(hnd.channel, { anchor: el, keyboard: true });
            else openMenu(hnd.menu(), { anchor: el, keyboard: true });
          }, LONG_PRESS_MS),
        };
        return true;
      }
      if (active === input && action === 'down') {
        moveFocus('down', root);
        return true;
      }
      if (isTextInput(active)) return false;
      return false;
    },
    onBack() {
      navigate('home');
      return true;
    },
    unmount() {
      destroyed = true;
      persist();
      refreshSoon.cancel();
      rerenderSoon.cancel();
      if (press) clearTimeout(press.timer);
      document.removeEventListener('keyup', onKeyUp);
    },
  };
}
