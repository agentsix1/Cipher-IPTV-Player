'use strict';

const db = require('./db');
const settings = require('./settings');
const playlists = require('./playlists');
const groupPrefs = require('./groups');
const icons = require('./icons');
const catalog = require('./catalog');
const config = require('./config');
const { httpError } = require('./auth');

/**
 * A user's whole setup as one JSON document: settings plus every playlist (with its login), and per
 * playlist the favorites and group preferences (order, renames, hidden and custom groups).
 */
const KIND = 'cipher-config';
const LEGACY_KINDS = new Set(['cipher-config', 'xfinity-stream-config']);
const FORMAT = 1;
const MAX_PLAYLISTS = 50;
const MAX_FAVORITES = 20000;

const PLAYLIST_FIELDS = ['name', 'type', 'm3uUrl', 'serverUrl', 'username', 'password', 'epgUrl', 'epgSources', 'useProviderEpg',
  'epgShiftHours', 'catchupShiftHours', 'streamFormat', 'userAgent', 'refreshHours'];

function exportConfig(userId, { includeImages = false } = {}) {
  return {
    kind: KIND,
    format: FORMAT,
    app: `Cipher ${config.version}`,
    exportedAt: new Date().toISOString(),
    includeImages: !!includeImages,
    settings: settings.get(userId),
    playlists: playlists.list(userId).map((pl) => {
      const entry = {};
      for (const key of PLAYLIST_FIELDS) entry[key] = pl[key];
      entry.isActive = pl.isActive;
      entry.favorites = [...playlists.favorites(userId, pl.id)];
      const groups = groupPrefs.get(userId, pl.id);
      if (includeImages && groups.chLogos && Object.keys(groups.chLogos).length) {
        entry.groups = { ...groups, chLogos: icons.exportIcons(userId, pl.id, groups) };
      } else entry.groups = groups;
      return entry;
    }),
  };
}

/** Identifies "the same playlist" across devices: same source, regardless of name. */
function sourceKey(pl) {
  if (pl.type === 'xtream') {
    return `x|${String(pl.serverUrl || pl.server_url || '').replace(/\/+$/, '').toLowerCase()}|${String(pl.username || '').toLowerCase()}`;
  }
  if (pl.type === 'mag') {
    return `g|${String(pl.serverUrl || pl.server_url || '').replace(/\/+$/, '').toLowerCase()}|${String(pl.macAddress || pl.username || '').toLowerCase()}`;
  }
  return `m|${String(pl.m3uUrl || pl.m3u_url || '').trim()}`;
}

/**
 * Merges an exported config into the user's setup: matching playlists are updated, new ones are added
 * (nothing is deleted). Favorites and group preferences of imported playlists are replaced.
 */
function importConfig(userId, data) {
  if (!data || typeof data !== 'object' || !LEGACY_KINDS.has(data.kind)) throw httpError(400, 'This is not a Cipher config');
  if (Number(data.format) > FORMAT) throw httpError(400, 'This config was made by a newer version of the app. Update this device first.');
  const entries = Array.isArray(data.playlists) ? data.playlists.slice(0, MAX_PLAYLISTS) : [];

  const existing = new Map(playlists.listRows(userId).map((row) => [sourceKey({ ...playlists.toClient(row) }), row]));
  const summary = { added: 0, updated: 0, settings: false };
  let activeId = null;

  db.transaction(() => {
    if (data.settings && typeof data.settings === 'object') {
      settings.update(userId, data.settings);
      summary.settings = true;
    }
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const input = {};
      for (const key of PLAYLIST_FIELDS) if (entry[key] !== undefined) input[key] = entry[key];
      const match = existing.get(sourceKey(input));
      let row;
      if (match) {
        const result = playlists.update(userId, match.id, input);
        row = result.row;
        if (result.sourceChanged) catalog.forget(row.id);
        summary.updated += 1;
      } else {
        row = playlists.create(userId, input);
        existing.set(sourceKey(input), row);
        summary.added += 1;
      }
      if (Array.isArray(entry.favorites)) playlists.setFavorites(userId, row.id, entry.favorites.slice(0, MAX_FAVORITES).map(String));
      if (entry.groups && typeof entry.groups === 'object') {
        const groups = { ...entry.groups };
        if (groups.chLogos) groups.chLogos = icons.importEmbeddedLogos(row.id, groups.chLogos);
        groupPrefs.replace(userId, row.id, groups);
      }
      if (entry.isActive) activeId = row.id;
    }
    if (activeId) playlists.activate(userId, activeId);
  });

  const active = playlists.getActiveRow(userId);
  if (active) catalog.ensureLoaded(active, { maxAgeHours: settings.get(userId).epgUpdateHours });
  return summary;
}

/**
 * Layout file: the active playlist's groups and channels layout (order, sort, renames, hidden, custom
 * groups, favorites, EPG assignments and time adjustments) as base64-encoded JSON. It holds no playlist
 * details (URLs, logins) and no guide data, so it can be applied to the same provider on any device.
 */
const LAYOUT_KIND = 'cipher-layout';
const LEGACY_LAYOUT_KINDS = new Set(['cipher-layout', 'xfinity-stream-layout']);
const LAYOUT_FORMAT = 1;

function exportLayout(userId, playlist) {
  const doc = {
    kind: LAYOUT_KIND,
    format: LAYOUT_FORMAT,
    app: `Cipher ${config.version}`,
    exportedAt: new Date().toISOString(),
    layout: groupPrefs.get(userId, playlist.id),
    favorites: [...playlists.favorites(userId, playlist.id)],
  };
  return Buffer.from(JSON.stringify(doc), 'utf8').toString('base64');
}

function decodeLayout(text) {
  const clean = String(text || '').replace(/\s+/g, '');
  if (!clean || !/^[A-Za-z0-9+/_-]+=*$/.test(clean)) throw httpError(400, 'This is not a layout file (it must be base64 text)');
  let doc;
  try {
    doc = JSON.parse(Buffer.from(clean, 'base64').toString('utf8'));
  } catch {
    throw httpError(400, 'This layout file is damaged or incomplete');
  }
  if (!doc || typeof doc !== 'object' || !LEGACY_LAYOUT_KINDS.has(doc.kind)) throw httpError(400, 'This is not a Cipher layout file');
  if (Number(doc.format) > LAYOUT_FORMAT) throw httpError(400, 'This layout was made by a newer version of the app. Update this device first.');
  if (!doc.layout || typeof doc.layout !== 'object') throw httpError(400, 'This layout file is empty');
  return doc;
}

/** Replaces the playlist's layout with the file's. Returns a summary for the UI. */
function importLayout(userId, playlist, text) {
  const doc = decodeLayout(text);
  db.transaction(() => {
    groupPrefs.replace(userId, playlist.id, doc.layout);
    if (Array.isArray(doc.favorites)) playlists.setFavorites(userId, playlist.id, doc.favorites.slice(0, MAX_FAVORITES).map(String));
  });
  const layout = groupPrefs.get(userId, playlist.id);
  return {
    customGroups: layout.custom.length,
    hiddenGroups: layout.hidden.length,
    renamedGroups: Object.keys(layout.names).length,
    renamedChannels: Object.keys(layout.chNames).length,
    hiddenChannels: layout.chHidden.length,
    epgAssignments: Object.keys(layout.epgMap).length,
    favorites: playlists.favorites(userId, playlist.id).size,
  };
}

module.exports = { exportConfig, importConfig, exportLayout, importLayout, KIND };
