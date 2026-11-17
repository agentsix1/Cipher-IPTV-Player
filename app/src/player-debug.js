'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./log');

const LOG_NAME = 'player-debug.log';
const MAX_EVENTS_PER_REQ = 200;
const MAX_MSG = 500;
const MAX_DATA_CHARS = 4000;

let stream = null;
let rotateChecked = 0;

function logPath() {
  return path.join(config.dataDir, LOG_NAME);
}

function ensureStream() {
  if (stream) return stream;
  fs.mkdirSync(config.dataDir, { recursive: true });
  stream = fs.createWriteStream(logPath(), { flags: 'a' });
  stream.on('error', (err) => {
    log.warn('player-debug log write failed', err);
    stream = null;
  });
  return stream;
}

/** Keep the debug log from growing forever (~8MB cap). */
function maybeRotate() {
  const now = Date.now();
  if (now - rotateChecked < 60000) return;
  rotateChecked = now;
  try {
    const p = logPath();
    const st = fs.statSync(p);
    if (st.size < 8 * 1024 * 1024) return;
    const bak = `${p}.1`;
    try { fs.unlinkSync(bak); } catch { /* ignore */ }
    fs.renameSync(p, bak);
    if (stream) {
      try { stream.end(); } catch { /* ignore */ }
      stream = null;
    }
  } catch {
    /* missing file is fine */
  }
}

function clipData(data) {
  if (data == null) return null;
  try {
    const s = JSON.stringify(data);
    if (s.length <= MAX_DATA_CHARS) return data;
    return { _truncated: true, preview: s.slice(0, MAX_DATA_CHARS) };
  } catch {
    return { _unserializable: true };
  }
}

function normalizeLevel(level) {
  if (level === 'warn' || level === 'error') return level;
  return 'info';
}

/**
 * Append client player events to data/player-debug.log and the server console.
 * @param {string|number|null} userId
 * @param {string} sessionId
 * @param {Array<{ t?: number, tag?: string, msg?: string, data?: any, level?: string }>} events
 */
function ingest(userId, sessionId, events) {
  if (!Array.isArray(events) || !events.length) return { written: 0 };
  maybeRotate();
  const out = ensureStream();
  const sid = String(sessionId || '-').slice(0, 64);
  const uid = userId == null ? null : String(userId);
  let written = 0;
  for (const raw of events.slice(0, MAX_EVENTS_PER_REQ)) {
    if (!raw || typeof raw !== 'object') continue;
    const tag = String(raw.tag || 'event').slice(0, 80);
    const msg = String(raw.msg || '').slice(0, MAX_MSG);
    const t = Number(raw.t) || Date.now();
    const level = normalizeLevel(raw.level);
    const row = {
      ts: new Date(t).toISOString(),
      user: uid,
      session: sid,
      level,
      tag,
      msg,
      data: clipData(raw.data),
    };
    out.write(`${JSON.stringify(row)}\n`);
    const line = `player [${sid}] ${tag}${msg ? `: ${msg}` : ''}`;
    if (level === 'error') log.error(line);
    else if (level === 'warn') log.warn(line);
    else log.info(line);
    written += 1;
  }
  return { written, path: logPath() };
}

/**
 * Server-originated debug line (VOD remux, cache, /play/vod, etc.) — same log file.
 * @param {string} tag
 * @param {string} [msg]
 * @param {object} [data]
 * @param {{ userId?: string|number|null, sessionId?: string, level?: string }} [meta]
 */
function record(tag, msg = '', data = null, meta = {}) {
  return ingest(meta.userId ?? null, meta.sessionId || 'server', [{
    t: Date.now(),
    tag,
    msg,
    data,
    level: meta.level || 'info',
  }]);
}

/**
 * Last N JSONL rows from the debug log (newest last). Best-effort for the overlay / API.
 * @param {number} [limit]
 */
function tail(limit = 80) {
  const n = Math.max(1, Math.min(500, Number(limit) || 80));
  const p = logPath();
  try {
    const buf = fs.readFileSync(p, 'utf8');
    const lines = buf.split(/\r?\n/).filter(Boolean);
    const slice = lines.slice(-n);
    const events = [];
    for (const line of slice) {
      try {
        events.push(JSON.parse(line));
      } catch {
        events.push({ ts: null, tag: 'raw', msg: line.slice(0, MAX_MSG) });
      }
    }
    return { path: p, events };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { path: p, events: [] };
    return { path: p, events: [], error: err.message };
  }
}

function info() {
  const p = logPath();
  let size = 0;
  let mtime = null;
  try {
    const st = fs.statSync(p);
    size = st.size;
    mtime = st.mtime.toISOString();
  } catch { /* missing */ }
  return {
    path: p,
    dataDir: config.dataDir,
    size,
    mtime,
    hostLogHint: 'Windows desktop also writes host.log next to this file (same data folder).',
  };
}

module.exports = { ingest, record, logPath, tail, info };
