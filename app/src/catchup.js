'use strict';

const { normalizeServer } = require('./xtream');

const pad = (n) => String(n).padStart(2, '0');

/** UTC "yyyy-MM-dd:HH-mm", the start format Xtream timeshift endpoints expect. */
function formatTimeshiftStart(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}:${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}`;
}

function formatUtcCompact(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/**
 * Stream length requested from the provider (minutes).
 * Covers from `startMs` until the later of "now + margin" and `untilMs` (programme end + preload).
 */
function timeshiftDurationMinutes(startMs, untilMs = 0, now = Date.now()) {
  // Prefer the caller's window (programme end + preload pad). Only fall back to "now"
  // when no end was provided — do not inflate finished shows out to the current time.
  const until = Number(untilMs) > 0 ? Number(untilMs) : (now + 5 * 60000);
  const minutes = Math.ceil((until - startMs) / 60000);
  return Math.min(12 * 60, Math.max(15, minutes));
}

function supportsCatchup(channel) {
  return !!(channel && (channel.catchup || channel.catchupDays > 0));
}

/**
 * Builds catch-up URLs for a channel starting at `startMs` (real air time, i.e. after EPG shift).
 * The playlist's catch-up shift (hours) is applied to the time sent to the provider.
 * Returns an ordered list of candidate URLs, or [] if catch-up is unavailable.
 */
function buildCatchupUrls(playlist, creds, channel, startMs, endMs, now = Date.now()) {
  if (!supportsCatchup(channel)) return [];

  const shiftMs = Math.round((Number(playlist.catchup_shift_hours) || 0) * 3600000);
  const start = Math.floor(startMs / 60000) * 60000 + shiftMs;
  const end = (endMs || startMs + 3600000) + shiftMs;

  if (channel.catchupSource) {
    const local = new Date(start);
    const durationMin = Math.max(1, Math.round((end - start) / 60000));
    let url = channel.catchupSource
      .replace(/\$?\{utc\}/g, formatUtcCompact(start))
      .replace(/\$?\{utcend\}/g, formatUtcCompact(end))
      .replace(/\$?\{start\}/g, formatTimeshiftStart(start))
      .replace(/\$?\{timestamp\}/g, String(Math.floor(start / 1000)))
      .replace(/\$?\{end\}/g, String(Math.floor(end / 1000)))
      .replace(/\$?\{duration\}/g, String(durationMin))
      .replace(/\{Y\}/g, String(local.getFullYear()))
      .replace(/\{m\}/g, pad(local.getMonth() + 1))
      .replace(/\{d\}/g, pad(local.getDate()))
      .replace(/\{H\}/g, pad(local.getHours()))
      .replace(/\{M\}/g, pad(local.getMinutes()))
      .replace(/\{S\}/g, pad(local.getSeconds()));
    // Relative sources ("?utc=...") are appended to the live stream URL.
    if (!/^https?:\/\//i.test(url)) url = channel.url + (channel.url.includes('?') ? url.replace(/^\?/, '&') : url);
    return [url];
  }

  if (!creds || !channel.streamId) return [];

  const server = normalizeServer(creds.streamBase || creds.server);
  const user = encodeURIComponent(creds.username);
  const pass = encodeURIComponent(creds.password);
  const startStr = formatTimeshiftStart(start);
  const duration = timeshiftDurationMinutes(start - shiftMs, end - shiftMs, now);

  return [
    `${server}/streaming/timeshift.php?username=${user}&password=${pass}&stream=${channel.streamId}&start=${encodeURIComponent(startStr)}&duration=${duration}`,
    `${server}/timeshift/${user}/${pass}/${duration}/${startStr}/${channel.streamId}.ts`,
  ];
}

module.exports = { buildCatchupUrls, supportsCatchup, formatTimeshiftStart, timeshiftDurationMinutes };
