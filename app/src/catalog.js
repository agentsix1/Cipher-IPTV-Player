'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const log = require('./log');
const { getText } = require('./http');
const { parseM3u, slug } = require('./m3u');
const xtream = require('./xtream');
const mag = require('./mag');
const { loadXmltv } = require('./xmltv');

const { epgSourcesOf, persistM3uXtreamCreds, xtreamCredsFromPlaylist } = require('./playlists');

const DAY = 24 * 3600 * 1000;
const MAIN_SOURCE = 'main';
const EPG_KEEP_PAST_MS = 8 * DAY;
const EPG_KEEP_FUTURE_MS = 10 * DAY;
const EPG_PARALLEL_DOWNLOADS = 4;
const EPG_RETRY_MS = 5 * 60 * 1000;
// A playlist link that failed (bad URL, web page, server down) is retried at most this often on its own.
const CHANNELS_RETRY_MS = 2 * 60 * 1000;
const MAG_EPG_PERIOD_HOURS = 96;
const MAG_DEEP_CONCURRENCY = 4;
const MAG_DEEP_MAX_CHANNELS = 400;
const MAG_HISTORY_CONCURRENCY = 3;
const MAG_HISTORY_MAX_CHANNELS = 40;

/** playlistId -> in-memory catalog state */
const states = new Map();

/** playlistId -> Set of extra XMLTV ids (lower-case) to keep, e.g. user EPG assignments. */
let extraEpgIds = () => new Set();

function setExtraEpgIds(fn) {
  extraEpgIds = fn;
}

function cacheDir(playlistId) {
  return path.join(config.dataDir, 'cache', playlistId.replace(/[^\w-]/g, ''));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function newState(playlistId) {
  return {
    playlistId,
    status: { state: 'idle', message: '', progress: 0 },
    channels: [],
    groups: [],
    byId: new Map(),
    creds: null,
    streamBase: '',
    m3uEpgUrl: '',
    m3uEpgUrls: [],
    epg: new Map(),
    epgList: [],
    epgSources: [],
    epgFetchedAt: 0,
    channelsFetchedAt: 0,
    channelsFailedAt: 0,
    loading: null,
  };
}

function getState(playlistId) {
  let state = states.get(playlistId);
  if (!state) {
    state = newState(playlistId);
    states.set(playlistId, state);
    loadFromCache(state);
  }
  return state;
}

function friendlyNetworkError(err) {
  const msg = String((err && err.message) || err || '');
  if (/timed out|timeout/i.test(msg)) return 'The playlist server did not respond. It may be offline.';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return 'Could not find the playlist server. Check the URL or your internet connection.';
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|socket hang up/i.test(msg)) {
    return 'The playlist server is unreachable. It may be offline.';
  }
  return msg || 'Playlist failed to load';
}

/** Snapshot used by the UI so one dead playlist cannot hide the rest of the app. */
function healthOf(state) {
  const channels = (state && state.channels && state.channels.length) || 0;
  const st = (state && state.status && state.status.state) || 'idle';
  const message = (state && state.status && state.status.message) || '';
  if (st === 'error' && !channels) return { state: 'offline', message, channels };
  if (st === 'loading' && !channels) return { state: 'loading', message, channels };
  if (!channels && st === 'idle') return { state: 'idle', message, channels };
  return { state: 'ready', message, channels, stale: st === 'error' };
}

function withDeadline(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function setChannels(state, channels, groups) {
  state.channels = channels;
  state.groups = groups;
  state.byId = new Map(channels.map((c) => [c.id, c]));
}

function loadFromCache(state) {
  const dir = cacheDir(state.playlistId);
  const channels = readJson(path.join(dir, 'channels.json'));
  if (channels && Array.isArray(channels.channels)) {
    setChannels(state, channels.channels, channels.groups || []);
    state.channelsFetchedAt = channels.fetchedAt || 0;
    state.creds = channels.creds || null;
    state.streamBase = channels.streamBase || '';
    state.m3uEpgUrl = channels.m3uEpgUrl || '';
    state.m3uEpgUrls = Array.isArray(channels.m3uEpgUrls) ? channels.m3uEpgUrls : (state.m3uEpgUrl ? [state.m3uEpgUrl] : []);
    state.status = { state: 'ready', message: '', progress: 1 };
  }
  const epg = readJson(path.join(dir, 'epg.json'));
  if (epg && epg.channels) {
    state.epg = new Map(Object.entries(epg.channels));
    state.epgList = Array.isArray(epg.list) ? epg.list : [];
    state.epgSources = Array.isArray(epg.sources) ? epg.sources : [];
    state.epgFetchedAt = epg.fetchedAt || 0;
  }
  if (channels) log.info(`Catalog cache loaded for ${state.playlistId}: ${state.channels.length} channels, ${state.epg.size} EPG channels`);
}

function hashId(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}

function m3uCatchup(attrs) {
  const mode = (attrs.catchup || attrs['catchup-type'] || '').toLowerCase();
  const days = Number(attrs['catchup-days'] || attrs.timeshift || attrs['tvg-rec']) || 0;
  return {
    catchup: (!!mode && mode !== 'disabled') || days > 0,
    catchupDays: days,
    catchupSource: attrs['catchup-source'] || '',
  };
}

/**
 * When an M3U is really an Xtream Codes export (get.php or /live/user/pass/id.ts),
 * login via player_api and patch catch-up / streamId onto the M3U channel rows.
 * Stores server + username + password on the playlist for fast timeshift later.
 * Keeps playlist type as m3u — names, groups, and stream URLs stay from the file.
 */
async function enrichM3uFromXtream(playlist, channels) {
  // Prefer login already saved on the playlist; else mine it from the M3U stream lines.
  let creds = xtreamCredsFromPlaylist(playlist)
    || xtream.guessCredentialsFromM3u(playlist.m3u_url, channels.map((c) => c.url));
  if (!creds) return null;

  // Always stamp stream ids from Xtream-shaped URLs so timeshift can target them.
  for (const ch of channels) {
    const sid = xtream.streamIdFromUrl(ch.url);
    if (sid) ch.streamId = sid;
  }

  const opts = { userAgent: playlist.user_agent, timeoutMs: 60000 };
  log.info(`Xtream enrich for M3U '${playlist.name}': trying ${creds.server} as ${creds.username}`);
  const account = await xtream.getAccount(creds, opts);
  const streamBase = xtream.resolveStreamBase(creds, account.server_info);
  const archive = await xtream.loadArchiveInfo(creds, { userAgent: playlist.user_agent });
  let matched = 0;
  let withCatchup = 0;
  for (const ch of channels) {
    const sid = ch.streamId || xtream.streamIdFromUrl(ch.url);
    const info = (sid && archive.byStreamId.get(sid))
      || (ch.epgId && archive.byEpgId.get(String(ch.epgId).toLowerCase()))
      || null;
    if (!info) {
      // Still keep streamId from the URL so timeshift can be attempted later.
      continue;
    }
    matched += 1;
    ch.streamId = info.streamId || sid || ch.streamId;
    if (info.catchup) {
      ch.catchup = true;
      ch.catchupDays = Math.max(Number(ch.catchupDays) || 0, Number(info.catchupDays) || 0);
      withCatchup += 1;
    }
    if (!ch.logo && info.logo) ch.logo = info.logo;
    if (!ch.epgId && info.epgId) ch.epgId = info.epgId;
  }
  // Durable store: playlist row holds host/user/pass for catch-up without re-detecting.
  const saved = { ...creds, server: streamBase || creds.server };
  if (persistM3uXtreamCreds(playlist, saved, streamBase)) {
    log.info(`Stored Xtream login on M3U '${playlist.name}' → ${streamBase || creds.server} (${creds.username})`);
  }
  log.info(`Xtream enrich for M3U '${playlist.name}': matched ${matched}/${channels.length} channels, ${withCatchup} with catch-up`);
  return {
    creds: { ...saved, streamBase },
    streamBase,
  };
}

async function loadM3uChannels(playlist) {
  const text = await getText(playlist.m3u_url, { userAgent: playlist.user_agent, timeoutMs: 45000 });
  const parsed = parseM3u(text);
  if (!parsed.entries.length) {
    if (/^\s*(<!doctype\s+html|<html|<head|<body)/i.test(text.slice(0, 2000))) {
      throw new Error('That link returned a web page, not an M3U playlist. Check the playlist URL.');
    }
    if (/^\s*[[{]/.test(text.slice(0, 200))) {
      throw new Error('That link returned JSON, not an M3U playlist. For an Xtream Codes login, choose the Xtream type.');
    }
    throw new Error('No channels found at that link. Check the playlist URL.');
  }
  const groupOrder = new Map();
  const channels = [];
  const seen = new Set();

  parsed.entries.forEach((entry, index) => {
    let id = `u${hashId(entry.url)}`;
    if (seen.has(id)) id = `${id}_${index}`;
    seen.add(id);
    const groupName = entry.group || 'Uncategorized';
    const groupId = slug(groupName);
    if (!groupOrder.has(groupId)) groupOrder.set(groupId, { id: groupId, name: groupName, order: groupOrder.size });
    channels.push({
      id,
      name: entry.name,
      logo: entry.attrs['tvg-logo'] || '',
      groupId,
      groupName,
      num: Number(entry.attrs['tvg-chno']) || channels.length + 1,
      epgId: entry.attrs['tvg-id'] || '',
      streamId: 0,
      url: entry.url,
      ...m3uCatchup(entry.attrs),
    });
  });

  const m3uEpgUrls = parsed.epgUrls || (parsed.epgUrl ? [parsed.epgUrl] : []);
  let creds = null;
  let streamBase = '';
  try {
    const enriched = await enrichM3uFromXtream(playlist, channels);
    if (enriched) {
      creds = enriched.creds;
      streamBase = enriched.streamBase || '';
    }
  } catch (err) {
    log.warn(`Xtream enrich from M3U '${playlist.name}' failed; keeping plain M3U`, err);
  }

  return {
    channels,
    groups: [...groupOrder.values()],
    creds,
    streamBase,
    m3uEpgUrl: m3uEpgUrls[0] || '',
    m3uEpgUrls,
  };
}

async function loadXtreamChannels(playlist) {
  const creds = { server: playlist.server_url, username: playlist.username, password: playlist.password };
  const result = await withDeadline(
    xtream.loadLive(creds, { userAgent: playlist.user_agent, streamFormat: playlist.stream_format }),
    45000,
    `Xtream login for '${playlist.name}' timed out`,
  );
  return { channels: result.channels, groups: result.groups, creds, streamBase: result.streamBase, m3uEpgUrl: '', m3uEpgUrls: [] };
}

async function loadMagChannels(playlist) {
  const opts = { userAgent: playlist.user_agent, deadlineMs: 25000, timeoutMs: 90000 };
  const creds = await withDeadline(
    mag.connect({ portal: playlist.server_url, mac: playlist.username }, opts),
    28000,
    `MAG portal for '${playlist.name}' timed out`,
  );
  const result = await withDeadline(
    mag.loadLive(creds, opts),
    100000,
    `MAG channels for '${playlist.name}' timed out`,
  );
  return { channels: result.channels, groups: result.groups, creds, streamBase: '', m3uEpgUrl: '', m3uEpgUrls: [] };
}

const CHANNEL_LOADERS = { xtream: loadXtreamChannels, mag: loadMagChannels };

function m3uGuideUrls(state) {
  if (Array.isArray(state.m3uEpgUrls) && state.m3uEpgUrls.length) return state.m3uEpgUrls;
  return state.m3uEpgUrl ? [state.m3uEpgUrl] : [];
}

function epgUrlFor(playlist, state) {
  if (playlist.type === 'xtream') {
    if (playlist.use_provider_epg && state.creds) return xtream.providerEpgUrl(state.creds);
    return playlist.epg_url || (state.creds ? xtream.providerEpgUrl(state.creds) : '');
  }
  return playlist.epg_url || m3uGuideUrls(state)[0] || '';
}

async function refreshChannels(playlist, state) {
  const keepUi = state.channels.length > 0;
  state.status = keepUi
    ? { state: 'ready', message: `Refreshing ${playlist.name}…`, progress: 1 }
    : { state: 'loading', message: `Loading ${playlist.name}…`, progress: 0.05 };
  const result = await (CHANNEL_LOADERS[playlist.type] || loadM3uChannels)(playlist);
  setChannels(state, result.channels, result.groups);
  state.creds = result.creds ? { ...result.creds, streamBase: result.streamBase } : null;
  state.streamBase = result.streamBase;
  state.m3uEpgUrl = result.m3uEpgUrl;
  state.m3uEpgUrls = result.m3uEpgUrls || (result.m3uEpgUrl ? [result.m3uEpgUrl] : []);
  state.channelsFetchedAt = Date.now();
  writeJson(path.join(cacheDir(state.playlistId), 'channels.json'), {
    fetchedAt: state.channelsFetchedAt,
    channels: state.channels,
    groups: state.groups,
    creds: state.creds,
    streamBase: state.streamBase,
    m3uEpgUrl: state.m3uEpgUrl,
    m3uEpgUrls: state.m3uEpgUrls,
  });
  log.info(`Channels loaded for '${playlist.name}': ${state.channels.length} channels, ${state.groups.length} groups`);
}

/**
 * The guide sources of a playlist. 'main' is the playlist's own guide (its programme keys are plain
 * XMLTV ids, as assignments made before extra sources existed expect). Every other source's keys are
 * prefixed with `<sourceId>::` so the same XMLTV id in two sources never collides.
 */
function epgSourcesFor(playlist, state) {
  const out = [];
  const used = new Set();
  const push = (id, name, url) => {
    if (!url || used.has(url)) return;
    used.add(url);
    out.push({ id, name, url });
  };
  if (playlist.type === 'xtream') {
    const main = epgUrlFor(playlist, state);
    const provider = state.creds ? xtream.providerEpgUrl(state.creds) : '';
    if (main) {
      const name = main === provider ? 'Provider guide' : main === playlist.epg_url ? 'EPG URL' : 'Playlist guide';
      push(MAIN_SOURCE, name, main);
    }
    if (playlist.epg_url && playlist.epg_url !== main) push('custom', 'EPG URL', playlist.epg_url);
  } else if (playlist.type === 'mag') {
    // The portal's own guide is fetched through its API, not as an XMLTV file.
    if (playlist.use_provider_epg || !playlist.epg_url) {
      const endpoint = (state.creds && state.creds.endpoint) || playlist.server_url;
      const url = `${endpoint}?type=itv&action=get_epg_info&period=${MAG_EPG_PERIOD_HOURS}`;
      used.add(url);
      out.push({ id: MAIN_SOURCE, name: 'Portal guide', url, portal: true });
    }
    if (playlist.epg_url) push(out.length ? 'custom' : MAIN_SOURCE, 'EPG URL', playlist.epg_url);
  } else {
    if (playlist.epg_url) push(MAIN_SOURCE, 'EPG URL', playlist.epg_url);
    m3uGuideUrls(state).forEach((url, index) => {
      push(out.length ? `playlist${index}` : MAIN_SOURCE, 'Playlist guide', url);
    });
    // M3U enriched from Xtream: add provider XMLTV when the file has little/no guide.
    if (state.creds && state.creds.username && state.creds.password) {
      const provider = xtream.providerEpgUrl(state.creds);
      push(out.length ? 'provider' : MAIN_SOURCE, 'Provider guide', provider);
    }
  }
  for (const s of epgSourcesOf(playlist)) {
    if (!s.enabled || used.has(s.url)) continue;
    used.add(s.url);
    out.push({ id: String(s.id).toLowerCase(), name: s.name, url: s.url });
  }
  return out;
}

const keyPrefix = (sourceId) => (sourceId === MAIN_SOURCE ? '' : `${sourceId}::`);

/** Programme-map key of an XMLTV channel listed by a source ({ id, source }). */
function epgKey(entry) {
  return `${keyPrefix(entry.source || MAIN_SOURCE)}${entry.id}`;
}

async function refreshEpg(playlist, state) {
  const sources = epgSourcesFor(playlist, state);
  if (!sources.length) {
    log.info(`No EPG source for '${playlist.name}'`);
    state.epgSources = [];
    state.epgFetchedAt = Date.now();
    return;
  }
  const channelIds = new Set();
  const streamIds = new Set();
  for (const c of state.channels) {
    if (c.epgId) channelIds.add(c.epgId.toLowerCase());
    if (c.streamId) streamIds.add(String(c.streamId));
  }
  let assigned = new Set();
  try {
    assigned = extraEpgIds(state.playlistId);
  } catch (err) {
    log.warn('Could not read EPG assignments', err);
  }

  const now = Date.now();
  const programmes = new Map();
  const list = [];
  const meta = [];
  let total = 0;
  let failures = 0;
  let lastError = null;
  // Several guides download at once (the epgshare01 set alone is ~100 files); results are merged
  // in source order afterwards so the main guide still wins lookups.
  const fractions = new Array(sources.length).fill(0);
  let finished = 0;
  let programmeCount = 0;
  const showProgress = () => {
    const done = fractions.reduce((a, b) => a + b, 0);
    const step = sources.length > 1 ? `(${finished}/${sources.length}) ` : '';
    const keepUi = state.channels.length > 0;
    state.status = {
      state: keepUi ? 'ready' : 'loading',
      message: `Loading TV guide${sources.length > 1 ? 's' : ''} ${step}... ${programmeCount.toLocaleString()} programmes`,
      progress: 0.25 + (done / sources.length) * 0.7,
    };
  };
  const results = new Array(sources.length);
  async function loadSource(i) {
    const src = sources[i];
    const prefix = keyPrefix(src.id);
    const wantedIds = new Set(channelIds);
    if (!prefix) for (const id of streamIds) wantedIds.add(id);
    for (const key of assigned) {
      if (prefix ? key.startsWith(prefix) : !key.includes('::')) wantedIds.add(key.slice(prefix.length));
    }
    let lastCount = 0;
    try {
      results[i] = {
        result: src.portal ? await loadPortalGuide(playlist, state) : await loadXmltv(src.url, {
          wantedIds,
          fromMs: now - EPG_KEEP_PAST_MS,
          toMs: now + EPG_KEEP_FUTURE_MS,
          userAgent: playlist.user_agent,
          onProgress: ({ received, total: size, count: n }) => {
            fractions[i] = size ? Math.min(1, received / size) : Math.min(0.95, received / (80 * 1024 * 1024));
            programmeCount += n - lastCount;
            lastCount = n;
            showProgress();
          },
        }),
      };
    } catch (err) {
      results[i] = { err };
    }
    fractions[i] = 1;
    finished += 1;
    showProgress();
  }
  let next = 0;
  const worker = async () => {
    while (next < sources.length) await loadSource(next++);
  };
  showProgress();
  await Promise.all(Array.from({ length: Math.min(EPG_PARALLEL_DOWNLOADS, sources.length) }, worker));

  for (const [i, src] of sources.entries()) {
    const prefix = keyPrefix(src.id);
    const { result, err } = results[i];
    if (result) {
      for (const [id, progs] of result.programmes) programmes.set(prefix + id, progs);
      for (const c of result.channels) list.push({ ...c, source: src.id });
      total += result.count;
      meta.push({ ...src, channels: result.channels.length, loaded: result.programmes.size, programmes: result.count, error: '', fetchedAt: Date.now() });
    } else {
      // Keep what this source had last time rather than blanking its channels.
      failures += 1;
      lastError = err;
      log.warn(`EPG source '${src.name}' failed for '${playlist.name}'`, err);
      for (const [key, progs] of state.epg) {
        if (prefix ? key.startsWith(prefix) : !key.includes('::')) programmes.set(key, progs);
      }
      const old = state.epgList.filter((e) => (e.source || MAIN_SOURCE) === src.id);
      list.push(...old);
      const before = (state.epgSources || []).find((s) => s.id === src.id);
      meta.push({ ...src, channels: old.length, loaded: before ? before.loaded : 0, programmes: before ? before.programmes : 0, error: err.message });
    }
  }
  if (failures === sources.length) {
    log.warn(`Every guide source failed for '${playlist.name}'. Channels stay loaded.`, lastError);
  }

  state.epg = programmes;
  state.epgList = list;
  state.epgSources = meta;
  state.epgFetchedAt = Date.now();
  persistEpgCache(state);
  log.info(`EPG loaded for '${playlist.name}': ${total} programmes across ${programmes.size} channels from ${sources.length} source(s)`);
}

function persistEpgCache(state) {
  if (states.get(state.playlistId) !== state) return;
  writeJson(path.join(cacheDir(state.playlistId), 'epg.json'), {
    fetchedAt: state.epgFetchedAt,
    channels: Object.fromEntries(state.epg),
    list: state.epgList,
    sources: state.epgSources,
  });
}

/** Marks guide data as changed without counting as a full guide download (combined view rebuilds on it). */
function touchEpg(state) {
  state.epgVersion = (state.epgVersion || 0) + 1;
}

/**
 * A MAG portal's bulk guide (the next programmes of every channel). Deeper data already held for a
 * channel (earlier days, the per-channel fill) is kept and merged with the fresh programmes.
 */
async function loadPortalGuide(playlist, state) {
  if (!state.creds) throw new Error('The portal login is not loaded yet');
  const { programmes } = await mag.loadEpg(state.creds, { period: MAG_EPG_PERIOD_HOURS, userAgent: playlist.user_agent });
  const oldest = Date.now() - EPG_KEEP_PAST_MS;
  const channels = [];
  const listed = new Set();
  let count = 0;
  for (const c of state.channels) {
    const key = String(c.streamId || '');
    if (!key || listed.has(key)) continue;
    const kept = (state.epg.get(key) || []).filter((p) => p[1] > oldest);
    const list = kept.length ? mag.mergeProgrammes(kept, programmes.get(key)) : programmes.get(key);
    if (!list || !list.length) continue;
    programmes.set(key, list);
    listed.add(key);
    channels.push({ id: key, name: c.name, icon: c.logo || '' });
  }
  for (const list of programmes.values()) count += list.length;
  return { programmes, channels, count };
}

/**
 * The bulk portal guide only covers the next few programmes. This fetches several days per channel in
 * the background (catch-up channels first) and merges them in, without blocking the app.
 */
function startMagDeepFill(playlist, state) {
  if (playlist.type !== 'mag' || !state.creds || state.deepFill) return;
  const ids = [];
  const seen = new Set();
  // Only catch-up channels need several days of programmes for archive playback.
  for (const c of state.channels) {
    if (!c.catchup) continue;
    const key = String(c.streamId || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    ids.push(key);
    if (ids.length >= MAG_DEEP_MAX_CHANNELS) break;
  }
  if (!ids.length) return;
  const started = Date.now();
  let done = 0;
  state.deepFill = mag.mapLimit(ids, MAG_DEEP_CONCURRENCY, async (key) => {
    if (states.get(state.playlistId) !== state) return;
    try {
      const deep = await mag.loadChannelEpg(state.creds, key, { userAgent: playlist.user_agent });
      if (deep.length) state.epg.set(key, mag.mergeProgrammes(deep, state.epg.get(key)));
    } catch (err) {
      if (done === 0) log.warn(`Guide fill for channel ${key} failed`, err);
    }
    done += 1;
    if (done % 250 === 0) {
      touchEpg(state);
      persistEpgCache(state);
    }
  }).then(() => {
    touchEpg(state);
    const meta = state.epgSources.find((s) => s.id === MAIN_SOURCE);
    if (meta) meta.programmes = [...state.epg.entries()].reduce((sum, [k, list]) => sum + (k.includes('::') ? 0 : list.length), 0);
    persistEpgCache(state);
    log.info(`Portal guide filled for '${playlist.name}': ${done} channels in ${Math.round((Date.now() - started) / 1000)}s`);
  }).finally(() => {
    state.deepFill = null;
  });
}

/**
 * Loads earlier guide days of MAG catch-up channels when a guide view reaches back past the data held
 * (needed to pick archived programmes). Runs in the background; later guide requests show the result.
 */
function ensureMagHistory(playlist, state, channels, fromMs) {
  if (!playlist || playlist.type !== 'mag' || !state.creds) return;
  const now = Date.now();
  state.historyDone = state.historyDone || new Set();
  state.historyQueue = state.historyQueue || [];
  let considered = 0;
  for (const c of channels) {
    if (!c.catchup || !c.streamId) continue;
    if (++considered > MAG_HISTORY_MAX_CHANNELS) break;
    const key = String(c.streamId);
    const oldest = Math.max(fromMs, now - (c.catchupHours || c.catchupDays * 24 || 72) * 3600000);
    const list = state.epg.get(key) || [];
    const covered = list.length ? list[0][0] : now;
    if (covered <= oldest + 30 * 60000) continue;
    const dates = new Set([mag.portalDate(covered, state.creds.timezone)]);
    for (let t = oldest; t < covered; t += 86400000) dates.add(mag.portalDate(t, state.creds.timezone));
    for (const date of dates) {
      const tag = `${key}|${date}`;
      if (state.historyDone.has(tag)) continue;
      state.historyDone.add(tag);
      state.historyQueue.push({ key, date, tag });
    }
  }
  if (state.historyRunning || !state.historyQueue.length) return;
  state.historyRunning = true;
  const worker = async () => {
    while (state.historyQueue.length && states.get(state.playlistId) === state) {
      const job = state.historyQueue.shift();
      try {
        const rows = await mag.loadDayTable(state.creds, job.key, job.date, { userAgent: playlist.user_agent });
        const progs = rows.map(mag.toProgramme).filter(Boolean);
        if (progs.length) state.epg.set(job.key, mag.mergeProgrammes(state.epg.get(job.key) || [], progs));
      } catch (err) {
        state.historyDone.delete(job.tag);
        log.warn(`Guide history ${job.tag} failed`, err);
      }
    }
  };
  Promise.all(Array.from({ length: MAG_HISTORY_CONCURRENCY }, worker)).finally(() => {
    state.historyRunning = false;
    touchEpg(state);
    persistEpgCache(state);
  });
}

/**
 * Fetches guide data for one assigned XMLTV id and merges it into the cached guide (no full re-download).
 * Returns true when a download was started.
 */
async function ensureEpgForKey(playlist, state, fullKey) {
  const key = String(fullKey || '').toLowerCase();
  if (!key || state.epg.has(key)) return false;
  let sourceId = MAIN_SOURCE;
  let xmlId = key;
  const sep = key.indexOf('::');
  if (sep >= 0) {
    sourceId = key.slice(0, sep);
    xmlId = key.slice(sep + 2);
  }
  const src = epgSourcesFor(playlist, state).find((s) => s.id === sourceId);
  if (!src || src.portal) return false;
  const prefix = keyPrefix(sourceId);
  const now = Date.now();
  const prev = state.status;
  state.status = { state: 'loading', message: 'Loading guide for this channel…', progress: 0.4 };
  try {
    const result = await loadXmltv(src.url, {
      wantedIds: new Set([xmlId]),
      fromMs: now - EPG_KEEP_PAST_MS,
      toMs: now + EPG_KEEP_FUTURE_MS,
      userAgent: playlist.user_agent,
    });
    for (const [id, progs] of result.programmes) state.epg.set(prefix + id, progs);
    if (!state.epg.has(key)) state.epg.set(key, []);
    const have = new Set(state.epgList.filter((e) => (e.source || MAIN_SOURCE) === sourceId).map((e) => e.id.toLowerCase()));
    for (const c of result.channels) {
      if (!have.has(String(c.id).toLowerCase())) state.epgList.push({ ...c, source: sourceId });
    }
    const meta = state.epgSources.find((s) => s.id === sourceId);
    if (meta) {
      meta.loaded = (meta.loaded || 0) + result.programmes.size;
      meta.programmes = (meta.programmes || 0) + result.count;
      meta.error = '';
    }
    state.epgFetchedAt = Date.now();
    persistEpgCache(state);
    log.info(`EPG merged for '${playlist.name}': ${key} (+${result.count} programmes)`);
    return true;
  } catch (err) {
    if (!state.epg.has(key)) state.epg.set(key, []);
    log.warn(`Could not load guide for ${key}`, err);
    throw err;
  } finally {
    state.status = prev.state === 'loading' ? { state: 'ready', message: '', progress: 1 } : prev;
  }
}

/** Reloads only the guide, after any load already running (e.g. EPG sources were edited). */
function reloadEpg(playlist) {
  return ensureLoaded(playlist, { epgOnly: true, force: true });
}

/**
 * Makes sure channels and EPG are loaded for a playlist. Reloads anything missing or older
 * than `maxAgeHours`. Concurrent callers share one load, except explicit reloads (refresh, edited
 * playlist): the running load was started with the old playlist row, so they run again afterwards
 * with the newest row. Several queued reloads collapse into one.
 */
function ensureLoaded(playlist, opts = {}) {
  const state = getState(playlist.id);
  if (!state.loading) return startLoad(playlist, state, opts);
  if (!opts.force && !opts.epgOnly) return state.loading;
  const q = state.queued;
  if (q) {
    const force = q.opts.force || !!opts.force;
    q.playlist = playlist;
    q.opts = { force, epgOnly: !force && !opts.channelsOnly, channelsOnly: !!opts.channelsOnly && !force };
    return q.promise;
  }
  const queued = { playlist, opts: { force: !!opts.force, epgOnly: !opts.force && !opts.channelsOnly, channelsOnly: !!opts.channelsOnly && !opts.force } };
  queued.promise = state.loading.then(() => {
    state.queued = null;
    return startLoad(queued.playlist, state, queued.opts);
  });
  state.queued = queued;
  return queued.promise;
}

function startLoad(playlist, state, { force = false, maxAgeHours = 12, epgOnly = false, channelsOnly = false } = {}) {

  const maxAge = Math.max(1, maxAgeHours) * 3600 * 1000;
  const now = Date.now();
  // Status polls call this every few seconds; without the pause a broken link is re-downloaded forever.
  const channelsRetryOk = now - (state.channelsFailedAt || 0) > CHANNELS_RETRY_MS;
  const needChannels = !epgOnly && (force || channelsOnly
    || ((!state.channels.length || now - state.channelsFetchedAt > maxAge) && channelsRetryOk));
  // "Fetched" rather than "has programmes": a guide that matched no channels is still loaded, and
  // re-downloading every source on each status poll would never end. Failures retry after a pause.
  const retryOk = now - (state.epgFailedAt || 0) > EPG_RETRY_MS;
  const needEpg = !channelsOnly && (needChannels || state.channels.length > 0)
    && (force || (!epgOnly && now - state.epgFetchedAt > maxAge && retryOk));
  if (!needChannels && !needEpg) return Promise.resolve(state);

  const hadData = state.channels.length > 0;
  if (needChannels && !hadData) {
    state.status = { state: 'loading', message: `Loading ${playlist.name}…`, progress: 0.05 };
  }
  state.loading = (async () => {
    let channelsStep = false;
    try {
      if (needChannels) {
        channelsStep = true;
        await refreshChannels(playlist, state);
        state.channelsFailedAt = 0;
        channelsStep = false;
      }
      // Guides only matter once there are channels to match them to.
      if (needEpg && state.channels.length) await refreshEpg(playlist, state);
      state.epgFailedAt = 0;
      state.status = { state: 'ready', message: '', progress: 1 };
      if (needEpg) startMagDeepFill(playlist, state);
    } catch (err) {
      if (channelsStep) state.channelsFailedAt = Date.now();
      else if (needEpg) state.epgFailedAt = Date.now();
      log.error(`Loading playlist '${playlist.name}' failed`, err);
      const detail = friendlyNetworkError(err);
      state.status = hadData || state.channels.length
        ? { state: 'ready', message: `Last refresh failed: ${detail}`, progress: 1 }
        : { state: 'error', message: detail, progress: 0 };
    } finally {
      state.loading = null;
    }
    return state;
  })();
  return state.loading;
}

function forget(playlistId) {
  states.delete(playlistId);
  fs.rmSync(cacheDir(playlistId), { recursive: true, force: true });
}

/**
 * Programmes for a channel (unshifted tuples). A user assignment (`override`: XMLTV id, or '' for no
 * guide) wins; otherwise the channel is matched by its EPG id, then its stream id.
 */
function programmesFor(state, channel, override) {
  if (typeof override === 'string') return (override && state.epg.get(override.toLowerCase())) || [];
  if (channel.epgId) {
    const list = state.epg.get(channel.epgId.toLowerCase());
    if (list) return list;
  }
  if (channel.streamId) {
    const list = state.epg.get(String(channel.streamId));
    if (list) return list;
  }
  if (channel.epgId) {
    for (const src of state.epgSources) {
      if (src.id === MAIN_SOURCE) continue;
      const list = state.epg.get(`${src.id}::${channel.epgId.toLowerCase()}`);
      if (list) return list;
    }
  }
  return [];
}

/** Re-downloads individual guide sources when their per-source timer has elapsed. */
async function refreshDueEpgSources(playlist, defaultHours) {
  const state = getState(playlist.id);
  if (state.loading || !state.epgSources.length) return;
  const sources = epgSourcesFor(playlist, state);
  const configured = new Map(epgSourcesOf(playlist).map((s) => [s.id, s]));
  const now = Date.now();
  for (const src of sources) {
    const cfg = configured.get(src.id);
    if (cfg && cfg.autoUpdate === false) continue;
    const hours = (cfg && cfg.refreshHours > 0) ? cfg.refreshHours : defaultHours;
    const meta = state.epgSources.find((s) => s.id === src.id);
    const fetched = meta && meta.fetchedAt ? meta.fetchedAt : state.epgFetchedAt;
    if (now - fetched < hours * 3600 * 1000) continue;
    try {
      await refreshOneEpgSource(playlist, state, src.id);
    } catch (err) {
      log.warn(`Scheduled guide refresh for '${src.name}' failed`, err);
    }
  }
}

async function refreshOneEpgSource(playlist, state, sourceId) {
  const src = epgSourcesFor(playlist, state).find((s) => s.id === sourceId);
  if (!src) return;
  const prefix = keyPrefix(sourceId);
  const channelIds = new Set();
  for (const c of state.channels) if (c.epgId) channelIds.add(c.epgId.toLowerCase());
  let assigned = new Set();
  try { assigned = extraEpgIds(state.playlistId); } catch { /* */ }
  const wantedIds = new Set(channelIds);
  if (!prefix) for (const c of state.channels) if (c.streamId) wantedIds.add(String(c.streamId));
  for (const key of assigned) {
    if (prefix ? key.startsWith(prefix) : !key.includes('::')) wantedIds.add(key.slice(prefix.length));
  }
  const now = Date.now();
  const result = src.portal ? await loadPortalGuide(playlist, state) : await loadXmltv(src.url, {
    wantedIds,
    fromMs: now - EPG_KEEP_PAST_MS,
    toMs: now + EPG_KEEP_FUTURE_MS,
    userAgent: playlist.user_agent,
  });
  for (const [id, progs] of result.programmes) state.epg.set(prefix + id, progs);
  if (src.portal) startMagDeepFill(playlist, state);
  state.epgList = state.epgList.filter((e) => (e.source || MAIN_SOURCE) !== sourceId).concat(result.channels.map((c) => ({ ...c, source: sourceId })));
  const meta = state.epgSources.find((s) => s.id === sourceId);
  const entry = { ...src, channels: result.channels.length, loaded: result.programmes.size, programmes: result.count, error: '', fetchedAt: now };
  if (meta) Object.assign(meta, entry);
  else state.epgSources.push(entry);
  state.epgFetchedAt = now;
  persistEpgCache(state);
}

module.exports = {
  getState,
  healthOf,
  ensureLoaded,
  reloadEpg,
  ensureEpgForKey,
  ensureMagHistory,
  refreshDueEpgSources,
  forget,
  programmesFor,
  epgUrlFor,
  epgSourcesFor,
  epgKey,
  setExtraEpgIds,
  MAIN_SOURCE,
};
