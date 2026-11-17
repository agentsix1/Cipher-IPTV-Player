'use strict';

const db = require('./db');

function parseExtra(row) {
  try {
    return JSON.parse((row && row.extra) || '{}') || {};
  } catch {
    return {};
  }
}

function keyOf(kind, itemId) {
  return `${kind}:${itemId}`;
}

function list(userId, playlistIds) {
  if (!playlistIds.length) return [];
  const ph = playlistIds.map(() => '?').join(',');
  return db.all(
    `SELECT * FROM bookmarks WHERE user_id = ? AND playlist_id IN (${ph}) ORDER BY created_at DESC`,
    [userId, ...playlistIds],
  );
}

function has(userId, playlistIds, kind, itemId) {
  if (!playlistIds.length) return false;
  const ph = playlistIds.map(() => '?').join(',');
  const row = db.get(
    `SELECT 1 AS x FROM bookmarks WHERE user_id = ? AND playlist_id IN (${ph}) AND kind = ? AND item_id = ?`,
    [userId, ...playlistIds, kind, itemId],
  );
  return !!row;
}

function add(userId, playlistId, body) {
  const kind = String(body.kind || '');
  const itemId = String(body.itemId || '').trim();
  if (!kind || !itemId) return null;
  const extra = typeof body.extra === 'string' ? body.extra : JSON.stringify(body.extra || {});
  db.run(
    `INSERT INTO bookmarks (
      user_id, playlist_id, kind, item_id, source_playlist_id, episode_id, season, episode,
      title, subtitle, poster, start_ms, end_ms, extra, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, playlist_id, kind, item_id) DO UPDATE SET
      source_playlist_id = excluded.source_playlist_id,
      episode_id = excluded.episode_id,
      season = excluded.season,
      episode = excluded.episode,
      title = excluded.title,
      subtitle = excluded.subtitle,
      poster = excluded.poster,
      start_ms = excluded.start_ms,
      end_ms = excluded.end_ms,
      extra = excluded.extra`,
    [
      userId,
      playlistId,
      kind,
      itemId,
      String(body.sourcePlaylistId || ''),
      String(body.episodeId || ''),
      Number(body.season) || 0,
      Number(body.episode) || 0,
      String(body.title || ''),
      String(body.subtitle || ''),
      String(body.poster || ''),
      Number(body.start) || Number(body.start_ms) || 0,
      Number(body.end) || Number(body.end_ms) || 0,
      extra,
      Date.now(),
    ],
  );
  return db.get(
    'SELECT * FROM bookmarks WHERE user_id = ? AND playlist_id = ? AND kind = ? AND item_id = ?',
    [userId, playlistId, kind, itemId],
  );
}

function remove(userId, playlistIds, kind, itemId) {
  if (!playlistIds.length) return false;
  const ph = playlistIds.map(() => '?').join(',');
  const existing = db.get(
    `SELECT 1 AS x FROM bookmarks WHERE user_id = ? AND playlist_id IN (${ph}) AND kind = ? AND item_id = ?`,
    [userId, ...playlistIds, kind, itemId],
  );
  if (!existing) return false;
  db.run(
    `DELETE FROM bookmarks WHERE user_id = ? AND playlist_id IN (${ph}) AND kind = ? AND item_id = ?`,
    [userId, ...playlistIds, kind, itemId],
  );
  return true;
}

module.exports = { list, has, add, remove, parseExtra, keyOf };
