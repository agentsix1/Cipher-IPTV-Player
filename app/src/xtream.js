'use strict';

const { getJson } = require('./http');

function normalizeServer(url) {
  let value = String(url || '').trim().replace(/\/+$/, '');
  if (value && !/^https?:\/\//i.test(value)) value = `http://${value}`;
  // Users often paste the full player_api.php or get.php URL.
  return value.replace(/\/(player_api|get|xmltv)\.php.*$/i, '');
}

function serverBase(u) {
  const port = u.port ? `:${u.port}` : '';
  return `${u.protocol}//${u.hostname}${port}`;
}

/** Credentials from an M3U URL like get.php?username=u&password=p (also u=/p= portals). */
function credentialsFromUrl(url) {
  try {
    const u = new URL(url);
    const username = u.searchParams.get('username')
      || u.searchParams.get('user')
      || u.searchParams.get('u');
    const password = u.searchParams.get('password')
      || u.searchParams.get('pass')
      || u.searchParams.get('p');
    if (!username || !password) return null;
    return { server: serverBase(u), username, password };
  } catch {
    return null;
  }
}

/** Credentials from a stream URL like http://host/live/u/p/123.ts or http://host/u/p/123. */
function credentialsFromStreamUrl(url) {
  try {
    const u = new URL(url);
    // Some exports put the login on every line: …/get.php?username=u&password=p&…
    const fromQuery = credentialsFromUrl(url);
    if (fromQuery) return fromQuery;
    const segments = u.pathname.split('/').filter(Boolean);
    const head = (segments[0] || '').toLowerCase();
    const offset = ['live', 'movie', 'series', 'timeshift', 'streaming'].includes(head) ? 1 : 0;
    if (segments.length <= offset + 2) return null;
    const username = decodeURIComponent(segments[offset]);
    const password = decodeURIComponent(segments[offset + 1]);
    if (!username || !password) return null;
    // Ignore obvious non-login path junk.
    if (/^(https?:|www\.|api|player_api|xmltv)$/i.test(username)) return null;
    return { server: serverBase(u), username, password };
  } catch {
    return null;
  }
}

function streamIdFromUrl(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    const idPart = last.includes('.') ? last.slice(0, last.lastIndexOf('.')) : last;
    const id = Number(idPart);
    return Number.isInteger(id) && id > 0 ? id : 0;
  } catch {
    return 0;
  }
}

function apiUrl(creds, action, extra = '') {
  const base = `${normalizeServer(creds.server)}/player_api.php?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}`;
  return action ? `${base}&action=${action}${extra}` : base;
}

function resolveStreamBase(creds, serverInfo) {
  if (serverInfo && serverInfo.url) {
    const protocol = String(serverInfo.server_protocol || 'http').replace(/:$/, '');
    const host = String(serverInfo.url).replace(/^\/+|\/+$/g, '');
    const port = Number(protocol === 'https' ? serverInfo.https_port : serverInfo.port);
    const isDefault = (protocol === 'https' && port === 443) || (protocol === 'http' && port === 80);
    return port > 0 && !isDefault ? `${protocol}://${host}:${port}` : `${protocol}://${host}`;
  }
  return normalizeServer(creds.server);
}

async function getAccount(creds, opts) {
  const account = await getJson(apiUrl(creds), opts);
  if (!account || !account.user_info) throw new Error('Server did not return account info (check the server URL)');
  if (Number(account.user_info.auth) !== 1) throw new Error('Login rejected by the IPTV server (check username/password)');
  return account;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** Loads live channels from an Xtream Codes account. */
async function loadLive(creds, { userAgent, streamFormat = 'ts' } = {}) {
  const opts = { userAgent, timeoutMs: 60000 };
  const account = await getAccount(creds, opts);
  const streamBase = resolveStreamBase(creds, account.server_info);
  const [categories, streams] = await Promise.all([
    getJson(apiUrl(creds, 'get_live_categories'), opts).then(asArray),
    getJson(apiUrl(creds, 'get_live_streams'), opts).then(asArray),
  ]);

  const groupNames = new Map();
  categories.forEach((c) => groupNames.set(String(c.category_id || '0'), c.category_name || 'Uncategorized'));

  const ext = streamFormat === 'm3u8' ? 'm3u8' : 'ts';
  const user = encodeURIComponent(creds.username);
  const pass = encodeURIComponent(creds.password);

  const channels = streams.map((s, index) => {
    const streamId = Number(s.stream_id) || 0;
    const groupId = String(s.category_id || '0');
    return {
      id: `x${streamId}`,
      name: String(s.name || '').trim() || `Channel ${streamId}`,
      logo: s.stream_icon || '',
      groupId,
      groupName: groupNames.get(groupId) || 'Uncategorized',
      num: Number(s.num) || index + 1,
      epgId: s.epg_channel_id || '',
      streamId,
      url: s.direct_source ? String(s.direct_source).trim() : `${streamBase}/live/${user}/${pass}/${streamId}.${ext}`,
      catchup: Number(s.tv_archive) !== 0 || Number(s.tv_archive_duration) > 0,
      catchupDays: Number(s.tv_archive_duration) || 0,
      catchupSource: '',
    };
  });

  const groups = categories.map((c, index) => ({
    id: String(c.category_id || '0'),
    name: c.category_name || 'Uncategorized',
    order: index,
  }));
  if (channels.some((c) => !groupNames.has(c.groupId)) && !groups.some((g) => g.id === '0')) {
    groups.push({ id: '0', name: 'Uncategorized', order: groups.length });
  }

  return { channels, groups, streamBase };
}

/** Catch-up metadata (tv_archive) keyed by stream id, used to enrich plain M3U playlists. */
async function loadArchiveInfo(creds, { userAgent } = {}) {
  const streams = asArray(await getJson(apiUrl(creds, 'get_live_streams'), { userAgent, timeoutMs: 60000 }));
  const byStreamId = new Map();
  const byEpgId = new Map();
  for (const s of streams) {
    const info = {
      streamId: Number(s.stream_id) || 0,
      epgId: s.epg_channel_id || '',
      catchup: Number(s.tv_archive) !== 0 || Number(s.tv_archive_duration) > 0,
      catchupDays: Number(s.tv_archive_duration) || 0,
      logo: s.stream_icon || '',
    };
    if (info.streamId) byStreamId.set(info.streamId, info);
    if (info.epgId) byEpgId.set(info.epgId.toLowerCase(), info);
  }
  return { byStreamId, byEpgId };
}

/**
 * Guess Xtream Codes login from stream lines first (correct CDN/API host), then the
 * playlist URL. Portal M3Us often live on a different host (u=/p=) than player_api.
 */
function guessCredentialsFromM3u(playlistUrl, channelUrls = []) {
  const votes = new Map();
  const urls = Array.isArray(channelUrls) ? channelUrls : [];
  // Prefer early live lines, but also scan deeper — large lists often bury the pattern.
  const sample = [];
  for (let i = 0; i < urls.length && sample.length < 160; i++) {
    const url = urls[i];
    if (!url) continue;
    if (
      /\/(live|timeshift|movie|series)\//i.test(url)
      || /[?&](username|user|u)=/i.test(url)
      || /\/\d+(?:\.(?:ts|m3u8))?(?:\?|$)/i.test(url)
    ) {
      sample.push(url);
    } else if (i < 50) {
      sample.push(url);
    }
  }
  for (const url of sample) {
    const creds = credentialsFromStreamUrl(url) || credentialsFromUrl(url);
    if (!creds) continue;
    const key = `${creds.server}\0${creds.username}\0${creds.password}`;
    const row = votes.get(key) || { creds, n: 0 };
    row.n += 1;
    votes.set(key, row);
  }
  let best = null;
  for (const row of votes.values()) {
    if (!best || row.n > best.n) best = row;
  }
  // Need a clear majority so mixed/reseller playlists do not false-positive.
  if (best && best.n >= 2) {
    if (sample.length < 8 || best.n >= Math.min(6, Math.ceil(sample.length * 0.2))) {
      return best.creds;
    }
  }

  // Fallback: portal URL login (get.php / m3u.php?u=&p=) when streams did not vote clearly.
  return credentialsFromUrl(playlistUrl);
}

function providerEpgUrl(creds) {
  return `${normalizeServer(creds.server)}/xmltv.php?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}`;
}

function youtubeId(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{11})/i);
  return m ? m[1] : '';
}

/** Movies (VOD) and TV series catalogs from an Xtream Codes account. */
async function loadVodCatalog(creds, { userAgent } = {}) {
  const opts = { userAgent, timeoutMs: 120000 };
  const [movieCats, movies, seriesCats, series] = await Promise.all([
    getJson(apiUrl(creds, 'get_vod_categories'), opts).then(asArray).catch(() => []),
    getJson(apiUrl(creds, 'get_vod_streams'), opts).then(asArray).catch(() => []),
    getJson(apiUrl(creds, 'get_series_categories'), opts).then(asArray).catch(() => []),
    getJson(apiUrl(creds, 'get_series'), opts).then(asArray).catch(() => []),
  ]);
  return { movieCats, movies, seriesCats, series };
}

async function loadVodInfo(creds, streamId, { userAgent } = {}) {
  return getJson(apiUrl(creds, 'get_vod_info', `&vod_id=${encodeURIComponent(streamId)}`), { userAgent, timeoutMs: 30000 });
}

async function loadSeriesInfo(creds, seriesId, { userAgent } = {}) {
  return getJson(apiUrl(creds, 'get_series_info', `&series_id=${encodeURIComponent(seriesId)}`), { userAgent, timeoutMs: 45000 });
}

module.exports = {
  normalizeServer,
  credentialsFromUrl,
  credentialsFromStreamUrl,
  streamIdFromUrl,
  guessCredentialsFromM3u,
  getAccount,
  loadLive,
  loadArchiveInfo,
  resolveStreamBase,
  providerEpgUrl,
  youtubeId,
  loadVodCatalog,
  loadVodInfo,
  loadSeriesInfo,
};
