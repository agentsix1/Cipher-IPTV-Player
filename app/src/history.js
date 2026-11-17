'use strict';

const db = require('./db');
const combined = require('./combined');
const playlists = require('./playlists');

const KINDS = new Set(['live', 'catchup', 'movie', 'series']);
const HIT_GAP_MS = 30 * 60 * 1000;

function parseExtra(row) {
  try {
    return JSON.parse((row && row.extra) || '{}') || {};
  } catch {
    return {};
  }
}

function placeholders(n) {
  return n ? new Array(n).fill('?').join(',') : 'NULL';
}

function scopeIds(userId, playlist) {
  if (!playlist) return [];
  if (playlist.id === combined.COMBINED_ID) {
    return [combined.COMBINED_ID, ...playlists.listRows(userId).map((r) => r.id)];
  }
  return [playlist.id];
}

function stripPrefix(id) {
  const text = String(id || '');
  const cut = text.indexOf('~');
  return cut >= 0 ? text.slice(cut + 1) : text;
}

function parseCatchupId(itemId) {
  const text = String(itemId || '');
  const at = text.lastIndexOf('@');
  if (at < 0) return { channelId: text, start: 0 };
  return { channelId: text.slice(0, at), start: Number(text.slice(at + 1)) || 0 };
}

function identityKey(kind, itemId) {
  if (kind === 'catchup') {
    const { channelId, start } = parseCatchupId(itemId);
    return `${kind}:${stripPrefix(channelId)}@${start}`;
  }
  if (kind === 'live') return `${kind}:${stripPrefix(itemId)}`;
  return `${kind}:${itemId}`;
}

function bareId(kind, value) {
  let id = String(value || '').trim();
  if (kind === 'movie') id = id.replace(/^m:/i, '');
  if (kind === 'series') id = id.replace(/^s:/i, '');
  return id;
}

function normalizeBody(body) {
  const kind = String((body && body.kind) || '');
  if (!KINDS.has(kind)) return null;
  let itemId = bareId(kind, body.itemId || body.seriesId || '');
  if (kind === 'series') {
    const seriesId = bareId('series', body.seriesId || '');
    if (seriesId) itemId = seriesId;
    if (/^e:/i.test(itemId) || itemId.includes('@')) return null;
  }
  if (kind === 'catchup') {
    const start = Number(body.start) || Number(body.start_ms) || 0;
    if (!itemId.includes('@') && start) itemId = `${itemId}@${start}`;
  }
  if (!itemId) return null;
  const extra = typeof body.extra === 'string' ? body.extra : JSON.stringify(body.extra || {});
  return {
    kind,
    itemId,
    sourcePlaylistId: String(body.sourcePlaylistId || body.playlist || ''),
    episodeId: String(body.episodeId || '').replace(/^e:/i, ''),
    season: Number(body.season) || 0,
    episode: Number(body.episode) || 0,
    title: String(body.title || ''),
    subtitle: String(body.subtitle || ''),
    poster: String(body.poster || ''),
    position: Math.max(0, Number(body.position) || 0),
    duration: Math.max(0, Number(body.duration) || 0),
    startMs: Number(body.start) || Number(body.start_ms) || 0,
    endMs: Number(body.end) || Number(body.end_ms) || 0,
    extra,
    updatedAt: Number(body.updatedAt) || Date.now(),
    seed: !!body.seed,
    silent: !!body.silent,
  };
}

function getRow(userId, playlistId, kind, itemId) {
  return db.get(
    'SELECT * FROM watch_history WHERE user_id = ? AND playlist_id = ? AND kind = ? AND item_id = ?',
    [userId, playlistId, kind, itemId],
  );
}

function record(userId, playlistId, body) {
  const data = normalizeBody(body);
  if (!data || !playlistId) return null;
  const existing = getRow(userId, playlistId, data.kind, data.itemId);
  if (data.seed && existing) return existing;
  if (!data.title && !data.subtitle && !existing) return null;
  const now = (data.silent || (data.seed && !data.title)) && existing
    ? (Number(existing.updated_at) || data.updatedAt)
    : data.updatedAt;
  let hits = 1;
  if (existing) {
    hits = Number(existing.hits) || 1;
    if (!data.seed && now - (Number(existing.updated_at) || 0) > HIT_GAP_MS) hits += 1;
  }
  const title = data.title || (existing && existing.title) || '';
  const subtitle = data.subtitle || (existing && existing.subtitle) || '';
  const poster = data.poster || (existing && existing.poster) || '';
  const episodeId = data.episodeId || (existing && existing.episode_id) || '';
  const season = data.season || (existing && existing.season) || 0;
  const episode = data.episode || (existing && existing.episode) || 0;
  const extra = data.extra && data.extra !== '{}' ? data.extra : (existing && existing.extra) || '';
  db.run(
    `INSERT INTO watch_history (
      user_id, playlist_id, kind, item_id, source_playlist_id, episode_id, season, episode,
      title, subtitle, poster, position, duration, start_ms, end_ms, hits, extra, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, playlist_id, kind, item_id) DO UPDATE SET
      source_playlist_id = CASE WHEN excluded.source_playlist_id != '' THEN excluded.source_playlist_id ELSE watch_history.source_playlist_id END,
      episode_id = CASE WHEN excluded.episode_id != '' THEN excluded.episode_id ELSE watch_history.episode_id END,
      season = CASE WHEN excluded.season != 0 THEN excluded.season ELSE watch_history.season END,
      episode = CASE WHEN excluded.episode != 0 THEN excluded.episode ELSE watch_history.episode END,
      title = CASE WHEN excluded.title != '' THEN excluded.title ELSE watch_history.title END,
      subtitle = CASE WHEN excluded.subtitle != '' THEN excluded.subtitle ELSE watch_history.subtitle END,
      poster = CASE WHEN excluded.poster != '' THEN excluded.poster ELSE watch_history.poster END,
      position = CASE WHEN excluded.position > 0 THEN excluded.position ELSE watch_history.position END,
      duration = CASE WHEN excluded.duration > 1 THEN excluded.duration ELSE watch_history.duration END,
      start_ms = CASE WHEN excluded.start_ms != 0 THEN excluded.start_ms ELSE watch_history.start_ms END,
      end_ms = CASE WHEN excluded.end_ms != 0 THEN excluded.end_ms ELSE watch_history.end_ms END,
      hits = excluded.hits,
      extra = CASE WHEN excluded.extra != '' AND excluded.extra != '{}' THEN excluded.extra ELSE watch_history.extra END,
      updated_at = excluded.updated_at`,
    [
      userId, playlistId, data.kind, data.itemId, data.sourcePlaylistId, episodeId, season, episode,
      title, subtitle, poster, data.position, data.duration, data.startMs, data.endMs, hits, extra, now,
    ],
  );
  return getRow(userId, playlistId, data.kind, data.itemId);
}

function dedupe(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const key = identityKey(row.kind, row.item_id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function recent(userId, playlistIds, limit) {
  if (!playlistIds.length) return [];
  const cap = Math.max(1, Math.min(200, Number(limit) || 24));
  const ph = placeholders(playlistIds.length);
  const rows = db.all(
    `SELECT * FROM watch_history WHERE user_id = ? AND playlist_id IN (${ph}) ORDER BY updated_at DESC LIMIT ?`,
    [userId, ...playlistIds, cap * 3],
  );
  return dedupe(rows).slice(0, cap);
}

function continueRow(userId, playlistIds) {
  return recent(userId, playlistIds, 1)[0] || null;
}

function forYou(userId, playlistIds, limit) {
  if (!playlistIds.length) return [];
  const cap = Math.max(1, Math.min(200, Number(limit) || 12));
  const ph = placeholders(playlistIds.length);
  const rows = db.all(
    `SELECT * FROM watch_history WHERE user_id = ? AND playlist_id IN (${ph}) AND kind = 'series'
     ORDER BY hits DESC, updated_at DESC LIMIT ?`,
    [userId, ...playlistIds, cap * 3],
  );
  return dedupe(rows).slice(0, cap);
}

function seedFromProgress(userId) {
  const key = `watch_seed:${userId}`;
  if (db.getMeta(key)) return;
  const rows = db.all(
    'SELECT playlist_id, item_id, position, duration, extra, updated_at FROM vod_progress WHERE user_id = ?',
    [userId],
  );
  for (const row of rows) {
    const id = String(row.item_id || '');
    if (id.startsWith('e:')) continue;
    if (id.startsWith('m:')) {
      record(userId, row.playlist_id, {
        kind: 'movie',
        itemId: id.slice(2),
        position: row.position,
        duration: row.duration,
        updatedAt: row.updated_at,
        sourcePlaylistId: row.playlist_id,
        seed: true,
        silent: true,
      });
    } else if (id.startsWith('s:')) {
      record(userId, row.playlist_id, {
        kind: 'series',
        itemId: id.slice(2),
        seriesId: id.slice(2),
        episodeId: String(row.extra || '').replace(/^e:/i, ''),
        position: row.position,
        duration: row.duration,
        updatedAt: row.updated_at,
        sourcePlaylistId: row.playlist_id,
        seed: true,
        silent: true,
      });
    }
  }
  db.setMeta(key, String(Date.now()));
}

module.exports = {
  record,
  recent,
  continueRow,
  forYou,
  seedFromProgress,
  scopeIds,
  parseExtra,
  parseCatchupId,
  stripPrefix,
  identityKey,
};
