'use strict';

const db = require('./db');

const DEFAULTS = Object.freeze({
  // Off by default: guide preview decodes via mpegts.js inside WebView2 and is a
  // top lag/RAM cost on weaker PCs. Users can re-enable in Settings.
  autoPlayPreview: false,
  epgUpdateHours: 12,
  playlistRefreshHours: 0,
  showChannelNumbers: true,
  scrollingText: true,
  guideHoursVisible: 0, // 0 = automatic (based on screen width)
  // Shorter defaults keep client block arrays / tick work smaller.
  guidePastHours: 24,
  guideFutureHours: 48,
  defaultVolume: 100,
  alwaysShowChannels: false,
  combinePlaylists: false,
  playlistView: '', // 'combined' = every playlist at once (when combinePlaylists is on), '' = the active playlist
  vodConvertAhead: true,
  /** Extra hours of catch-up to load after the current programme ends (0 = stop at the end). */
  catchupPreloadHours: 1,
  /** On-screen debug overlay (also Ctrl+Shift+D). */
  debugOverlay: false,
  /** Home / See All highlight color (#rrggbb). */
  hubHighlight: '#c084fc',
});

const VALIDATORS = {
  autoPlayPreview: (v) => !!v,
  showChannelNumbers: (v) => !!v,
  scrollingText: (v) => !!v,
  debugOverlay: (v) => !!v,
  epgUpdateHours: (v) => clampNum(v, 1, 168, DEFAULTS.epgUpdateHours),
  playlistRefreshHours: (v) => clampNum(v, 0, 168, 0),
  guideHoursVisible: (v) => clampNum(v, 0, 12, 0),
  guidePastHours: (v) => clampNum(v, 0, 24 * 14, DEFAULTS.guidePastHours),
  guideFutureHours: (v) => clampNum(v, 6, 24 * 14, DEFAULTS.guideFutureHours),
  defaultVolume: (v) => clampNum(v, 0, 100, 100),
  alwaysShowChannels: (v) => !!v,
  combinePlaylists: (v) => !!v,
  playlistView: (v) => (v === 'combined' ? 'combined' : ''),
  vodConvertAhead: (v) => v !== false,
  catchupPreloadHours: (v) => clampNum(v, 0, 12, DEFAULTS.catchupPreloadHours),
  hubHighlight: (v) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(v || '').trim());
    return m ? `#${m[1].toLowerCase()}` : DEFAULTS.hubHighlight;
  },
};

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function get(userId) {
  const row = db.get('SELECT json FROM settings WHERE user_id = ?', [userId]);
  let stored = {};
  try {
    stored = row ? JSON.parse(row.json) : {};
  } catch {
    stored = {};
  }
  return { ...DEFAULTS, ...stored };
}

function update(userId, patch) {
  const next = get(userId);
  for (const [key, validate] of Object.entries(VALIDATORS)) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) next[key] = validate(patch[key]);
  }
  db.run('INSERT INTO settings (user_id, json) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json',
    [userId, JSON.stringify(next)]);
  return next;
}

module.exports = { DEFAULTS, get, update };
