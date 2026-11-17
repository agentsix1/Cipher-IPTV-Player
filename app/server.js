'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('./src/config');
const log = require('./src/log');
const db = require('./src/db');
const auth = require('./src/auth');
const settings = require('./src/settings');
const playlists = require('./src/playlists');
const catalog = require('./src/catalog');
const vod = require('./src/vod');
const { createRouter } = require('./src/routes');

const REFRESH_CHECK_MS = 30 * 60 * 1000;

function playlistRefreshIntervalHours(row, prefs) {
  const h = Number(row.refresh_hours);
  if (h === 0) return 0;
  if (h > 0) return h;
  return prefs.playlistRefreshHours || 0;
}

/** Channels + guide + Movies/TV Shows so MAG cmds/ids stay current. */
async function refreshPlaylistBundle(row) {
  await catalog.ensureLoaded(row, { force: true });
  if (!vod.supportsVod(row)) return;
  const state = catalog.getState(row.id);
  await vod.refreshCatalog(row, state);
}

function refreshActivePlaylists() {
  for (const user of db.all('SELECT id FROM users')) {
    const prefs = settings.get(user.id);
    const rows = playlists.listRows(user.id);
    let active = null;
    for (const row of rows) {
      const hours = playlistRefreshIntervalHours(row, prefs);
      if (hours > 0) {
        const state = catalog.getState(row.id);
        if (Date.now() - state.channelsFetchedAt > hours * 3600 * 1000) {
          refreshPlaylistBundle(row).catch((err) => {
            log.warn(`Scheduled refresh for '${row.name}' failed: ${err.message}`);
          });
        }
      }
      if (row.is_active) active = row;
    }
    if (!active) continue;
    catalog.ensureLoaded(active, { maxAgeHours: prefs.epgUpdateHours });
    catalog.refreshDueEpgSources(active, prefs.epgUpdateHours);
  }
}

async function main() {
  await db.open(config.dataDir);
  if (config.isApk) auth.ensureLocalUser();

  // Portable desktop: sync editable config/playlists.json + config/layout.ini ↔ SQLite.
  const userfiles = require('./src/userfiles');
  userfiles.attachHooks();
  if (config.isApk || config.desktop) {
    try {
      const boot = userfiles.bootstrap('local');
      log.info(`Config directory: ${boot.dir}`);
    } catch (err) {
      log.warn(`User config bootstrap failed: ${err.message}`);
    }
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10mb' }));
  app.use(auth.middleware);

  app.use('/api', createRouter());

  const vendor = (file) => (_req, res) => res.sendFile(require.resolve(file));
  app.get('/vendor/hls.min.js', vendor('hls.js/dist/hls.min.js'));
  // Prefer our AAC-LC patched build (Chrome HE-AAC ASC makes IPTV audio late).
  const mpegtsPatched = require('path').join(__dirname, 'vendor', 'mpegts.js');
  app.get('/vendor/mpegts.js', (_req, res) => {
    res.sendFile(require('fs').existsSync(mpegtsPatched) ? mpegtsPatched : require.resolve('mpegts.js/dist/mpegts.js'));
  });

  const indexFile = path.join(__dirname, 'public', 'index.html');
  const sendIndex = (_req, res) => {
    if (!config.ui) return res.sendFile(indexFile);
    const html = fs.readFileSync(indexFile, 'utf8').replace('<html lang="en">', `<html lang="en" data-ui="${config.ui}">`);
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html);
  };
  app.get(['/', '/index.html'], sendIndex);
  app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: 0 }));
  app.get('*', sendIndex);

  const server = app.listen(config.port, config.host, () => {
    log.info(`Cipher ${config.version} (${config.mode} mode${config.ui ? `, ${config.ui} UI` : ''}) listening on http://${config.host}:${config.port}`);
    log.info(`Data directory: ${config.dataDir}`);
    log.info(`Config directory: ${config.configDir}`);
    const ffmpeg = require('./src/ffmpeg');
    const ff = ffmpeg.findBinary();
    log.info(ff ? `ffmpeg: ${ff} (unused for remux; libVLC decodes)` : 'ffmpeg: not found (ok — proxy-only + libVLC)');
  });
  server.on('error', (err) => {
    log.error(`Listen failed on ${config.host}:${config.port}`, err);
    process.exit(1);
  });
  server.keepAliveTimeout = 65000;

  refreshActivePlaylists();
  setInterval(refreshActivePlaylists, REFRESH_CHECK_MS).unref();

  const shutdown = () => {
    try {
      db.saveNow();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Windows raises SIGHUP when the console window is closed.
  process.on('SIGHUP', shutdown);
}

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception', err);
  // EADDRINUSE before the listen 'error' event is wired — exit so the desktop host can detect failure.
  if (err && err.code === 'EADDRINUSE') process.exit(1);
});
process.on('unhandledRejection', (err) => log.error('Unhandled rejection', err));

main().catch((err) => {
  log.error('Startup failed', err);
  process.exit(1);
});
