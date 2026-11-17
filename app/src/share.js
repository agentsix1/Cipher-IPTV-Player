'use strict';

const crypto = require('crypto');
const os = require('os');
const dgram = require('dgram');
const express = require('express');
const config = require('./config');
const log = require('./log');
const backup = require('./backup');
const { request } = require('./http');
const { httpError } = require('./auth');

/**
 * Device-to-device config sharing. A device creates a short-lived numeric code; another device on the
 * same network enters this device's address plus the code and pulls the config (GET /api/share/:code).
 *
 * The Android app's main server only listens on 127.0.0.1, so there a separate listener on
 * SHARE_PORT is opened on all interfaces while a code is active, serving only the share endpoint.
 */
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_USES = 5;
const SHARE_PORT = 8788;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS = 20;

const codes = new Map(); // code -> { userId, expiresAt, uses }
const fails = new Map(); // ip -> { count, since }
let shareServer = null;
let closeTimer = null;

function prune() {
  const now = Date.now();
  for (const [code, entry] of codes) if (entry.expiresAt <= now || entry.uses >= MAX_USES) codes.delete(code);
  for (const [ip, entry] of fails) if (now - entry.since > FAIL_WINDOW_MS) fails.delete(ip);
}

function newCode() {
  for (;;) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    if (!codes.has(code)) return code;
  }
}

/** IPv4 LAN addresses of this device. os.networkInterfaces() is blocked on newer Android, so fall back to a UDP probe. */
async function lanAddresses() {
  const found = new Set();
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal) found.add(a.address);
    }
  } catch {
    // not permitted on this platform
  }
  if (!found.size) {
    await new Promise((resolve) => {
      const socket = dgram.createSocket('udp4');
      const done = () => {
        try {
          socket.close();
        } catch {
          // already closed
        }
        resolve();
      };
      socket.on('error', done);
      try {
        socket.connect(53, '8.8.8.8', () => {
          try {
            const { address } = socket.address();
            if (address && address !== '0.0.0.0') found.add(address);
          } catch {
            // no route
          }
          done();
        });
      } catch {
        done();
      }
    });
  }
  return [...found].filter((ip) => !ip.startsWith('169.254.'));
}

function sharePort() {
  return config.isApk ? SHARE_PORT : config.port;
}

function ensureShareServer() {
  if (!config.isApk) return;
  clearTimeout(closeTimer);
  closeTimer = setTimeout(stopShareServerIfIdle, CODE_TTL_MS + 5000);
  closeTimer.unref();
  if (shareServer) return;
  const app = express();
  app.disable('x-powered-by');
  app.get('/api/share/:code', handleShareRequest);
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  shareServer = app.listen(SHARE_PORT, '0.0.0.0', () => log.info(`Share listener open on port ${SHARE_PORT}`));
  shareServer.on('error', (err) => {
    log.error('Share listener failed', err);
    shareServer = null;
  });
}

function stopShareServerIfIdle() {
  prune();
  if (codes.size || !shareServer) return;
  shareServer.close();
  shareServer = null;
  log.info('Share listener closed');
}

/** Creates (or replaces) the user's share code. */
async function createCode(userId, { includeImages = false } = {}) {
  prune();
  for (const [code, entry] of codes) if (entry.userId === userId) codes.delete(code);
  const code = newCode();
  const expiresAt = Date.now() + CODE_TTL_MS;
  codes.set(code, { userId, expiresAt, uses: 0, includeImages: !!includeImages });
  ensureShareServer();
  const port = sharePort();
  const addresses = (await lanAddresses()).map((ip) => `${ip}:${port}`);
  return { code, expiresAt, addresses, port };
}

function cancelCode(userId) {
  for (const [code, entry] of codes) if (entry.userId === userId) codes.delete(code);
  stopShareServerIfIdle();
}

function handleShareRequest(req, res) {
  prune();
  const ip = req.socket.remoteAddress || '?';
  const failed = fails.get(ip);
  if (failed && failed.count >= MAX_FAILS) {
    res.status(429).json({ error: 'Too many wrong codes. Wait a few minutes and try again.' });
    return;
  }
  const entry = codes.get(String(req.params.code || ''));
  if (!entry) {
    fails.set(ip, { count: (failed ? failed.count : 0) + 1, since: failed ? failed.since : Date.now() });
    res.status(404).json({ error: 'That code is wrong or has expired. Create a new code on the other device.' });
    return;
  }
  entry.uses += 1;
  log.info(`Config shared with ${ip}`);
  res.json({ ok: true, config: backup.exportConfig(entry.userId, { includeImages: !!entry.includeImages }) });
}

/** "192.168.1.5:8080", "http://host", "host" → candidate base URLs to try in order. */
function candidateUrls(address) {
  const raw = String(address || '').trim().replace(/\/+$/, '');
  if (!raw) throw httpError(400, 'Enter the other device\'s address');
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw httpError(400, 'That address is not valid');
  }
  const ports = url.port
    ? [Number(url.port), SHARE_PORT, 8093, 8080, 80]
    : [SHARE_PORT, 8093, 8080, 80];
  const seen = new Set();
  const out = [];
  for (const port of ports) {
    if (!port || seen.has(port)) continue;
    seen.add(port);
    out.push(`${url.protocol}//${url.hostname}:${port}`);
  }
  return out;
}

async function fetchRemote(address, code) {
  const clean = String(code || '').replace(/\D/g, '');
  if (clean.length !== 6) throw httpError(400, 'The share code has 6 digits');
  let lastError = null;
  for (const base of candidateUrls(address)) {
    try {
      const { res } = await request(`${base}/api/share/${clean}`, { timeoutMs: 6000, maxRedirects: 0 });
      const chunks = [];
      for await (const chunk of res) chunks.push(chunk);
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        body = null;
      }
      if (res.statusCode === 200 && body && body.config) return body.config;
      if (body && body.error) throw httpError(400, body.error);
      lastError = new Error(`Unexpected reply from ${base}`);
    } catch (err) {
      if (err.status) throw err;
      lastError = err;
    }
  }
  throw httpError(502, `Could not reach the other device (${lastError ? lastError.message : 'no answer'}). `
    + 'On the other device, tap Create share code first and keep that screen open. '
    + 'Android app: use the address shown with port 8788. Web server (PC login): use the same IP with port 8093 (or your server port). '
    + 'Both devices must be on the same Wi‑Fi (guest networks often block this).');
}

module.exports = { createCode, cancelCode, handleShareRequest, fetchRemote, CODE_TTL_MS };
