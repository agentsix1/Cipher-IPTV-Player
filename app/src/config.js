'use strict';

const path = require('path');
const pkg = require('../package.json');

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (m) out[m[1]] = m[2] === undefined ? 'true' : m[2];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const mode = String(args.mode || process.env.XS_MODE || 'web').toLowerCase() === 'apk' ? 'apk' : 'web';

module.exports = {
  mode,
  isApk: mode === 'apk',
  port: Number(args.port || process.env.XS_PORT || (mode === 'apk' ? 8787 : 8080)),
  // APK defaults to loopback (no login). Explicit --host / XS_HOST overrides when needed.
  host: args.host || process.env.XS_HOST || (mode === 'apk' ? '127.0.0.1' : '0.0.0.0'),
  // Forces the web UI layout for every visitor ('phone' | 'tv' | 'desktop'); empty = detect per device.
  ui: ['phone', 'tv', 'desktop'].includes(String(args.ui || process.env.XS_UI || '').toLowerCase())
    ? String(args.ui || process.env.XS_UI).toLowerCase()
    : '',
  dataDir: path.resolve(args.data || process.env.XS_DATA_DIR || path.join(__dirname, '..', 'data')),
  // Editable playlists.json + layout.ini (desktop portable pack puts these next to the exe).
  configDir: path.resolve(
    args.config || process.env.XS_CONFIG_DIR || path.join(
      path.resolve(args.data || process.env.XS_DATA_DIR || path.join(__dirname, '..', 'data')),
      '..',
      'config',
    ),
  ),
  version: pkg.version,
  // Set by the Windows desktop exe, which runs the local (apk-mode) server on the PC.
  desktop: args.desktop === 'true' || process.env.XS_DESKTOP === '1',
};
