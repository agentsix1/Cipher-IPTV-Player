'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const log = require('./log');
const playerDebug = require('./player-debug');

const sessions = new Map();
const byAccount = new Map();

/** Always leave at least this much free on the cache drive. */
const MIN_FREE_BYTES = 1 * 1024 * 1024 * 1024;
const SPACE_CHECK_EVERY_BYTES = 32 * 1024 * 1024;

function cacheDir() {
  const dir = path.join(config.dataDir, 'cache', 'vod');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function idFor(url) {
  return crypto.createHash('sha1').update(String(url || '')).digest('hex');
}

function guessType(url) {
  const ext = String((String(url).match(/\.([a-z0-9]{2,5})(?:\?|$)/i) || [])[1] || '').toLowerCase();
  return {
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', mkv: 'video/x-matroska',
    webm: 'video/webm', ogv: 'video/ogg', '3gp': 'video/3gpp',
    ts: 'video/mp2t', m2ts: 'video/mp2t', mts: 'video/mp2t',
  }[ext] || (/timeshift|streaming\/.*\.ts/i.test(String(url || '')) ? 'video/mp2t' : 'video/mp4');
}

/** True when content-type / URL should be MPEG-TS (188-byte sync 0x47). */
function expectsMpegTs(type, url) {
  if (/mp2t|mpegts|video\/ts/i.test(String(type || ''))) return true;
  return /\.ts(?:\?|$)/i.test(String(url || '')) || /timeshift/i.test(String(url || ''));
}

/**
 * Reject zeros / non-TS so mpegts.js does not spam sync_byte after cache tip.
 * Returns true when at least 3 aligned 0x47 syncs are found.
 */
function hasMpegTsSync(buf, maxPackets = 8) {
  if (!buf || buf.length < 188) return false;
  const limit = Math.min(187, buf.length - 188);
  for (let off = 0; off <= limit; off++) {
    if (buf[off] !== 0x47) continue;
    let hits = 0;
    for (let i = off; i + 188 <= buf.length && hits < maxPackets; i += 188) {
      if (buf[i] !== 0x47) break;
      hits++;
    }
    if (hits >= 3) return true;
  }
  return false;
}

/** Free bytes on the volume that holds `dir`, or null if unknown. */
function freeBytes(dir = cacheDir()) {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const st = fs.statfsSync(dir);
    const avail = Number(st.bavail != null ? st.bavail : st.bfree);
    const size = Number(st.bsize);
    if (!(avail >= 0) || !(size > 0)) return null;
    return avail * size;
  } catch (err) {
    log.warn('Disk free-space check failed', err);
    return null;
  }
}

function diskError(message) {
  const err = new Error(message);
  err.code = 'ENOSPC';
  return err;
}

/** Throws if there is not at least 1 GB free (and room for `needBytes` when known). */
function assertDiskSpace(needBytes = 0) {
  const free = freeBytes();
  if (free == null) return free;
  if (free < MIN_FREE_BYTES) {
    throw diskError('Not enough disk space. Keep at least 1 GB free.');
  }
  const need = Math.max(0, Number(needBytes) || 0);
  if (need > 0 && free - need < MIN_FREE_BYTES) {
    const needGb = (need / (1024 * 1024 * 1024)).toFixed(1);
    throw diskError(`Not enough disk space for this download (~${needGb} GB). Keep at least 1 GB free.`);
  }
  return free;
}

function wake(session) {
  for (const fn of [...session.waiters]) fn();
}

function waitUntil(session, need, ms = 20000) {
  if (session.error) return Promise.reject(session.error);
  if (session.bytes >= need || session.done) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.waiters.delete(on);
      resolve();
    }, ms);
    const on = () => {
      if (session.error) {
        clearTimeout(timer);
        session.waiters.delete(on);
        reject(session.error);
        return;
      }
      if (session.bytes >= need || session.done) {
        clearTimeout(timer);
        session.waiters.delete(on);
        resolve();
      }
    };
    session.waiters.add(on);
  });
}

function stop(session) {
  if (!session || session.stopped) return;
  session.stopped = true;
  session.error = session.error || new Error('Aborted');
  try { if (session.abort) session.abort(); } catch { /* ignore */ }
  try { if (session.ws) session.ws.destroy(); } catch { /* ignore */ }
  wake(session);
  sessions.delete(session.id);
  if (session.account && byAccount.get(session.account) === session.id) byAccount.delete(session.account);
  const file = session.file;
  const id = session.id;
  // Delayed delete — never remove a file that a newer session for the same id reused.
  setTimeout(() => {
    const cur = sessions.get(id);
    if (cur && cur.file === file && !cur.stopped) return;
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }, 1500);
}

/** Stop catch-up disk caches (optionally keeping one URL). */
function stopCatchupCaches(exceptUrl = '') {
  const exceptId = exceptUrl ? idFor(exceptUrl) : '';
  for (const session of [...sessions.values()]) {
    if (!session.catchup) continue;
    if (exceptId && session.id === exceptId) continue;
    stop(session);
  }
}

/**
 * Stop every disk download for one playlist/account (movies + catch-up).
 * Live play needs the provider's single connection free.
 */
function stopAccountCaches(accountKey, exceptUrl = '') {
  const key = String(accountKey || '');
  if (!key) return;
  const exceptId = exceptUrl ? idFor(exceptUrl) : '';
  for (const session of [...sessions.values()]) {
    if (String(session.account || '') !== key) continue;
    if (exceptId && session.id === exceptId) continue;
    stop(session);
  }
}

function fileReady(session) {
  if (!session || !session.file) return false;
  try {
    return fs.existsSync(session.file) && (session.bytes > 0 || session.ws);
  } catch {
    return false;
  }
}

function ensure(data, openUpstream) {
  const id = idFor(data.u);
  let session = sessions.get(id);
  // Reuse a healthy in-flight/completed download — never restart just because a client remounted.
  if (session && !session.stopped && !session.error) {
    session.touched = Date.now();
    if (data.catchup) {
      session.catchup = true;
      if (data.ch) session.channelId = data.ch;
      if (Number(data.startMs) > 0) session.startMs = Number(data.startMs);
    }
    return session;
  }
  // Catch-up with bytes already on disk: clear a stale error and keep the file if it still exists.
  if (session && session.catchup && session.bytes > 0 && fileReady(session) && !session.stopped) {
    session.error = null;
    session.touched = Date.now();
    return session;
  }
  if (session) stop(session);
  if (data.k) {
    const prevId = byAccount.get(data.k);
    // Reuse an in-flight download for the same URL; only stop a different stream.
    if (prevId && prevId !== id) {
      const prev = sessions.get(prevId);
      if (prev && !prev.done) stop(prev);
    }
  }

  // Refuse to start when the drive is already under the 1 GB reserve.
  assertDiskSpace(0);

  const file = path.join(cacheDir(), `${id}.bin`);
  // Only unlink if nothing active owns this path (avoid racing a just-restarted writer).
  try {
    if (!sessions.get(id)) fs.unlinkSync(file);
  } catch { /* ignore */ }
  session = {
    id,
    file,
    url: data.u || '',
    bytes: 0,
    total: 0,
    type: 'video/mp4',
    done: false,
    error: null,
    waiters: new Set(),
    stopped: false,
    account: data.k || '',
    catchup: !!data.catchup,
    channelId: data.ch || '',
    startMs: Number(data.startMs) || 0,
    touched: Date.now(),
    lastSpaceCheck: 0,
  };
  sessions.set(id, session);
  if (data.k) byAccount.set(data.k, id);
  download(session, data, openUpstream);
  return session;
}

async function download(session, data, openUpstream) {
  const controller = new AbortController();
  session.abort = () => controller.abort();
  const ws = fs.createWriteStream(session.file);
  session.ws = ws;
  ws.on('error', () => {});
  log.info(`VOD cache start ${session.id.slice(0, 8)}${session.catchup ? ' (catch-up)' : ''}`);
  playerDebug.record('vod.cache.start', session.catchup ? 'catch-up' : 'vod', {
    id: session.id.slice(0, 8),
    catchup: !!session.catchup,
  });
  let lastMilestone = 0;
  try {
    const { res: up, finalUrl } = await openUpstream(data, { ...(data.h || {}) }, controller);
    if (up.statusCode >= 400) {
      up.resume();
      throw new Error(`HTTP ${up.statusCode}`);
    }
    session.total = Number(up.headers['content-length']) || 0;
    session.type = String(up.headers['content-type'] || '').split(';')[0] || guessType(finalUrl);
    playerDebug.record('vod.cache.headers', '', {
      id: session.id.slice(0, 8),
      status: up.statusCode,
      total: session.total,
      type: session.type,
    });
    // Provider error pages must not be cached as video (mpegts sync_byte spam).
    if (/text\/html|application\/json|text\/plain/i.test(session.type)) {
      up.resume();
      throw new Error(`Not a media stream (${session.type || 'unknown type'})`);
    }
    if (session.total > 0) assertDiskSpace(session.total);
    if (up.socket) up.socket.setTimeout(0);
    wake(session);
    let checkedHead = false;
    let tsHeadOk = false;
    const wantTs = expectsMpegTs(session.type, finalUrl) || !!session.catchup;
    let tsProbe = Buffer.alloc(0);
    for await (const chunk of up) {
      if (session.stopped || ws.destroyed || !ws.writable) break;
      if (!checkedHead && chunk && chunk.length) {
        checkedHead = true;
        const head = chunk.subarray(0, Math.min(16, chunk.length)).toString('utf8').trimStart();
        if (/^<!DOCTYPE|^<html|^\{|^HTTP\//i.test(head)) {
          throw new Error('Upstream returned an error page instead of media');
        }
      }
      if (wantTs && !tsHeadOk) {
        tsProbe = tsProbe.length ? Buffer.concat([tsProbe, chunk]) : Buffer.from(chunk);
        if (tsProbe.length >= 188 * 4) {
          if (!hasMpegTsSync(tsProbe)) {
            throw new Error('Upstream returned non-MPEG-TS data (no 0x47 sync)');
          }
          tsHeadOk = true;
          tsProbe = Buffer.alloc(0);
        }
      } else if (wantTs && tsHeadOk && chunk && chunk.length >= 188 * 3
        && session.bytes > 0
        && Math.floor(session.bytes / (2 * 1024 * 1024))
          !== Math.floor((session.bytes + chunk.length) / (2 * 1024 * 1024))) {
        // Periodic mid-stream check — stop appending garbage after a good prefix.
        if (!hasMpegTsSync(chunk)) {
          throw new Error('MPEG-TS sync lost mid-stream');
        }
      }
      if (session.bytes - session.lastSpaceCheck >= SPACE_CHECK_EVERY_BYTES) {
        session.lastSpaceCheck = session.bytes;
        assertDiskSpace(0);
      }
      const ok = await new Promise((resolve) => {
        if (ws.destroyed || !ws.writable) {
          resolve(false);
          return;
        }
        try {
          if (ws.write(chunk)) resolve(true);
          else ws.once('drain', () => resolve(true));
        } catch {
          resolve(false);
        }
      });
      if (!ok) break;
      session.bytes += chunk.length;
      session.touched = Date.now();
      // Milestone every ~7.5MB (~30s @ 250KB/s) so start-buffer progress is visible.
      if (session.bytes - lastMilestone >= 7.5 * 1024 * 1024) {
        lastMilestone = session.bytes;
        playerDebug.record('vod.cache.progress', `${Math.round(session.bytes / 1024 / 1024)}MB`, {
          id: session.id.slice(0, 8),
          bytes: session.bytes,
          total: session.total,
          pct: session.total ? Math.round((100 * session.bytes) / session.total) : null,
        });
      }
      wake(session);
    }
    if (!ws.destroyed && ws.writable) {
      await new Promise((resolve) => ws.end(() => resolve()));
    }
    if (!session.total || session.total < session.bytes) session.total = session.bytes;
    // Never advertise Content-Length past real bytes (avoids client reading past EOF).
    if (session.total > session.bytes) session.total = session.bytes;
    if (!session.stopped && session.bytes > 0) {
      if (wantTs && !tsHeadOk && session.bytes >= 188 * 4 && !hasMpegTsSync(readSlice(session.file, 0, Math.min(session.bytes, 188 * 8) - 1))) {
        throw new Error('Upstream returned non-MPEG-TS data (no 0x47 sync)');
      }
      session.done = true;
      log.info(`VOD cache done ${session.id.slice(0, 8)} ${session.bytes} bytes`);
      playerDebug.record('vod.cache.done', `${session.bytes} bytes`, {
        id: session.id.slice(0, 8),
        bytes: session.bytes,
        total: session.total,
      });
      wake(session);
    }
  } catch (err) {
    playerDebug.record('vod.cache.error', err && err.message, {
      id: session.id.slice(0, 8),
      bytes: session.bytes,
    });
    try { if (!ws.destroyed) ws.destroy(); } catch { /* ignore */ }
    if (!session.stopped) {
      session.error = err;
      log.warn('VOD cache failed', err);
      wake(session);
    }
    // Remove empty / non-media failures so remount cannot re-serve poison.
    const msg = String((err && err.message) || err || '');
    if ((err && err.code === 'ENOSPC') || /non-MPEG-TS|error page|Not a media stream/i.test(msg)) {
      if (!(session.bytes > 188 * 4)) {
        setTimeout(() => { try { fs.unlinkSync(session.file); } catch { /* ignore */ } }, 500);
      }
    }
  }
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/i.exec(String(header || '').trim());
  if (!m) return null;
  let start = m[1] === '' ? NaN : Number(m[1]);
  let end = m[2] === '' ? NaN : Number(m[2]);
  if (!Number.isFinite(start) && Number.isFinite(end) && size) {
    start = Math.max(0, size - end);
    end = size - 1;
  }
  if (!Number.isFinite(start)) return null;
  if (!Number.isFinite(end)) end = size ? size - 1 : Infinity;
  return { start, end };
}

function drain(res) {
  return new Promise((resolve) => {
    if (res.destroyed) resolve();
    else res.once('drain', resolve);
  });
}

function readSlice(file, start, end) {
  const len = end - start + 1;
  const buf = Buffer.alloc(len);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, start);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  return buf;
}

async function streamGrow(session, res, start, lastByte) {
  let pos = start;
  while (!res.destroyed && !res.writableEnded) {
    if (session.stopped || session.error) break;
    if (pos >= session.bytes) {
      if (session.done || session.error || session.stopped) break;
      // Keep the progressive response open across brief download stalls so mpegts
      // does not see LOADING_COMPLETE and underrun for a long time.
      await waitUntil(session, pos + 1, 20000);
      if (res.destroyed) break;
      continue;
    }
    const cap = lastByte == null ? session.bytes - 1 : Math.min(session.bytes - 1, lastByte);
    if (cap < pos) break;
    const buf = readSlice(session.file, pos, cap);
    if (!buf) {
      // File was replaced mid-serve (restart race) — wait for the writer to recreate it.
      if (session.stopped || session.error) break;
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }
    pos += buf.length;
    if (!res.write(buf)) await drain(res);
    if (lastByte != null && pos > lastByte) break;
  }
}

/**
 * Serve from the growing disk cache.
 * Returns false when the download never produced bytes so the caller can proxy
 * the provider URL directly instead of returning a hard 502 to mpegts.js.
 */
async function serve(req, res, data, openUpstream) {
  const session = ensure(data, openUpstream);
  session.touched = Date.now();
  try {
    await waitUntil(session, 1, 25000);
  } catch (err) {
    if (err && err.code === 'ENOSPC') {
      if (!res.headersSent) res.status(507).json({ error: err.message || 'Download failed' });
      return true;
    }
    log.warn('VOD cache not ready; caller may fall back', err);
    return false;
  }
  if (session.bytes < 1) {
    if (session.error && session.error.code === 'ENOSPC') {
      if (!res.headersSent) res.status(507).json({ error: session.error.message || 'Download failed' });
      return true;
    }
    log.warn(`VOD cache empty for ${session.id.slice(0, 8)}: ${(session.error && session.error.message) || 'no data'}`);
    return false;
  }

  // Prefer real bytes once finished — never promise padding past EOF.
  const total = session.done ? session.bytes : (session.total || 0);
  const range = parseRange(req.headers.range, total);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', session.type || 'video/mp4');
  res.setHeader('Cache-Control', 'no-cache');

  const progressive = !range || (range.start === 0 && range.end >= (total ? total - 1 : Infinity));
  if (progressive) {
    // While still downloading, omit Content-Length so clients stream immediately
    // instead of waiting for the promised full episode size.
    const finished = !!session.done;
    const last = finished && total ? total - 1 : null;
    res.status(range && finished ? 206 : 200);
    if (finished && total) {
      res.setHeader('Content-Length', String(total));
      if (range) res.setHeader('Content-Range', `bytes 0-${total - 1}/${total}`);
    }
    await streamGrow(session, res, 0, last);
    if (!res.writableEnded && !res.destroyed) res.end();
    return true;
  }

  // Fail fast when the seek point is not on disk yet — waiting up to 60s made VOD
  // hard seeks take minutes. Caller falls back to direct proxy (provider Range).
  if (session.bytes <= range.start) {
    if (!session.done && !session.error) {
      // Brief grace for tiny race (just started writing); then miss → direct proxy.
      try { await waitUntil(session, range.start + 1, 1500); } catch { /* miss */ }
    }
    if (session.bytes <= range.start) {
      log.warn(`VOD cache Range miss @${range.start} (have ${session.bytes}); fall back to proxy`);
      return false;
    }
  }

  const want = range.end === Infinity ? range.start + 2 * 1024 * 1024 - 1 : range.end;
  try {
    await waitUntil(session, Math.min(want, range.start + 2 * 1024 * 1024) + 1, 2500);
  } catch { /* send what we have */ }
  const sendEnd = Math.min(session.bytes - 1, range.end === Infinity ? session.bytes - 1 : range.end);
  if (sendEnd < range.start) {
    res.status(503).end();
    return true;
  }
  const length = sendEnd - range.start + 1;
  res.status(206);
  res.setHeader('Content-Range', `bytes ${range.start}-${sendEnd}/${total || '*'}`);
  res.setHeader('Content-Length', String(length));
  const rs = fs.createReadStream(session.file, { start: range.start, end: sendEnd });
  rs.on('error', () => res.destroy());
  rs.pipe(res);
  return true;
}

function status(data) {
  const session = sessions.get(idFor(data.u));
  if (!session || session.stopped) return { bytes: 0, total: 0, done: false };
  return {
    bytes: session.bytes,
    total: session.total || 0,
    done: !!session.done,
    error: session.error ? String(session.error.message || session.error) : '',
    free: freeBytes(),
  };
}

function prefetch(data, openUpstream) {
  return ensure(data, openUpstream);
}

async function waitFor(url, bytes, ms) {
  const session = sessions.get(idFor(url));
  if (!session) return null;
  try {
    await waitUntil(session, bytes, ms);
  } catch {
    /* download error — caller inspects snapshot() */
  }
  return snapshot(url);
}

function snapshot(url) {
  const session = sessions.get(idFor(url));
  if (!session || session.stopped) return null;
  return {
    file: session.file,
    bytes: session.bytes,
    total: session.total || 0,
    done: !!session.done,
    error: session.error ? String(session.error.message || session.error) : '',
  };
}

function stopUrl(url) {
  const session = sessions.get(idFor(url));
  if (session) stop(session);
}

/**
 * Abort an in-flight disk download (frees the IPTV connection). Finished caches are kept
 * so a later resume does not re-fetch the whole title.
 */
function abortActive(url) {
  const session = sessions.get(idFor(url));
  if (!session || session.done) return false;
  stop(session);
  return true;
}

/** Abort every unfinished download for one playlist/account. Keeps completed files. */
function abortAccountActive(accountKey) {
  const key = String(accountKey || '');
  if (!key) return 0;
  let n = 0;
  for (const session of [...sessions.values()]) {
    if (String(session.account || '') !== key) continue;
    if (session.done) continue;
    stop(session);
    n++;
  }
  return n;
}

/**
 * Reuse an in-flight catch-up download for the same channel + programme start.
 * Timeshift URLs change when `duration` ticks; restarting would wipe the file.
 */
function findCatchupReuse(channelId, startMs) {
  const ch = String(channelId || '');
  const start = Number(startMs) || 0;
  if (!ch || !start) return null;
  for (const session of sessions.values()) {
    if (!session.catchup || session.stopped) continue;
    if (String(session.channelId || '') !== ch) continue;
    if (Number(session.startMs) !== start) continue;
    if (!session.url) continue;
    // Allow reuse after a transient error if we still have data on disk.
    if (session.error && !(session.bytes > 0 && fileReady(session))) continue;
    if (session.error) session.error = null;
    session.touched = Date.now();
    return {
      url: session.url,
      bytes: session.bytes,
      total: session.total || 0,
      done: !!session.done,
    };
  }
  return null;
}

setInterval(() => {
  const stale = Date.now() - 45 * 60 * 1000;
  for (const session of [...sessions.values()]) {
    if (session.done && session.touched < stale) stop(session);
  }
}, 60000).unref();

module.exports = {
  serve,
  status,
  prefetch,
  waitFor,
  snapshot,
  stopUrl,
  abortActive,
  abortAccountActive,
  stopCatchupCaches,
  stopAccountCaches,
  findCatchupReuse,
  freeBytes,
  assertDiskSpace,
  MIN_FREE_BYTES,
};
