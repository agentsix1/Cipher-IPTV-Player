'use strict';

/**
 * Search across channels, groups, guide programmes ("shows") and the on-demand movie/TV catalog.
 *
 * Matching is word based and forgiving: every query word must start a word of the target
 * ("espn 2" finds "ESPN2 HD" via the compact form, "news" finds "Sky News"). With `any` the
 * query words are alternatives instead (used by quick searches such as Sports or Kids).
 */

const MIN = 60000;
const DAY = 24 * 60 * MIN;

function normalize(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function createMatcher(query, { any = false } = {}) {
  const norm = normalize(query);
  const words = norm ? norm.split(' ') : [];
  const compact = words.join('');
  if (!words.length) return null;

  /** 0 = no match; higher is better (100 exact, 80 prefix, 60+ all words, 30 substring). */
  function score(text) {
    const t = normalize(text);
    if (!t) return 0;
    if (any) {
      const own = t.split(' ');
      let hits = 0;
      for (const w of words) if (own.some((o) => o === w || (w.length >= 3 && o.startsWith(w)))) hits += 1;
      return hits ? 50 + hits * 5 : 0;
    }
    if (t === norm) return 100;
    if (t.startsWith(norm)) return 80;
    const own = t.split(' ');
    let whole = 0;
    let all = true;
    for (const w of words) {
      if (own.includes(w)) whole += 1;
      else if (!own.some((o) => o.startsWith(w))) {
        all = false;
        break;
      }
    }
    if (all) return 60 + Math.min(15, whole * 5) - Math.min(10, Math.max(0, own.length - words.length));
    if (compact.length >= 3 && own.some((o) => o.startsWith(compact) || o === compact)) return compact === own[0] ? 45 : 30;
    return 0;
  }
  return { score, words, norm };
}

/** Index of the programme airing at `t` in a start-sorted list (shift applied), or -1. */
function indexAt(list, shift, t) {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = list[mid];
    if (p[1] + shift <= t) lo = mid + 1;
    else if (p[0] + shift > t) hi = mid - 1;
    else return mid;
  }
  return -1;
}

function nowAndNext(list, shift, now) {
  if (!list || !list.length) return { now: null, next: null };
  const i = indexAt(list, shift, now);
  const cur = i >= 0 ? list[i] : null;
  let next = null;
  const from = i >= 0 ? i + 1 : list.findIndex((p) => p[0] + shift > now);
  if (from >= 0 && from < list.length) next = list[from];
  const out = (p) => (p ? { title: p[2], start: p[0] + shift, end: p[1] + shift } : null);
  return { now: out(cur), next: out(next) };
}

/**
 * ctx: {
 *   channels: visible catalog channels (hidden ones already removed),
 *   groups: the user's group list (groupList()),
 *   groupName(channel), toClient(channel), programmes(channel), shiftOf(channel),
 *   favorites: Set, pastHours, futureHours,
 *   vodSources: [{ id, name, doc }]  on-demand catalogs to search
 * }
 * opts: { q, any, types:Set(...), when, desc, limit }
 */
function searchVodKind(sources, matcher, kind, { desc, limit }) {
  const hits = [];
  for (const src of sources || []) {
    const bucket = kind === 'series' ? src.doc && src.doc.series : src.doc && src.doc.movies;
    const extra = (src.doc && src.doc.searchExtra && src.doc.searchExtra[kind]) || [];
    const cats = new Map((bucket && bucket.categories || []).map((c) => [c.id, c.name]));
    const seen = new Set();
    const items = [];
    for (const item of [...((bucket && bucket.items) || []), ...extra]) {
      if (!item || !item.id || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    for (const item of items) {
      let s = matcher.score(item.name);
      let inDesc = false;
      if (!s && desc && item.plot) {
        const d = matcher.score(item.plot);
        if (d >= 45) {
          s = 20;
          inDesc = true;
        }
      }
      if (!s) continue;
      hits.push({
        item, s, inDesc,
        category: cats.get(item.categoryId) || '',
        playlistId: src.id,
        playlistName: src.name,
      });
    }
  }
  hits.sort((a, b) => b.s - a.s || a.item.name.localeCompare(b.item.name));
  return {
    count: hits.length,
    items: hits.slice(0, limit).map(({ item, inDesc, category, playlistId, playlistName }) => ({
      id: item.id,
      name: item.name,
      poster: item.poster || '',
      categoryId: item.categoryId || '',
      category,
      year: item.year || '',
      kind,
      inDesc,
      playlistId,
      playlistName,
    })),
  };
}

function search(ctx, opts) {
  const matcher = createMatcher(opts.q, { any: opts.any });
  const types = opts.types;
  const now = Date.now();
  const limit = Math.max(1, Math.min(300, opts.limit || 100));
  const out = {
    channels: [], groups: [], shows: [], titles: [], movies: [], series: [],
    counts: { channels: 0, groups: 0, shows: 0, movies: 0, series: 0 },
  };
  if (!matcher) return out;

  const digits = /^\d{1,5}$/.test(opts.q.trim()) ? Number(opts.q.trim()) : null;

  // ---- channels
  if (types.has('channels')) {
    const hits = [];
    for (const ch of ctx.channels) {
      const client = ctx.toClient(ch);
      let s = Math.max(matcher.score(client.name), client.renamed ? matcher.score(client.originalName) - 5 : 0);
      if (digits !== null && Number(ch.num) === digits) s = Math.max(s, 120);
      if (s) hits.push({ ch, client, s });
    }
    hits.sort((a, b) => b.s - a.s || (b.client.fav ? 1 : 0) - (a.client.fav ? 1 : 0) || a.client.name.localeCompare(b.client.name));
    out.counts.channels = hits.length;
    out.channels = hits.slice(0, limit).map(({ ch, client }) => ({
      ...client,
      groupName: ctx.groupName(ch),
      ...nowAndNext(ctx.programmes(ch), ctx.shiftOf(ch), now),
    }));
  }

  // ---- groups
  if (types.has('groups')) {
    const hits = [];
    for (const g of ctx.groups) {
      const s = Math.max(matcher.score(g.name), g.renamed ? matcher.score(g.originalName) - 5 : 0);
      if (s) hits.push({ g, s });
    }
    hits.sort((a, b) => b.s - a.s || b.g.count - a.g.count);
    out.counts.groups = hits.length;
    out.groups = hits.slice(0, limit).map(({ g }) => ({ id: g.id, name: g.name, count: g.count, custom: !!g.custom, pinned: !!g.pinned }));
  }

  // ---- shows
  if (types.has('shows')) {
    const when = opts.when || 'all';
    const from = now - (ctx.pastHours || 24) * 3600000;
    const to = now + (ctx.futureHours || 72) * 3600000;
    const titleCache = new Map();
    const titleScore = (title) => {
      let s = titleCache.get(title);
      if (s === undefined) {
        s = matcher.score(title);
        titleCache.set(title, s);
      }
      return s;
    };
    // Channels sharing a guide (e.g. HD / SD / backup feeds) are searched once.
    const lists = new Map();
    for (const ch of ctx.channels) {
      const list = ctx.programmes(ch);
      if (!list || !list.length) continue;
      const entry = lists.get(list);
      if (entry) entry.others.push(ch);
      else lists.set(list, { ch, others: [] });
    }
    const hits = [];
    for (const [list, { ch, others }] of lists) {
      const shift = ctx.shiftOf(ch);
      const catchup = !!ctx.toClient(ch).catchup;
      const days = ch.catchupDays || 7;
      for (const p of list) {
        const start = p[0] + shift;
        const end = p[1] + shift;
        if (end <= from) continue;
        if (start >= to) break;
        const live = start <= now && end > now;
        const past = end <= now;
        if (when === 'now' && !live) continue;
        if (when === 'upcoming' && start <= now) continue;
        if (when === 'past' && !(past && catchup && start >= now - days * DAY)) continue;
        if (when === 'all' && past && !(catchup && start >= now - days * DAY)) continue;
        let s = titleScore(p[2]);
        let inDesc = false;
        if (!s && opts.desc && p[3]) {
          const d = matcher.score(p[3]);
          if (d >= 45) {
            s = 20;
            inDesc = true;
          }
        }
        if (!s) continue;
        hits.push({ ch, others, start, end, title: p[2], hasDesc: !!p[3], s, live, past, catchup, inDesc });
      }
    }
    const stage = (x) => (x.live ? 0 : x.past ? 2 : 1);
    const strong = (x) => (x.s >= 60 ? 0 : 1);
    hits.sort((a, b) => strong(a) - strong(b) || stage(a) - stage(b)
      || (stage(a) === 2 ? b.start - a.start : a.start - b.start) || b.s - a.s);
    out.counts.shows = hits.length;

    const titles = new Map();
    for (const x of hits) {
      const key = normalize(x.title);
      let t = titles.get(key);
      if (!t) {
        t = { title: x.title, airings: 0, live: 0, upcoming: 0, past: 0, next: null, channels: new Set(), s: x.s };
        titles.set(key, t);
      }
      t.airings += 1;
      t.channels.add(x.ch.id);
      if (x.live) t.live += 1;
      else if (x.past) t.past += 1;
      else {
        t.upcoming += 1;
        if (!t.next || x.start < t.next) t.next = x.start;
      }
    }
    out.titles = [...titles.values()]
      .sort((a, b) => b.s - a.s || b.live - a.live || b.airings - a.airings)
      .slice(0, 16)
      .map(({ channels, s, ...t }) => ({ ...t, channels: channels.size }));

    out.shows = hits.slice(0, limit).map((x) => {
      const client = ctx.toClient(x.ch);
      return {
        channel: {
          id: client.id,
          name: client.name,
          logo: client.logo,
          num: client.num,
          catchup: client.catchup,
          catchupDays: client.catchupDays,
          fav: client.fav,
          groupId: client.groupId,
          groupName: ctx.groupName(x.ch),
          playlistId: client.playlistId || '',
          playlistName: client.playlistName || '',
          srcId: client.srcId || client.id,
        },
        start: x.start,
        end: x.end,
        title: x.title,
        hasDesc: x.hasDesc,
        live: x.live,
        past: x.past,
        catchup: x.past && x.catchup,
        inDesc: x.inDesc,
        alsoOn: x.others.length,
        alsoOnNames: x.others.slice(0, 4).map((c) => ctx.toClient(c).name),
      };
    });
  }

  // ---- on demand (movies / TV shows)
  const vodSources = ctx.vodSources || (ctx.vod ? [{ id: '', name: '', doc: ctx.vod }] : []);
  if (types.has('movies')) {
    const found = searchVodKind(vodSources, matcher, 'movies', { desc: opts.desc, limit });
    out.counts.movies = found.count;
    out.movies = found.items;
  }
  if (types.has('series')) {
    const found = searchVodKind(vodSources, matcher, 'series', { desc: opts.desc, limit });
    out.counts.series = found.count;
    out.series = found.items;
  }
  return out;
}

module.exports = { search, nowAndNext, normalize, createMatcher };
