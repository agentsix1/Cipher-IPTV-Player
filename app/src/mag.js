'use strict';

const { getText, request } = require('./http');
const log = require('./log');

/**
 * MAG / Stalker middleware portals (portal URL + MAC address). Every call goes to the portal's
 * load.php with `type` and `action`; lists are paged (usually 14 items per page) except the live
 * channel list, which `get_all_channels` returns in one response.
 */

const MAG_UA = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';
const PAGE_CONCURRENCY = 6;
const SESSION_TTL_MS = 6 * 3600 * 1000;

/** "portal|mac" -> Promise of { endpoint, origin, mac, token, timezone, profile, openedAt } */
const sessions = new Map();

function normalizeMac(value) {
  const hex = String(value || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  return hex.length === 12 ? hex.match(/../g).join(':') : '';
}

/** Portal address without query, trailing slash, or the STB client folder (/c). */
function normalizePortal(url) {
  let value = String(url || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  try {
    const u = new URL(value);
    let path = u.pathname.replace(/\/+$/, '');
    if (!/\.php$/i.test(path)) path = path.replace(/\/c$/i, '');
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return '';
  }
}

function endpointCandidates(portal) {
  if (/\.php$/i.test(portal)) return [portal];
  const out = [`${portal}/server/load.php`, `${portal}/portal.php`];
  if (!/\/stalker_portal$/i.test(portal)) out.push(`${portal}/stalker_portal/server/load.php`);
  return out;
}

/** Stream URL from a portal `cmd` ("ffmpeg http://...", "auto http://..."). */
function cmdUrl(cmd) {
  return String(cmd || '')
    .replace(/\\\//g, '/')
    .replace(/\\/g, '')
    .trim()
    .replace(/^(?:ffmpeg|ffrt\d?|auto)\s+/i, '')
    .trim();
}

function isHttp(url) {
  return /^https?:\/\//i.test(url);
}

/** User-Agent for portal API and stream requests: MAG boxes are rejected if a browser UA is sent. */
function streamUserAgent(playlist) {
  const custom = String((playlist && playlist.user_agent) || '').trim();
  if (custom) return custom;
  return MAG_UA;
}

function streamHeaders(playlist, creds) {
  if (!playlist || playlist.type !== 'mag') return {};
  const mac = (creds && creds.mac) || playlist.username || '';
  const tz = (creds && creds.timezone) || 'Europe/London';
  if (!mac) return {};
  let origin = '';
  try {
    origin = new URL((creds && creds.portal) || playlist.server_url).origin;
  } catch { /* ignore */ }
  const headers = {
    Cookie: `mac=${mac}; stb_lang=en; timezone=${tz}`,
    'X-User-Agent': 'Model: MAG250; Link: WiFi',
  };
  if (origin) {
    headers.Referer = `${origin}/c/`;
    headers.Origin = origin;
  }
  // Bearer is for portal load.php only. Sending it to the CDN gets HTTP 403/460.
  return headers;
}

function applySession(creds, session) {
  if (!creds || !session) return;
  creds.token = session.token;
  creds.timezone = session.timezone;
  creds.endpoint = session.endpoint;
}

/** True when a URL is a portal tmp / play_token CDN link (must be re-minted at play time). */
function isTmpPlayUrl(url) {
  if (!isHttp(url)) return false;
  return /play_token=/i.test(url)
    || /\/play\/(?:live|movie|timeshift)\.php/i.test(url)
    || /\/play\//i.test(url);
}

/** True when a channel's cmd is a placeholder the portal must turn into a real link at play time. */
function needsLink(channel, url) {
  if (!isHttp(url)) return true;
  if (isTmpPlayUrl(url)) return true;
  if (String(channel.use_http_tmp_link) === '1' || String(channel.use_load_balancing) === '1') return true;
  try {
    return /^(localhost|127\.0\.0\.1)$/i.test(new URL(url).hostname);
  } catch {
    return true;
  }
}

class PortalError extends Error {}

async function rawCall(session, params, { userAgent, timeoutMs = 30000 } = {}) {
  const query = new URLSearchParams({ ...params, mac: session.mac, JsHttpRequest: '1-xml' });
  const headers = {
    'X-User-Agent': 'Model: MAG250; Link: WiFi',
    Cookie: `mac=${session.mac}; stb_lang=en; timezone=${session.timezone || 'Europe/London'}`,
    Referer: `${session.origin}/c/`,
  };
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  const text = await getText(`${session.endpoint}?${query}`, {
    userAgent: userAgent || MAG_UA,
    headers,
    timeoutMs,
    family: 4,
  });
  if (!text.trim()) return { js: null };
  try {
    return JSON.parse(text);
  } catch {
    if (/authori[sz]ation failed/i.test(text)) throw new PortalError('auth');
    throw new Error(`The portal returned an unexpected reply (${text.slice(0, 80).replace(/\s+/g, ' ')})`);
  }
}

async function openSession(creds, opts) {
  const origin = new URL(creds.portal).origin;
  const list = [...new Set([creds.endpoint, ...endpointCandidates(creds.portal)].filter(Boolean))];
  const deadline = Date.now() + Math.max(5000, Number(opts && opts.deadlineMs) || 25000);
  let lastError = null;
  for (const endpoint of list) {
    const left = deadline - Date.now();
    if (left < 1200) {
      lastError = lastError || new Error('timed out');
      break;
    }
    const session = { endpoint, origin, mac: creds.mac, token: '', timezone: 'Europe/London', profile: null, openedAt: Date.now() };
    try {
      const shake = await rawCall(session, { type: 'stb', action: 'handshake', token: '', prehash: '0' }, { ...opts, timeoutMs: Math.min(20000, left) });
      if (!shake || !('js' in shake)) continue;
      session.token = (shake.js && shake.js.token) || '';
      const profileLeft = deadline - Date.now();
      if (profileLeft < 800) throw new Error('timed out');
      const profile = await rawCall(session, { type: 'stb', action: 'get_profile', hd: '1', ver: '', num_banks: '2', stb_type: 'MAG250', image_version: '218', hw_version: '1.7-BD-00', not_valid_token: '0', auth_second_step: '1' }, { ...opts, timeoutMs: Math.min(15000, profileLeft) });
      const js = profile && profile.js;
      if (js && typeof js === 'object') {
        if (String(js.blocked) === '1') throw new Error('The portal has blocked this MAC address');
        if (js.default_timezone) session.timezone = js.default_timezone;
        session.profile = js;
      }
      return session;
    } catch (err) {
      lastError = err;
      if (/blocked/.test(err.message)) throw err;
    }
  }
  throw new Error(`Could not connect to a MAG portal at ${creds.portal}${lastError ? ` (${lastError.message})` : ''}`);
}

function sessionFor(creds, opts, fresh = false) {
  const key = `${creds.portal}|${creds.mac}`;
  const cached = sessions.get(key);
  if (cached && !fresh && Date.now() - cached.openedAt < SESSION_TTL_MS) return cached.promise;
  const entry = { openedAt: Date.now(), promise: openSession(creds, opts) };
  entry.promise.catch(() => sessions.delete(key));
  sessions.set(key, entry);
  return entry.promise;
}

/** One portal call; re-handshakes once when the portal rejects the session token. */
async function call(creds, params, opts = {}) {
  let session = await sessionFor(creds, opts);
  applySession(creds, session);
  try {
    return await rawCall(session, params, opts);
  } catch (err) {
    if (!(err instanceof PortalError)) throw err;
    session = await sessionFor(creds, opts, true);
    applySession(creds, session);
    return rawCall(session, params, opts);
  }
}

/** Connects (handshake + profile) and returns the session details worth caching with the playlist. */
async function connect(creds, opts = {}) {
  const session = await sessionFor(creds, opts, true);
  const out = {
    portal: creds.portal,
    mac: creds.mac,
    endpoint: session.endpoint,
    timezone: session.timezone,
    token: session.token,
  };
  applySession(creds, session);
  return out;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function pageData(reply) {
  const js = reply && reply.js;
  return {
    data: Array.isArray(js && js.data) ? js.data : [],
    total: Number(js && js.total_items) || 0,
    per: Number(js && js.max_page_items) || 0,
  };
}

/** Every page of a paged list (`p` starts at 1). `opts.maxPages` caps how many pages are fetched. */
async function allPages(creds, params, opts = {}) {
  const first = pageData(await call(creds, { ...params, p: 1 }, opts));
  const per = first.per || first.data.length || 14;
  const wanted = first.total > first.data.length ? Math.ceil(first.total / per) : 1;
  const pages = opts.maxPages > 0 ? Math.min(wanted, opts.maxPages) : wanted;
  const rest = await mapLimit(Array.from({ length: Math.max(0, pages - 1) }, (_v, i) => i + 2), PAGE_CONCURRENCY, async (p) => {
    try {
      return pageData(await call(creds, { ...params, p }, opts)).data;
    } catch (err) {
      log.warn(`MAG page ${p} of ${params.type}/${params.action} failed`, err);
      return [];
    }
  });
  const seen = new Set();
  const out = [];
  for (const row of first.data.concat(...rest)) {
    const id = row && row.id != null ? String(row.id) : '';
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    out.push(row);
  }
  return { items: out, total: first.total || out.length };
}

function categoryRows(reply) {
  const rows = Array.isArray(reply && reply.js) ? reply.js : [];
  return rows
    .filter((c) => c && c.id != null && String(c.id) !== '*')
    .map((c) => ({ id: String(c.id), name: String(c.title || c.alias || 'Other').trim() || 'Other' }));
}

function absoluteLogo(origin, logo) {
  const value = String(logo || '').trim();
  if (!value) return '';
  if (isHttp(value)) return value;
  return value.startsWith('/') ? `${origin}${value}` : '';
}

/** Live channels and their groups. */
async function loadLive(creds, opts = {}) {
  const callOpts = { ...opts, timeoutMs: Number(opts.timeoutMs) || 90000 };
  let genres = [];
  try {
    genres = categoryRows(await call(creds, { type: 'itv', action: 'get_genres' }, opts));
  } catch (err) {
    log.warn(`MAG get_genres failed for ${creds.portal}`, err);
  }
  let rows = null;
  try {
    const reply = await call(creds, { type: 'itv', action: 'get_all_channels' }, callOpts);
    rows = reply && reply.js && (Array.isArray(reply.js.data) ? reply.js.data : (Array.isArray(reply.js) ? reply.js : null));
  } catch (err) {
    log.warn(`MAG get_all_channels failed for ${creds.portal}; falling back to get_ordered_list`, err);
  }
  if (!rows || !rows.length) {
    rows = (await allPages(creds, { type: 'itv', action: 'get_ordered_list', genre: '*', sortby: 'number' }, opts)).items;
  }

  const origin = new URL(creds.portal).origin;
  const groupNames = new Map(genres.map((g) => [g.id, g.name]));
  const channels = [];
  const seen = new Set();
  rows.forEach((c, index) => {
    const chId = String(c.id || '').trim();
    if (!chId || seen.has(chId)) return;
    seen.add(chId);
    const url = cmdUrl(c.cmd);
    const groupId = String(c.tv_genre_id || '0');
    const hours = Number(c.tv_archive_duration) || 0;
    const archive = (Number(c.tv_archive) === 1 || Number(c.enable_tv_archive) === 1 || Number(c.archive) === 1) && hours !== 0;
    const channel = {
      id: `g${chId}`,
      name: String(c.name || '').trim() || `Channel ${chId}`,
      logo: absoluteLogo(origin, c.logo),
      groupId,
      groupName: groupNames.get(groupId) || (groupId === '0' ? 'Uncategorized' : `Group ${groupId}`),
      num: Number(c.number) || index + 1,
      epgId: String(c.xmltv_id || '').trim(),
      streamId: Number(chId) || 0,
      chId,
      url,
      catchup: archive,
      catchupDays: archive ? Math.max(1, Math.ceil((hours > 0 ? hours : 168) / 24)) : 0,
      catchupHours: archive ? (hours > 0 ? hours : 168) : 0,
      catchupSource: '',
    };
    // Always keep the portal cmd for create_link — catalog URLs often embed ephemeral play_tokens.
    channel.linkCmd = String(c.cmd || '') || `ffmpeg http://localhost/ch/${chId}`;
    channels.push(channel);
  });

  const groups = genres.map((g, order) => ({ id: g.id, name: g.name, order }));
  const known = new Set(groups.map((g) => g.id));
  for (const c of channels) {
    if (known.has(c.groupId)) continue;
    known.add(c.groupId);
    // When get_genres fails/resets, keep each tv_genre_id as its own group so the UI
    // does not collapse every channel into a single "Uncategorized" bucket.
    groups.push({
      id: c.groupId,
      name: groupNames.get(c.groupId) || (c.groupId === '0' ? 'Uncategorized' : `Group ${c.groupId}`),
      order: groups.length,
    });
  }
  return { channels, groups };
}

/** Stream URL for a live channel. Tokens go stale, so a fresh link is minted at play time. */
async function liveUrl(creds, channel, opts = {}) {
  const chId = channel.chId || String(channel.streamId || '');
  // Never feed a full CDN http(s) cmd into create_link — portals empty stream= and the CDN 405/460s.
  const rawCmd = String(channel.linkCmd || '').trim();
  const cmd = rawCmd && !/^ffmpeg\s+https?:\/\//i.test(rawCmd) && !isTmpPlayUrl(cmdUrl(rawCmd))
    ? rawCmd
    : `ffmpeg http://localhost/ch/${chId}`;
  let reply = null;
  try {
    reply = await call(creds, {
      type: 'itv', action: 'create_link', cmd, series: '', forced_storage: 'undefined', disable_ad: '0', download: '0',
    }, opts);
  } catch (err) {
    log.warn(`MAG create_link failed for ch ${chId}: ${err.message}`);
  }
  const url = cmdUrl(reply && reply.js && reply.js.cmd);
  // Prefer any freshly minted HTTP link over a catalog URL that still carries play_token.
  if (isHttp(url) && /(?:\?|&)stream=\d+/.test(url)) return url;
  if (isHttp(url)) return url;
  if (isHttp(channel.url) && !isTmpPlayUrl(channel.url)) return channel.url;
  throw new Error('The portal did not return a stream link for this channel');
}

// ---- Guide ----------------------------------------------------------------------------------------

const DESC_MAX = 600;

function toProgramme(p) {
  const start = Number(p.start_timestamp) * 1000;
  const end = Number(p.stop_timestamp) * 1000;
  if (!(start > 0) || !(end > start)) return null;
  let desc = String(p.descr || '').trim();
  if (desc.length > DESC_MAX) desc = `${desc.slice(0, DESC_MAX - 3)}...`;
  return [start, end, String(p.name || '').trim() || 'Untitled', desc];
}

/** Sorted, de-duplicated programme list; entries in `more` win over `base` at the same start time. */
function mergeProgrammes(base, more) {
  const byStart = new Map();
  for (const p of base || []) if (p) byStart.set(p[0], p);
  for (const p of more || []) {
    if (!p) continue;
    const old = byStart.get(p[0]);
    byStart.set(p[0], old && !p[3] && old[3] ? [p[0], p[1], p[2], old[3]] : p);
  }
  const list = [...byStart.values()].sort((a, b) => a[0] - b[0]);
  for (let i = list.length - 1; i > 0; i--) {
    if (list[i][0] < list[i - 1][1]) list.splice(i, 1);
  }
  return list;
}

/** The portal's bulk guide: get_epg_info returns every channel's next programmes for `period` hours. */
async function loadEpg(creds, { period = 96, ...opts } = {}) {
  const reply = await call(creds, { type: 'itv', action: 'get_epg_info', period: String(period) }, { ...opts, timeoutMs: 180000 });
  const data = (reply && reply.js && reply.js.data) || {};
  const programmes = new Map();
  let count = 0;
  for (const [chId, rows] of Object.entries(data)) {
    if (!Array.isArray(rows)) continue;
    const list = mergeProgrammes([], rows.map(toProgramme));
    if (!list.length) continue;
    programmes.set(String(chId).toLowerCase(), list);
    count += list.length;
  }
  return { programmes, count };
}

/** Several days of one channel's guide (titles only on most portals). */
async function loadChannelEpg(creds, chId, opts = {}) {
  const reply = await call(creds, { type: 'epg', action: 'get_all_program_for_ch', ch_id: chId }, opts);
  const rows = Array.isArray(reply && reply.js) ? reply.js : [];
  return mergeProgrammes([], rows.map(toProgramme));
}

/** One day of a channel's guide with programme ids (needed for archive links). `date` is yyyy-mm-dd, portal time. */
async function loadDayTable(creds, chId, date, opts = {}) {
  const { items } = await allPages(creds, { type: 'epg', action: 'get_simple_data_table', ch_id: chId, date }, opts);
  return items;
}

function portalDate(ms, timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

const pad = (n) => String(n).padStart(2, '0');

/** Offset (ms) of portal wall-clock time from UTC, read from a programme's "time" and timestamp. */
function offsetOf(row) {
  const wall = Date.parse(`${String(row.time || '').replace(' ', 'T')}Z`);
  const ts = Number(row.start_timestamp) * 1000;
  return Number.isFinite(wall) && ts > 0 ? Math.round((wall - ts) / 60000) * 60000 : 0;
}

function wallStart(ms, offset) {
  const d = new Date(ms + offset);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}:${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}`;
}

/** Guide rows (with ids) for the days around `ms`, newest day first. */
async function dayRowsAround(creds, chId, ms, opts) {
  const dates = [...new Set([portalDate(ms, creds.timezone), portalDate(ms - 86400000, creds.timezone), portalDate(ms + 86400000, creds.timezone)])];
  const rows = [];
  for (const date of dates) {
    const day = await loadDayTable(creds, chId, date, opts).catch(() => []);
    rows.push(...day);
    if (day.some((p) => Number(p.start_timestamp) * 1000 <= ms && Number(p.stop_timestamp) * 1000 > ms)) break;
  }
  return rows;
}

/**
 * Archive (catch-up) URL for a channel from `startMs` to `endMs` (real air time, catch-up shift
 * already applied). Uses the portal's tv_archive link for the programme airing at `startMs`; when
 * the portal answers with a timeshift URL (start/duration in the query) it is moved to the exact start.
 */
async function archiveUrls(creds, channel, startMs, endMs, opts = {}) {
  const chId = channel.chId || String(channel.streamId || '');
  const start = Math.floor(startMs / 60000) * 60000;
  const minutes = Math.max(1, Math.ceil(((endMs || start + 3600000) - start) / 60000));
  const rows = await dayRowsAround(creds, chId, start, opts);
  const programme = rows.find((p) => Number(p.start_timestamp) * 1000 === start)
    || rows.find((p) => Number(p.start_timestamp) * 1000 <= start && Number(p.stop_timestamp) * 1000 > start);
  const offset = rows.length ? offsetOf(rows[0]) : 0;
  const urls = [];

  if (programme && programme.id != null) {
    const reply = await call(creds, {
      type: 'tv_archive', action: 'create_link', cmd: `auto /media/${programme.id}.mpg`,
      series: '', forced_storage: '', disable_ad: '0', download: '0', force_ch_link_check: '0',
    }, opts).catch((err) => {
      log.warn(`MAG archive link for ${chId} failed`, err);
      return null;
    });
    const url = cmdUrl(reply && reply.js && reply.js.cmd);
    if (isHttp(url)) {
      const progStart = Number(programme.start_timestamp) * 1000;
      urls.push(progStart === start ? url : retimeTimeshift(url, start, minutes, offset));
    }
  }

  // Xtream-backed portals: the live link's timeshift twin, if the programme lookup found nothing.
  if (!urls.length && /\/play\/live\.php\?/i.test(channel.url || '')) {
    const u = new URL(channel.url);
    u.pathname = u.pathname.replace(/live\.php$/i, 'timeshift.php');
    u.searchParams.set('start', wallStart(start, offset));
    u.searchParams.set('duration', String(minutes));
    urls.push(u.toString());
  }
  return urls;
}

/** Moves a timeshift URL (start=yyyy-mm-dd:HH-MM&duration=N) to another start and length. */
function retimeTimeshift(url, start, minutes, offset) {
  try {
    const u = new URL(url);
    if (!/^\d{4}-\d{2}-\d{2}:\d{2}-\d{2}$/.test(u.searchParams.get('start') || '')) return url;
    u.searchParams.set('start', wallStart(start, offset));
    if (u.searchParams.has('duration')) u.searchParams.set('duration', String(minutes));
    return u.toString();
  } catch {
    return url;
  }
}

// ---- Movies and series ----------------------------------------------------------------------------

async function loadVodCategories(creds, opts = {}) {
  const [movieCats, seriesCats] = await Promise.all([
    call(creds, { type: 'vod', action: 'get_categories' }, opts).then(categoryRows).catch(() => []),
    call(creds, { type: 'series', action: 'get_categories' }, opts).then(categoryRows).catch(() => []),
  ]);
  return { movieCats, seriesCats };
}

function vodItem(row, categoryId) {
  return {
    id: String(row.id),
    name: String(row.name || row.o_name || '').trim() || `Title ${row.id}`,
    poster: String(row.screenshot_uri || row.pic || '').trim(),
    categoryId: String(row.category_id || categoryId || '0'),
    cmd: String(row.cmd || ''),
    plot: String(row.description || '').trim(),
    year: String(row.year || '').slice(0, 4).replace(/\D/g, ''),
    genre: String(row.genres_str || '').trim(),
  };
}

const vodType = (kind) => (kind === 'series' ? 'series' : 'vod');

/** One page of a category: { items, total }. */
async function loadCategoryPage(creds, kind, categoryId, page, opts = {}) {
  const reply = await call(creds, { type: vodType(kind), action: 'get_ordered_list', category: categoryId, genre: categoryId, sortby: 'added', p: page }, opts);
  const { data, total } = pageData(reply);
  return { items: data.filter((r) => r && r.id != null).map((r) => vodItem(r, categoryId)), total };
}

/** Every title in a category. */
async function loadCategory(creds, kind, categoryId, opts = {}) {
  const { items, total } = await allPages(creds, { type: vodType(kind), action: 'get_ordered_list', category: categoryId, genre: categoryId, sortby: 'added' }, opts);
  return { items: items.filter((r) => r && r.id != null).map((r) => vodItem(r, categoryId)), total };
}

/**
 * Portal-wide movie/series search (`get_ordered_list` + `search=`). MAG catalogs are paged, so
 * local first-page caches miss titles that are not at the top of a category.
 */
async function searchTitles(creds, query, opts = {}) {
  const q = String(query || '').trim();
  const movies = [];
  const series = [];
  if (!q) return { movies, series };
  const kinds = opts.kinds && opts.kinds.length ? opts.kinds : ['movies', 'series'];
  const searchOpts = { ...opts, maxPages: Math.max(1, Math.min(12, opts.maxPages || 6)), timeoutMs: opts.timeoutMs || 20000 };

  async function searchKind(kind) {
    const type = vodType(kind);
    const bucket = kind === 'series' ? series : movies;
    const seen = new Set();
    const shapes = [
      { type, action: 'get_ordered_list', search: q, sortby: 'name' },
      { type, action: 'get_ordered_list', search: q, genre: '*', sortby: 'added' },
    ];
    for (const params of shapes) {
      try {
        const { items } = await allPages(creds, params, searchOpts);
        let added = 0;
        for (const row of items) {
          if (!row || row.id == null) continue;
          const item = vodItem(row, row.category_id || row.genre_id || '0');
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          bucket.push(item);
          added += 1;
        }
        if (added) break;
      } catch (err) {
        log.warn(`MAG ${kind} search failed`, err);
      }
    }
  }

  await Promise.all(kinds.map(searchKind));
  return { movies, series };
}

function seasonNumber(row, index) {
  const fromId = Number(String(row.id || '').split(':').pop());
  if (Number.isInteger(fromId) && fromId > 0) return fromId;
  const fromName = Number((String(row.name || '').match(/(\d+)/) || [])[1]);
  return fromName > 0 ? fromName : index + 1;
}

/** A series' episodes. Portals list seasons; each season's `series` array holds its episode numbers. */
async function loadSeriesEpisodes(creds, seriesId, opts = {}) {
  const { items: seasons } = await allPages(creds, { type: 'series', action: 'get_ordered_list', movie_id: seriesId, season_id: '0', episode_id: '0' }, opts);
  const episodes = [];
  seasons.forEach((row, index) => {
    const season = seasonNumber(row, index);
    const numbers = Array.isArray(row.series) && row.series.length ? row.series : [];
    for (const n of numbers) {
      const episode = Number(n) || 0;
      if (!episode) continue;
      episodes.push({
        id: `${row.id}:${episode}`,
        season,
        episode,
        title: `Episode ${episode}`,
        plot: '',
        poster: String(row.screenshot_uri || '').trim(),
        cmd: String(row.cmd || ''),
        duration: 0,
      });
    }
  });
  episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
  return { seasons: seasons.length, episodes };
}

/** True when create_link returned a usable CDN URL (not stream=. / empty). */
function isPlayableMagUrl(url) {
  if (!isHttp(url)) return false;
  try {
    const u = new URL(url);
    // Path-token CDNs (…/play/<token>) have no query — those are valid.
    // Only reject when the portal echoes a broken stream= / stream=. placeholder.
    if (u.searchParams.has('stream')) {
      const stream = String(u.searchParams.get('stream') || '').trim();
      if (stream === '' || stream === '.') return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function createVodLink(creds, params, opts = {}) {
  // Episodes: prefer type=series when the portal supports it; most Ministra forks only
  // answer on type=vod with series=<episode> + a season cmd.
  const types = params.series ? ['series', 'vod'] : ['vod'];
  const cmds = [];
  const cmd = String(params.cmd || '').trim();
  const raw = cmdUrl(cmd);
  // Do not pass ephemeral CDN play URLs back into create_link — they return stream= empty / 460.
  if (cmd && !isTmpPlayUrl(raw)) {
    cmds.push(cmd);
    // cmdUrl() is for "ffmpeg http://..." wrappers. Do NOT push a second copy of
    // base64 JSON cmds (cmdUrl leaves them unchanged) — duplicate create_link
    // calls burn single-use play_tokens.
    if (raw && raw !== cmd && !isTmpPlayUrl(raw) && /^https?:\/\//i.test(raw)) cmds.push(raw);
  } else if (!cmd || isTmpPlayUrl(raw)) {
    // Only when we have no real cmd: try file_id-only mint as a last resort.
    cmds.push('');
  }
  const seenCmd = new Set();
  for (const type of types) {
    for (const useCmd of cmds) {
      const key = `${type}|${useCmd}`;
      if (seenCmd.has(key)) continue;
      seenCmd.add(key);
      const reply = await call(creds, {
        type,
        action: 'create_link',
        cmd: useCmd,
        file_id: params.file_id || '',
        series: params.series || '',
        forced_storage: '',
        disable_ad: '0',
        download: '0',
        force_ch_link_check: '0',
      }, opts).catch((err) => {
        log.warn(`MAG VOD create_link failed (${type}): ${err.message}`);
        return null;
      });
      const url = cmdUrl(reply && reply.js && reply.js.cmd);
      if (!isPlayableMagUrl(url)) continue;
      // Return the first good link immediately — further create_link calls on this
      // portal invalidate the previous play_token (HTTP 462 on the CDN).
      return params.series ? withEpisodeParams(url, params.series) : url;
    }
  }
  return '';
}

/** Barry-style movie.php series links 404 when sn2 (episode) is missing. */
function withEpisodeParams(url, episode) {
  const ep = String(episode || '').trim();
  if (!ep) return url;
  try {
    const u = new URL(url);
    if (/movie\.php/i.test(u.pathname)) {
      if (!u.searchParams.get('type')) u.searchParams.set('type', 'series');
      if (!String(u.searchParams.get('sn2') || '').trim()) u.searchParams.set('sn2', ep);
    }
    return u.toString();
  } catch {
    return url;
  }
}

function episodeLinkScore(url, episode) {
  try {
    const u = new URL(url);
    const ep = String(episode || '');
    const sn2 = String(u.searchParams.get('sn2') || '').trim();
    const series = (u.searchParams.get('type') || '').toLowerCase() === 'series';
    let n = 0;
    if (u.searchParams.get('play_token')) n += 1;
    if (ep && sn2 === ep) n += 8;
    else if (sn2) n += 2;
    else if (series) n -= 6;
    return n;
  } catch {
    return 0;
  }
}

/** Build the base64 JSON cmd many MAG portals expect when the catalog row omitted it. */
function synthesizeMovieCmd(movieId, container = 'mp4') {
  const payload = {
    type: 'movie',
    stream_id: String(movieId),
    stream_source: null,
    target_container: JSON.stringify([container]),
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

/** Strip quality/provider prefixes so "4K-NF - Spy Kids…" matches portal search. */
function searchName(name) {
  return String(name || '')
    .replace(/^\s*(?:4K[\s_-]*)?(?:NF|EN|CR|TOP|UHD|HDR|DV|ATMOS)[\s_-]*/ig, '')
    .replace(/^\s*[-–:|]+\s*/, '')
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function titlesRelated(a, b) {
  const na = searchName(a).toLowerCase();
  const nb = searchName(b).toLowerCase();
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/** Peek one URL with one header set. play_tokens are single-use on success. */
async function peekMedia(url, headers, opts = {}) {
  const { res } = await request(url, {
    userAgent: opts.userAgent || MAG_UA,
    headers: headers || {},
    timeoutMs: 12000,
    family: 4,
    agent: 'stream',
  });
  const status = res.statusCode;
  if (status >= 400) {
    res.resume();
    return { ok: false, status };
  }
  const chunks = [];
  let n = 0;
  for await (const c of res) {
    chunks.push(c);
    n += c.length;
    if (n >= 32) break;
  }
  try { res.resume(); } catch { /* ignore */ }
  if (n < 8) return { ok: false, status };
  const buf = Buffer.concat(chunks);
  // Reject HTML/JSON error bodies; accept MP4/MKV/TS magic.
  if (buf[0] === 0x3c /* < */ || buf[0] === 0x7b /* { */) return { ok: false, status };
  return { ok: true, status };
}

/** Peek the CDN — play_tokens are single-use, so callers must re-mint after a success. */
async function linkDeliversMedia(url, creds, opts = {}) {
  if (!isPlayableMagUrl(url)) return false;
  let origin = '';
  try { origin = new URL(creds.portal).origin; } catch { /* ignore */ }
  const cookieHeaders = {
    Cookie: `mac=${creds.mac}; stb_lang=en; timezone=${creds.timezone || 'Europe/London'}`,
    'X-User-Agent': 'Model: MAG250; Link: WiFi',
  };
  if (origin) {
    cookieHeaders.Referer = `${origin}/c/`;
    cookieHeaders.Origin = origin;
  }
  // Some MAG CDNs 456 when Cookie/Origin hitch a ride — also try UA-only.
  const tries = [
    cookieHeaders,
    { 'X-User-Agent': 'Model: MAG250; Link: WiFi' },
    {},
  ];
  for (const headers of tries) {
    try {
      const peek = await peekMedia(url, headers, opts);
      if (peek.ok) return true;
    } catch {
      /* try next header set */
    }
  }
  return false;
}

/**
 * Mint a link and verify the CDN serves media. Re-mints after a successful peek
 * because play_tokens are single-use on these portals.
 */
async function mintCheckedMovieLink(creds, cmd, fileId, opts = {}) {
  const first = await createVodLink(creds, { cmd, file_id: fileId, series: '' }, opts);
  if (!first) return '';
  if (!(await linkDeliversMedia(first, creds, opts))) return '';
  return createVodLink(creds, { cmd, file_id: fileId, series: '' }, opts);
}

/** Playable URL for a movie ({ id, cmd }). */
async function movieUrl(creds, movie, opts = {}) {
  let cmd = String(movie.cmd || '').trim();
  const fileId = movie.id;
  // Never use get_ordered_list?movie_id= — on these portals it returns an unrelated
  // category page, and create_link with that junk cmd + our file_id yields HTTP 405/462.
  if (!cmd || isTmpPlayUrl(cmdUrl(cmd))) {
    cmd = synthesizeMovieCmd(movie.id, 'mp4');
  }

  let url = await mintCheckedMovieLink(creds, cmd, fileId, opts);
  if (!url && /mkv/i.test(cmd)) {
    // already mkv cmd that failed — try mp4 sibling synth
    url = await mintCheckedMovieLink(creds, synthesizeMovieCmd(movie.id, 'mp4'), fileId, opts);
  } else if (!url && cmd === synthesizeMovieCmd(movie.id, 'mp4')) {
    url = await mintCheckedMovieLink(creds, synthesizeMovieCmd(movie.id, 'mkv'), fileId, opts);
  }

  // Stale catalog / dead 4K rows: portal still mints tokens but CDN 405s.
  // Fall back to a related title from live portal search (e.g. 4K-NF → SD copy).
  if (!url && movie.name) {
    const q = searchName(movie.name);
    if (q.length >= 3) {
      try {
        const { movies } = await searchTitles(creds, q, { ...opts, kinds: ['movies'], maxPages: 4 });
        for (const alt of movies || []) {
          if (!alt || String(alt.id) === String(movie.id)) continue;
          if (!titlesRelated(movie.name, alt.name)) continue;
          if (!alt.cmd || isTmpPlayUrl(cmdUrl(alt.cmd))) continue;
          log.info(`MAG movie ${movie.id} CDN dead; trying related '${alt.name}' (${alt.id})`);
          url = await mintCheckedMovieLink(creds, alt.cmd, alt.id, opts);
          if (url) break;
        }
      } catch (err) {
        log.warn(`MAG movie fallback search failed: ${err.message}`);
      }
    }
  }

  if (url) return url;

  // Last resort: return an unchecked mint so the player can still try.
  const unchecked = await createVodLink(creds, { cmd, file_id: fileId, series: '' }, opts);
  if (unchecked) return unchecked;
  const direct = cmdUrl(movie.cmd);
  if (isHttp(direct) && !isTmpPlayUrl(direct) && !/^https?:\/\/(localhost|127\.0\.0\.1)\b/i.test(direct)) {
    return direct;
  }
  throw new Error('The portal did not return a link for this movie');
}

/**
 * Mint a series episode URL and verify the CDN actually delivers media.
 * play_tokens are single-use, so a successful peek requires a fresh remint (same as movies).
 */
async function mintCheckedEpisodeLink(creds, cmd, episode, opts = {}) {
  const series = String(episode || '').trim();
  const first = await createVodLink(creds, { cmd, series }, opts);
  if (!first) return '';
  if (!(await linkDeliversMedia(first, creds, opts))) return '';
  return createVodLink(creds, { cmd, series }, opts);
}

/** Playable URL for an episode ({ cmd, episode }). */
async function episodeUrl(creds, ep, opts = {}) {
  let cmd = String(ep.cmd || '').trim();
  if (!cmd && opts.seriesId) {
    const pack = await loadSeriesEpisodes(creds, opts.seriesId, opts);
    const match = pack.episodes.find((e) => e.id === ep.id || (e.season === ep.season && e.episode === ep.episode));
    if (match) cmd = String(match.cmd || '').trim();
  }
  if (!cmd) throw new Error('This episode has no portal stream command');

  const url = await mintCheckedEpisodeLink(creds, cmd, ep.episode, opts);
  if (url) return url;
  // Do not hand the player a known-dead play_token (CDN 456/462) — that surfaces as a
  // generic VLC "playback failed". Fail here with a clear portal/CDN message instead.
  throw new Error(
    'This portal’s CDN rejected the episode stream (HTTP 456/462). '
    + 'Catalog loaded, but playback is blocked — switch to another MAG playlist/MAC.',
  );
}

module.exports = {
  MAG_UA,
  streamUserAgent,
  streamHeaders,
  normalizeMac,
  normalizePortal,
  cmdUrl,
  call,
  connect,
  mapLimit,
  loadLive,
  liveUrl,
  loadEpg,
  loadChannelEpg,
  loadDayTable,
  mergeProgrammes,
  toProgramme,
  portalDate,
  archiveUrls,
  loadVodCategories,
  loadCategoryPage,
  loadCategory,
  searchTitles,
  loadSeriesEpisodes,
  createVodLink,
  movieUrl,
  episodeUrl,
  peekMedia,
  isPlayableMagUrl,
};
