'use strict';

/**
 * User-editable files next to the desktop app:
 *   config/playlists.json  — playlist URLs / Xtream / MAG logins
 *   config/layout.ini      — group/channel layout (order, renames, favorites, …)
 *
 * SQLite remains the runtime store; these files are the portable source of truth
 * users can hand-edit and copy between machines.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./log');
const playlists = require('./playlists');
const groupPrefs = require('./groups');
const PLAYLISTS_FILE = 'playlists.json';
const LAYOUT_FILE = 'layout.ini';

let writeTimer = null;
let syncing = false;

function configDir() {
  return config.configDir;
}

function playlistsPath() {
  return path.join(configDir(), PLAYLISTS_FILE);
}

function layoutPath() {
  return path.join(configDir(), LAYOUT_FILE);
}

function ensureConfigDir() {
  fs.mkdirSync(configDir(), { recursive: true });
}

function escapeIni(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function unescapeIni(value) {
  return String(value ?? '')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\\\/g, '\\');
}

/** Minimal INI reader: [section] + key=value (no multiline values). */
function parseIni(text) {
  const sections = { '': {} };
  let current = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) {
      current = sec[1].trim();
      if (!sections[current]) sections[current] = {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = unescapeIni(line.slice(eq + 1).trim());
    sections[current][key] = value;
  }
  return sections;
}

function writeIni(sections) {
  const lines = [
    '; Cipher layout - edit freely, then restart the app (or change a setting in-app to reload).',
    '; Sections: [playlist:<name>]  keys use dotted paths (groups.order, channels.name.<id>, ...).',
    '',
  ];
  for (const [name, kv] of Object.entries(sections)) {
    if (!name) continue;
    lines.push(`[${name}]`);
    const keys = Object.keys(kv).sort();
    for (const key of keys) lines.push(`${key}=${escapeIni(kv[key])}`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function csv(list) {
  return (Array.isArray(list) ? list : []).map(String).filter(Boolean).join(',');
}

function fromCsv(value) {
  if (!value) return [];
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

function layoutToIniSection(layout, favorites) {
  const kv = {};
  kv['groups.sort'] = layout.sort || 'playlist';
  kv['groups.showHidden'] = layout.showHidden ? '1' : '0';
  kv['groups.order'] = csv(layout.order);
  kv['groups.hidden'] = csv(layout.hidden);
  for (const [id, name] of Object.entries(layout.names || {})) {
    kv[`groups.name.${id}`] = name;
  }
  kv['channels.showHidden'] = layout.chShowHidden ? '1' : '0';
  kv['channels.hidden'] = csv(layout.chHidden);
  for (const [id, name] of Object.entries(layout.chNames || {})) {
    kv[`channels.name.${id}`] = name;
  }
  for (const [id, epg] of Object.entries(layout.epgMap || {})) {
    kv[`channels.epg.${id}`] = epg;
  }
  for (const [id, shift] of Object.entries(layout.epgShift || {})) {
    kv[`channels.epgShift.${id}`] = String(shift);
  }
  for (const [id, logo] of Object.entries(layout.chLogos || {})) {
    // Skip huge data-URLs in the INI — keep only http(s) / relative paths.
    if (logo && !String(logo).startsWith('data:')) kv[`channels.logo.${id}`] = logo;
  }
  for (const [groupId, sort] of Object.entries(layout.chSort || {})) {
    kv[`channels.sort.${groupId}`] = sort;
  }
  for (const [groupId, order] of Object.entries(layout.chOrder || {})) {
    kv[`channels.order.${groupId}`] = csv(order);
  }
  for (const custom of layout.custom || []) {
    if (!custom || !custom.id) continue;
    kv[`custom.${custom.id}.name`] = custom.name || '';
    kv[`custom.${custom.id}.channels`] = csv(custom.channels);
  }
  kv.favorites = csv(favorites);
  return kv;
}

function iniSectionToLayout(kv) {
  const layout = {
    sort: kv['groups.sort'] || 'playlist',
    showHidden: kv['groups.showHidden'] === '1' || kv['groups.showHidden'] === 'true',
    order: fromCsv(kv['groups.order']),
    hidden: fromCsv(kv['groups.hidden']),
    names: {},
    custom: [],
    chSort: {},
    chOrder: {},
    chNames: {},
    chHidden: fromCsv(kv['channels.hidden']),
    chShowHidden: kv['channels.showHidden'] === '1' || kv['channels.showHidden'] === 'true',
    epgMap: {},
    epgShift: {},
    chLogos: {},
  };
  const customMap = new Map();
  for (const [key, value] of Object.entries(kv)) {
    let m;
    if ((m = /^groups\.name\.(.+)$/.exec(key))) layout.names[m[1]] = value;
    else if ((m = /^channels\.name\.(.+)$/.exec(key))) layout.chNames[m[1]] = value;
    else if ((m = /^channels\.epg\.(.+)$/.exec(key))) layout.epgMap[m[1]] = value;
    else if ((m = /^channels\.epgShift\.(.+)$/.exec(key))) {
      const n = Number(value);
      if (Number.isFinite(n)) layout.epgShift[m[1]] = n;
    } else if ((m = /^channels\.logo\.(.+)$/.exec(key))) layout.chLogos[m[1]] = value;
    else if ((m = /^channels\.sort\.(.+)$/.exec(key))) layout.chSort[m[1]] = value;
    else if ((m = /^channels\.order\.(.+)$/.exec(key))) layout.chOrder[m[1]] = fromCsv(value);
    else if ((m = /^custom\.([^.]+)\.name$/.exec(key))) {
      if (!customMap.has(m[1])) customMap.set(m[1], { id: m[1], name: '', channels: [] });
      customMap.get(m[1]).name = value;
    } else if ((m = /^custom\.([^.]+)\.channels$/.exec(key))) {
      if (!customMap.has(m[1])) customMap.set(m[1], { id: m[1], name: '', channels: [] });
      customMap.get(m[1]).channels = fromCsv(value);
    }
  }
  layout.custom = [...customMap.values()];
  return { layout, favorites: fromCsv(kv.favorites) };
}

function playlistSectionName(pl) {
  const name = String(pl.name || 'playlist').replace(/[\]\r\n]/g, ' ').trim() || 'playlist';
  return `playlist:${name}`;
}

function writePlaylistsFile(userId) {
  ensureConfigDir();
  const doc = {
    version: 1,
    updatedAt: new Date().toISOString(),
    playlists: playlists.list(userId).map((pl) => ({
      name: pl.name,
      type: pl.type,
      m3uUrl: pl.m3uUrl || '',
      serverUrl: pl.serverUrl || '',
      username: pl.username || '',
      password: pl.password || '',
      macAddress: pl.macAddress || '',
      epgUrl: pl.epgUrl || '',
      epgSources: pl.epgSources || [],
      useProviderEpg: pl.useProviderEpg !== false,
      epgShiftHours: pl.epgShiftHours || 0,
      catchupShiftHours: pl.catchupShiftHours || 0,
      streamFormat: pl.streamFormat || 'ts',
      userAgent: pl.userAgent || '',
      refreshHours: pl.refreshHours,
      isActive: !!pl.isActive,
    })),
  };
  const target = playlistsPath();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);
  return target;
}

function writeLayoutFile(userId) {
  ensureConfigDir();
  const sections = {};
  for (const pl of playlists.list(userId)) {
    const layout = groupPrefs.get(userId, pl.id);
    const favs = [...playlists.favorites(userId, pl.id)];
    sections[playlistSectionName(pl)] = layoutToIniSection(layout, favs);
  }
  const target = layoutPath();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, writeIni(sections), 'utf8');
  fs.renameSync(tmp, target);
  return target;
}

function writeAll(userId) {
  if (syncing) return;
  syncing = true;
  try {
    writePlaylistsFile(userId);
    writeLayoutFile(userId);
    log.info(`User files written: ${playlistsPath()} , ${layoutPath()}`);
  } catch (err) {
    log.warn(`User files write failed: ${err.message}`);
  } finally {
    syncing = false;
  }
}

function scheduleWrite(userId) {
  if (!userId) userId = 'local';
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    writeAll(userId);
  }, 400);
}

function sourceKey(pl) {
  if (pl.type === 'xtream') {
    return `x|${String(pl.serverUrl || '').replace(/\/+$/, '').toLowerCase()}|${String(pl.username || '').toLowerCase()}`;
  }
  if (pl.type === 'mag') {
    return `g|${String(pl.serverUrl || '').replace(/\/+$/, '').toLowerCase()}|${String(pl.macAddress || pl.username || '').toLowerCase()}`;
  }
  return `m|${String(pl.m3uUrl || '').trim()}`;
}

/** Load playlists.json into the DB (create/update by source; do not delete missing rows). */
function loadPlaylistsFile(userId) {
  const file = playlistsPath();
  if (!fs.existsSync(file)) return { loaded: false };
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    log.warn(`playlists.json parse error: ${err.message}`);
    return { loaded: false, error: err.message };
  }
  const entries = Array.isArray(doc.playlists) ? doc.playlists : (Array.isArray(doc) ? doc : []);
  const existing = new Map(playlists.listRows(userId).map((row) => [sourceKey(playlists.toClient(row)), row]));
  let added = 0;
  let updated = 0;
  let activeId = null;
  syncing = true;
  try {
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const input = { ...entry };
      if (entry.type === 'mag' && entry.macAddress && !entry.username) input.username = entry.macAddress;
      const key = sourceKey(input);
      const match = existing.get(key);
      let row;
      if (match) {
        playlists.update(userId, match.id, input);
        row = playlists.getRow(userId, match.id);
        updated += 1;
      } else {
        row = playlists.create(userId, input);
        existing.set(key, row);
        added += 1;
      }
      if (entry.isActive) activeId = row.id;
    }
    if (activeId) playlists.activate(userId, activeId);
  } finally {
    syncing = false;
  }
  log.info(`playlists.json loaded (${added} added, ${updated} updated)`);
  return { loaded: true, added, updated };
}

/** Load layout.ini into group_prefs / favorites for matching playlists. */
function loadLayoutFile(userId) {
  const file = layoutPath();
  if (!fs.existsSync(file)) return { loaded: false };
  let sections;
  try {
    sections = parseIni(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    log.warn(`layout.ini parse error: ${err.message}`);
    return { loaded: false, error: err.message };
  }
  const byName = new Map(playlists.list(userId).map((pl) => [String(pl.name || '').toLowerCase(), pl]));
  let applied = 0;
  syncing = true;
  try {
    for (const [section, kv] of Object.entries(sections)) {
      if (!section.startsWith('playlist:')) continue;
      const name = section.slice('playlist:'.length).trim();
      const pl = byName.get(name.toLowerCase());
      if (!pl) {
        log.warn(`layout.ini section [${section}] — no matching playlist name`);
        continue;
      }
      const { layout, favorites } = iniSectionToLayout(kv);
      groupPrefs.replace(userId, pl.id, layout);
      playlists.setFavorites(userId, pl.id, favorites);
      applied += 1;
    }
  } finally {
    syncing = false;
  }
  log.info(`layout.ini loaded (${applied} playlist section(s))`);
  return { loaded: true, applied };
}

function ensureDefaultFiles() {
  ensureConfigDir();
  const pj = playlistsPath();
  if (!fs.existsSync(pj)) {
    fs.writeFileSync(pj, `${JSON.stringify({
      version: 1,
      playlists: [],
    }, null, 2)}\n`, 'utf8');
    log.info(`Created template ${pj}`);
  }
  const lj = layoutPath();
  if (!fs.existsSync(lj)) {
    fs.writeFileSync(lj, [
      '; Cipher layout - edit freely, then restart the app.',
      '; Add a [playlist:Your Name] section matching a playlist name from playlists.json.',
      '',
    ].join('\n'), 'utf8');
    log.info(`Created template ${lj}`);
  }
}

/**
 * Boot: ensure templates, import editable files into SQLite, then rewrite so
 * formatting stays consistent for hand-editing.
 */
function bootstrap(userId) {
  ensureDefaultFiles();
  const hadPlaylists = playlists.listRows(userId).length > 0;
  const pl = loadPlaylistsFile(userId);
  const ly = loadLayoutFile(userId);
  // Always emit current state so users see a complete, up-to-date file.
  if (hadPlaylists || pl.added || pl.updated) writeAll(userId);
  else writeAll(userId);
  return { playlists: pl, layout: ly, dir: configDir() };
}

function attachHooks() {
  const wrap = (obj, name) => {
    const orig = obj[name];
    if (typeof orig !== 'function' || orig.__userfilesWrapped) return;
    const wrapped = function wrappedFn(...args) {
      const result = orig.apply(this, args);
      if (!syncing) {
        const uid = typeof args[0] === 'string'
          ? args[0]
          : (args[0] && args[0].user_id) || 'local';
        scheduleWrite(uid);
      }
      return result;
    };
    wrapped.__userfilesWrapped = true;
    obj[name] = wrapped;
  };
  for (const name of ['create', 'update', 'remove', 'activate', 'setFavorites', 'toggleFavorite', 'persistM3uXtreamCreds']) {
    wrap(playlists, name);
  }
  for (const name of ['replace', 'updateList', 'updateGroup', 'createCustom', 'deleteCustom',
    'setCustomChannel', 'removeCustomChannel', 'moveCustomChannel', 'updateChannelList', 'updateChannel']) {
    if (typeof groupPrefs[name] === 'function') wrap(groupPrefs, name);
  }
}

module.exports = {
  bootstrap,
  attachHooks,
  scheduleWrite,
  writeAll,
  playlistsPath,
  layoutPath,
  configDir,
};
