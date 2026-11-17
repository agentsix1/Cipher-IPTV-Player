'use strict';

const express = require('express');
const config = require('./config');
const auth = require('./auth');
const settings = require('./settings');
const playlists = require('./playlists');
const catalog = require('./catalog');
const streams = require('./streams');
const groupPrefs = require('./groups');
const backup = require('./backup');
const share = require('./share');
const { searchEpg } = require('./epgsearch');
const search = require('./search');
const { buildCatchupUrls, supportsCatchup } = require('./catchup');
const { EPGSHARE_SOURCES, EPGSHARE_BASE } = require('./epgpresets');
const icons = require('./icons');
const vod = require('./vod');
const combined = require('./combined');
const mag = require('./mag');
const ffmpeg = require('./ffmpeg');
const log = require('./log');
const playerDebug = require('./player-debug');
const history = require('./history');
const bookmarks = require('./bookmarks');
const homeHub = require('./home');
const meta = require('./meta');

const FAVORITES_GROUP = '__fav';

catalog.setExtraEpgIds(groupPrefs.epgTargets);

/** Channels + TV guide + Movies/TV Shows (fresh MAG cmds/ids). */
async function refreshPlaylistFull(row) {
  await catalog.ensureLoaded(row, { force: true });
  if (!vod.supportsVod(row)) return;
  const state = catalog.getState(row.id);
  await vod.refreshCatalog(row, state);
}

/**
 * Async route wrapper. Responds on rejection directly — relying only on next(err) from a
 * promise microtask has been observed to leave /play/* requests hanging forever (no response),
 * which wedges the UI on "Loading…" and makes the app feel locked up.
 */
const wrap = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch((err) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const status = (err && err.status) || 500;
    if (status >= 500) log.error('API error', err);
    else log.warn(`API ${status}: ${err && err.message ? err.message : err}`);
    try {
      res.status(status).json({ error: (err && err.message) || 'Server error' });
    } catch (sendErr) {
      next(sendErr);
    }
  });
};

/**
 * Loads what the user is viewing: the active playlist, or every playlist merged when "All playlists"
 * is selected. Kicks off loading if needed.
 */
function activeContext(req) {
  const prefs = settings.get(req.user.id);
  const rows = playlists.listRows(req.user.id);
  if (combined.isOn(prefs, rows)) {
    for (const row of rows) catalog.ensureLoaded(row, { maxAgeHours: prefs.epgUpdateHours });
    return { playlist: combined.virtualRow(), state: combined.stateFor(req.user.id, rows), prefs };
  }
  const playlist = playlists.getActiveRow(req.user.id);
  if (!playlist) throw auth.httpError(404, 'No playlist configured');
  const state = catalog.getState(playlist.id);
  catalog.ensureLoaded(playlist, { maxAgeHours: prefs.epgUpdateHours });
  return { playlist, state, prefs };
}

/** List and channel preferences for what is being viewed (the combined view inherits each playlist's channel edits). */
function listPrefs(userId, playlist, state) {
  const prefs = groupPrefs.get(userId, playlist.id);
  return state && state.combined ? combined.inheritPrefs(prefs, state, (id) => groupPrefs.get(userId, id)) : prefs;
}

function epgShiftMs(playlist) {
  return Math.round((Number(playlist.epg_shift_hours) || 0) * 3600000);
}

/** The user's EPG assignment for a channel: an XMLTV id, '' for "no guide", or undefined (automatic). */
function epgOverride(prefs, channelId) {
  return Object.prototype.hasOwnProperty.call(prefs.epgMap, channelId) ? prefs.epgMap[channelId] : undefined;
}

/** Playlist EPG shift plus the channel's own adjustment, in ms. */
function channelShiftMs(playlist, prefs, channel) {
  const base = channel._shiftMs !== undefined ? channel._shiftMs : epgShiftMs(playlist);
  return base + Math.round((Number(prefs.epgShift[channel.id]) || 0) * 3600000);
}

function programmesOf(state, channel, prefs) {
  return catalog.programmesFor(state, channel, epgOverride(prefs, channel.id));
}

/** Icon URL for one guide channel key, using the same entries the guide picker lists. */
function iconForGuideEntries(entries, key) {
  const want = String(key || '').trim().toLowerCase();
  if (!want || !entries) return '';
  const bare = want.includes('::') ? want.slice(want.lastIndexOf('::') + 2) : want;
  let bareHit = '';
  for (const e of entries) {
    if (!e || !e.icon) continue;
    const k = String(e.key != null ? e.key : '').toLowerCase();
    const id = String(e.id || '').toLowerCase();
    if ((k && k === want) || id === want) return e.icon;
    if (!bareHit && (id === bare || (k && k.endsWith(`::${bare}`)))) bareHit = e.icon;
  }
  return bareHit;
}

/**
 * Lookup maps over the guide's channel icons, rebuilt only when the guide list changes. A channel
 * list request asks for hundreds of icons against guides with tens of thousands of entries.
 */
/** `pk~` prefix of a combined-view guide key or source id. */
function iconScope(value) {
  const s = String(value || '').toLowerCase();
  const cut = s.indexOf('~');
  return cut >= 0 ? s.slice(0, cut + 1) : '';
}

function iconIndexOf(state) {
  let index = state.iconIndex;
  if (index && index.list === state.epgList && index.size === state.epgList.length) return index;
  const exact = new Map();
  const bare = new Map();
  for (const e of state.epgList) {
    if (!e || !e.icon) continue;
    const id = String(e.id || '').toLowerCase();
    const key = catalog.epgKey(e).toLowerCase();
    if (!exact.has(key)) exact.set(key, e.icon);
    if (state.combined) {
      // Combined-view bare matches stay inside the entry's own playlist.
      const scoped = `${iconScope(e.source)}${id}`;
      if (id && !bare.has(scoped)) bare.set(scoped, e.icon);
      continue;
    }
    if (id && !exact.has(id)) exact.set(id, e.icon);
    if (id && !bare.has(id)) bare.set(id, e.icon);
  }
  index = { list: state.epgList, size: state.epgList.length, exact, bare };
  state.iconIndex = index;
  return index;
}

/** Icon URL from the XMLTV channel this stream is matched to (assignment, then automatic). */
function epgIconFor(state, channel, override) {
  if (!state || !state.epgList || !state.epgList.length) return '';
  const index = iconIndexOf(state);
  const lookup = (value) => {
    const want = String(value || '').trim().toLowerCase();
    if (!want) return '';
    const hit = index.exact.get(want);
    if (hit) return hit;
    const id = want.includes('::') ? want.slice(want.lastIndexOf('::') + 2) : want;
    return index.bare.get(state.combined ? `${iconScope(want)}${id}` : id) || '';
  };
  if (typeof override === 'string') return override ? lookup(override) : '';
  // Combined-view channels already carry their own playlist's guide key; a bare stream id would match other playlists.
  if (channel._pl) return lookup(channel.epgId);
  return lookup(channel.epgId) || lookup(channel.streamId);
}

/** `channel` may be a raw catalog channel or one decorated by groupPrefs.applyChannels. */
function channelToClient(channel, favorites, prefs, state) {
  const originalName = channel.originalName || channel.name;
  const override = epgOverride(prefs, channel.id);
  return {
    id: channel.id,
    name: prefs.chNames[channel.id] || originalName,
    originalName,
    renamed: !!prefs.chNames[channel.id],
    hidden: channel.hidden !== undefined ? channel.hidden : prefs.chHidden.includes(channel.id),
    logo: prefs.chLogos[channel.id] || channel.logo,
    logoCustom: !!prefs.chLogos[channel.id],
    playlistLogo: channel.logo || '',
    epgLogo: epgIconFor(state, channel, override),
    num: channel.num,
    groupId: channel.groupId,
    catchup: supportsCatchup(channel),
    catchupDays: channel.catchupDays || 0,
    fav: favorites.has(channel.id),
    epg: override === undefined ? 'auto' : override ? 'custom' : 'none',
    epgShift: Number(prefs.epgShift[channel.id]) || 0,
  };
}

function channelsInGroup(state, groupId, favorites, prefs) {
  if (groupId === FAVORITES_GROUP) return state.channels.filter((c) => favorites.has(c.id));
  if (!groupId) return state.channels;
  if (groupPrefs.isCustom(groupId)) {
    const custom = prefs.custom.find((c) => c.id === groupId);
    return custom ? custom.channels.map((id) => state.byId.get(id)).filter(Boolean) : [];
  }
  return state.channels.filter((c) => c.groupId === groupId);
}

/** The group list as the user sees it: Favorites, playlist groups and custom groups, renamed/sorted/hidden per prefs. */
function groupList(state, favorites, prefs) {
  const hidden = new Set(prefs.chShowHidden ? [] : prefs.chHidden);
  const shown = (id) => !hidden.has(id);
  const all = new Map();
  const counts = new Map();
  for (const c of state.channels) {
    all.set(c.groupId, (all.get(c.groupId) || 0) + 1);
    if (shown(c.id)) counts.set(c.groupId, (counts.get(c.groupId) || 0) + 1);
  }
  const groups = state.groups
    .filter((g) => all.get(g.id))
    .map((g) => ({ id: g.id, name: g.name, count: counts.get(g.id) || 0 }));
  const favCount = state.channels.filter((c) => favorites.has(c.id) && shown(c.id)).length;
  if (favCount) groups.unshift({ id: FAVORITES_GROUP, name: 'Favorites', count: favCount, pinned: true });
  for (const c of prefs.custom) {
    groups.push({
      id: c.id,
      name: c.name,
      count: c.channels.filter((id) => state.byId.has(id) && shown(id)).length,
      custom: true,
      system: c.id === groupPrefs.UNUSED_GROUP_ID,
    });
  }
  return groupPrefs.apply(groups, prefs);
}

function statusPayload(state) {
  return {
    ...state.status,
    channels: state.channels.length,
    epgChannels: state.epg.size,
    epgFetchedAt: state.epgFetchedAt || null,
  };
}

/** Programmes overlapping [from, to] with the EPG shift applied: [start, end, title, hasDescription]. */
function shiftedProgrammes(list, shift, from, to) {
  const out = [];
  for (const p of list) {
    const start = p[0] + shift;
    const end = p[1] + shift;
    if (end <= from) continue;
    if (start >= to) break;
    out.push([start, end, p[2], p[3] ? 1 : 0]);
  }
  return out;
}

function searchScopeRows(userId, scope) {
  const rows = playlists.listRows(userId);
  const value = String(scope || 'all');
  if (!value || value === 'all') return rows;
  if (value.startsWith('type:')) {
    const match = rows.filter((r) => r.type === value.slice(5));
    return match.length ? match : rows;
  }
  const one = rows.find((r) => r.id === value);
  return one ? [one] : rows;
}
function catalogHealth(row) {
  return catalog.healthOf(catalog.getState(row.id));
}

function viewInfo(userId) {
  const userSettings = settings.get(userId);
  const rows = playlists.listRows(userId);
  const active = playlists.getActiveRow(userId);
  const isCombined = combined.isOn(userSettings, rows);
  return {
    combineEnabled: !!userSettings.combinePlaylists && rows.length > 1,
    current: isCombined ? combined.COMBINED_ID : (active ? active.id : ''),
    playlists: rows.map((row) => ({ id: row.id, name: row.name, type: row.type, catalog: catalogHealth(row) })),
  };
}

function memberStatus(state) {
  if (!state || !Array.isArray(state.members)) return undefined;
  return state.members.map((m) => ({
    id: m.row.id,
    name: m.row.name,
    type: m.row.type,
    ...catalog.healthOf(m.state),
  }));
}

function findChannel(state, id) {
  const channel = state.byId.get(String(id || ''));
  if (!channel) throw auth.httpError(404, 'Channel not found');
  return channel;
}

function magSign(source, url, opts = {}) {
  const pl = source.playlist;
  return streams.signedUrl(url, mag.streamUserAgent(pl), pl.id, mag.streamHeaders(pl, source.state.creds), opts);
}

/** Starts loading earlier guide days for MAG catch-up channels shown from `fromMs` (also inside "All playlists"). */
function loadMagHistory(playlist, state, channels, fromMs) {
  if (!state.combined) {
    catalog.ensureMagHistory(playlist, state, channels, fromMs);
    return;
  }
  for (const member of state.members || []) {
    if (member.row.type !== 'mag') continue;
    const own = channels.filter((c) => c._pl === member.row.id).map((c) => member.state.byId.get(c._src)).filter(Boolean);
    if (own.length) catalog.ensureMagHistory(member.row, member.state, own, fromMs);
  }
}

function createRouter() {
  const r = express.Router();

  // ---- Session / auth -------------------------------------------------------
  r.get('/session', (req, res) => {
    res.json({
      mode: config.mode,
      desktop: config.desktop,
      version: config.version,
      user: req.user,
      needsSetup: !config.isApk && auth.userCount() === 0,
    });
  });

  r.post('/auth/setup', wrap(async (req, res) => {
    if (config.isApk || auth.userCount() > 0) throw auth.httpError(403, 'Setup already completed');
    auth.createUser(req.body.username, req.body.password, true);
    const { token, user } = auth.login(req.body.username, req.body.password);
    res.setHeader('Set-Cookie', auth.sessionCookie(token, auth.SESSION_TTL_MS));
    res.json({ user });
  }));

  r.post('/auth/login', wrap(async (req, res) => {
    if (config.isApk) return res.json({ user: req.user });
    const { token, user } = auth.login(req.body.username, req.body.password);
    res.setHeader('Set-Cookie', auth.sessionCookie(token, auth.SESSION_TTL_MS));
    res.json({ user });
  }));

  r.post('/auth/logout', (req, res) => {
    auth.logout(req.sessionToken);
    res.setHeader('Set-Cookie', auth.sessionCookie('', 0));
    res.json({ ok: true });
  });

  // Stream links are signed, so the proxy does not need the session cookie.
  r.get('/stream', wrap(streams.proxy));
  r.get('/stream-cache', (req, res) => {
    const st = streams.cacheStatus(req.query.p, req.query.s);
    if (!st) {
      res.status(403).json({ error: 'Invalid or expired stream link' });
      return;
    }
    res.json(st);
  });

  // Local player debug sink — before auth so a stale session never 401/404s the logger.
  r.post('/player-debug', (req, res) => {
    const body = req.body || {};
    const result = playerDebug.ingest(req.user && req.user.id, body.sessionId, body.events);
    res.json({ ok: true, ...result });
  });

  // Debug metadata + recent lines (no auth — local loopback tooling / overlay).
  r.get('/debug/info', (req, res) => {
    res.json({ ok: true, ...playerDebug.info() });
  });
  r.get('/debug/tail', (req, res) => {
    const n = Number(req.query.n) || 80;
    res.json({ ok: true, ...playerDebug.tail(n) });
  });

  // Another device pulling this user's config with a share code (the code is the credential).
  r.get('/share/:code', share.handleShareRequest);

  r.use(auth.requireUser);

  // ---- Config backup / device-to-device sharing -------------------------------
  r.get('/config/export', (req, res) => {
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="cipher-config-${stamp}.json"`);
    const includeImages = req.query.includeImages === '1' || req.query.includeImages === 'true';
    res.json(backup.exportConfig(req.user.id, { includeImages }));
  });

  r.post('/config/import', (req, res) => {
    res.json(backup.importConfig(req.user.id, (req.body || {}).config));
  });

  r.post('/config/import-remote', wrap(async (req, res) => {
    const remote = await share.fetchRemote((req.body || {}).address, (req.body || {}).code);
    res.json(backup.importConfig(req.user.id, remote));
  }));

  r.get('/layout/export', (req, res) => {
    const playlist = playlists.getActiveRow(req.user.id);
    if (!playlist) throw auth.httpError(404, 'No playlist configured');
    const name = String(playlist.name || 'playlist').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'playlist';
    res.json({
      filename: `cipher-layout-${name}-${new Date().toISOString().slice(0, 10)}.cipherlayout`,
      data: backup.exportLayout(req.user.id, playlist),
    });
  });

  r.post('/layout/import', (req, res) => {
    const playlist = playlists.getActiveRow(req.user.id);
    if (!playlist) throw auth.httpError(404, 'Add a playlist before importing a layout');
    res.json(backup.importLayout(req.user.id, playlist, (req.body || {}).data));
  });

  r.post('/share', wrap(async (req, res) => {
    const includeImages = !!(req.body || {}).includeImages;
    res.json(await share.createCode(req.user.id, { includeImages }));
  }));
  r.delete('/share', (req, res) => {
    share.cancelCode(req.user.id);
    res.json({ ok: true });
  });

  r.post('/auth/password', wrap(async (req, res) => {
    auth.changePassword(req.user.id, req.body.currentPassword, req.body.newPassword);
    res.json({ ok: true });
  }));

  // ---- Users (web mode, admin) ---------------------------------------------
  r.get('/users', auth.requireAdmin, (_req, res) => res.json(auth.listUsers()));
  r.post('/users', auth.requireAdmin, wrap(async (req, res) => {
    res.json(auth.createUser(req.body.username, req.body.password, !!req.body.isAdmin));
  }));
  r.delete('/users/:id', auth.requireAdmin, (req, res) => {
    if (req.params.id === req.user.id) throw auth.httpError(400, 'You cannot delete your own account');
    for (const pl of playlists.listRows(req.params.id)) catalog.forget(pl.id);
    auth.deleteUser(req.params.id);
    res.json({ ok: true });
  });

  // ---- Settings -------------------------------------------------------------
  r.get('/settings', (req, res) => res.json(settings.get(req.user.id)));
  r.put('/settings', (req, res) => {
    const body = { ...(req.body || {}) };
    const before = settings.get(req.user.id);
    // Turning Combine playlists on shows every playlist right away; turning it off goes back to one.
    if (body.combinePlaylists !== undefined && !!body.combinePlaylists !== !!before.combinePlaylists) {
      body.playlistView = body.combinePlaylists ? combined.COMBINED_ID : '';
    }
    res.json(settings.update(req.user.id, body));
  });

  // ---- Playlists ------------------------------------------------------------
  r.get('/playlists', (req, res) => res.json(playlists.list(req.user.id).map((pl) => ({
    ...pl,
    catalog: catalogHealth({ id: pl.id }),
  }))));

  /** Built-in guide sources the playlist form offers (epgshare01.online). */
  r.get('/epg/presets', (req, res) => res.json({ epgshare: EPGSHARE_SOURCES, base: EPGSHARE_BASE }));

  r.post('/playlists', wrap(async (req, res) => {
    const row = playlists.create(req.user.id, req.body);
    playerDebug.record('playlist.create', row.name || row.type || String(row.id), {
      id: row.id,
      type: row.type,
      userId: req.user && req.user.id,
    }, { userId: req.user && req.user.id });
    refreshPlaylistFull(row).catch((err) => log.warn(`Playlist create refresh failed: ${err.message}`));
    res.json(playlists.toClient(row));
  }));

  r.put('/playlists/:id', wrap(async (req, res) => {
    const { row, sourceChanged, epgChanged } = playlists.update(req.user.id, req.params.id, req.body);
    // M3U without a stored Xtream login: reload so stream URLs can be mined for
    // player_api catch-up metadata (and the login saved on the playlist row).
    const needsXtreamEnrich = row.type === 'm3u' && !(row.server_url && row.username && row.password);
    if (sourceChanged || needsXtreamEnrich) {
      refreshPlaylistFull(row).catch((err) => log.warn(`Playlist update refresh failed: ${err.message}`));
    } else if (epgChanged) catalog.reloadEpg(row);
    res.json(playlists.toClient(row));
  }));

  r.delete('/playlists/:id', (req, res) => {
    playlists.remove(req.user.id, req.params.id);
    vod.forget(req.params.id);
    catalog.forget(req.params.id);
    res.json({ ok: true });
  });

  r.post('/playlists/:id/activate', (req, res) => {
    const row = playlists.activate(req.user.id, req.params.id);
    settings.update(req.user.id, { playlistView: '' });
    catalog.ensureLoaded(row, { maxAgeHours: settings.get(req.user.id).epgUpdateHours });
    res.json(playlists.toClient(row));
  });

  r.post('/playlists/:id/refresh', wrap(async (req, res) => {
    if (req.params.id === combined.COMBINED_ID) {
      const rows = playlists.listRows(req.user.id);
      await Promise.all(rows.map((row) => refreshPlaylistFull(row).catch((err) => {
        log.warn(`Refresh failed for '${row.name}': ${err.message}`);
      })));
      return res.json({ ok: true });
    }
    const row = playlists.getRow(req.user.id, req.params.id);
    if (!row) throw auth.httpError(404, 'Playlist not found');
    await refreshPlaylistFull(row);
    res.json({ ok: true });
  }));

  /**
   * Chooses what the app shows: one playlist (`id`) or every playlist merged (`id: "combined"`, only when
   * the Combine playlists setting is on).
   */
  r.post('/playlist-view', (req, res) => {
    const id = String((req.body || {}).id || '');
    const userSettings = settings.get(req.user.id);
    if (id === combined.COMBINED_ID) {
      if (!userSettings.combinePlaylists) throw auth.httpError(400, 'Turn on Combine playlists in Settings first');
      settings.update(req.user.id, { playlistView: combined.COMBINED_ID });
    } else {
      const row = playlists.activate(req.user.id, id);
      catalog.ensureLoaded(row, { maxAgeHours: userSettings.epgUpdateHours });
      settings.update(req.user.id, { playlistView: '' });
    }
    res.json(viewInfo(req.user.id));
  });

  r.get('/playlist-view', (req, res) => res.json(viewInfo(req.user.id)));

  // ---- Home hub ----------------------------------------------------------------
  r.get('/home', wrap(async (req, res) => {
    const ctx = activeContext(req);
    res.json(await homeHub.build(req.user.id, ctx, vodContext(req), { recentLimit: 5, forYouLimit: 4 }));
  }));

  r.get('/home/recent', wrap(async (req, res) => {
    const ctx = activeContext(req);
    const limit = Number(req.query.limit) || 80;
    res.json(await homeHub.build(req.user.id, ctx, vodContext(req), { recentLimit: limit, recentOnly: true }));
  }));

  r.get('/home/foryou', wrap(async (req, res) => {
    const ctx = activeContext(req);
    const limit = Number(req.query.limit) || 60;
    res.json(await homeHub.build(req.user.id, ctx, vodContext(req), { forYouLimit: limit, forYouOnly: true }));
  }));

  r.post('/watch', (req, res) => {
    const { playlist, state } = activeContext(req);
    history.seedFromProgress(req.user.id);
    const body = req.body || {};
    let sourceId = String(body.playlist || body.sourcePlaylistId || '');
    let sourceItemId = String(body.itemId || '');
    const kind = String(body.kind || '');
    if ((kind === 'live' || kind === 'catchup') && state && state.byId) {
      const raw = String(body.itemId || '');
      const chId = raw.includes('@') ? raw.slice(0, raw.lastIndexOf('@')) : raw;
      const ch = state.byId.get(chId);
      if (ch && ch._pl) sourceId = sourceId || ch._pl;
      if (ch && ch._src) {
        sourceItemId = kind === 'catchup' && body.start ? `${ch._src}@${body.start}` : ch._src;
      }
    }
    const silent = !String(body.title || '').trim();
    history.record(req.user.id, playlist.id, { ...body, sourcePlaylistId: sourceId, silent });
    if (sourceId && sourceId !== playlist.id) {
      history.record(req.user.id, sourceId, { ...body, itemId: sourceItemId || body.itemId, sourcePlaylistId: sourceId, silent });
    }
    res.json({ ok: true });
  });

  r.get('/bookmarks', (req, res) => {
    const { playlist } = activeContext(req);
    const ids = history.scopeIds(req.user.id, playlist);
    res.json(bookmarks.list(req.user.id, ids).map((row) => ({
      kind: row.kind,
      itemId: row.item_id,
      title: row.title,
      poster: row.poster,
      subtitle: row.subtitle,
    })));
  });

  r.post('/bookmarks', (req, res) => {
    const { playlist } = activeContext(req);
    const row = bookmarks.add(req.user.id, playlist.id, req.body || {});
    if (!row) throw auth.httpError(400, 'Missing bookmark');
    res.json({ ok: true, bookmarked: true });
  });

  r.delete('/bookmarks', (req, res) => {
    const { playlist } = activeContext(req);
    const body = req.body || {};
    const kind = String(body.kind || req.query.kind || '');
    const itemId = String(body.itemId || req.query.itemId || '');
    const ids = history.scopeIds(req.user.id, playlist);
    const removed = bookmarks.remove(req.user.id, ids, kind, itemId);
    res.json({ ok: true, bookmarked: false, removed });
  });

  // ---- Catalog ----------------------------------------------------------------
  r.get('/status', (req, res) => {
    if (!playlists.getActiveRow(req.user.id)) {
      return res.json({ state: 'none', message: 'No playlist configured', progress: 0, playlist: null });
    }
    const { playlist, state } = activeContext(req);
    res.json({
      ...statusPayload(state),
      playlist: { id: playlist.id, name: playlist.name },
      members: memberStatus(state),
    });
  });

  r.get('/groups', (req, res) => {
    const { playlist, state } = activeContext(req);
    const favorites = playlists.favorites(req.user.id, playlist.id);
    groupPrefs.ensureUnusedGroup(req.user.id, playlist.id);
    const prefs = listPrefs(req.user.id, playlist, state);
    res.json({
      status: { ...statusPayload(state), members: memberStatus(state) },
      groups: groupList(state, favorites, prefs),
      prefs: {
        sort: prefs.sort,
        showHidden: prefs.showHidden,
        hiddenCount: prefs.hidden.length,
        hasCustomOrder: prefs.order.length > 0,
      },
    });
  });

  /** Shared context for the search endpoints: visible channels plus cached lookups. */
  function searchContext(req) {
    const userSettings = settings.get(req.user.id);
    const rows = searchScopeRows(req.user.id, req.query.scope);
    if (!rows.length) throw auth.httpError(404, 'No playlist configured');
    for (const row of rows) catalog.ensureLoaded(row, { maxAgeHours: userSettings.epgUpdateHours });
    const playlist = rows.length === 1 ? rows[0] : combined.virtualRow();
    const state = rows.length === 1 ? catalog.getState(rows[0].id) : combined.merge(rows);
    const favorites = playlists.favorites(req.user.id, playlist.id);
    groupPrefs.ensureUnusedGroup(req.user.id, playlist.id);
    const prefs = listPrefs(req.user.id, playlist, state);
    const hidden = new Set(prefs.chShowHidden ? [] : prefs.chHidden);
    const groupNames = new Map(state.groups.map((g) => [g.id, prefs.names[g.id] || g.name]));
    const clients = new Map();
    const toClient = (ch) => {
      let c = clients.get(ch.id);
      if (!c) {
        c = channelToClient(ch, favorites, prefs, state);
        c.playlistId = ch._pl || (rows.length === 1 ? rows[0].id : '');
        c.playlistName = ch.playlistName || (rows.length === 1 ? rows[0].name : '');
        c.srcId = ch._src || ch.id;
        clients.set(ch.id, c);
      }
      return c;
    };
    const vodSources = [];
    for (const row of rows) {
      if (row.type !== 'xtream' && row.type !== 'mag') continue;
      const vodState = catalog.getState(row.id);
      vod.ensureCatalog(row, vodState).catch(() => {});
      vodSources.push({ id: row.id, name: row.name, doc: vod.memoryOrDisk(row.id) });
    }
    const vodDoc = vodSources.find((s) => s.doc && vod.summaryOf(s.doc).hasVod) || vodSources[0] || null;
    return {
      playlist,
      state,
      favorites,
      rows,
      vodDoc: vodDoc && vodDoc.doc,
      vodSources,
      ctx: {
        channels: state.channels.filter((c) => !hidden.has(c.id)),
        groups: groupList(state, favorites, prefs),
        groupName: (ch) => groupNames.get(ch.groupId) || ch.groupName || '',
        toClient,
        programmes: (ch) => programmesOf(state, ch, prefs),
        shiftOf: (ch) => channelShiftMs(playlist, prefs, ch),
        favorites,
        pastHours: userSettings.guidePastHours,
        futureHours: userSettings.guideFutureHours,
        vodSources,
      },
    };
  }

  r.get('/search', wrap(async (req, res) => {
    const { state, ctx, rows } = searchContext(req);
    const allTypes = ['channels', 'shows', 'groups', 'movies', 'series'];
    const asked = String(req.query.types || '').split(',').filter((t) => allTypes.includes(t));
    const types = new Set(asked.length ? asked : allTypes);
    const when = ['all', 'now', 'upcoming', 'past'].includes(req.query.when) ? req.query.when : 'all';
    const q = String(req.query.q || '').slice(0, 200);
    const any = req.query.any === '1';
    if (types.has('movies') || types.has('series')) {
      ctx.vodSources = await vod.enrichMany(rows, q, {
        movies: types.has('movies'),
        series: types.has('series'),
        any,
      });
    }
    const vodSources = ctx.vodSources || [];
    const result = search.search(ctx, {
      q,
      any,
      types,
      when,
      desc: req.query.desc === '1',
      limit: Number(req.query.limit) || 100,
    });
    const hasVod = vodSources.some((s) => s.doc && vod.summaryOf(s.doc).hasVod);
    const vodLoading = vodSources.some((s) => s.doc && s.doc.loading);
    res.json({
      ...result,
      hasGuide: state.epg.size > 0,
      hasVod,
      vodLoading,
      loading: state.status.state === 'loading',
    });
  }));

  /** Search page start screen: recently watched and favorite channels with what is on now. */
  r.get('/search/suggest', (req, res) => {
    const { state, ctx, favorites, vodSources } = searchContext(req);
    const now = Date.now();
    const visible = new Set(ctx.channels.map((c) => c.id));
    const describe = (ch) => ({ ...ctx.toClient(ch), groupName: ctx.groupName(ch), ...search.nowAndNext(ctx.programmes(ch), ctx.shiftOf(ch), now) });
    const recentIds = String(req.query.recent || '').split(',').filter(Boolean).slice(0, 20);
    const recent = recentIds.map((id) => state.byId.get(id)).filter((ch) => ch && visible.has(ch.id)).map(describe);
    const favs = ctx.channels.filter((c) => favorites.has(c.id)).slice(0, 40).map(describe);
    const soon = [];
    for (const ch of favs) {
      if (ch.next && ch.next.start - now <= 60 * 60000) {
        const channel = {
          id: ch.id, name: ch.name, logo: ch.logo, num: ch.num, catchup: ch.catchup, fav: true,
          groupId: ch.groupId, groupName: ch.groupName,
          playlistId: ch.playlistId || '', playlistName: ch.playlistName || '', srcId: ch.srcId || ch.id,
        };
        soon.push({ channel, ...ch.next, live: false, past: false });
      }
    }
    soon.sort((a, b) => a.start - b.start);
    res.json({
      recent,
      favorites: favs,
      startingSoon: soon.slice(0, 12),
      stats: { channels: ctx.channels.length, groups: ctx.groups.length, guideChannels: state.epg.size },
      hasGuide: state.epg.size > 0,
      hasVod: (vodSources || []).some((s) => s.doc && vod.summaryOf(s.doc).hasVod),
    });
  });

  r.put('/groups/prefs', (req, res) => {
    const { playlist } = activeContext(req);
    groupPrefs.updateList(req.user.id, playlist.id, req.body || {});
    res.json({ ok: true });
  });

  r.put('/groups/:id', (req, res) => {
    const { playlist } = activeContext(req);
    groupPrefs.updateGroup(req.user.id, playlist.id, String(req.params.id), req.body || {});
    res.json({ ok: true });
  });

  r.post('/groups', (req, res) => {
    const { playlist, state } = activeContext(req);
    const body = req.body || {};
    let channels = [];
    if (body.copyFrom) {
      const favorites = playlists.favorites(req.user.id, playlist.id);
      const prefs = listPrefs(req.user.id, playlist, state);
      channels = channelsInGroup(state, String(body.copyFrom), favorites, prefs).map((c) => c.id);
    }
    const id = groupPrefs.createCustom(req.user.id, playlist.id, {
      name: body.name,
      channels,
      after: body.copyFrom ? String(body.copyFrom) : (body.after ? String(body.after) : null),
    });
    res.json({ id, count: channels.length });
  });

  r.delete('/groups/:id', (req, res) => {
    const { playlist } = activeContext(req);
    groupPrefs.deleteCustom(req.user.id, playlist.id, String(req.params.id));
    res.json({ ok: true });
  });

  r.put('/groups/:id/channels/:channelId', (req, res) => {
    const { playlist, state } = activeContext(req);
    findChannel(state, req.params.channelId);
    groupPrefs.setCustomChannel(req.user.id, playlist.id, String(req.params.id), String(req.params.channelId), true);
    res.json({ ok: true });
  });

  r.delete('/groups/:id/channels/:channelId', (req, res) => {
    const { playlist, state } = activeContext(req);
    findChannel(state, req.params.channelId);
    groupPrefs.removeCustomChannel(req.user.id, playlist.id, String(req.params.id), String(req.params.channelId));
    res.json({ ok: true });
  });

  r.post('/channels/:channelId/move-group', (req, res) => {
    const { playlist, state } = activeContext(req);
    findChannel(state, req.params.channelId);
    const groupId = String((req.body || {}).groupId || '');
    if (!groupId) throw auth.httpError(400, 'Choose a group');
    groupPrefs.moveCustomChannel(req.user.id, playlist.id, String(req.params.channelId), groupId);
    res.json({ ok: true });
  });

  r.get('/channels/:channelId/groups', (req, res) => {
    const { playlist, state } = activeContext(req);
    findChannel(state, req.params.channelId);
    groupPrefs.ensureUnusedGroup(req.user.id, playlist.id);
    const prefs = listPrefs(req.user.id, playlist, state);
    const groups = groupPrefs.customGroupsForChannel(prefs, String(req.params.channelId))
      .map((c) => ({ id: c.id, name: c.name, system: c.id === groupPrefs.UNUSED_GROUP_ID }));
    res.json({ groups });
  });

  /** A group's channels with the user's channel preferences applied, plus the list preferences. */
  function groupChannels(req) {
    const { playlist, state } = activeContext(req);
    const favorites = playlists.favorites(req.user.id, playlist.id);
    groupPrefs.ensureUnusedGroup(req.user.id, playlist.id);
    const prefs = listPrefs(req.user.id, playlist, state);
    const groupId = String(req.query.group || '');
    const raw = channelsInGroup(state, groupId, favorites, prefs);
    return {
      playlist,
      state,
      favorites,
      prefs,
      channels: groupPrefs.applyChannels(raw, groupId, prefs),
      listPrefs: groupPrefs.channelListInfo(prefs, groupId, raw),
    };
  }

  r.get('/channels', (req, res) => {
    const { playlist, state, favorites, prefs, channels, listPrefs } = groupChannels(req);
    const withNow = req.query.now === '1';
    const now = Date.now();
    res.json({
      channels: channels.map((c) => {
        const client = channelToClient(c, favorites, prefs, state);
        if (!withNow) return client;
        const { now: current } = search.nowAndNext(programmesOf(state, c, prefs), channelShiftMs(playlist, prefs, c), now);
        return { ...client, now: current };
      }),
      prefs: listPrefs,
    });
  });

  r.put('/channel-list/:groupId', (req, res) => {
    const { playlist } = activeContext(req);
    const groupId = req.params.groupId === '__all' ? '' : String(req.params.groupId);
    groupPrefs.updateChannelList(req.user.id, playlist.id, groupId, req.body || {});
    res.json({ ok: true });
  });

  r.get('/channel-icons/:playlistId/:file', (req, res) => {
    try {
      const file = icons.readIcon(req.params.playlistId, req.params.file);
      res.sendFile(file);
    } catch (err) {
      res.status(err.status || 404).end();
    }
  });

  // Proxied channel logos: 2s fetch timeout, disk cache, always an image (default on miss).
  r.get('/logo', wrap(async (req, res) => {
    await icons.serveLogo(req, res);
  }));
  r.get('/logo/default', (req, res) => {
    icons.serveDefaultLogo(req, res);
  });

  r.get('/channels/:id', (req, res) => {
    const { playlist, state } = activeContext(req);
    const channel = findChannel(state, req.params.id);
    const favorites = playlists.favorites(req.user.id, playlist.id);
    const prefs = listPrefs(req.user.id, playlist, state);
    const client = channelToClient(channel, favorites, prefs, state);
    if (req.query.now === '1') {
      const now = Date.now();
      const list = programmesOf(state, channel, prefs);
      const current = list.find((p) => p[0] <= now && p[1] > now);
      client.now = current ? { title: current[2], start: current[0], end: current[1] } : null;
    }
    res.json(client);
  });

  r.put('/channels/:id', wrap(async (req, res) => {
    const { playlist, state } = activeContext(req);
    const channel = findChannel(state, req.params.id);
    const body = { ...(req.body || {}) };
    if (body.imageDataUrl || body.logoUrl) {
      body.logoUrl = await icons.storeChannelIcon(playlist.id, channel.id, {
        dataUrl: body.imageDataUrl,
        url: body.logoUrl,
      });
      delete body.imageDataUrl;
    }
    const prefs = groupPrefs.updateChannel(req.user.id, playlist.id, channel.id, body);
    // A newly assigned XMLTV channel is only in memory if the last guide download kept it.
    const wanted = body.epgId !== undefined && prefs.epgMap[channel.id]
      ? String(prefs.epgMap[channel.id] || '').toLowerCase()
      : '';
    let reloading = false;
    if (wanted && !state.epg.has(wanted)) {
      reloading = true;
      const fetching = state.combined ? combined.ensureEpgForKey(state, wanted) : catalog.ensureEpgForKey(playlist, state, wanted);
      fetching.catch((err) => {
        log.warn(`Guide fetch for ${channel.id} failed`, err);
      });
    }
    res.json({ ok: true, reloading });
  }));

  /** The playlist's guide sources with their load results. */
  function epgSourceList(playlist, state) {
    const loaded = new Map(state.epgSources.map((s) => [s.id, s]));
    const configured = state.combined ? combined.sourcesFor(state) : catalog.epgSourcesFor(playlist, state);
    const list = configured.map((s) => {
      const info = loaded.get(s.id) || {};
      return {
        id: s.id,
        name: s.name,
        url: s.url.replace(/(password|pass|pwd)=[^&]*/gi, '$1=•••'),
        channels: info.channels ?? state.epgList.filter((e) => (e.source || catalog.MAIN_SOURCE) === s.id).length,
        loaded: info.loaded || 0,
        programmes: info.programmes || 0,
        error: info.error || '',
        pending: !loaded.has(s.id) && state.epgSources.length > 0,
      };
    });
    return list;
  }

  /** XMLTV channels with their programme-map keys, optionally from one source. */
  function epgEntries(state, source) {
    if (!state.epgList.length) {
      return [...state.epg.keys()].map((key) => {
        const cut = key.indexOf('::');
        return { key, id: cut >= 0 ? key.slice(cut + 2) : key, name: cut >= 0 ? key.slice(cut + 2) : key, icon: '', source: cut >= 0 ? key.slice(0, cut) : catalog.MAIN_SOURCE };
      }).filter((e) => !source || e.source === source);
    }
    const out = [];
    for (const e of state.epgList) {
      const src = e.source || catalog.MAIN_SOURCE;
      if (source && src !== source) continue;
      out.push({ key: catalog.epgKey(e), id: e.id, name: e.name, icon: e.icon, source: src });
    }
    return out;
  }

  r.get('/epg/sources', (req, res) => {
    const { playlist, state } = activeContext(req);
    res.json({
      sources: epgSourceList(playlist, state),
      hasList: state.epgList.length > 0,
      loading: state.status.state === 'loading',
      fetchedAt: state.epgFetchedAt || null,
    });
  });

  r.get('/epg/search', (req, res) => {
    const { playlist, state } = activeContext(req);
    const prefs = listPrefs(req.user.id, playlist, state);
    const channel = req.query.ch ? findChannel(state, req.query.ch) : null;
    const source = String(req.query.source || '');
    const sourceNames = new Map(epgSourceList(playlist, state).map((s) => [s.id, s.name]));
    const all = epgEntries(state, '');
    const entries = source ? all.filter((e) => e.source === source) : all;
    const byKey = new Map(all.map((e) => [e.key.toLowerCase(), e]));
    const nameOf = (key) => (byKey.get(String(key).toLowerCase()) || {}).name || String(key).replace(/^[^:]*::/, '');
    const sourceOf = (key) => sourceNames.get((byKey.get(String(key).toLowerCase()) || {}).source) || '';
    const shift = epgShiftMs(playlist);
    const now = Date.now();
    const nowTitle = (key) => {
      const p = (state.epg.get(String(key).toLowerCase()) || []).find((x) => x[0] + shift <= now && x[1] + shift > now);
      return p ? p[2] : '';
    };
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 60));
    const { results, total } = searchEpg(entries, String(req.query.q || ''), (key) => state.epg.has(key.toLowerCase()), { offset, limit });
    let current = null;
    if (channel) {
      const override = epgOverride(prefs, channel.id);
      const autoId = channel.epgId || (channel.streamId && state.epg.has(String(channel.streamId)) ? String(channel.streamId) : '');
      current = {
        mode: override === undefined ? 'auto' : override ? 'custom' : 'none',
        id: override || '',
        name: override ? nameOf(override) : '',
        source: override ? sourceOf(override) : '',
        autoId,
        autoName: autoId ? nameOf(autoId) : '',
        autoHasData: catalog.programmesFor(state, channel).length > 0,
        shift: Number(prefs.epgShift[channel.id]) || 0,
        icon: override === undefined
          ? iconForGuideEntries(all, autoId)
          : (override ? iconForGuideEntries(all, override) : ''),
      };
    }
    res.json({
      results: results.map((e) => ({ ...e, sourceName: sourceNames.get(e.source) || e.source, now: e.hasData ? nowTitle(e.key) : '' })),
      current,
      total,
      available: entries.length,
      offset,
      hasList: state.epgList.length > 0,
      loading: state.status.state === 'loading',
    });
  });

  /** Upcoming programmes of one XMLTV channel (by key), for previewing a guide before using it. */
  r.get('/epg/schedule', (req, res) => {
    const { playlist, state } = activeContext(req);
    const key = String(req.query.key || '').toLowerCase();
    const list = state.epg.get(key);
    if (!list) return res.json({ loaded: false, programmes: [] });
    const shift = epgShiftMs(playlist);
    const from = Date.now() - 2 * 3600000;
    const out = [];
    for (const p of list) {
      if (p[1] + shift <= from) continue;
      out.push({ start: p[0] + shift, end: p[1] + shift, title: p[2], desc: p[3] || '' });
      if (out.length >= 12) break;
    }
    res.json({ loaded: true, programmes: out });
  });

  /** One channel's guide row (programmes in the visible window) after an EPG assignment. */
  r.get('/channels/:id/guide', (req, res) => {
    const { playlist, state, favorites, prefs } = groupChannels(req);
    const channel = findChannel(state, req.params.id);
    const from = Number(req.query.start) || Date.now() - 3 * 3600000;
    const to = Number(req.query.end) || from + 24 * 3600000;
    const override = epgOverride(prefs, channel.id);
    const pending = typeof override === 'string' && override !== '' && !state.epg.has(override.toLowerCase());
    loadMagHistory(playlist, state, [channel], from);
    res.json({
      ch: channelToClient(channel, favorites, prefs, state),
      p: shiftedProgrammes(programmesOf(state, channel, prefs), channelShiftMs(playlist, prefs, channel), from, to),
      pending,
    });
  });

  r.get('/guide', (req, res) => {
    const { playlist, state, favorites, prefs, channels, listPrefs } = groupChannels(req);
    const from = Number(req.query.start) || Date.now() - 3 * 3600000;
    const to = Number(req.query.end) || from + 24 * 3600000;
    const rows = channels.map((c) => ({
      ch: channelToClient(c, favorites, prefs, state),
      p: shiftedProgrammes(programmesOf(state, c, prefs), channelShiftMs(playlist, prefs, c), from, to),
    }));
    loadMagHistory(playlist, state, channels.filter((c) => !c.hidden), from);
    res.json({ start: from, end: to, rows, prefs: listPrefs, status: statusPayload(state) });
  });

  /** The channel named by ?ch= with its programmes and EPG shift (user assignment and adjustment applied). */
  function channelGuide(req) {
    const { playlist, state } = activeContext(req);
    const channel = findChannel(state, req.query.ch);
    const prefs = listPrefs(req.user.id, playlist, state);
    return { list: programmesOf(state, channel, prefs), shift: channelShiftMs(playlist, prefs, channel) };
  }

  r.get('/guide/art', wrap(async (req, res) => {
    const title = String(req.query.title || '').trim();
    if (!title || /^(no information|untitled|n\/?a)$/i.test(title)) {
      res.json({ poster: '', backdrop: '', rating: '', plot: '' });
      return;
    }
    const extra = await meta.tvmazeShow(title);
    res.json({
      poster: (extra && (extra.poster || extra.backdrop)) || '',
      backdrop: (extra && (extra.backdrop || extra.poster)) || '',
      rating: extra && extra.rating ? String(extra.rating) : '',
      plot: (extra && extra.plot) || '',
    });
  }));

  r.get('/program', (req, res) => {
    const { list, shift } = channelGuide(req);
    const at = Number(req.query.start);
    const p = list.find((x) => x[0] + shift === at);
    if (!p) throw auth.httpError(404, 'Programme not found');
    res.json({ start: p[0] + shift, end: p[1] + shift, title: p[2], desc: p[3] || '' });
  });

  r.get('/program-at', (req, res) => {
    const { list, shift } = channelGuide(req);
    const at = Number(req.query.t) || Date.now();
    const p = list.find((x) => x[0] + shift <= at && x[1] + shift > at);
    res.json(p ? { start: p[0] + shift, end: p[1] + shift, title: p[2], desc: p[3] || '' } : null);
  });

  r.get('/now', (req, res) => {
    const { list, shift } = channelGuide(req);
    const now = Date.now();
    const idx = list.findIndex((p) => p[0] + shift <= now && p[1] + shift > now);
    const toClient = (p) => (p ? { start: p[0] + shift, end: p[1] + shift, title: p[2], desc: p[3] || '' } : null);
    const next = idx >= 0 ? list[idx + 1] : list.find((p) => p[0] + shift > now);
    res.json({ current: toClient(list[idx]), next: toClient(next) });
  });

  r.post('/favorites/:channelId', (req, res) => {
    const { playlist, state } = activeContext(req);
    findChannel(state, req.params.channelId);
    res.json({ fav: playlists.toggleFavorite(req.user.id, playlist.id, req.params.channelId) });
  });

  // ---- Video on demand -------------------------------------------------------
  /** Movies and shows always come from one playlist: the selected one (also while viewing All playlists). */
  function vodPlaylist(req) {
    const userId = req.user.id;
    const asked = String((req.query && req.query.playlist) || (req.body && req.body.playlist) || '');
    if (asked) {
      const row = playlists.getRow(userId, asked);
      if (row) return { playlist: row, state: catalog.getState(row.id) };
    }
    const rows = playlists.listRows(userId);
    let playlist = playlists.getActiveRow(userId);
    if (!playlist) throw auth.httpError(404, 'No playlist configured');
    const userSettings = settings.get(userId);
    if (combined.isOn(userSettings, rows)) {
      const vodRows = rows.filter((r) => r.type === 'xtream' || r.type === 'mag');
      const ranked = vodRows
        .map((r) => {
          const n = vod.summaryOf(vod.memoryOrDisk(r.id) || {});
          return { r, n: n.movies + n.series };
        })
        .sort((a, b) => b.n - a.n);
      const usable = vodRows.find((r) => catalog.healthOf(catalog.getState(r.id)).state !== 'offline');
      if (ranked[0] && ranked[0].n > 0) playlist = ranked[0].r;
      else if (usable) playlist = usable;
      else if (vodRows.length && playlist.type !== 'xtream' && playlist.type !== 'mag') playlist = vodRows[0];
    }
    return { playlist, state: catalog.getState(playlist.id) };
  }

  function vodNeedsLogin(playlist, state) {
    return playlist.type === 'mag' ? !state.creds : (!state.creds && !state.channels.length);
  }

  function vodContext(req) {
    const { playlist, state } = vodPlaylist(req);
    if (vodNeedsLogin(playlist, state)) catalog.ensureLoaded(playlist, { maxAgeHours: 12 }).catch(() => {});
    return { playlist, state: catalog.getState(playlist.id) };
  }

  async function vodContextReady(req) {
    const { playlist } = vodPlaylist(req);
    let state = catalog.getState(playlist.id);
    if (vodNeedsLogin(playlist, state)) {
      try {
        await catalog.ensureLoaded(playlist, { maxAgeHours: 12 });
      } catch (err) {
        const fail = new Error((err && err.message) || 'Playlist is offline');
        fail.status = 503;
        throw fail;
      }
      state = catalog.getState(playlist.id);
    }
    if (vodNeedsLogin(playlist, state)) {
      const fail = new Error((state.status && state.status.message) || 'Playlist is offline');
      fail.status = 503;
      throw fail;
    }
    return { playlist, state };
  }

  r.get('/vod/summary', wrap(async (req, res) => {
    const { playlist, state } = vodContext(req);
    const supported = vod.supportsVod(playlist);
    if (!supported) {
      res.json({ movies: 0, series: 0, hasVod: false, loading: false, supported: false });
      return;
    }
    let mem = vod.memoryOrDisk(playlist.id);
    // Kick (or retry) catalog load for Xtream/MAG so Movies/Shows tabs appear.
    if (!mem || mem.loading || !vod.summaryOf(mem).hasVod) {
      vod.ensureCatalog(playlist, state).catch(() => {});
      mem = vod.getMemory(playlist.id) || mem;
    }
    const sum = vod.summaryOf(mem || {});
    const connecting = vodNeedsLogin(playlist, state) && state.status.state === 'loading';
    const offline = state.status.state === 'error' && !sum.hasVod;
    res.json({
      ...sum,
      loading: !offline && (!!(mem && mem.loading) || !mem || connecting),
      supported: true,
      error: offline ? (state.status.message || (mem && mem.error) || '') : ((mem && mem.error) || ''),
    });
  }));

  r.get('/vod/:kind', wrap(async (req, res) => {
    const kind = req.params.kind === 'series' ? 'series' : 'movies';
    const { playlist, state } = vodContext(req);
    if (!vod.supportsVod(playlist)) {
      res.json({ categories: [], items: [], loading: false, supported: false });
      return;
    }
    vod.ensureCatalog(playlist, state).catch(() => {});
    const mem = vod.memoryOrDisk(playlist.id);
    const sum = vod.summaryOf(mem || {});
    const connecting = vodNeedsLogin(playlist, state) && (state.status.state === 'loading' || state.status.state === 'idle');
    const catalogLoading = !!(mem && mem.loading);
    const offline = state.status.state === 'error' && !sum.hasVod;
    if (req.query.cat && playlist.type === 'mag' && state.creds && sum.hasVod) {
      const doc = await vod.ensureMagCategory(playlist, state, kind, String(req.query.cat));
      const progress = vod.progressMap(req.user.id, playlist.id);
      res.json({ ...vod.rowsFor(doc, kind, progress), loading: false, supported: true });
      return;
    }
    if (sum.hasVod && mem) {
      const progress = vod.progressMap(req.user.id, playlist.id);
      res.json({ ...vod.rowsFor(mem, kind, progress), loading: catalogLoading, supported: true });
      return;
    }
    if (offline) {
      res.json({
        categories: [],
        items: [],
        loading: false,
        supported: true,
        error: state.status.message || (mem && mem.error) || 'Playlist is offline',
      });
      return;
    }
    if (connecting || catalogLoading || !mem) {
      res.json({ categories: [], items: [], loading: true, supported: true });
      return;
    }
    const doc = await vod.ensureCatalog(playlist, state);
    const progress = vod.progressMap(req.user.id, playlist.id);
    res.json({ ...vod.rowsFor(doc, kind, progress), loading: !!(doc && doc.loading), supported: true, error: doc && doc.error });
  }));

  r.get('/vod/:kind/:id', wrap(async (req, res) => {
    const { playlist, state } = await vodContextReady(req);
    const progress = vod.progressMap(req.user.id, playlist.id);
    const detail = req.params.kind === 'series'
      ? await vod.seriesDetail(playlist, state, req.params.id, progress)
      : await vod.movieDetail(playlist, state, req.params.id, progress);
    if (!detail) throw auth.httpError(404, 'Not found');
    res.json(detail);
  }));

  r.post('/vod/progress', (req, res) => {
    const { playlist } = vodPlaylist(req);
    const body = req.body || {};
    if (!body.itemId) throw auth.httpError(400, 'Missing item');
    vod.saveProgress(req.user.id, playlist.id, body);
    let viewingId = playlist.id;
    try {
      viewingId = activeContext(req).playlist.id;
    } catch {
      viewingId = playlist.id;
    }
    homeHub.watchFromVodProgress(req.user.id, viewingId, playlist.id, body);
    res.json({ ok: true });
  });

  r.get('/play/vod', wrap(async (req, res) => {
    const t0 = Date.now();
    const { playlist, state } = await vodContextReady(req);
    const item = await vod.resolvePlay(playlist, req.user.id, state, req.query.id, {
      resume: req.query.resume !== '0',
      seriesId: req.query.series || '',
    });
    playerDebug.record('vod.play.request', item.title || String(req.query.id || ''), {
      id: req.query.id || '',
      series: req.query.series || '',
      resume: req.query.resume !== '0',
      itemId: item.itemId,
      episodeId: item.episodeId || '',
      seriesId: item.seriesId || '',
      start: item.start || 0,
      duration: item.duration || 0,
      playlistId: playlist.id,
      urlHost: (() => { try { return new URL(item.url).host; } catch { return ''; } })(),
    }, { userId: req.user && req.user.id });
    const headers = mag.streamHeaders(playlist, state.creds);
    const ua = mag.streamUserAgent(playlist);
    let kind = streams.playKind(item.url, playlist.type);
    let probed = null;
    let transcode = false;
    // Cipher: never block play/seek on sequential disk prefetch. libVLC opens the
    // proxied URL and Range-seeks at the provider — waiting for 7.5MB+ made hard seeks
    // take minutes.
    const prefetch = false;
    // MAG play_token links are often single-use — never burn them with ffprobe.
    const skipProbe = playlist.type === 'mag'
      || /play_token=/i.test(item.url)
      || /\/play\//i.test(item.url);
    if (kind !== 'hls') {
      kind = 'file';
      if (!skipProbe) {
        try { probed = ffmpeg.probeCodecs(item.url, { userAgent: ua, headers }); } catch { /* ignore */ }
      }
      playerDebug.record('vod.play.proxy', 'direct (no disk wait)', {
        kind,
        startSec: item.start || 0,
        probed: probed ? { video: probed.video, audio: probed.audio, duration: probed.duration, format: probed.format } : null,
        skipProbe,
        waitMs: Date.now() - t0,
      }, { userId: req.user && req.user.id });
    } else {
      playerDebug.record('vod.play.hls', 'skip disk cache', { kind }, { userId: req.user && req.user.id });
    }
    const duration = Number(item.duration) || (probed && probed.duration) || 0;
    const probedVideo = (probed && probed.video) || '';
    const audioCodec = (probed && probed.audio) || '';
    const videoCodec = probedVideo;
    const remint = item.remint && item.remint.cmd ? {
      portal: (state.creds && (state.creds.portal || state.creds.server)) || playlist.server_url || '',
      mac: (state.creds && state.creds.mac) || playlist.username || '',
      cmd: item.remint.cmd,
      fileId: item.remint.fileId || '',
      series: item.remint.series || '',
      seriesId: item.remint.seriesId || item.seriesId || '',
      episodeId: item.remint.episodeId || item.episodeId || '',
    } : null;
    const payload = {
      title: item.title,
      subtitle: item.subtitle,
      poster: item.poster,
      // Proxy-only signed URL; libVLC opens this (no progressive disk cache).
      urls: [streams.signedUrl(item.url, ua, playlist.id, headers, {
        vod: true,
        transcode: false,
        cache: false,
        remint: playlist.type === 'mag' ? remint : null,
      })],
      kind,
      transcode: false,
      prefetch,
      start: item.start || 0,
      duration,
      itemId: item.itemId,
      seriesId: item.seriesId || '',
      episodeId: item.episodeId || '',
      // So MSE opens hev1/hvc1 for HEVC remuxes instead of an AVC SourceBuffer.
      videoCodec,
      audioCodec,
    };
    playerDebug.record('vod.play.response', payload.title || '', {
      kind: payload.kind,
      transcode: payload.transcode,
      prefetch: payload.prefetch,
      start: payload.start,
      duration: payload.duration,
      itemId: payload.itemId,
      episodeId: payload.episodeId,
      seriesId: payload.seriesId,
      videoCodec,
      audioCodec,
      ms: Date.now() - t0,
      url0: payload.urls[0] ? String(payload.urls[0]).slice(0, 160) : '',
    }, { userId: req.user && req.user.id });
    res.json(payload);
  }));

  /**
   * Leave on-demand: free the IPTV connection (abort unfinished disk downloads + remux pipes).
   * Body: { p, s } from the play URL (preferred), or { playlist } to clear that account.
   */
  r.post('/play/vod/stop', wrap(async (req, res) => {
    const body = req.body || {};
    const data = body.p && body.s ? streams.decodeStreamLink(body.p, body.s) : null;
    let accountKey = (data && data.k) || (body.playlist ? String(body.playlist) : '');
    const streamUrl = (data && data.v && data.u) || '';
    if (!accountKey) {
      try {
        const { playlist } = vodContext(req);
        accountKey = playlist && playlist.id;
      } catch { /* no active VOD playlist */ }
    }
    const stopped = streams.releaseVodPlayback(accountKey, streamUrl);
    playerDebug.record('vod.stop', stopped ? 'aborted' : 'idle', {
      stopped,
      account: accountKey ? String(accountKey).slice(0, 12) : '',
      hadLink: !!(data && data.u),
    }, { userId: req.user && req.user.id });
    res.json({ ok: true, stopped });
  }));

  r.get('/play/live', wrap(async (req, res) => {
    const t0 = Date.now();
    const ch = String(req.query.ch || '');
    playerDebug.record('play.live.request', ch || '(missing)', { ch });
    const { playlist, state } = activeContext(req);
    const channel = findChannel(state, ch);
    const source = combined.resolve(playlist, state, channel);
    // Drop any live proxy + VOD/catch-up download holding this account before minting a new URL.
    streams.releaseAccount(source.playlist.id);
    const url = source.playlist.type === 'mag' && source.state.creds
      ? await mag.liveUrl(source.state.creds, source.channel, { userAgent: mag.streamUserAgent(source.playlist) })
      : source.channel.url;
    const payload = {
      channel: channelToClient(channel, playlists.favorites(req.user.id, playlist.id), listPrefs(req.user.id, playlist, state), state),
      urls: [magSign(source, url)],
      kind: streams.streamKind(url),
    };
    playerDebug.record('play.live.ok', channel.name || ch, {
      ch,
      kind: payload.kind,
      ms: Date.now() - t0,
      playlistId: source.playlist.id,
    });
    res.json(payload);
  }));

  r.get('/play/catchup', wrap(async (req, res) => {
    const { playlist, state } = activeContext(req);
    const channel = findChannel(state, req.query.ch);
    const source = combined.resolve(playlist, state, channel);
    const start = Number(req.query.start);
    const end = Number(req.query.end) || start + 3600000;
    if (!Number.isFinite(start)) throw auth.httpError(400, 'Missing start time');
    if (start > Date.now()) throw auth.httpError(400, 'That programme has not aired yet');
    const days = channel.catchupDays || 7;
    if (start < Date.now() - days * 24 * 3600000) throw auth.httpError(400, `Catch-up only goes back ${days} days on this channel`);
    let urls;
    if (source.playlist.type === 'mag' && source.state.creds && !source.channel.catchupSource) {
      const shiftMs = Math.round((Number(source.playlist.catchup_shift_hours) || 0) * 3600000);
      urls = supportsCatchup(source.channel)
        ? await mag.archiveUrls(source.state.creds, source.channel, start + shiftMs, end + shiftMs, { userAgent: mag.streamUserAgent(source.playlist) })
        : [];
    } else {
      // Native Xtream, or M3U with stored/discovered Xtream login + streamId for timeshift.
      const stored = playlists.xtreamCredsFromPlaylist(source.playlist);
      const creds = source.state.creds || stored;
      const canTimeshift = !!(creds && (source.playlist.type === 'xtream' || source.channel.streamId));
      urls = buildCatchupUrls(source.playlist, canTimeshift ? creds : null, source.channel, start, end);
    }
    if (!urls.length) throw auth.httpError(400, 'Catch-up is not available for this channel');
    const pl = source.playlist;
    // Free live/VOD downloads so the single IPTV connection can open timeshift immediately.
    // Do not prefetch catch-up to disk — sequential cache + remount-from-0 made hard seeks
    // wait ~2–3 minutes for buffered lead. libVLC opens the proxied timeshift URL directly.
    streams.releaseAccount(pl.id);
    streams.stopCatchupCaches();
    playerDebug.record('play.catchup.proxy', 'direct timeshift (no disk wait)', {
      ch: channel.id,
      start,
      end,
      urls: urls.length,
    }, { userId: req.user && req.user.id });
    res.json({
      channel: channelToClient(channel, playlists.favorites(req.user.id, playlist.id), listPrefs(req.user.id, playlist, state), state),
      urls: urls.map((u) => magSign(source, u, {
        vod: true,
        cache: false,
        catchup: false,
      })),
      kind: streams.streamKind(urls[0]),
      start,
      end,
      prefetch: false,
      prefetchError: '',
      duration: Math.max(60, Math.round((end - start) / 1000)),
    });
  }));

  r.use((err, _req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) require('./log').error('API error', err);
    res.status(status).json({ error: err.message || 'Server error' });
  });

  return r;
}

module.exports = { createRouter };
