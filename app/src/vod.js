'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./log');
const db = require('./db');
const xtream = require('./xtream');
const mag = require('./mag');
const catalog = require('./catalog');
const { createMatcher } = require('./search');

const MAX_AGE_MS = 12 * 3600 * 1000;
const MAG_OVERVIEW_CONCURRENCY = 8;
const MAG_SEARCH_CACHE_MS = 90 * 1000;
const catalogs = new Map();
/** "playlistId|kind:categoryId" -> Promise while a MAG category's remaining pages download. */
const categoryLoads = new Map();
/** "playlistId|kinds|query" -> recent MAG portal search work. */
const magSearchCache = new Map();

function cacheFile(playlistId) {
  return path.join(config.dataDir, 'cache', String(playlistId).replace(/[^\w-]/g, ''), 'vod.json');
}

function infoFile(playlistId, name) {
  return path.join(config.dataDir, 'cache', String(playlistId).replace(/[^\w-]/g, ''), 'vod', name);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function categoryList(rows) {
  const out = [];
  const seen = new Set();
  for (const c of rows || []) {
    const id = String(c.category_id ?? c.categoryId ?? '0');
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: String(c.category_name || c.categoryName || 'Other').trim() || 'Other' });
  }
  return out;
}

function categoryIdOf(row) {
  if (row.category_id != null && row.category_id !== '') return String(row.category_id);
  if (Array.isArray(row.category_ids) && row.category_ids.length) return String(row.category_ids[0]);
  return '0';
}

function normalizeCatalog(raw) {
  const movieCats = categoryList(raw.movieCats);
  const movieNames = new Map(movieCats.map((c) => [c.id, c.name]));
  const movies = [];
  for (const row of raw.movies || []) {
    const id = Number(row.stream_id) || 0;
    if (!id) continue;
    const categoryId = categoryIdOf(row);
    if (!movieNames.has(categoryId)) {
      movieNames.set(categoryId, 'Other');
      movieCats.push({ id: categoryId, name: 'Other' });
    }
    movies.push({
      id: String(id),
      name: String(row.name || '').trim() || `Movie ${id}`,
      poster: row.stream_icon || row.cover || '',
      categoryId,
      ext: String(row.container_extension || 'mp4').replace(/^\./, ''),
    });
  }
  const seriesCats = categoryList(raw.seriesCats);
  const seriesNames = new Map(seriesCats.map((c) => [c.id, c.name]));
  const series = [];
  for (const row of raw.series || []) {
    const id = Number(row.series_id) || 0;
    if (!id) continue;
    const categoryId = categoryIdOf(row);
    if (!seriesNames.has(categoryId)) {
      seriesNames.set(categoryId, 'Other');
      seriesCats.push({ id: categoryId, name: 'Other' });
    }
    series.push({
      id: String(id),
      name: String(row.name || '').trim() || `Series ${id}`,
      poster: row.cover || row.stream_icon || '',
      categoryId,
      trailer: xtream.youtubeId(row.youtube_trailer),
    });
  }
  return {
    fetchedAt: Date.now(),
    movies: { categories: movieCats, items: movies },
    series: { categories: seriesCats, items: series },
  };
}

function getMemory(playlistId) {
  return catalogs.get(playlistId) || null;
}

/** In-memory catalog, or a still-valid disk copy (so Movies/Shows can paint before a refresh). */
function memoryOrDisk(playlistId) {
  const mem = catalogs.get(playlistId);
  if (mem && !mem.loading) return mem;
  const disk = readJson(cacheFile(playlistId));
  if (disk && disk.movies) {
    if (!mem) catalogs.set(playlistId, disk);
    return mem && mem.loading ? { ...disk, loading: true } : disk;
  }
  return mem;
}

/** Puts a MAG category's titles into the catalog, replacing what that category held before. */
function setCategoryItems(doc, kind, categoryId, items) {
  const bucket = doc[kind];
  const seen = new Set();
  const fresh = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    fresh.push({ ...item, categoryId });
  }
  bucket.items = bucket.items.filter((i) => i.categoryId !== categoryId).concat(fresh);
}

/**
 * MAG portals page every list (about 14 titles per page) and have no bulk call for movies or series,
 * so the catalog starts with each category's first page; a category's remaining pages load when it
 * is opened (`ensureMagCategory`).
 */
/** Drop in-memory + on-disk VOD data so the next load pulls fresh portal cmds/ids. */
function forget(playlistId) {
  catalogs.delete(playlistId);
  for (const key of [...categoryLoads.keys()]) {
    if (key.startsWith(`${playlistId}|`)) categoryLoads.delete(key);
  }
  for (const key of [...magSearchCache.keys()]) {
    if (key.startsWith(`${playlistId}|`)) magSearchCache.delete(key);
  }
  const dir = path.join(config.dataDir, 'cache', String(playlistId).replace(/[^\w-]/g, ''));
  try { fs.rmSync(path.join(dir, 'vod.json'), { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(path.join(dir, 'vod'), { recursive: true, force: true }); } catch { /* ignore */ }
}

async function ensureMagCatalog(playlist, state, { force = false } = {}) {
  const cached = getMemory(playlist.id);
  if (cached && cached.loading) return cached.loading;
  if (!force && cacheFresh(cached)) return cached;
  const disk = force ? null : readJson(cacheFile(playlist.id));
  if (!force && cacheFresh(disk)) {
    catalogs.set(playlist.id, disk);
    return disk;
  }
  if (force) {
    // Wipe stale MAG titles (dead 4K rows, old cmds) before re-pulling from the portal.
    forget(playlist.id);
  }
  if (!state.creds) await catalog.ensureLoaded(playlist, { maxAgeHours: 12 });
  if (!state.creds) {
    const empty = { fetchedAt: Date.now(), movies: { categories: [], items: [] }, series: { categories: [], items: [] } };
    catalogs.set(playlist.id, empty);
    return empty;
  }
  const doc = {
    fetchedAt: 0,
    magPages: {},
    movies: { categories: [], items: [], total: 0 },
    series: { categories: [], items: [], total: 0 },
    // Soft refresh keeps search hits; forced playlist refresh starts clean so play URLs
    // cannot resolve to removed portal stream ids.
    searchExtra: force
      ? { movies: [], series: [] }
      : ((cached && cached.searchExtra)
        || (disk && disk.searchExtra)
        || { movies: [], series: [] }),
  };
  const loading = (async () => {
    const opts = { userAgent: playlist.user_agent };
    try {
      const { movieCats, seriesCats } = await mag.loadVodCategories(state.creds, opts);
      doc.movies.categories = movieCats;
      doc.series.categories = seriesCats;
      doc.movies.items = [];
      doc.series.items = [];
      doc.movies.total = 0;
      doc.series.total = 0;
      doc.magPages = {};
      const jobs = [...movieCats.map((c) => ['movies', c.id]), ...seriesCats.map((c) => ['series', c.id])];
      await mag.mapLimit(jobs, MAG_OVERVIEW_CONCURRENCY, async ([kind, categoryId]) => {
        try {
          const page = await mag.loadCategoryPage(state.creds, kind, categoryId, 1, opts);
          setCategoryItems(doc, kind, categoryId, page.items);
          doc[kind].total += page.total;
          doc.magPages[`${kind}:${categoryId}`] = { total: page.total, complete: page.items.length >= page.total };
        } catch (err) {
          log.warn(`MAG ${kind} category ${categoryId} failed`, err);
        }
      });
      doc.fetchedAt = Date.now();
      delete doc.loading;
      catalogs.set(playlist.id, doc);
      writeJson(cacheFile(playlist.id), doc);
      log.info(`VOD catalog for '${playlist.name}': ${doc.movies.total} movies, ${doc.series.total} series in ${jobs.length} categories${force ? ' (forced refresh)' : ''}`);
      return doc;
    } catch (err) {
      log.warn(`VOD catalog failed for '${playlist.name}'`, err);
      delete doc.loading;
      const fallback = {
        fetchedAt: Date.now(),
        magPages: {},
        movies: { categories: [], items: [] },
        series: { categories: [], items: [] },
        searchExtra: { movies: [], series: [] },
        error: err.message,
      };
      catalogs.set(playlist.id, fallback);
      return fallback;
    }
  })();
  doc.loading = loading;
  catalogs.set(playlist.id, doc);
  return loading;
}

/** Downloads every page of one MAG category (once per catalog). */
async function ensureMagCategory(playlist, state, kind, categoryId) {
  const doc = await ensureCatalog(playlist, state);
  const key = `${kind}:${categoryId}`;
  const info = doc.magPages && doc.magPages[key];
  if (!info || info.complete || !state.creds) return doc;
  const loadKey = `${playlist.id}|${key}`;
  if (!categoryLoads.has(loadKey)) {
    categoryLoads.set(loadKey, (async () => {
      try {
        const { items, total } = await mag.loadCategory(state.creds, kind, categoryId, { userAgent: playlist.user_agent });
        setCategoryItems(doc, kind, categoryId, items);
        doc.magPages[key] = { total, complete: true };
        writeJson(cacheFile(playlist.id), doc);
      } catch (err) {
        log.warn(`MAG ${kind} category ${categoryId} failed`, err);
      } finally {
        categoryLoads.delete(loadKey);
      }
    })());
  }
  await categoryLoads.get(loadKey);
  return doc;
}

const VOD_RETRY_MS = 2 * 60 * 1000;

/** True when a cached catalog is still good enough to serve without refetching. */
function cacheFresh(doc) {
  if (!doc || doc.loading) return false;
  const age = Date.now() - (doc.fetchedAt || 0);
  if (age >= MAX_AGE_MS) return false;
  const sum = summaryOf(doc);
  // Empty catalogs that failed can retry after a short cooldown.
  if (!sum.hasVod && doc.error && age >= VOD_RETRY_MS) return false;
  return true;
}

async function ensureCatalog(playlist, state, { force = false } = {}) {
  if (playlist.type === 'mag') return ensureMagCatalog(playlist, state, { force });
  if (playlist.type !== 'xtream') {
    const empty = { fetchedAt: Date.now(), movies: { categories: [], items: [] }, series: { categories: [], items: [] } };
    catalogs.set(playlist.id, empty);
    return empty;
  }
  const cached = getMemory(playlist.id);
  if (cached && cached.loading) return cached.loading;
  if (!force && cacheFresh(cached)) return cached;
  const disk = force ? null : readJson(cacheFile(playlist.id));
  if (!force && cacheFresh(disk)) {
    catalogs.set(playlist.id, disk);
    return disk;
  }
  if (force) forget(playlist.id);
  if (!state.creds && !state.channels.length) await catalog.ensureLoaded(playlist, { maxAgeHours: 12 });
  const creds = state.creds;
  if (!creds) {
    const empty = {
      fetchedAt: Date.now(),
      movies: { categories: [], items: [] },
      series: { categories: [], items: [] },
      error: 'Provider login unavailable',
    };
    catalogs.set(playlist.id, empty);
    return empty;
  }
  const loading = (async () => {
    try {
      const raw = await xtream.loadVodCatalog(creds, { userAgent: playlist.user_agent });
      const doc = normalizeCatalog(raw);
      catalogs.set(playlist.id, doc);
      writeJson(cacheFile(playlist.id), doc);
      log.info(`VOD catalog for '${playlist.name}': ${doc.movies.items.length} movies, ${doc.series.items.length} series${force ? ' (forced refresh)' : ''}`);
      return doc;
    } catch (err) {
      log.warn(`VOD catalog failed for '${playlist.name}'`, err);
      const fallback = {
        fetchedAt: Date.now(),
        movies: (disk && disk.movies) || { categories: [], items: [] },
        series: (disk && disk.series) || { categories: [], items: [] },
        error: err.message,
      };
      catalogs.set(playlist.id, fallback);
      return fallback;
    }
  })();
  catalogs.set(playlist.id, {
    movies: { categories: [], items: [] },
    series: { categories: [], items: [] },
    loading,
    fetchedAt: 0,
  });
  return loading;
}

/** Force-refresh Movies / TV Shows from the provider (fresh cmds/ids for MAG). */
function refreshCatalog(playlist, state) {
  return ensureCatalog(playlist, state, { force: true });
}

function summaryOf(doc) {
  const count = (bucket) => (bucket ? Math.max(bucket.total || 0, bucket.items.length) : 0);
  const movies = count(doc && doc.movies);
  const series = count(doc && doc.series);
  return { movies, series, hasVod: movies + series > 0, loading: !!(doc && doc.loading) };
}

function supportsVod(playlist) {
  return !!(playlist && (playlist.type === 'xtream' || playlist.type === 'mag'));
}

function liveSearchQuery(query, any) {
  if (any) return false;
  const t = String(query || '').trim();
  if (t.length < 2 || t.length > 64) return false;
  return t.split(/\s+/).length <= 8;
}

function emptyDoc() {
  return { fetchedAt: 0, movies: { categories: [], items: [] }, series: { categories: [], items: [] } };
}

function findTitle(doc, kind, id) {
  const needle = String(id);
  const bucket = kind === 'series' ? doc.series : doc.movies;
  const extra = doc.searchExtra && doc.searchExtra[kind];
  return (bucket && bucket.items || []).find((i) => i.id === needle)
    || (extra || []).find((i) => i.id === needle)
    || null;
}

/** Adds portal search hits into a side index that MAG first-page refreshes cannot wipe. */
function mergeHits(doc, kind, items, matcher) {
  if (!doc.searchExtra) doc.searchExtra = { movies: [], series: [] };
  const extra = doc.searchExtra[kind] || (doc.searchExtra[kind] = []);
  const byId = new Map(extra.map((i) => [i.id, i]));
  const bucket = doc[kind] || (doc[kind] = { categories: [], items: [] });
  const cats = new Set((bucket.categories || []).map((c) => c.id));
  for (const item of items || []) {
    if (!item || !item.id) continue;
    const score = matcher.score(item.name) || (item.plot ? matcher.score(item.plot) : 0);
    if (!score) continue;
    const prev = byId.get(item.id);
    if (prev) {
      if (!prev.poster && item.poster) prev.poster = item.poster;
      if (!prev.plot && item.plot) prev.plot = item.plot;
      if (!prev.year && item.year) prev.year = item.year;
      // Prefer a real portal cmd (base64 JSON / ffmpeg) over a missing/stale one.
      if (item.cmd && (!prev.cmd || prev.cmd.length < item.cmd.length)) prev.cmd = item.cmd;
      continue;
    }
    extra.push(item);
    byId.set(item.id, item);
    if (item.categoryId && !cats.has(item.categoryId)) {
      cats.add(item.categoryId);
      bucket.categories.push({ id: item.categoryId, name: item.genre || 'Search' });
    }
  }
}

/**
 * Makes sure on-demand search can see titles that are not in the first page of a MAG category,
 * and waits for Xtream catalogs that are still downloading.
 */
async function enrichForSearch(playlist, state, query, { movies = true, series = true, any = false } = {}) {
  if (playlist.type !== 'xtream' && playlist.type !== 'mag') return memoryOrDisk(playlist.id);
  let st = state;
  if (!st.creds) {
    const health = catalog.healthOf(st);
    if (health.state === 'offline') return memoryOrDisk(playlist.id) || emptyDoc();
    catalog.ensureLoaded(playlist, { maxAgeHours: 12 }).catch((err) => {
      log.warn(`Could not load '${playlist.name}' for search`, err);
    });
    if (health.state === 'loading' || health.state === 'idle' || health.state === 'error') {
      return memoryOrDisk(playlist.id) || emptyDoc();
    }
    st = catalog.getState(playlist.id);
  }
  if (playlist.type === 'xtream') {
    ensureCatalog(playlist, st).catch((err) => log.warn(`VOD catalog failed for '${playlist.name}'`, err));
    return memoryOrDisk(playlist.id) || emptyDoc();
  }
  ensureCatalog(playlist, st).catch(() => {});
  let doc = memoryOrDisk(playlist.id);
  if (!doc) {
    doc = emptyDoc();
    catalogs.set(playlist.id, doc);
  }
  if (!st.creds || !liveSearchQuery(query, any) || (!movies && !series)) return doc;
  const kinds = [];
  if (movies) kinds.push('movies');
  if (series) kinds.push('series');
  const cacheKey = `${playlist.id}|${kinds.join(',')}|${String(query).trim().toLowerCase()}`;
  const cached = magSearchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < MAG_SEARCH_CACHE_MS) {
    try {
      await cached.promise;
    } catch { /* already logged */ }
    return memoryOrDisk(playlist.id) || doc;
  }
  const work = (async () => {
    const found = await mag.searchTitles(st.creds, query, { kinds, userAgent: playlist.user_agent });
    const matcher = createMatcher(query);
    if (!matcher) return;
    const target = catalogs.get(playlist.id) || doc;
    mergeHits(target, 'movies', found.movies, matcher);
    mergeHits(target, 'series', found.series, matcher);
    catalogs.set(playlist.id, target);
  })();
  magSearchCache.set(cacheKey, { at: Date.now(), promise: work });
  try {
    await work;
  } catch (err) {
    magSearchCache.delete(cacheKey);
    log.warn(`MAG search failed for '${playlist.name}'`, err);
  }
  return memoryOrDisk(playlist.id) || doc;
}

async function enrichMany(rows, query, flags) {
  const list = (rows || []).filter((row) => row.type === 'xtream' || row.type === 'mag');
  const out = new Array(list.length);
  await mag.mapLimit(list, 4, async (row, i) => {
    try {
      const doc = await enrichForSearch(row, catalog.getState(row.id), query, flags);
      out[i] = { id: row.id, name: row.name, doc: doc || emptyDoc() };
    } catch (err) {
      log.warn(`Search catalog skipped for '${row.name}'`, err);
      out[i] = { id: row.id, name: row.name, doc: memoryOrDisk(row.id) || emptyDoc() };
    }
  });
  return out;
}

function progressMap(userId, playlistId) {
  const rows = db.all('SELECT item_id, position, duration, extra FROM vod_progress WHERE user_id = ? AND playlist_id = ?', [userId, playlistId]);
  const map = new Map();
  for (const row of rows) map.set(row.item_id, { position: Number(row.position) || 0, duration: Number(row.duration) || 0, extra: row.extra || '' });
  return map;
}

function inProgress(entry) {
  if (!entry || !(entry.position > 5)) return false;
  if (!(entry.duration > 1)) return true;
  const f = entry.position / entry.duration;
  return f < 0.97;
}

function fraction(entry) {
  if (!inProgress(entry)) return 0;
  const dur = entry.duration > 1 ? entry.duration : Math.max(entry.position / 0.7, 45 * 60);
  return Math.max(0, Math.min(1, entry.position / dur));
}

function rowsFor(doc, kind, progress) {
  const bucket = (kind === 'series' ? doc && doc.series : doc && doc.movies) || { categories: [], items: [] };
  const prefix = kind === 'series' ? 's:' : 'm:';
  const items = (bucket.items || []).map((item) => {
    const saved = progress.get(`${prefix}${item.id}`);
    const row = {
      id: item.id,
      name: item.name,
      poster: item.poster,
      categoryId: item.categoryId,
    };
    const frac = fraction(saved);
    if (frac) row.progress = frac;
    if (kind === 'series' && item.trailer) row.trailer = item.trailer;
    return row;
  });
  const used = new Set(items.map((i) => i.categoryId));
  const categories = (bucket.categories || []).filter((c) => used.has(c.id));
  return { categories, items };
}

function backdropOf(info) {
  const paths = info && (info.backdrop_path || info.backdrop);
  if (Array.isArray(paths) && paths.length) return String(paths[0] || '');
  if (typeof paths === 'string') return paths;
  return '';
}

function progressInfo(saved) {
  return saved && fraction(saved) ? { position: saved.position, duration: saved.duration, fraction: fraction(saved) } : null;
}

async function movieDetail(playlist, state, id, progress) {
  const doc = await ensureCatalog(playlist, state);
  const item = findTitle(doc, 'movies', id);
  if (!item) return null;
  if (playlist.type === 'mag') {
    return {
      kind: 'movie',
      id: item.id,
      name: item.name,
      poster: item.poster,
      backdrop: item.poster,
      plot: item.plot || '',
      genre: item.genre || '',
      year: item.year || '',
      trailer: '',
      progress: progressInfo(progress.get(`m:${item.id}`)),
    };
  }
  let info = readJson(infoFile(playlist.id, `movie-${item.id}.json`));
  if (!info && state.creds) {
    try {
      const raw = await xtream.loadVodInfo(state.creds, item.id, { userAgent: playlist.user_agent });
      info = (raw && raw.info) || {};
      const data = (raw && raw.movie_data) || {};
      if (data.container_extension) item.ext = String(data.container_extension).replace(/^\./, '');
      writeJson(infoFile(playlist.id, `movie-${item.id}.json`), info);
      writeJson(cacheFile(playlist.id), doc);
    } catch (err) {
      log.warn(`Movie info ${item.id} failed`, err);
      info = {};
    }
  }
  info = info || {};
  const saved = progress.get(`m:${item.id}`);
  return {
    kind: 'movie',
    id: item.id,
    name: info.name || item.name,
    poster: info.cover || info.movie_image || item.poster,
    backdrop: backdropOf(info) || info.cover || item.poster,
    plot: info.plot || info.description || '',
    genre: info.genre || '',
    year: String(info.releasedate || info.release_date || '').slice(0, 4),
    trailer: xtream.youtubeId(info.youtube_trailer) || '',
    progress: progressInfo(saved),
  };
}

function episodeList(raw) {
  const seasons = raw && raw.episodes && typeof raw.episodes === 'object' ? raw.episodes : {};
  const out = [];
  const keys = Object.keys(seasons).sort((a, b) => Number(a) - Number(b));
  for (const key of keys) {
    const eps = Array.isArray(seasons[key]) ? seasons[key] : [];
    for (const ep of eps) {
      const id = Number(ep.id) || 0;
      if (!id) continue;
      const info = ep.info || {};
      out.push({
        id: String(id),
        season: Number(ep.season) || Number(key) || 1,
        episode: Number(ep.episode_num) || out.length + 1,
        title: String(ep.title || info.name || `Episode ${ep.episode_num || ''}`).trim(),
        plot: info.plot || '',
        poster: info.movie_image || '',
        ext: String(ep.container_extension || 'mp4').replace(/^\./, ''),
        duration: Number(info.duration_secs) || 0,
      });
    }
  }
  return out;
}

function seriesFileName(seriesId) {
  return `series-${String(seriesId).replace(/[^\w-]/g, '_')}.json`;
}

/** A series' info and episode list from the provider, cached on disk. */
async function loadSeriesPack(playlist, state, seriesId) {
  const opts = { userAgent: playlist.user_agent };
  let pack;
  if (playlist.type === 'mag') {
    const { episodes } = await mag.loadSeriesEpisodes(state.creds, seriesId, opts);
    pack = { info: {}, episodes };
  } else {
    const raw = await xtream.loadSeriesInfo(state.creds, seriesId, opts);
    pack = { info: (raw && raw.info) || {}, episodes: episodeList(raw) };
  }
  writeJson(infoFile(playlist.id, seriesFileName(seriesId)), pack);
  return pack;
}

async function seriesDetail(playlist, state, id, progress) {
  const doc = await ensureCatalog(playlist, state);
  const item = findTitle(doc, 'series', id);
  if (!item) return null;
  let pack = readJson(infoFile(playlist.id, seriesFileName(item.id)));
  if (!pack && state.creds) {
    try {
      pack = await loadSeriesPack(playlist, state, item.id);
    } catch (err) {
      log.warn(`Series info ${item.id} failed`, err);
      pack = { info: {}, episodes: [] };
    }
  }
  pack = pack || { info: {}, episodes: [] };
  const info = pack.info || {};
  const cont = progress.get(`s:${item.id}`);
  const episodes = (pack.episodes || []).map((ep) => {
    const saved = progress.get(`e:${ep.id}`);
    const { cmd: _cmd, ...row } = ep;
    const frac = fraction(saved);
    if (frac) row.progress = frac;
    return row;
  });
  const savedEp = cont && cont.extra ? progress.get(cont.extra) : null;
  return {
    kind: 'series',
    id: item.id,
    name: info.name || item.name,
    poster: info.cover || item.poster,
    backdrop: backdropOf(info) || info.cover || item.poster,
    plot: info.plot || item.plot || '',
    genre: info.genre || item.genre || '',
    year: String(info.releaseDate || info.release_date || item.year || '').slice(0, 4),
    trailer: xtream.youtubeId(info.youtube_trailer) || item.trailer || '',
    episodes,
    resume: cont && cont.extra ? {
      episodeId: cont.extra.replace(/^e:/, ''),
      position: savedEp ? savedEp.position : cont.position,
      duration: savedEp ? savedEp.duration : cont.duration,
      fraction: fraction(savedEp || cont),
    } : null,
  };
}

function saveProgress(userId, playlistId, { itemId, position, duration, seriesId, episodeId }) {
  const pos = Math.max(0, Number(position) || 0);
  const dur = Math.max(0, Number(duration) || 0);
  const now = Date.now();
  db.run(`INSERT INTO vod_progress (user_id, playlist_id, item_id, position, duration, extra, updated_at)
    VALUES (?, ?, ?, ?, ?, '', ?)
    ON CONFLICT(user_id, playlist_id, item_id) DO UPDATE SET
      position = excluded.position,
      duration = CASE WHEN excluded.duration > 1 THEN excluded.duration ELSE vod_progress.duration END,
      updated_at = excluded.updated_at`,
  [userId, playlistId, String(itemId), pos, dur, now]);
  if (seriesId && episodeId) {
    db.run(`INSERT INTO vod_progress (user_id, playlist_id, item_id, position, duration, extra, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, playlist_id, item_id) DO UPDATE SET
        position = excluded.position,
        duration = CASE WHEN excluded.duration > 1 THEN excluded.duration ELSE vod_progress.duration END,
        extra = excluded.extra,
        updated_at = excluded.updated_at`,
    [userId, playlistId, `s:${seriesId}`, pos, dur, `e:${episodeId}`, now]);
  }
}

function streamBaseOf(state) {
  return (state.creds && (state.creds.streamBase || state.creds.server)) || state.streamBase || '';
}

async function resolvePlay(playlist, userId, state, token, { resume = true, seriesId = '' } = {}) {
  const doc = await ensureCatalog(playlist, state);
  const creds = state.creds;
  if (!creds) {
    const err = new Error('This playlist has no video-on-demand login');
    err.status = 400;
    throw err;
  }
  const base = String(streamBaseOf(state)).replace(/\/+$/, '');
  const user = encodeURIComponent(creds.username);
  const pass = encodeURIComponent(creds.password);
  const progress = progressMap(userId, playlist.id);
  const raw = String(token || '');
  const isMag = playlist.type === 'mag';
  const opts = { userAgent: playlist.user_agent };
  const movie = /^m:(.+)$/.exec(raw);
  if (movie) {
    const item = findTitle(doc, 'movies', movie[1]);
    if (!item) {
      const err = new Error('Movie not found');
      err.status = 404;
      throw err;
    }
    const saved = progress.get(movie[0]);
    const start = resume && saved && fraction(saved) ? saved.position : 0;
    const duration = Number(item.duration) || (saved && saved.duration) || 0;
    return {
      title: item.name,
      subtitle: 'Movie',
      poster: item.poster,
      url: isMag ? await mag.movieUrl(creds, item, opts) : `${base}/movie/${user}/${pass}/${item.id}.${item.ext || 'mp4'}`,
      start,
      duration,
      itemId: `m:${item.id}`,
      remint: isMag ? { cmd: item.cmd || '', fileId: item.id, series: '' } : null,
    };
  }
  const episode = /^e:(.+)$/.exec(raw);
  if (episode) {
    const found = await findEpisode(playlist, state, doc, episode[1], seriesId);
    if (!found) {
      const err = new Error('Episode not found');
      err.status = 404;
      throw err;
    }
    const saved = progress.get(`e:${found.ep.id}`);
    const start = resume && saved && fraction(saved) ? saved.position : 0;
    const duration = Number(found.ep.duration) || (saved && saved.duration) || 0;
    return {
      title: found.series.name,
      subtitle: `S${found.ep.season} E${found.ep.episode} · ${found.ep.title}`,
      poster: found.ep.poster || found.series.poster,
      url: isMag ? await mag.episodeUrl(creds, found.ep, { ...opts, seriesId: found.series.id }) : `${base}/series/${user}/${pass}/${found.ep.id}.${found.ep.ext || 'mp4'}`,
      start,
      duration,
      itemId: `e:${found.ep.id}`,
      seriesId: found.series.id,
      episodeId: found.ep.id,
      season: found.ep.season,
      episode: found.ep.episode,
      episodeTitle: found.ep.title || '',
      remint: isMag ? {
        cmd: found.ep.cmd || '',
        fileId: '',
        series: String(found.ep.episode || ''),
        seriesId: found.series.id,
        episodeId: found.ep.id,
      } : null,
    };
  }
  const err = new Error('Unknown video');
  err.status = 400;
  throw err;
}

module.exports = {
  ensureCatalog,
  refreshCatalog,
  forget,
  ensureMagCategory,
  enrichForSearch,
  enrichMany,
  summaryOf,
  supportsVod,
  getMemory,
  memoryOrDisk,
  progressMap,
  rowsFor,
  movieDetail,
  seriesDetail,
  saveProgress,
  resolvePlay,
};

async function findEpisode(playlist, state, doc, episodeId, seriesId) {
  const needle = String(episodeId);
  const extra = (doc.searchExtra && doc.searchExtra.series) || [];
  const ordered = seriesId
    ? [findTitle(doc, 'series', seriesId), ...doc.series.items, ...extra].filter(Boolean)
    : [...doc.series.items, ...extra];
  const seen = new Set();
  for (const series of ordered) {
    if (seen.has(series.id)) continue;
    seen.add(series.id);
    let pack = readJson(infoFile(playlist.id, seriesFileName(series.id)));
    if (!pack && seriesId && String(series.id) === String(seriesId) && state.creds) {
      try {
        pack = await loadSeriesPack(playlist, state, series.id);
      } catch {
        pack = null;
      }
    }
    if (!pack) continue;
    const ep = (pack.episodes || []).find((e) => e.id === needle);
    if (ep) return { series, ep };
    if (seriesId && String(series.id) === String(seriesId)) break;
  }
  return null;
}
