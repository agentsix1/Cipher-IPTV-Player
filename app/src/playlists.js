'use strict';

const crypto = require('crypto');
const db = require('./db');
const { httpError } = require('./auth');
const { normalizeServer } = require('./xtream');
const { normalizePortal, normalizeMac } = require('./mag');

const MAX_EPG_SOURCES = 150; // room for the ~100 epgshare01 guides plus the user's own

/** Extra XMLTV sources stored on a playlist row: [{ id, name, url, enabled }]. */
function epgSourcesOf(row) {
  try {
    const list = JSON.parse((row && row.epg_sources) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function cleanEpgSources(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const s of input.slice(0, MAX_EPG_SOURCES)) {
    if (!s || typeof s !== 'object') continue;
    const url = String(s.url || '').trim();
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) throw httpError(400, `EPG source URL must start with http:// or https:// (${url.slice(0, 60)})`);
    let id = /^s[a-z0-9]{3,16}$/.test(String(s.id || '')) ? s.id : '';
    if (!id || seen.has(id)) id = `s${crypto.randomBytes(4).toString('hex')}`;
    seen.add(id);
    const refreshHours = Number(s.refreshHours);
    out.push({
      id,
      name: String(s.name || '').trim().slice(0, 60) || `Guide ${out.length + 1}`,
      url,
      enabled: s.enabled !== false,
      autoUpdate: s.autoUpdate !== false,
      refreshHours: Number.isFinite(refreshHours) && refreshHours >= 0 ? Math.min(168, refreshHours) : 0,
    });
  }
  return out;
}

function toClient(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    m3uUrl: row.m3u_url || '',
    serverUrl: row.server_url || '',
    username: row.username || '',
    password: row.password || '',
    macAddress: row.type === 'mag' ? row.username || '' : '',
    epgUrl: row.epg_url || '',
    epgSources: epgSourcesOf(row),
    useProviderEpg: !!row.use_provider_epg,
    epgShiftHours: Number(row.epg_shift_hours) || 0,
    catchupShiftHours: Number(row.catchup_shift_hours) || 0,
    streamFormat: row.stream_format || 'ts',
    userAgent: row.user_agent || '',
    isActive: !!row.is_active,
    refreshHours: Number.isFinite(Number(row.refresh_hours)) ? Number(row.refresh_hours) : -1,
    updatedAt: row.updated_at,
  };
}

function clampShift(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(-24, Math.min(24, Math.round(n * 4) / 4)) : 0;
}

function sanitize(input, existing) {
  const src = { ...(existing ? toClient(existing) : {}), ...(input || {}) };
  const type = ['xtream', 'mag'].includes(src.type) ? src.type : 'm3u';
  const defaultNames = { xtream: 'Xtream playlist', mag: 'MAG portal', m3u: 'M3U playlist' };
  const name = String(src.name || '').trim() || defaultNames[type];
  const m3uUrl = String(src.m3uUrl || '').trim();
  let serverUrl = '';
  if (type === 'xtream') serverUrl = normalizeServer(src.serverUrl);
  if (type === 'mag') serverUrl = normalizePortal(src.serverUrl);
  // M3U may keep a discovered Xtream host (for catch-up timeshift) without changing type.
  if (type === 'm3u') serverUrl = normalizeServer(src.serverUrl) || '';
  const mac = type === 'mag' ? normalizeMac(src.macAddress || src.username) : '';
  const username = type === 'mag' ? mac : String(src.username || '').trim();
  const password = String(src.password || '');

  if (type === 'm3u' && !/^https?:\/\//i.test(m3uUrl)) throw httpError(400, 'Enter a valid M3U URL (http:// or https://)');
  if (type === 'xtream' && (!serverUrl || !username || !password)) throw httpError(400, 'Server URL, username, and password are required');
  if (type === 'mag' && !serverUrl) throw httpError(400, 'Enter the portal URL (for example http://example.com/c/)');
  if (type === 'mag' && !mac) throw httpError(400, 'Enter a valid MAC address (for example 00:1A:79:12:34:56)');

  const epgUrl = String(src.epgUrl || '').trim();
  if (epgUrl && !/^https?:\/\//i.test(epgUrl)) throw httpError(400, 'EPG URL must start with http:// or https://');

  const refreshRaw = Number(src.refreshHours);
  const refresh_hours = Number.isFinite(refreshRaw) ? Math.max(-1, Math.min(168, Math.round(refreshRaw))) : -1;

  return {
    name,
    type,
    m3u_url: type === 'm3u' ? m3uUrl : '',
    server_url: serverUrl,
    username: type === 'mag' ? mac : username,
    password: type === 'mag' ? '' : password,
    epg_url: epgUrl,
    epg_sources: src.epgSources === undefined && existing
      ? existing.epg_sources || '[]'
      : JSON.stringify(cleanEpgSources(src.epgSources)),
    use_provider_epg: src.useProviderEpg === false ? 0 : 1,
    epg_shift_hours: clampShift(src.epgShiftHours),
    catchup_shift_hours: clampShift(src.catchupShiftHours),
    stream_format: src.streamFormat === 'm3u8' ? 'm3u8' : 'ts',
    user_agent: String(src.userAgent || '').trim(),
    refresh_hours,
  };
}

function listRows(userId) {
  return db.all('SELECT * FROM playlists WHERE user_id = ? ORDER BY created_at', [userId]);
}

function list(userId) {
  return listRows(userId).map(toClient);
}

function getRow(userId, id) {
  return db.get('SELECT * FROM playlists WHERE user_id = ? AND id = ?', [userId, id]);
}

function getActiveRow(userId) {
  return db.get('SELECT * FROM playlists WHERE user_id = ? AND is_active = 1', [userId])
    || db.get('SELECT * FROM playlists WHERE user_id = ? ORDER BY created_at LIMIT 1', [userId]);
}

function create(userId, input) {
  const data = sanitize(input);
  const id = crypto.randomUUID();
  const now = Date.now();
  const makeActive = !db.get('SELECT id FROM playlists WHERE user_id = ?', [userId]) || input.isActive;
  if (makeActive) db.run('UPDATE playlists SET is_active = 0 WHERE user_id = ?', [userId]);
  db.run(`INSERT INTO playlists (id, user_id, name, type, m3u_url, server_url, username, password, epg_url, epg_sources, use_provider_epg,
      epg_shift_hours, catchup_shift_hours, stream_format, user_agent, refresh_hours, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, userId, data.name, data.type, data.m3u_url, data.server_url, data.username, data.password, data.epg_url,
    data.epg_sources, data.use_provider_epg, data.epg_shift_hours, data.catchup_shift_hours, data.stream_format, data.user_agent,
    data.refresh_hours, makeActive ? 1 : 0, now, now]);
  return getRow(userId, id);
}

/**
 * Returns { row, sourceChanged, epgChanged } so callers know whether channels (and the guide) or only
 * the guide must be reloaded.
 */
function update(userId, id, input) {
  const existing = getRow(userId, id);
  if (!existing) throw httpError(404, 'Playlist not found');
  const data = sanitize(input, existing);
  const sourceKeys = ['type', 'm3u_url', 'server_url', 'username', 'password', 'epg_url', 'use_provider_epg', 'stream_format', 'user_agent'];
  const sourceChanged = sourceKeys.some((k) => String(existing[k] ?? '') !== String(data[k] ?? ''));
  const loadSignature = (json) => JSON.stringify(epgSourcesOf({ epg_sources: json }).filter((s) => s.enabled).map((s) => [s.id, s.url]));
  const epgChanged = loadSignature(existing.epg_sources) !== loadSignature(data.epg_sources);
  db.run(`UPDATE playlists SET name = ?, type = ?, m3u_url = ?, server_url = ?, username = ?, password = ?, epg_url = ?,
      epg_sources = ?, use_provider_epg = ?, epg_shift_hours = ?, catchup_shift_hours = ?, stream_format = ?, user_agent = ?,
      refresh_hours = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
  [data.name, data.type, data.m3u_url, data.server_url, data.username, data.password, data.epg_url, data.epg_sources,
    data.use_provider_epg, data.epg_shift_hours, data.catchup_shift_hours, data.stream_format, data.user_agent, data.refresh_hours,
    Date.now(), id, userId]);
  return { row: getRow(userId, id), sourceChanged, epgChanged };
}

function remove(userId, id) {
  const existing = getRow(userId, id);
  if (!existing) return;
  db.run('DELETE FROM playlists WHERE id = ? AND user_id = ?', [id, userId]);
  db.run('DELETE FROM favorites WHERE playlist_id = ? AND user_id = ?', [id, userId]);
  db.run('DELETE FROM group_prefs WHERE playlist_id = ? AND user_id = ?', [id, userId]);
  if (existing.is_active) {
    const next = db.get('SELECT id FROM playlists WHERE user_id = ? ORDER BY created_at LIMIT 1', [userId]);
    if (next) db.run('UPDATE playlists SET is_active = 1 WHERE id = ?', [next.id]);
  }
}

function activate(userId, id) {
  if (!getRow(userId, id)) throw httpError(404, 'Playlist not found');
  db.run('UPDATE playlists SET is_active = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE user_id = ?', [id, userId]);
  return getRow(userId, id);
}

function favorites(userId, playlistId) {
  return new Set(db.all('SELECT channel_id FROM favorites WHERE user_id = ? AND playlist_id = ?', [userId, playlistId]).map((r) => r.channel_id));
}

function toggleFavorite(userId, playlistId, channelId) {
  const exists = db.get('SELECT 1 AS x FROM favorites WHERE user_id = ? AND playlist_id = ? AND channel_id = ?', [userId, playlistId, channelId]);
  if (exists) db.run('DELETE FROM favorites WHERE user_id = ? AND playlist_id = ? AND channel_id = ?', [userId, playlistId, channelId]);
  else db.run('INSERT INTO favorites (user_id, playlist_id, channel_id) VALUES (?, ?, ?)', [userId, playlistId, channelId]);
  return !exists;
}

function setFavorites(userId, playlistId, channelIds) {
  db.run('DELETE FROM favorites WHERE user_id = ? AND playlist_id = ?', [userId, playlistId]);
  for (const channelId of new Set(channelIds)) {
    db.run('INSERT INTO favorites (user_id, playlist_id, channel_id) VALUES (?, ?, ?)', [userId, playlistId, channelId]);
  }
}

/**
 * Persist Xtream Codes login discovered inside an M3U (host + user + pass) so catch-up
 * timeshift can reuse it without re-parsing stream URLs every seek.
 */
function persistM3uXtreamCreds(playlist, creds, streamBase = '') {
  if (!playlist || playlist.type !== 'm3u' || !playlist.id || !creds) return false;
  const server = normalizeServer(streamBase || creds.server || creds.streamBase || '');
  const username = String(creds.username || '').trim();
  const password = String(creds.password || '');
  if (!server || !username || !password) return false;
  if (playlist.server_url === server && playlist.username === username && playlist.password === password) {
    return false;
  }
  db.run(
    'UPDATE playlists SET server_url = ?, username = ?, password = ?, updated_at = ? WHERE id = ?',
    [server, username, password, Date.now(), playlist.id],
  );
  playlist.server_url = server;
  playlist.username = username;
  playlist.password = password;
  return true;
}

/** Xtream login stored on a playlist row (native Xtream or M3U enriched from stream URLs). */
function xtreamCredsFromPlaylist(playlist) {
  if (!playlist) return null;
  const username = String(playlist.username || '').trim();
  const password = String(playlist.password || '');
  const server = normalizeServer(playlist.server_url || '');
  if (!server || !username || !password) return null;
  if (playlist.type === 'mag') return null;
  return { server, username, password };
}

module.exports = {
  toClient, epgSourcesOf, list, listRows, getRow, getActiveRow, create, update, remove, activate,
  favorites, toggleFavorite, setFavorites, persistM3uXtreamCreds, xtreamCredsFromPlaylist,
};
