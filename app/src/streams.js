'use strict';

const crypto = require('crypto');
const db = require('./db');
const log = require('./log');
const { request } = require('./http');
const ffmpeg = require('./ffmpeg');
const vodcache = require('./vodcache');
const playerDebug = require('./player-debug');

const LINK_TTL_MS = 24 * 3600 * 1000;
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;
/** Start VOD playback once ~this many seconds of media are on disk (not the whole episode). */
const VOD_START_BUFFER_SEC = 30;
/** Conservative bytes/sec floor used for start/seek lead (matches remux wait heuristic). */
const VOD_BYTES_PER_SEC = 250000;

/** Disk bytes to wait for before starting VOD play / remux (~30s, plus seek lead). */
function vodLeadBytes(startSec = 0) {
  const lead = Math.floor(VOD_START_BUFFER_SEC * VOD_BYTES_PER_SEC);
  const ss = Math.max(0, Number(startSec) || 0);
  if (ss > 1) {
    // Must cover the seek point itself — a low cap made -ss land past EOF of the
    // growing cache, ffmpeg exited in seconds, and the client treated that as EOS.
    return Math.max(lead, Math.floor(ss * VOD_BYTES_PER_SEC) + lead);
  }
  return lead;
}

let secret = null;

function getSecret() {
  if (!secret) {
    secret = db.getMeta('stream_secret');
    if (!secret) {
      secret = crypto.randomBytes(32).toString('hex');
      db.setMeta('stream_secret', secret);
    }
  }
  return secret;
}

const b64url = (text) => Buffer.from(text).toString('base64url');

function sign(payload) {
  return crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url').slice(0, 32);
}

/**
 * Same-origin URL that proxies `target` through this server.
 * `key` groups streams that share one provider account (the playlist id); see `claimAccount`.
 */
function signedUrl(target, userAgent, key = '', extraHeaders, opts = {}) {
  const body = { u: target, a: userAgent || '', k: key, e: Date.now() + LINK_TTL_MS };
  if (extraHeaders && Object.keys(extraHeaders).length) body.h = extraHeaders;
  if (opts.vod) body.v = 1;
  if (opts.transcode) body.t = 1;
  if (opts.cache) body.c = 1;
  // Catch-up TS: normalize codecs via ffmpeg (copy/encode video + AAC) like live.
  if (opts.catchup) body.cu = 1;
  // Optional MAG remint info so a burned play_token (456/462) can be refreshed once.
  if (opts.remint && typeof opts.remint === 'object') body.r = opts.remint;
  const payload = b64url(JSON.stringify(body));
  return `/api/stream?p=${payload}&s=${sign(payload)}`;
}

// Open continuous (live TS) streams per key. Most IPTV accounts allow a single connection, so a new
// stream request closes the previous one instead of getting the provider's "too many connections" video.
const continuous = new Map();

function claimAccount(key) {
  const open = key && continuous.get(key);
  if (!open) return;
  for (const close of [...open]) {
    try { close(); } catch { /* ignore */ }
  }
  continuous.delete(key);
}

/** Kill live proxy feeds + disk caches for one playlist (call before minting a new play URL). */
function releaseAccount(key, exceptUrl = '') {
  if (!key) return;
  claimAccount(key);
  vodcache.stopAccountCaches(key, exceptUrl);
}

function trackContinuous(key, close) {
  if (!key) return () => {};
  if (!continuous.has(key)) continuous.set(key, new Set());
  continuous.get(key).add(close);
  return () => {
    const set = continuous.get(key);
    if (!set) return;
    set.delete(close);
    if (!set.size) continuous.delete(key);
  };
}

function verify(payload, signature) {
  if (!payload || !signature) return null;
  const expected = sign(payload);
  if (expected.length !== signature.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.e > Date.now() ? data : null;
  } catch {
    return null;
  }
}

function streamKind(url) {
  return /\.m3u8?(\?|$)/i.test(url) ? 'hls' : 'ts';
}

/** How the player should open a VOD URL. MAG create_link often returns movie.php?stream=id.mkv (MKV/MP4, not live TS). */
function playKind(url, playlistType) {
  const value = String(url || '');
  if (/\.m3u8?(\?|$)/i.test(value)) return 'hls';
  if (/\.(mp4|m4v|mov|mkv|webm|ogv|3gp)(\?|$|&)/i.test(value)) return 'file';
  try {
    const u = new URL(value);
    const stream = u.searchParams.get('stream') || '';
    if (/\.(mp4|m4v|mov|mkv|webm|ogv|3gp|avi)(?:\?|$)/i.test(stream)) return 'file';
    if (/movie\.php$/i.test(u.pathname)) return 'file';
  } catch { /* ignore */ }
  if (playlistType === 'mag') return 'ts';
  return 'file';
}

function rewritePlaylist(text, baseUrl, userAgent, key, extraHeaders, vod) {
  const toProxy = (uri) => signedUrl(new URL(uri, baseUrl).toString(), userAgent, key, extraHeaders, { vod });
  return text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${toProxy(uri)}"`);
    return toProxy(trimmed);
  }).join('\n');
}

const magUa = require('./mag').MAG_UA;

async function openUpstream(data, headers, controller) {
  const mag = !!(data.h && (data.h.Cookie || data.h.Authorization));
  const vod = !!data.v;
  const playToken = /play_token=/i.test(data.u) || /\/play\//i.test(data.u);
  const ua = data.a || magUa;
  const headerTries = [];
  const first = { ...(headers || {}) };
  headerTries.push(first);
  if (first.Authorization) {
    const noAuth = { ...first };
    delete noAuth.Authorization;
    headerTries.push(noAuth);
  }
  if (mag || vod || playToken) {
    const slim = { ...first };
    delete slim.Authorization;
    delete slim.Origin;
    delete slim.Referer;
    headerTries.push(slim);
  }
  // MAG CDN play_token links often 460 when Cookie/Origin hitch a ride — try UA-only.
  // Keep Range on bare tries so VOD seeks still work after Cookie is stripped.
  if (mag || playToken) {
    const bare = {};
    if (first['X-User-Agent']) bare['X-User-Agent'] = first['X-User-Agent'];
    if (first.Range) bare.Range = first.Range;
    headerTries.push(bare);
    headerTries.push(first.Range ? { Range: first.Range } : {});
  }
  const seen = new Set();
  let last = null;
  for (const hdr of headerTries) {
    const key = JSON.stringify(hdr);
    if (seen.has(key)) continue;
    seen.add(key);
    if (last && last.res) last.res.resume();
    last = await request(data.u, {
      userAgent: ua,
      headers: hdr,
      timeoutMs: vod ? 45000 : 20000,
      signal: controller.signal,
      // Keep MAG on the sticky IPv4 agent; VOD MAG still needs IPv4 (portal handshake is v4).
      agent: mag && !vod ? 'stream' : (vod ? false : undefined),
      family: mag || playToken ? 4 : (vod ? 0 : undefined),
    });
    if (last.res.statusCode < 400) return last;
    // MAG CDNs use 456/460/462 for bad headers/tokens; 405 often means wrong cookie set.
    if (![403, 404, 405, 410, 456, 460, 462, 511].includes(last.res.statusCode)) return last;
    log.warn(`Stream HTTP ${last.res.statusCode}, retrying ${safeHost(data.u)}`);
  }
  return last;
}

function prefetchVod(target, userAgent, key, extraHeaders, opts = {}) {
  return vodcache.prefetch({
    u: target,
    a: userAgent || '',
    k: key || '',
    h: extraHeaders || {},
    v: 1,
    catchup: !!opts.catchup,
    ch: opts.channelId || '',
    startMs: Number(opts.startMs) || 0,
  }, openUpstream);
}

/** Active catch-up disk download for this channel + show start, if any. */
function findCatchupReuse(channelId, startMs) {
  return vodcache.findCatchupReuse(channelId, startMs);
}

function waitVodCache(target, bytes, ms) {
  return vodcache.waitFor(target, bytes, ms);
}

function vodCacheInfo(target) {
  return vodcache.snapshot(target);
}

function stopVodCache(target) {
  vodcache.stopUrl(target);
}

/** Stop an unfinished VOD disk download; leave completed caches on disk. */
function abortActiveVod(target) {
  return vodcache.abortActive(target);
}

/**
 * Leave on-demand playback: kill remux/proxy pipes for this account and abort any
 * unfinished movie/catch-up disk downloads so the IPTV connection is freed.
 */
function releaseVodPlayback(accountKey, streamUrl = '') {
  if (accountKey) claimAccount(accountKey);
  let stopped = 0;
  if (streamUrl) {
    if (vodcache.abortActive(streamUrl)) stopped += 1;
  }
  if (accountKey) stopped += vodcache.abortAccountActive(accountKey);
  return stopped;
}

/** Decode a signed /api/stream link (p + s) for stop/status helpers. */
function decodeStreamLink(payload, signature) {
  return verify(payload, signature);
}

/** Drop catch-up disk caches when changing channel (keeps `exceptUrl` if still needed). */
function stopCatchupCaches(exceptUrl = '') {
  vodcache.stopCatchupCaches(exceptUrl);
}

/** Drop movie + catch-up downloads for a playlist so live can use the account's connection. */
function stopAccountCaches(accountKey, exceptUrl = '') {
  vodcache.stopAccountCaches(accountKey, exceptUrl);
}

function cacheStatus(payload, signature) {
  const data = verify(payload, signature);
  if (!data) return null;
  return vodcache.status(data);
}

async function proxy(req, res) {
  const data = verify(req.query.p, req.query.s);
  if (!data) {
    res.status(403).json({ error: 'Invalid or expired stream link' });
    return;
  }

  const controller = new AbortController();
  const vod = !!data.v;
  // One live TS per account. On-demand (and HLS segments) must not cancel each other.
  if (!vod) {
    claimAccount(data.k);
    // Movie/catch-up disk downloads also hold the provider connection — release them for live.
    if (data.k) vodcache.stopAccountCaches(data.k);
  }

  const mag = !!(data.h && (data.h.Cookie || data.h.Authorization));
  const magPlay = /\/play\//i.test(data.u)
    || /play_token=/i.test(data.u)
    || /\/(?:live|movie|timeshift)\.php(?:\?|$)/i.test(data.u);
  // Xtream live is often /live/user/pass/id.ts (not live.php) — still a single continuous TS feed.
  const xtreamTs = /\/live\/.+\.ts(?:\?|$)/i.test(data.u) || /\/timeshift\/.+\.ts(?:\?|$)/i.test(data.u) || /\.ts(?:\?|$)/i.test(data.u);
  const liveTs = !vod && (mag || magPlay || xtreamTs);
  const isHls = /\.m3u8?/i.test(data.u);
  // Cipher: never remux — libVLC decodes all codecs; this proxy only forwards bytes.
  const transcode = false;
  const catchupTs = false;
  if (vod && data.c && !transcode && !catchupTs) {
    try {
      playerDebug.record('vod.serve', 'progressive cache', {
        host: safeHost(data.u),
        range: req.headers.range || '',
      });
      const served = await vodcache.serve(req, res, data, openUpstream);
      if (served !== false) return;
      // Cache never got bytes (provider error / abort) — stream the URL directly.
      log.warn(`VOD cache miss for ${safeHost(data.u)}; proxying directly`);
      playerDebug.record('vod.serve.miss', 'proxy direct', { host: safeHost(data.u) });
      try { vodcache.stopUrl(data.u); } catch { /* ignore */ }
    } catch (err) {
      if (!controller.signal.aborted) log.warn('VOD cache serve failed', err);
      playerDebug.record('vod.serve.error', err && err.message);
      if (res.headersSent) return;
      try { vodcache.stopUrl(data.u); } catch { /* ignore */ }
    }
  }
  res.on('close', () => controller.abort());
  // Live MAG/TS feeds break with Range; MAG VOD needs Range for libVLC progress-bar seeks
  // (Xtream VOD already allowed Range — without it, seeks only work inside the buffer).
  const skipRange = transcode || catchupTs || liveTs || (magPlay && !vod);
  const range = req.headers.range && !skipRange ? req.headers.range : '';

  // Remux paths removed (libVLC). Kept as dead branches for easier diffs.
  if (false && transcode) {
    if (data.k) claimAccount(data.k);
    const start = Math.max(0, Number(req.query.ss) || Number(data.ss) || 0);
    // Keep / start the disk download, then remux from local bytes when possible
    // (one provider connection; seekable without re-fetching from 0).
    let inputFile = '';
    let cacheGrowing = false;
    let snapBytes = 0;
    const remuxT0 = Date.now();
    const seeking = start > 0.4;
    // Only use the disk cache when the signed URL opted in (`c=1`). URL-only remux
    // (moov-at-EOF MP4) must not start a second download alongside ffmpeg.
    if (data.c) {
      try {
        vodcache.prefetch(data, openUpstream);
        let snap;
        let need = 0;
        if (seeking) {
          // Hard seek: never wait for bytes≈ss×bitrate (that was up to 60s, then we
          // often fell through to URL remux anyway). Finished cache → local -ss;
          // still downloading → URL -ss immediately so ffmpeg can HTTP-seek.
          need = 256 * 1024;
          snap = vodcache.snapshot(data.u);
          if (!snap || snap.bytes < need) {
            snap = await vodcache.waitFor(data.u, need, 2500);
          }
          playerDebug.record('vod.remux.wait', `seek-fast start=${start}`, {
            need,
            start,
            seeking: true,
            bytes: snap && snap.bytes,
            done: !!(snap && snap.done),
            host: safeHost(data.u),
          });
        } else {
          // Fresh start: ~30s of media — enough to begin without the whole episode.
          need = vodLeadBytes(0);
          playerDebug.record('vod.remux.wait', `need=${need} start=${start}`, {
            need,
            start,
            seeking: false,
            host: safeHost(data.u),
          });
          snap = await vodcache.waitFor(data.u, need, 60000);
        }
        if (snap && snap.file && snap.bytes >= Math.min(need, 256 * 1024) && !snap.error) {
          // Only remux from disk when ffmpeg can open it (MKV/faststart MP4).
          // Incomplete moov-at-EOF MP4 must use the provider URL instead.
          const readable = ffmpeg.probeFile(snap.file);
          // Growing files cannot -ss reliably (seekable 0 / no index) — any mid-file
          // seek must use the provider URL or ffmpeg exits after a tiny fragment.
          const growing = !snap.done;
          const seekOnGrowing = seeking && growing;
          const enoughForSeek = !seeking || snap.done;
          if (
            readable
            && (readable.video || readable.audio)
            && enoughForSeek
            && !seekOnGrowing
          ) {
            inputFile = snap.file;
            cacheGrowing = growing;
            snapBytes = snap.bytes;
          } else {
            const why = !readable
              ? 'unreadable'
              : seekOnGrowing
                ? 'seek-on-growing'
                : 'seek-past-cache';
            playerDebug.record('vod.remux.cache', why, {
              bytes: snap.bytes,
              need,
              start,
              done: !!snap.done,
              waitMs: Date.now() - remuxT0,
            });
            // Free the provider connection so URL remux can open (single-account IPTV).
            try { vodcache.stopUrl(data.u); } catch { /* ignore */ }
          }
        }
        playerDebug.record('vod.remux.cache', inputFile ? 'ok' : 'miss', {
          bytes: snap && snap.bytes,
          done: !!(snap && snap.done),
          growing: cacheGrowing,
          seeking,
          error: (snap && snap.error) || '',
          waitMs: Date.now() - remuxT0,
        });
      } catch (err) {
        log.warn('VOD cache for remux not ready', err);
        playerDebug.record('vod.remux.cache', 'error', { error: err && err.message });
      }
    }
    try {
      playerDebug.record('vod.remux.start', inputFile ? (cacheGrowing ? 'grow-file' : 'disk') : 'url', {
        start,
        snapBytes,
        growing: cacheGrowing,
        host: safeHost(data.u),
      });
      const ff = ffmpeg.transcodeFromUrl(res, {
        url: data.u,
        inputFile,
        userAgent: data.a,
        headers: data.h || {},
        start,
        signal: controller.signal,
        growing: cacheGrowing,
        isCacheDone: () => {
          const s = vodcache.snapshot(data.u);
          return !!(s && s.done);
        },
      });
      if (data.k && ff) {
        const untrack = trackContinuous(data.k, () => {
          try { ff.kill('SIGKILL'); } catch { /* ignore */ }
          try { res.destroy(); } catch { /* ignore */ }
        });
        res.on('close', untrack);
      }
      if (ff) {
        ff.on('close', (code) => {
          playerDebug.record('vod.remux.close', `code=${code}`, {
            code,
            start,
            ms: Date.now() - remuxT0,
          });
        });
      }
    } catch (err) {
      log.warn('Transcode failed', err);
      playerDebug.record('vod.remux.error', err && err.message);
      if (!res.headersSent) res.status(502).json({ error: err.message });
    }
    return;
  }

  // Catch-up remux disabled — raw proxy / disk cache below.
  if (false && catchupTs) {
    if (data.k) claimAccount(data.k);
    let inputFile = '';
    let cacheGrowing = false;
    try {
      if (data.c || data.v) {
        vodcache.prefetch(data, openUpstream);
        const snap = await vodcache.waitFor(data.u, 256 * 1024, 20000);
        if (snap && snap.file && snap.bytes >= 64 * 1024 && !snap.error) {
          inputFile = snap.file;
          cacheGrowing = !snap.done;
        }
      }
      playerDebug.record('ts.sync.start', inputFile ? (cacheGrowing ? 'catchup-grow' : 'catchup-disk') : 'catchup-url', {
        host: safeHost(data.u),
        growing: cacheGrowing,
      });
      const ff = ffmpeg.liveSyncTs(res, {
        url: data.u,
        inputFile,
        userAgent: data.a,
        headers: data.h || {},
        signal: controller.signal,
        growing: cacheGrowing,
        isCacheDone: () => {
          const s = vodcache.snapshot(data.u);
          return !!(s && s.done);
        },
      });
      if (data.k && ff) {
        const untrack = trackContinuous(data.k, () => {
          try { ff.kill('SIGKILL'); } catch { /* ignore */ }
          try { res.destroy(); } catch { /* ignore */ }
          try { controller.abort(); } catch { /* ignore */ }
        });
        res.on('close', untrack);
      }
      return;
    } catch (err) {
      log.warn('Catch-up sync remux unavailable; proxying raw TS', err);
      playerDebug.record('ts.sync.error', err && err.message);
    }
  }

  // Live ffmpeg sync remux disabled — raw TS proxy (libVLC).
  if (false && !vod && liveTs && ffmpeg.findBinary()) {
    try {
      const ff = ffmpeg.liveSyncTs(res, {
        url: data.u,
        userAgent: data.a,
        headers: data.h || {},
        signal: controller.signal,
      });
      if (data.k && ff) {
        const untrack = trackContinuous(data.k, () => {
          try { ff.kill('SIGKILL'); } catch { /* ignore */ }
          try { res.destroy(); } catch { /* ignore */ }
          try { controller.abort(); } catch { /* ignore */ }
        });
        res.on('close', untrack);
      }
      return;
    } catch (err) {
      log.warn('Live sync remux unavailable; proxying raw TS', err);
    }
  }

  let upstream;
  try {
    const headers = { ...(data.h || {}) };
    if (range) headers.Range = range;
    upstream = await openUpstream(data, headers, controller);
    if (range && [416, 405, 456, 460, 462].includes(upstream.res.statusCode)) {
      upstream.res.resume();
      const retry = { ...(data.h || {}) };
      log.warn(`Stream HTTP ${upstream.res.statusCode}, retrying ${safeHost(data.u)} without Range`);
      upstream = await openUpstream(data, retry, controller);
    }
    // Burned MAG play_token: remint once from portal cmd embedded in the signed payload.
    const playToken = /play_token=/i.test(data.u) || /\/play\//i.test(data.u);
    if (
      playToken
      && data.r
      && data.r.portal
      && data.r.mac
      && data.r.cmd
      && upstream
      && [456, 460, 462].includes(upstream.res.statusCode)
    ) {
      upstream.res.resume();
      try {
        const magApi = require('./mag');
        const creds = {
          portal: magApi.normalizePortal(data.r.portal),
          mac: magApi.normalizeMac(data.r.mac),
        };
        await magApi.connect(creds, { timeoutMs: 20000 });
        const nextUrl = await magApi.createVodLink(creds, {
          cmd: data.r.cmd,
          file_id: data.r.fileId || '',
          series: data.r.series || '',
        }, { timeoutMs: 30000 });
        if (nextUrl && nextUrl !== data.u) {
          log.warn(`Stream reminted play_token for ${safeHost(data.u)} → ${safeHost(nextUrl)}`);
          data.u = nextUrl;
          // Fresh token: prefer no Range on the first remint attempt.
          upstream = await openUpstream(data, { ...(data.h || {}) }, controller);
        }
      } catch (err) {
        log.warn(`Stream remint failed for ${safeHost(data.u)}: ${err.message}`);
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) log.warn(`Stream connect failed: ${safeHost(data.u)}`, err);
    if (!res.headersSent) res.status(502).json({ error: `Could not reach stream: ${err.message}` });
    return;
  }

  const { res: up, finalUrl } = upstream;
  if (up.statusCode >= 400) {
    up.resume();
    log.warn(`Stream HTTP ${up.statusCode}: ${safeHost(data.u)}`);
    const hint = up.statusCode === 456
      ? 'Portal CDN rejected the stream (HTTP 456). Try another MAG playlist/MAC.'
      : `Stream returned HTTP ${up.statusCode}`;
    res.status(502).json({ error: hint });
    return;
  }

  const contentType = String(up.headers['content-type'] || '');
  if (/text\/html|application\/json/i.test(contentType)) {
    up.resume();
    log.warn(`Stream non-media content-type ${contentType}: ${safeHost(data.u)}`);
    res.status(502).json({ error: 'Stream returned an error page instead of media' });
    return;
  }
  const isPlaylist = /mpegurl/i.test(contentType) || /\.m3u8?(\?|$)/i.test(finalUrl);

  if (isPlaylist) {
    const chunks = [];
    let size = 0;
    for await (const chunk of up) {
      size += chunk.length;
      if (size > MAX_PLAYLIST_BYTES) break;
      chunks.push(chunk);
    }
    const body = rewritePlaylist(Buffer.concat(chunks).toString('utf8'), finalUrl, data.a, data.k, data.h, vod);
    res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' });
    res.send(body);
    return;
  }

  // Peek before headers — cache-miss proxy used to forward HTML/zeros as video/mp2t.
  const expectTs = /mp2t|mpegts|video\/ts/i.test(contentType)
    || /\.ts(?:\?|$)/i.test(finalUrl)
    || /timeshift/i.test(finalUrl)
    || (!up.headers['content-type'] && !/\.(mp4|m4v|mkv|webm)(?:\?|$)/i.test(finalUrl));
  let peek;
  try {
    peek = await readUpstreamPeek(up, expectTs ? 188 * 4 : 64);
  } catch (err) {
    if (!controller.signal.aborted) log.warn(`Stream peek failed: ${safeHost(data.u)}`, err);
    res.status(502).json({ error: 'Could not read stream' });
    return;
  }
  if (!peek.length) {
    res.status(502).json({ error: 'Stream returned no media data' });
    return;
  }
  const head = peek.subarray(0, Math.min(16, peek.length)).toString('utf8').trimStart();
  if (/^<!DOCTYPE|^<html|^\{|^HTTP\//i.test(head)) {
    up.resume();
    log.warn(`Stream error-page body: ${safeHost(data.u)}`);
    res.status(502).json({ error: 'Stream returned an error page instead of media' });
    return;
  }
  if (expectTs && peek.length >= 188 * 3 && !hasMpegTsSync(peek)) {
    up.resume();
    log.warn(`Stream non-TS body: ${safeHost(data.u)}`);
    res.status(502).json({ error: 'Stream returned non-MPEG-TS data' });
    return;
  }

  res.status(up.statusCode);
  if (up.headers['content-type']) res.setHeader('content-type', up.headers['content-type']);
  if (up.headers['content-length']) res.setHeader('content-length', up.headers['content-length']);
  if (up.headers['content-range']) res.setHeader('content-range', up.headers['content-range']);
  if (up.statusCode === 206 || up.headers['content-range'] || up.headers['content-length']) {
    res.setHeader('accept-ranges', 'bytes');
  }
  if (!up.headers['content-type']) {
    const ext = String((finalUrl.match(/\.([a-z0-9]{2,5})(?:\?|$)/i) || [])[1] || '').toLowerCase();
    const types = { mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', avi: 'video/x-msvideo', webm: 'video/webm' };
    res.setHeader('content-type', types[ext] || 'video/mp2t');
  }
  res.setHeader('Cache-Control', 'no-cache');
  if (up.socket) up.socket.setTimeout(vod ? 120000 : 60000);
  up.on('error', () => res.destroy());
  // Track every live/proxy feed so the next tune can hard-kill it. Providers often
  // send Content-Length on live TS; skipping those left orphaned connections.
  if (!vod && data.k) {
    const untrack = trackContinuous(data.k, () => {
      try { up.destroy(); } catch { /* ignore */ }
      try { res.destroy(); } catch { /* ignore */ }
      try { controller.abort(); } catch { /* ignore */ }
    });
    res.on('close', untrack);
  }
  res.on('close', () => {
    try { up.destroy(); } catch { /* ignore */ }
    try { controller.abort(); } catch { /* ignore */ }
  });
  if (!res.write(peek)) await new Promise((r) => res.once('drain', r));
  up.pipe(res);
}

/** Read the first `need` bytes from an incoming upstream response. */
function readUpstreamPeek(up, need) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= need) finish();
    };
    const onEnd = () => finish();
    const onErr = (err) => {
      cleanup();
      reject(err);
    };
    const finish = () => {
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const cleanup = () => {
      up.off('data', onData);
      up.off('end', onEnd);
      up.off('error', onErr);
    };
    up.on('data', onData);
    up.once('end', onEnd);
    up.once('error', onErr);
    up.resume();
  });
}

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

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

module.exports = {
  vodLeadBytes,
  VOD_START_BUFFER_SEC,
  VOD_BYTES_PER_SEC,
  signedUrl,
  proxy,
  streamKind,
  playKind,
  prefetchVod,
  waitVodCache,
  vodCacheInfo,
  stopVodCache,
  abortActiveVod,
  releaseVodPlayback,
  decodeStreamLink,
  stopCatchupCaches,
  stopAccountCaches,
  releaseAccount,
  claimAccount,
  findCatchupReuse,
  cacheStatus,
};
