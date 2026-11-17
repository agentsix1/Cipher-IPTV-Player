'use strict';

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const log = require('./log');

let db = null;
let dbFile = null;
let saveTimer = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT PRIMARY KEY,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  m3u_url TEXT,
  server_url TEXT,
  username TEXT,
  password TEXT,
  epg_url TEXT,
  epg_sources TEXT NOT NULL DEFAULT '[]',
  use_provider_epg INTEGER NOT NULL DEFAULT 1,
  epg_shift_hours REAL NOT NULL DEFAULT 0,
  catchup_shift_hours REAL NOT NULL DEFAULT 0,
  stream_format TEXT NOT NULL DEFAULT 'ts',
  user_agent TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS favorites (
  user_id TEXT NOT NULL,
  playlist_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  PRIMARY KEY (user_id, playlist_id, channel_id)
);
CREATE TABLE IF NOT EXISTS group_prefs (
  user_id TEXT NOT NULL,
  playlist_id TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (user_id, playlist_id)
);
CREATE TABLE IF NOT EXISTS vod_progress (
  user_id TEXT NOT NULL,
  playlist_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  position REAL NOT NULL,
  duration REAL NOT NULL,
  extra TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, playlist_id, item_id)
);
CREATE TABLE IF NOT EXISTS watch_history (
  user_id TEXT NOT NULL,
  playlist_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  source_playlist_id TEXT NOT NULL DEFAULT '',
  episode_id TEXT NOT NULL DEFAULT '',
  season INTEGER NOT NULL DEFAULT 0,
  episode INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  subtitle TEXT NOT NULL DEFAULT '',
  poster TEXT NOT NULL DEFAULT '',
  position REAL NOT NULL DEFAULT 0,
  duration REAL NOT NULL DEFAULT 0,
  start_ms INTEGER NOT NULL DEFAULT 0,
  end_ms INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 1,
  extra TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, playlist_id, kind, item_id)
);
CREATE INDEX IF NOT EXISTS watch_history_updated ON watch_history (user_id, playlist_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS watch_history_foryou ON watch_history (user_id, playlist_id, kind, hits DESC, updated_at DESC);
CREATE TABLE IF NOT EXISTS bookmarks (
  user_id TEXT NOT NULL,
  playlist_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  source_playlist_id TEXT NOT NULL DEFAULT '',
  episode_id TEXT NOT NULL DEFAULT '',
  season INTEGER NOT NULL DEFAULT 0,
  episode INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  subtitle TEXT NOT NULL DEFAULT '',
  poster TEXT NOT NULL DEFAULT '',
  start_ms INTEGER NOT NULL DEFAULT 0,
  end_ms INTEGER NOT NULL DEFAULT 0,
  extra TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, playlist_id, kind, item_id)
);
`;

async function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  dbFile = path.join(dataDir, 'cipher.db');
  const legacyDb = path.join(dataDir, 'xfinity.db');
  // One-time rename from the old Xfinity Stream filename.
  if (!fs.existsSync(dbFile) && fs.existsSync(legacyDb)) {
    try {
      fs.renameSync(legacyDb, dbFile);
      log.info(`Database migrated: ${legacyDb} → ${dbFile}`);
    } catch (err) {
      log.warn(`Database migrate failed, using legacy file: ${err.message}`);
      dbFile = legacyDb;
    }
  }
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file),
  });
  if (fs.existsSync(dbFile)) {
    db = new SQL.Database(fs.readFileSync(dbFile));
    log.info(`Database loaded: ${dbFile}`);
  } else {
    db = new SQL.Database();
    log.info(`Database created: ${dbFile}`);
  }
  db.exec(SCHEMA);
  migrate();
  saveNow();
}

/** Adds columns introduced after the first release to existing databases. */
function migrate() {
  const columns = all('PRAGMA table_info(playlists)').map((c) => c.name);
  if (!columns.includes('epg_sources')) db.exec("ALTER TABLE playlists ADD COLUMN epg_sources TEXT NOT NULL DEFAULT '[]'");
  if (!columns.includes('refresh_hours')) db.exec('ALTER TABLE playlists ADD COLUMN refresh_hours INTEGER NOT NULL DEFAULT -1');
  // watch_history / bookmarks are created by SCHEMA (CREATE TABLE IF NOT EXISTS) on every open.
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 300);
}

function saveNow() {
  if (!db || !dbFile) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const tmp = `${dbFile}.tmp`;
  fs.writeFileSync(tmp, Buffer.from(db.export()));
  fs.renameSync(tmp, dbFile);
}

function run(sql, params = []) {
  db.run(sql, params);
  scheduleSave();
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

function get(sql, params = []) {
  return all(sql, params)[0] || null;
}

/** Runs fn inside a transaction; any throw rolls every change back. */
function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    scheduleSave();
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function getMeta(key) {
  const row = get('SELECT value FROM meta WHERE key = ?', [key]);
  return row ? row.value : null;
}

function setMeta(key, value) {
  run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
}

module.exports = { open, run, all, get, transaction, getMeta, setMeta, saveNow };
