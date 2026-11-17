'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { Readable } = require('stream');

const DEFAULT_UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Cipher/1.0';

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 32 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 32 }),
};

/** Separate sockets for media so gzip portal API keep-alives never share a connection with /play/. */
const streamAgents = {
  'http:': new http.Agent({ keepAlive: false, maxSockets: 8 }),
  'https:': new https.Agent({ keepAlive: false, maxSockets: 8 }),
};

/**
 * GET a URL, following redirects. Resolves with the raw response (body unread)
 * and the final URL after redirects.
 * `agent: 'stream'` uses a dedicated non-keep-alive pool (MAG/CDN play links).
 */
function request(url, { headers = {}, userAgent, timeoutMs = 30000, maxRedirects = 6, signal, agent, family } = {}) {
  return new Promise((resolve, reject) => {
    let redirects = 0;

    const go = (target) => {
      let parsed;
      try {
        parsed = new URL(target);
      } catch {
        reject(new Error(`Invalid URL: ${target}`));
        return;
      }
      const lib = parsed.protocol === 'https:' ? https : http;
      const pool = agent === 'stream' ? streamAgents[parsed.protocol]
        : agent === false ? false
          : (agent || agents[parsed.protocol]);
      const req = lib.get(parsed, {
        agent: pool,
        family: family !== undefined ? family : (agent === 'stream' ? 4 : undefined),
        headers: { 'User-Agent': userAgent || DEFAULT_UA, Accept: '*/*', ...headers },
        timeout: timeoutMs,
        rejectUnauthorized: false,
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (++redirects > maxRedirects) {
            reject(new Error('Too many redirects'));
            return;
          }
          go(new URL(res.headers.location, target).toString());
          return;
        }
        resolve({ res, finalUrl: target });
      });
      req.on('timeout', () => req.destroy(new Error(`Request timed out: ${parsed.host}`)));
      req.on('error', reject);
      if (signal) {
        if (signal.aborted) req.destroy(new Error('Aborted'));
        else signal.addEventListener('abort', () => req.destroy(new Error('Aborted')), { once: true });
      }
    };

    go(url);
  });
}

/** Wraps a response body so gzip content is transparently decompressed (by header or magic bytes). */
async function decodedBody(res) {
  const iterator = res[Symbol.asyncIterator]();
  const first = await iterator.next();
  const head = first.done ? null : first.value;
  const isGzip = head && head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
  const source = Readable.from((async function* replay() {
    if (head) yield head;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  })());
  return isGzip ? source.pipe(zlib.createGunzip()) : source;
}

async function getOk(url, opts) {
  const result = await request(url, { ...opts, headers: { 'Accept-Encoding': 'gzip', ...(opts && opts.headers) } });
  if (result.res.statusCode >= 400) {
    result.res.resume();
    throw new Error(`HTTP ${result.res.statusCode} from ${new URL(url).host}`);
  }
  return result;
}

async function getText(url, opts = {}) {
  const { res } = await getOk(url, opts);
  const body = await decodedBody(res);
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function getJson(url, opts = {}) {
  const text = await getText(url, opts);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${new URL(url).host}`);
  }
}

/** Async iterable of decoded text chunks, for streaming large files (XMLTV). */
async function getTextStream(url, opts = {}) {
  const { res } = await getOk(url, opts);
  const total = Number(res.headers['content-length']) || 0;
  const body = await decodedBody(res);
  return { body, total, raw: res };
}

module.exports = { DEFAULT_UA, request, getText, getJson, getTextStream };
