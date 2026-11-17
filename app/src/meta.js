'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getJson } = require('./http');
const log = require('./log');

const memory = new Map();
const TTL_MS = 7 * 24 * 3600 * 1000;
const NEG_TTL_MS = 6 * 3600 * 1000;
/** Cap in-RAM meta entries so long sessions do not grow unbounded. */
const MAX_MEMORY = 4000;
let disk = null;
let saveTimer = null;

function cacheFile() {
  return path.join(config.dataDir, 'cache', 'meta.json');
}

function loadDisk() {
  if (disk) return disk;
  try {
    disk = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) || {};
  } catch {
    disk = {};
  }
  return disk;
}

function pruneExpired(store, now = Date.now()) {
  for (const key of Object.keys(store)) {
    const row = store[key];
    if (!row || typeof row !== 'object') {
      delete store[key];
      continue;
    }
    const ttl = row.data ? TTL_MS : NEG_TTL_MS;
    if (now - (row.at || 0) >= ttl) delete store[key];
  }
}

function pruneMemory() {
  const now = Date.now();
  for (const [key, row] of memory) {
    const ttl = row && row.data ? TTL_MS : NEG_TTL_MS;
    if (!row || now - (row.at || 0) >= ttl) memory.delete(key);
  }
  if (memory.size <= MAX_MEMORY) return;
  const oldest = [...memory.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
  const drop = oldest.length - MAX_MEMORY;
  for (let i = 0; i < drop; i++) memory.delete(oldest[i][0]);
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const file = cacheFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const store = loadDisk();
      pruneExpired(store);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(store));
      fs.renameSync(tmp, file);
    } catch (err) {
      log.warn('Meta cache save failed', err);
    }
  }, 800);
}

function getCached(key) {
  const now = Date.now();
  const mem = memory.get(key);
  if (mem) {
    const ttl = mem.data ? TTL_MS : NEG_TTL_MS;
    if (now - mem.at < ttl) return { hit: true, data: mem.data };
  }
  const row = loadDisk()[key];
  if (row && typeof row === 'object') {
    const ttl = row.data ? TTL_MS : NEG_TTL_MS;
    if (now - (row.at || 0) < ttl) {
      memory.set(key, row);
      return { hit: true, data: row.data };
    }
  }
  return { hit: false, data: null };
}

function putCache(key, data) {
  const row = { at: Date.now(), data: data || null };
  memory.set(key, row);
  loadDisk()[key] = row;
  pruneMemory();
  scheduleSave();
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanName(name) {
  return String(name || '')
    .replace(/\[[^\]]*]/g, ' ')
    .replace(/\([^)]*\d{3,4}[^)]*\)/g, ' ')
    .replace(/\b(4k|uhd|hdr10\+?|hdr|h\.?265|hevc|x264|1080p|720p|480p|fhd|hd|sd|multi-audio|dual audio)\b/ig, ' ')
    .replace(/\bs\d{1,2}\s*e\d{1,3}\b/ig, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function imageOf(img) {
  if (!img || typeof img !== 'object') return '';
  return String(img.original || img.medium || '');
}

function resolutionUrl(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const res = entry.resolutions || {};
  return String((res.original && res.original.url) || (res.medium && res.medium.url) || '');
}

function isWide(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  return w >= 400 && w >= h * 1.25;
}

async function tvmazeBackdrop(showId) {
  const id = Number(showId) || 0;
  if (!id) return '';
  const key = `tvbg:${id}`;
  const cached = getCached(key);
  if (cached.hit) return cached.data || '';
  try {
    const images = await getJson(`https://api.tvmaze.com/shows/${id}/images`, { timeoutMs: 8000 });
    const list = Array.isArray(images) ? images : [];
    const picked = list
      .filter((img) => img && img.type === 'background' && resolutionUrl(img))
      .sort((a, b) => {
        const aw = (a.resolutions && a.resolutions.original && a.resolutions.original.width) || 0;
        const bw = (b.resolutions && b.resolutions.original && b.resolutions.original.width) || 0;
        return bw - aw;
      })[0];
    const wide = resolutionUrl(picked);
    putCache(key, wide || null);
    return wide;
  } catch (err) {
    log.warn(`TVMaze images lookup failed for ${id}`, err);
    putCache(key, null);
    return '';
  }
}

async function wikipediaBackdrop(name) {
  const q = cleanName(name);
  if (q.length < 2) return '';
  const key = `wiki:${q.toLowerCase()}`;
  const cached = getCached(key);
  if (cached.hit) return cached.data || '';
  const headers = { 'Api-User-Agent': 'Cipher/1.0 (home hub; local media app)' };
  const tries = [q, `${q} (film)`, `${q} (movie)`, `${q} (TV series)`];
  try {
    let fallback = '';
    for (const term of tries) {
      try {
        const data = await getJson(
          `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(term)}`,
          { timeoutMs: 7000, headers },
        );
        const img = (data && (data.originalimage || data.thumbnail)) || null;
        if (!img || !img.source) continue;
        if (isWide(img.width, img.height)) {
          putCache(key, img.source);
          return img.source;
        }
        if (!fallback) fallback = img.source;
      } catch {
        /* try next title */
      }
    }
    putCache(key, fallback || null);
    return fallback;
  } catch (err) {
    log.warn(`Wikipedia image lookup failed for "${q}"`, err);
    putCache(key, null);
    return '';
  }
}

async function tvmazeShow(name) {
  const q = cleanName(name);
  if (q.length < 2) return null;
  const key = `tv2:${q.toLowerCase()}`;
  const cached = getCached(key);
  if (cached.hit) return cached.data;
  try {
    const results = await getJson(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(q)}`, { timeoutMs: 8000 });
    const show = Array.isArray(results) && results[0] && results[0].show;
    const data = show ? {
      name: show.name || q,
      plot: stripHtml(show.summary),
      poster: imageOf(show.image),
      backdrop: '',
      genre: Array.isArray(show.genres) ? show.genres.join(', ') : '',
      rating: show.rating && show.rating.average ? Number(show.rating.average) : 0,
      year: String(show.premiered || '').slice(0, 4),
      tvmazeId: show.id,
    } : null;
    if (data && show.id) data.backdrop = await tvmazeBackdrop(show.id);
    if (data && !data.backdrop) data.backdrop = await wikipediaBackdrop(data.name || q) || data.poster;
    putCache(key, data);
    return data;
  } catch (err) {
    log.warn(`TVMaze show lookup failed for "${q}"`, err);
    putCache(key, null);
    return null;
  }
}

async function tvmazeEpisode(name, season, episode) {
  const show = await tvmazeShow(name);
  if (!show || !show.tvmazeId) return show;
  const s = Number(season) || 0;
  const e = Number(episode) || 0;
  if (!s || !e) return show;
  const key = `ep2:${show.tvmazeId}:${s}:${e}`;
  const cached = getCached(key);
  if (cached.hit) {
    return { ...show, ...(cached.data || {}), backdrop: show.backdrop || (cached.data && cached.data.backdrop) || '' };
  }
  try {
    const ep = await getJson(
      `https://api.tvmaze.com/shows/${show.tvmazeId}/episodebynumber?season=${s}&number=${e}`,
      { timeoutMs: 8000 },
    );
    const data = ep ? {
      episodeTitle: String(ep.name || '').trim(),
      episodePlot: stripHtml(ep.summary),
      episodePoster: imageOf(ep.image),
      backdrop: show.backdrop || imageOf(ep.image),
    } : null;
    putCache(key, data);
    return { ...show, ...(data || {}) };
  } catch (err) {
    log.warn(`TVMaze episode lookup failed for "${cleanName(name)} S${s}E${e}"`, err);
    putCache(key, null);
    return show;
  }
}

function itunesArt(url) {
  return String(url || '').replace(/\d+x\d+bb/, '600x600bb');
}

async function itunesMovie(name) {
  const term = cleanName(name);
  if (term.length < 2) return null;
  const key = `it2:${term.toLowerCase()}`;
  const cached = getCached(key);
  if (cached.hit) return cached.data;
  try {
    const data = await getJson(
      `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=movie&entity=movie&limit=1`,
      { timeoutMs: 8000 },
    );
    const item = data && Array.isArray(data.results) ? data.results[0] : null;
    const poster = item ? itunesArt(item.artworkUrl100 || item.artworkUrl60) : '';
    const out = {
      name: (item && item.trackName) || term,
      plot: '',
      poster,
      backdrop: '',
      genre: (item && item.primaryGenreName) || '',
      rating: (item && item.contentAdvisoryRating) || '',
      year: String((item && item.releaseDate) || '').slice(0, 4),
    };
    out.backdrop = await wikipediaBackdrop(out.name || term) || poster;
    if (!item && !out.backdrop) {
      putCache(key, null);
      return null;
    }
    putCache(key, out);
    return out;
  } catch (err) {
    log.warn(`iTunes movie lookup failed for "${term}"`, err);
    putCache(key, null);
    return null;
  }
}

module.exports = { tvmazeShow, tvmazeEpisode, itunesMovie, cleanName, wikipediaBackdrop };
