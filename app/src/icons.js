'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { httpError } = require('./auth');
const { request, DEFAULT_UA } = require('./http');

const MAX_BYTES = 512 * 1024;
const LOGO_TIMEOUT_MS = 2000;
const LOGO_MAX_BYTES = 400 * 1024;
const LOGO_CACHE_MAX_FILES = 4000;

/** In-flight remote fetches so parallel <img> requests share one download. */
const inflight = new Map();

function iconsDir(playlistId) {
  return path.join(config.dataDir, 'channel-icons', playlistId.replace(/[^\w-]/g, ''));
}

function logoCacheDir() {
  const dir = path.join(config.dataDir, 'logo-cache');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function hashKey(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex');
}

function defaultLogoSvg(name = '') {
  const letter = String(name || '').trim().replace(/[^a-zA-Z0-9]/g, '').charAt(0).toUpperCase() || '?';
  let hue = 210;
  for (let i = 0; i < letter.length; i++) hue = (hue + letter.charCodeAt(i) * 37) % 360;
  const bg = `hsl(${hue} 18% 22%)`;
  const fg = `hsl(${hue} 12% 72%)`;
  const safe = letter.replace(/[|&<>'"]/g, '') || '?';
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">`
    + `<rect width="128" height="128" rx="28" fill="${bg}"/>`
    + `<text x="64" y="84" text-anchor="middle" font-family="Segoe UI,system-ui,sans-serif" `
    + `font-size="64" font-weight="700" fill="${fg}">${safe}</text></svg>`,
  );
}

/** Saves a data-URL or remote http(s) logo; returns a URL path served by the app. */
async function storeChannelIcon(playlistId, channelId, { url, dataUrl }) {
  const dir = iconsDir(playlistId);
  fs.mkdirSync(dir, { recursive: true });
  const safe = channelId.replace(/[^\w-]/g, '').slice(0, 40) || 'ch';
  if (dataUrl) {
    const m = /^data:image\/(\w+);base64,(.+)$/i.exec(String(dataUrl));
    if (!m) throw httpError(400, 'Image must be a PNG or JPEG data URL');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_BYTES) throw httpError(400, 'Image is too large (max 512 KB)');
    const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    const file = path.join(dir, `${safe}.${ext}`);
    fs.writeFileSync(file, buf);
    return `/api/channel-icons/${encodeURIComponent(playlistId)}/${encodeURIComponent(safe)}.${ext}`;
  }
  const link = String(url || '').trim();
  if (!link) throw httpError(400, 'Enter an image URL or upload a file');
  if (!/^https?:\/\//i.test(link)) throw httpError(400, 'Logo URL must start with http:// or https://');
  return link.slice(0, 2000);
}

function readIcon(playlistId, file) {
  const dir = iconsDir(playlistId);
  const base = path.basename(String(file || ''));
  const full = path.join(dir, base);
  if (!full.startsWith(dir + path.sep) || !fs.existsSync(full)) throw httpError(404, 'Not found');
  return full;
}

function exportIcons(userId, playlistId, prefs) {
  const out = {};
  for (const [id, url] of Object.entries(prefs.chLogos || {})) {
    if (String(url).startsWith('/api/channel-icons/')) {
      try {
        const parts = url.split('/');
        const file = parts[parts.length - 1];
        const full = readIcon(playlistId, file);
        out[id] = `data:image/${file.endsWith('.png') ? 'png' : 'jpeg'};base64,${fs.readFileSync(full).toString('base64')}`;
      } catch {
        out[id] = url;
      }
    } else {
      out[id] = url;
    }
  }
  return out;
}

/** Turns data-URL logos in an import into stored files; http(s) URLs are kept as-is. */
function importEmbeddedLogos(playlistId, chLogos) {
  const out = {};
  for (const [id, url] of Object.entries(chLogos || {})) {
    const s = String(url || '');
    if (/^data:image\//i.test(s)) {
      try {
        out[id] = storeChannelIcon(playlistId, id, { dataUrl: s });
      } catch {
        out[id] = s.slice(0, 2000);
      }
    } else if (s) out[id] = s.slice(0, 2000);
  }
  return out;
}

function sniffType(buf, contentType) {
  if (buf && buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf && buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf && buf.length >= 6 && buf.slice(0, 3).toString() === 'GIF') return 'image/gif';
  if (buf && buf.length >= 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') {
    return 'image/webp';
  }
  if (buf && buf.length >= 4 && buf.slice(0, 4).toString() === '<svg') return 'image/svg+xml';
  if (buf && buf.length >= 5 && buf.slice(0, 5).toString() === '<?xml') return 'image/svg+xml';
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (ct.startsWith('image/')) return ct;
  return 'image/jpeg';
}

async function readLimited(res, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res) {
    size += chunk.length;
    if (size > maxBytes) {
      res.destroy();
      throw new Error('Logo too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function pruneLogoCache(dir) {
  let entries;
  try { entries = fs.readdirSync(dir).filter((f) => f.endsWith('.bin')); } catch { return; }
  if (entries.length <= LOGO_CACHE_MAX_FILES) return;
  const ranked = entries.map((name) => {
    try {
      const st = fs.statSync(path.join(dir, name));
      return { name, atime: st.atimeMs || st.mtimeMs };
    } catch {
      return { name, atime: 0 };
    }
  }).sort((a, b) => a.atime - b.atime);
  for (const row of ranked.slice(0, ranked.length - LOGO_CACHE_MAX_FILES)) {
    try { fs.unlinkSync(path.join(dir, row.name)); } catch { /* ignore */ }
    try { fs.unlinkSync(path.join(dir, `${row.name}.type`)); } catch { /* ignore */ }
  }
}

/**
 * Fetch a remote logo with a short timeout, cache on disk, share in-flight downloads.
 * Returns { buf, type, cached } or null on failure.
 */
async function loadRemoteLogo(url) {
  const link = String(url || '').trim();
  if (!/^https?:\/\//i.test(link)) return null;
  const dir = logoCacheDir();
  const key = hashKey(link);
  const bin = path.join(dir, `${key}.bin`);
  const typeFile = path.join(dir, `${key}.bin.type`);
  if (fs.existsSync(bin)) {
    try {
      const buf = fs.readFileSync(bin);
      if (buf.length > 32) {
        const type = fs.existsSync(typeFile)
          ? fs.readFileSync(typeFile, 'utf8').trim()
          : sniffType(buf, '');
        return { buf, type: type || 'image/jpeg', cached: true };
      }
    } catch { /* refetch */ }
  }
  if (inflight.has(link)) return inflight.get(link);

  const job = (async () => {
    try {
      const { res } = await request(link, {
        timeoutMs: LOGO_TIMEOUT_MS,
        maxRedirects: 4,
        userAgent: DEFAULT_UA,
        headers: { Accept: 'image/*,*/*;q=0.8' },
      });
      if (res.statusCode >= 400) {
        res.resume();
        return null;
      }
      const buf = await readLimited(res, LOGO_MAX_BYTES);
      if (!buf || buf.length < 32) return null;
      const type = sniffType(buf, res.headers['content-type']);
      if (!type.startsWith('image/')) return null;
      try {
        fs.writeFileSync(bin, buf);
        fs.writeFileSync(typeFile, type);
        pruneLogoCache(dir);
      } catch { /* disk full — still serve this response */ }
      return { buf, type, cached: false };
    } catch {
      return null;
    } finally {
      inflight.delete(link);
    }
  })();
  inflight.set(link, job);
  return job;
}

/**
 * Express handler: /api/logo?u=&n=
 * Always returns an image (remote/cached or generated default) so the UI never
 * flickers through a broken <img>.
 */
async function serveLogo(req, res) {
  const name = String(req.query.n || '').slice(0, 80);
  const raw = String(req.query.u || '').trim();
  // Already-local app icons — stream directly when present.
  if (raw.startsWith('/api/channel-icons/')) {
    try {
      const parts = raw.split('/').filter(Boolean);
      const playlistId = decodeURIComponent(parts[2] || '');
      const file = decodeURIComponent(parts[3] || '');
      const full = readIcon(playlistId, file);
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      return res.sendFile(full);
    } catch {
      /* fall through to default */
    }
  }
  if (/^https?:\/\//i.test(raw)) {
    const hit = await loadRemoteLogo(raw);
    if (hit && hit.buf) {
      res.setHeader('Content-Type', hit.type);
      res.setHeader('Cache-Control', hit.cached
        ? 'public, max-age=604800, immutable'
        : 'public, max-age=86400');
      return res.end(hit.buf);
    }
  }
  const svg = defaultLogoSvg(name);
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.end(svg);
}

function serveDefaultLogo(req, res) {
  const svg = defaultLogoSvg(String(req.query.n || '').slice(0, 80));
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  res.end(svg);
}

module.exports = {
  storeChannelIcon,
  readIcon,
  exportIcons,
  importEmbeddedLogos,
  iconsDir,
  serveLogo,
  serveDefaultLogo,
  LOGO_TIMEOUT_MS,
};
