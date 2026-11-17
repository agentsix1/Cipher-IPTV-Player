'use strict';

/**
 * ffmpeg sidecar next to the desktop exe (or app/bin, tools/, PATH).
 * Chrome will play HEVC video on Windows but not E-AC3 audio. We remux in one pass:
 * copy video, always encode audio to AAC, write fragmented MP4 for Media Source
 * so the browser can keep converting while paused. PGS is dropped.
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const config = require('./config');
const log = require('./log');

let resolved;
const probeCache = new Map();
/**
 * Browser-native progressive playback (Chrome/Edge) — whitelist.
 * Anything outside this set is remuxed (and video may be re-encoded).
 */
const SAFE_VIDEO = /^(h264|avc1|avc3|hevc|h265|hev1|hvc1|vp8|vp9|av01|av1)$/i;
/** Video codecs we can copy into fMP4/MSE without re-encode. */
const COPY_VIDEO = /^(h264|avc1|avc3|hevc|h265|hev1|hvc1|vp9|av01|av1)$/i;
const SAFE_AUDIO = /^(aac|mp4a|mp3|opus|vorbis|flac)$/i;

function win() {
  return process.platform === 'win32';
}

function binName(base) {
  return win() ? `${base}.exe` : base;
}

function lookIn(dir) {
  if (!dir) return '';
  try {
    const file = path.join(dir, binName('ffmpeg'));
    return fs.existsSync(file) ? file : '';
  } catch {
    return '';
  }
}

function findOnPath() {
  try {
    const out = execFileSync(win() ? 'where' : 'which', ['ffmpeg'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    const first = String(out || '').split(/\r?\n/).map((s) => s.trim()).find((s) => s && fs.existsSync(s));
    return first || '';
  } catch {
    return '';
  }
}

function findBinary() {
  if (resolved) return resolved;
  const env = String(process.env.FFMPEG || process.env.FFMPEG_PATH || '').trim();
  if (env && fs.existsSync(env)) {
    resolved = env;
    return resolved;
  }
  const hits = [
    lookIn(path.dirname(process.execPath)),
    lookIn(path.join(path.dirname(process.execPath), 'server')),
    lookIn(path.join(path.dirname(process.execPath), 'server', 'bin')),
    lookIn(path.join(__dirname, '..', 'bin')),
    lookIn(path.join(__dirname, '..', '..', 'desktop-exe', 'tools')),
    lookIn(path.join(__dirname, '..', '..', 'dist', 'windows')),
    lookIn(path.join(config.dataDir, '..')),
    lookIn(process.cwd()),
    findOnPath(),
  ].filter(Boolean);
  if (hits[0]) {
    resolved = hits[0];
    log.info(`Using ffmpeg at ${resolved}`);
    return resolved;
  }
  return '';
}

function guessInputFormat(url) {
  const value = String(url || '');
  if (/\.mkv(\?|$|&)/i.test(value) || /(?:\?|&)stream=[^&]*\.mkv(?:&|$)/i.test(value)) return 'matroska';
  if (/\.avi(\?|$|&)/i.test(value)) return 'avi';
  if (/\.mp4(\?|$|&)/i.test(value) || /\.m4v(\?|$|&)/i.test(value)) return 'mp4';
  if (/\.ts(\?|$|&)/i.test(value) || /\.m2ts(\?|$|&)/i.test(value)) return 'mpegts';
  return '';
}

function headerBlob(headers) {
  return Object.entries(headers || {})
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n') + '\r\n';
}

function codecName(value) {
  return String(value || '').split(',')[0].trim().toLowerCase();
}

function isHevcCodec(name) {
  const v = codecName(name);
  return v === 'hevc' || v === 'h265' || v === 'hev1' || v === 'hvc1';
}

/** True when video cannot be copied into a Chrome-playable fMP4 — re-encode to H.264. */
function videoNeedsEncode(name) {
  const v = codecName(name);
  if (!v) return false;
  return !COPY_VIDEO.test(v);
}

/** Codec string to send to the player for MSE mime selection (after remux/encode). */
function outputVideoCodec(name) {
  if (videoNeedsEncode(name)) return 'h264';
  return codecName(name) || '';
}

function ffmpegArgs({
  url, inputFile, userAgent, headers, start, pipeInput = false, growing = false, videoCodec = '',
}) {
  const input = pipeInput ? 'pipe:0' : (inputFile || url);
  const local = !!inputFile && !pipeInput;
  const encodeVideo = videoNeedsEncode(videoCodec);
  // Growing local MKV needs a larger probe — tiny probesize fails on 4K remuxes.
  const probe = local || pipeInput ? (growing ? '2000000' : '512000') : '65536';
  const analyze = local || pipeInput ? (growing ? '5000000' : '1000000') : '200000';
  const args = [
    '-hide_banner', '-loglevel', 'error',
    // ignidx: incomplete MKV/MP4 often has no usable index yet — don't scan to EOF.
    '-fflags', pipeInput || (local && growing) ? '+genpts+discardcorrupt+ignidx+nobuffer' : '+genpts+discardcorrupt+fastseek',
    '-err_detect', 'ignore_err',
    '-probesize', probe,
    '-analyzeduration', analyze,
  ];
  // Network timeouts only apply when ffmpeg opens the provider URL itself.
  if (!local && !pipeInput) {
    args.push(
      '-rw_timeout', '15000000',
      // Survive brief IPTV drops during HTTP -ss seeks without restarting from 0.
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '2',
    );
  }
  if (!local && !pipeInput && userAgent) args.push('-user_agent', userAgent);
  if (!local && !pipeInput) {
    const hdr = headerBlob(headers);
    if (hdr.trim()) args.push('-headers', hdr);
  }
  // Local incomplete files: never seek to EOF looking for duration/cues.
  if (local && growing) args.push('-seekable', '0');
  // -ss before -i needs a real file offset; pipe input always starts at 0.
  if (!pipeInput && start > 0.4) args.push('-ss', Number(start).toFixed(3), '-noaccurate_seek');
  args.push(
    '-i', input,
    '-map', '0:v:0?',
    '-map', '0:a:0?',
    '-sn', '-dn',
  );
  if (encodeVideo) {
    // Exotic / legacy video (MPEG-2, VC-1, MPEG-4 ASP, …) — H.264 for universal MSE.
    // Hard seeks reopen the remux: ultrafast gets the first fMP4 fragment out sooner.
    const preset = start > 0.4 ? 'ultrafast' : 'veryfast';
    args.push('-c:v', 'libx264', '-preset', preset, '-crf', '22', '-pix_fmt', 'yuv420p', '-tag:v', 'avc1');
  } else {
    args.push('-c:v', 'copy');
    // hev1 is HEVC-only — tagging H.264 as hev1 makes the MP4 muxer refuse the header
    // ("Tag hev1 incompatible with output codec id '27' (avc1)") and write 0 bytes.
    if (isHevcCodec(videoCodec)) args.push('-tag:v', 'hev1');
  }
  args.push(
    '-c:a', 'aac',
    '-ac', '2',
    '-ar', '48000',
    '-b:a', '128k',
    '-max_muxing_queue_size', '1024',
    '-muxdelay', '0',
    '-muxpreload', '0',
    '-flush_packets', '1',
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  );
  return args;
}

/**
 * Feed a still-growing disk cache into ffmpeg stdin so remux starts after ~30s
 * of download instead of blocking on an incomplete file until EOF.
 */
function feedGrowingFile(stdin, file, { signal, isDone } = {}) {
  let pos = 0;
  let timer = null;
  let stopped = false;
  let idleTicks = 0;
  const stop = (endStdin = true) => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (endStdin) {
      try { stdin.end(); } catch { /* ignore */ }
    }
  };
  if (signal) {
    if (signal.aborted) {
      stop(false);
      return stop;
    }
    signal.addEventListener('abort', () => stop(false), { once: true });
  }
  const tick = () => {
    if (stopped || stdin.destroyed || stdin.writableEnded) return;
    try {
      const size = fs.statSync(file).size;
      if (size > pos) {
        idleTicks = 0;
        const fd = fs.openSync(file, 'r');
        const len = Math.min(size - pos, 2 * 1024 * 1024);
        const buf = Buffer.alloc(len);
        const n = fs.readSync(fd, buf, 0, len, pos);
        try { fs.closeSync(fd); } catch { /* ignore */ }
        if (n > 0) {
          pos += n;
          const chunk = n === len ? buf : buf.subarray(0, n);
          if (!stdin.write(chunk)) {
            stdin.once('drain', () => { if (!stopped) timer = setTimeout(tick, 20); });
            return;
          }
        }
      } else if (typeof isDone === 'function' && isDone()) {
        idleTicks += 1;
        // Download finished and size stable — EOF so ffmpeg can finalize.
        if (idleTicks >= 3) {
          stop(true);
          return;
        }
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') log.warn('grow-feed read failed', err);
    }
    timer = setTimeout(tick, 80);
  };
  tick();
  return stop;
}

function findProbe() {
  const ff = findBinary();
  if (!ff) return '';
  const file = path.join(path.dirname(ff), binName('ffprobe'));
  try {
    return fs.existsSync(file) ? file : '';
  } catch {
    return '';
  }
}

function probeWith(args, cacheKey) {
  if (cacheKey && probeCache.has(cacheKey)) return probeCache.get(cacheKey);
  const bin = findProbe() || findBinary();
  if (!bin) return null;
  const isProbe = /ffprobe/i.test(path.basename(bin));
  const full = isProbe
    ? ['-hide_banner', '-loglevel', 'error', ...args, '-show_entries', 'stream=codec_type,codec_name:format=format_name,duration', '-of', 'json']
    : ['-hide_banner', '-loglevel', 'error', ...args];
  try {
    const out = execFileSync(bin, full, {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    const parsed = parseProbe(out, '');
    if (cacheKey) probeCache.set(cacheKey, parsed);
    return parsed;
  } catch (err) {
    const parsed = parseProbe(err && err.stdout, err && err.stderr);
    if (parsed && (parsed.video || parsed.audio || parsed.duration)) {
      if (cacheKey) probeCache.set(cacheKey, parsed);
      return parsed;
    }
    if (cacheKey) probeCache.set(cacheKey, null);
    return null;
  }
}

function probeCodecs(url, { userAgent, headers } = {}) {
  const key = String(url || '');
  if (!key) return null;
  if (probeCache.size > 80) probeCache.delete(probeCache.keys().next().value);
  const args = ['-probesize', '65536', '-analyzeduration', '400000', '-rw_timeout', '8000000'];
  if (userAgent) args.push('-user_agent', userAgent);
  const hdr = headerBlob(headers);
  if (hdr.trim()) args.push('-headers', hdr);
  args.push('-i', url);
  return probeWith(args, key);
}

function probeFile(file) {
  if (!file || !fs.existsSync(file)) return null;
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return null; }
  if (size < 2048) return null;
  return probeWith(['-probesize', String(Math.min(size, 2 * 1024 * 1024)), '-analyzeduration', '2000000', '-i', file], `file:${file}:${size}`);
}

function parseClock(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 1) return n;
  const m = String(value || '').match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function parseProbe(stdout, stderr) {
  const text = `${stdout || ''}`;
  if (text.trim().startsWith('{')) {
    try {
      const json = JSON.parse(text);
      const streams = json.streams || [];
      const video = (streams.find((s) => s.codec_type === 'video') || {}).codec_name || '';
      const audio = (streams.find((s) => s.codec_type === 'audio') || {}).codec_name || '';
      const duration = parseClock(json.format && json.format.duration);
      const format = String((json.format && json.format.format_name) || '');
      return { video, audio, duration, format };
    } catch { /* fall through */ }
  }
  const blob = `${stdout || ''}\n${stderr || ''}`;
  const video = (blob.match(/Video:\s*([a-z0-9_]+)/i) || [])[1] || '';
  const audio = (blob.match(/Audio:\s*([a-z0-9_]+)/i) || [])[1] || '';
  const duration = parseClock((blob.match(/Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/i) || [])[1]);
  if (!video && !audio && !duration) return null;
  return { video, audio, duration, format: '' };
}

function containerHint(url) {
  const value = String(url || '');
  if (/\.(mp4|m4v|mov|webm|ogv)(\?|$|&)/i.test(value)) return 'mp4';
  if (/\.avi(\?|$|&)/i.test(value)) return 'avi';
  if (/\.(mkv|ts|m2ts)(\?|$|&)/i.test(value)) return 'mkv';
  try {
    const stream = new URL(value).searchParams.get('stream') || '';
    if (/\.(mp4|m4v|mov|webm|ogv)(?:\?|$)/i.test(stream)) return 'mp4';
    if (/\.avi(?:\?|$)/i.test(stream)) return 'avi';
    if (/\.(mkv|ts|m2ts)(?:\?|$)/i.test(stream)) return 'mkv';
  } catch { /* ignore */ }
  return '';
}

function codecsNeedRemux(probed) {
  if (!probed) return false;
  const video = codecName(probed.video);
  const audio = codecName(probed.audio);
  // Unknown codec names → remux (safer than hoping native <video> works).
  if (video && !SAFE_VIDEO.test(video)) return true;
  if (audio && !SAFE_AUDIO.test(audio)) return true;
  return false;
}

/**
 * True when the browser cannot play the file as-is.
 * Policy: only progressive MP4/WebM with safe codecs stay native; everything else
 * (MKV/AVI/TS, bad audio/video, extensionless unknowns) is remuxed via ffmpeg.
 */
function needsRemux(url, probed) {
  if (!findBinary()) return false;
  if (/\.m3u8?/i.test(String(url || ''))) return false;
  const hint = containerHint(url);
  const fmt = String((probed && probed.format) || '').toLowerCase();

  // Non-progressive containers always need remux (even H.264+AAC inside MKV).
  if (hint === 'avi' || hint === 'mkv') {
    log.info(`Player cannot play ${hint} container; remux`);
    return true;
  }
  if (/matroska|avi|mpegts/.test(fmt) && !/mp4|isom|iso5|dash/.test(fmt)) {
    log.info(`Player cannot play ${fmt}; remux`);
    return true;
  }

  if (codecsNeedRemux(probed)) {
    log.info(`Player cannot play ${probed.video || '-'} / ${probed.audio || '-'}; remux`);
    return true;
  }

  // WebM with safe codecs can play natively.
  if (/webm/.test(fmt) && probed && !codecsNeedRemux(probed)) return false;

  // Progressive MP4/MOV/M4V hint: native when codecs are safe or still unknown (common case).
  if (hint === 'mp4') {
    if (!probed) return false;
    if (codecsNeedRemux(probed)) return true;
    return false;
  }

  // Extensionless / unknown URL with no usable probe → remux so movie.php MKVs never hit native.
  if (!hint && !probed) {
    log.info('Player cannot trust unknown VOD URL; remux');
    return true;
  }
  if (!hint && probed) {
    const nativeFmt = /mp4|isom|iso5|dash|webm/.test(fmt);
    if (!nativeFmt || codecsNeedRemux(probed)) {
      log.info(`Player cannot play probed ${fmt || 'unknown'}; remux`);
      return true;
    }
  }
  return false;
}

function needsPlayerRemux(url, opts = {}) {
  return needsRemux(url, probeCodecs(url, opts));
}

function wantsTranscode(url, contentType) {
  const value = String(url || '');
  const ct = String(contentType || '');
  if (/\.(mkv|avi|ts|m2ts)(\?|$|&)/i.test(value)) return true;
  if (/(?:\?|&)stream=[^&]*\.(mkv|avi|ts|m2ts)(?:&|$)/i.test(value)) return true;
  if (/matroska|x-msvideo|mp2t/i.test(ct)) return true;
  return false;
}

/**
 * Remux to fragmented MP4 (copy video, AAC audio) for MSE/<video>.
 * Prefer a growing disk cache (`inputFile`) so we do not open a second provider
 * connection and so `-ss` seeks hit local bytes. Falls back to the URL.
 *
 * MKV/AVI cannot be remuxed from stdin (matroska needs random access). Read the
 * growing file with `-seekable 0` instead — pipe-to-stdin never produces playable MSE.
 */
function transcodeFromUrl(res, {
  url, inputFile, userAgent, headers, start = 0, signal, growing = false, isCacheDone,
} = {}) {
  const bin = findBinary();
  if (!bin) throw new Error('ffmpeg is not installed');
  const ss = Math.max(0, Number(start) || 0);
  const local = !!(inputFile && fs.existsSync(inputFile));
  const fmt = guessInputFormat(url) || (local ? 'file' : 'auto');
  // Only pure MPEG-TS is safe on stdin; MKV/MP4/AVI need the file path.
  const pipeOk = fmt === 'mpegts';
  const pipeInput = !!(local && growing && ss <= 0.4 && pipeOk);
  // Prefer a local probe (cheap); fall back to any URL probe cached from /play/vod.
  const probed = (local && probeFile(inputFile)) || (url ? probeCodecs(url, { userAgent, headers }) : null);
  const videoCodec = (probed && probed.video) || '';
  const encodeVideo = videoNeedsEncode(videoCodec);
  const args = ffmpegArgs({
    url,
    inputFile: local ? inputFile : '',
    userAgent,
    headers,
    start: ss,
    pipeInput,
    growing: !!(local && growing),
    videoCodec,
  });
  const mode = pipeInput ? 'grow-pipe' : local ? (growing ? 'grow-file' : 'disk') : 'url';
  const vOut = encodeVideo ? 'libx264' : (isHevcCodec(videoCodec) ? 'copy+hev1' : 'copy');
  log.info(`Remux ${fmt}/${videoCodec || '?'} @${ss.toFixed(0)}s → fmp4 ${vOut}+aac (${mode})`);
  try {
    require('./player-debug').record('vod.remux.ffmpeg', mode, {
      fmt,
      start: ss,
      growing: !!growing,
      videoCodec: videoCodec || '',
      encodeVideo,
      hevcTag: !encodeVideo && isHevcCodec(videoCodec),
    });
  } catch { /* ignore */ }
  const ff = spawn(bin, args, {
    windowsHide: true,
    stdio: [pipeInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  let errTxt = '';
  let stopFeed = null;
  ff.stderr.on('data', (chunk) => {
    errTxt += chunk.toString();
    if (errTxt.length > 6000) errTxt = errTxt.slice(-3000);
  });
  ff.on('error', (err) => {
    log.warn('ffmpeg spawn failed', err);
    try { require('./player-debug').record('vod.remux.ffmpeg', 'spawn-error', { error: err.message }); } catch { /* ignore */ }
    if (!res.headersSent) res.status(502).json({ error: `Could not start transcode: ${err.message}` });
    else res.destroy();
  });
  ff.on('close', (code) => {
    if (stopFeed) stopFeed(false);
    if (errTxt.trim()) {
      log.warn(`ffmpeg exited ${code}: ${errTxt.trim().slice(-800)}`);
      try {
        require('./player-debug').record('vod.remux.ffmpeg', `exit ${code}`, {
          stderr: errTxt.trim().slice(-500),
        });
      } catch { /* ignore */ }
    }
  });
  const stop = () => {
    if (stopFeed) stopFeed(false);
    try { ff.kill('SIGKILL'); } catch { /* ignore */ }
  };
  if (signal) {
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  }
  res.on('close', stop);
  if (pipeInput) {
    stopFeed = feedGrowingFile(ff.stdin, inputFile, { signal, isDone: isCacheDone });
    ff.stdin.on('error', () => { /* EPIPE when ffmpeg exits */ });
  }
  if (!res.headersSent) {
    res.status(200);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-cache');
  }
  ff.stdout.pipe(res);
  return ff;
}

/**
 * Live / catch-up MPEG-TS: copy video (H.264 or HEVC), re-encode audio to AAC-LC.
 * Prefers a local cache file when provided so catch-up does not open a second
 * provider connection. Falls back to the provider URL (live).
 */
function liveSyncTs(res, {
  url, inputFile, userAgent, headers, signal, growing = false, isCacheDone,
} = {}) {
  const bin = findBinary();
  if (!bin) throw new Error('ffmpeg is not installed');
  const local = !!(inputFile && fs.existsSync(inputFile));
  if (!local && !url) throw new Error('missing live url');
  const input = local ? inputFile : url;
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-fflags', local && growing ? '+genpts+discardcorrupt+ignidx+nobuffer' : '+genpts+discardcorrupt+nobuffer',
    '-err_detect', 'ignore_err',
    '-flags', 'low_delay',
    '-probesize', local ? (growing ? '2000000' : '512000') : '65536',
    '-analyzeduration', local ? (growing ? '2000000' : '1000000') : '500000',
  ];
  if (!local) args.push('-rw_timeout', '15000000');
  if (!local && userAgent) args.push('-user_agent', userAgent);
  if (!local) {
    const hdr = headerBlob(headers);
    if (hdr.trim()) args.push('-headers', hdr);
  }
  if (local && growing) args.push('-seekable', '0');
  // Probe so exotic live video (MPEG-2) gets encoded; H.264/HEVC stay copy.
  const probed = local ? probeFile(inputFile) : (url ? probeCodecs(url, { userAgent, headers }) : null);
  const videoCodec = (probed && probed.video) || '';
  const encodeVideo = videoNeedsEncode(videoCodec);
  args.push('-i', input, '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn');
  if (encodeVideo) {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '23', '-pix_fmt', 'yuv420p');
  } else {
    args.push('-c:v', 'copy');
  }
  args.push(
    // Force LC + stretch/squeeze audio to the video clock (fixes progressive lip-sync drift).
    '-af', 'aresample=async=1:min_hard_comp=0.1:first_pts=0',
    '-c:a', 'aac',
    '-profile:a', 'aac_low',
    '-b:a', '192k',
    '-ac', '2',
    '-ar', '48000',
    '-muxdelay', '0',
    '-muxpreload', '0',
    '-f', 'mpegts',
    'pipe:1',
  );
  const mode = local ? (growing ? 'file-grow' : 'file') : 'url';
  log.info(`TS sync remux → mpegts ${encodeVideo ? 'libx264' : 'copy'}+aac_lc (${mode})`);
  try {
    require('./player-debug').record('ts.sync.ffmpeg', mode, {
      videoCodec: videoCodec || '',
      encodeVideo,
      growing: !!growing,
    });
  } catch { /* ignore */ }
  const ff = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let errTxt = '';
  ff.stderr.on('data', (chunk) => {
    errTxt += chunk.toString();
    if (errTxt.length > 6000) errTxt = errTxt.slice(-3000);
  });
  ff.on('error', (err) => {
    log.warn('live sync ffmpeg spawn failed', err);
    if (!res.headersSent) res.status(502).json({ error: `Could not start live sync: ${err.message}` });
    else res.destroy();
  });
  ff.on('close', (code) => {
    if (code && errTxt.trim()) log.warn(`live sync ffmpeg exited ${code}: ${errTxt.trim().slice(-800)}`);
    if (!res.writableEnded && !res.destroyed) {
      try { res.end(); } catch { /* ignore */ }
    }
  });
  const stop = () => {
    try { ff.kill('SIGKILL'); } catch { /* ignore */ }
  };
  if (signal) {
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  }
  res.on('close', stop);
  if (!res.headersSent) {
    res.status(200);
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'no-cache');
  }
  ff.stdout.pipe(res);
  ff.stdout.on('error', () => res.destroy());
  return ff;
}

module.exports = {
  findBinary,
  wantsTranscode,
  needsPlayerRemux,
  probeCodecs,
  probeFile,
  needsRemux,
  videoNeedsEncode,
  outputVideoCodec,
  isHevcCodec,
  transcodeFromUrl,
  liveSyncTs,
};
