'use strict';

const catalog = require('./catalog');
const { slug } = require('./m3u');

/**
 * "All playlists" view: one virtual catalog made of every playlist of a user. Channels keep their own
 * playlist's stream, guide and catch-up; groups with the same name are merged.
 *
 * Ids are namespaced with a short playlist key so they never collide:
 *   channel      <pk>~<channelId>
 *   guide key    <pk>~<sourceId>::<xmltvId>   (the playlist's own guide uses sourceId "main")
 * Group lists, favorites and per-channel edits made in this view are stored under COMBINED_ID.
 */
const COMBINED_ID = 'combined';
const COMBINED_NAME = 'All playlists';
const SEP = '~';

const cache = new Map();

const pkOf = (playlistId) => String(playlistId).replace(/[^\w]/g, '').slice(0, 8);

/** Combined guide key for a key of one playlist's guide map. */
function combinedKey(pk, memberKey) {
  const key = String(memberKey || '').toLowerCase();
  return key.includes('::') ? `${pk}${SEP}${key}` : `${pk}${SEP}${catalog.MAIN_SOURCE}::${key}`;
}

/** Splits a combined guide key back into { pk, key } for the playlist's own guide map. */
function memberKeyOf(combined) {
  const text = String(combined || '').toLowerCase();
  const cut = text.indexOf(SEP);
  if (cut < 0) return null;
  let key = text.slice(cut + 1);
  const main = `${catalog.MAIN_SOURCE}::`;
  if (key.startsWith(main)) key = key.slice(main.length);
  return { pk: text.slice(0, cut), key };
}

/** True when the user looks at every playlist at once. */
function isOn(userSettings, rows) {
  return !!(userSettings.combinePlaylists && userSettings.playlistView === COMBINED_ID && rows.length > 1);
}

function virtualRow() {
  return {
    id: COMBINED_ID,
    name: COMBINED_NAME,
    type: 'combined',
    epg_shift_hours: 0,
    catchup_shift_hours: 0,
    user_agent: '',
  };
}

/** The guide key the playlist's own lookup would use for a channel (assignment aside). */
function autoKey(state, channel) {
  if (channel.epgId && state.epg.has(channel.epgId.toLowerCase())) return channel.epgId;
  if (channel.streamId && state.epg.has(String(channel.streamId))) return String(channel.streamId);
  if (channel.epgId) {
    for (const src of state.epgSources) {
      if (src.id === catalog.MAIN_SOURCE) continue;
      const key = `${src.id}::${channel.epgId.toLowerCase()}`;
      if (state.epg.has(key)) return key;
    }
    return channel.epgId;
  }
  return '';
}

function signature(members) {
  return members.map(({ row, state }) => [
    row.id, row.updated_at, row.epg_shift_hours,
    state.channels.length, state.channelsFetchedAt,
    state.epg.size, state.epgList.length, state.epgFetchedAt, state.epgVersion || 0,
  ].join(':')).join('|');
}

function build(members) {
  const channels = [];
  const groups = new Map();
  const epg = new Map();
  const epgList = [];
  const epgSources = [];
  let epgFetchedAt = 0;
  let channelsFetchedAt = 0;
  for (const { row, state, pk } of members) {
    const shiftMs = Math.round((Number(row.epg_shift_hours) || 0) * 3600000);
    const groupNames = new Map(state.groups.map((g) => [g.id, g.name]));
    for (const c of state.channels) {
      const groupName = groupNames.get(c.groupId) || c.groupName || 'Uncategorized';
      const groupId = `cmb-${slug(groupName)}`;
      if (!groups.has(groupId)) groups.set(groupId, { id: groupId, name: groupName, order: groups.size });
      const auto = autoKey(state, c);
      channels.push({
        ...c,
        id: `${pk}${SEP}${c.id}`,
        groupId,
        groupName,
        epgId: auto ? combinedKey(pk, auto) : '',
        playlistName: row.name,
        _pl: row.id,
        _src: c.id,
        _shiftMs: shiftMs,
      });
    }
    for (const [key, progs] of state.epg) epg.set(combinedKey(pk, key), progs);
    for (const e of state.epgList) epgList.push({ ...e, source: `${pk}${SEP}${e.source || catalog.MAIN_SOURCE}` });
    for (const s of state.epgSources) epgSources.push({ ...s, id: `${pk}${SEP}${s.id}`, name: `${row.name} · ${s.name}` });
    epgFetchedAt = Math.max(epgFetchedAt, state.epgFetchedAt || 0);
    channelsFetchedAt = Math.max(channelsFetchedAt, state.channelsFetchedAt || 0);
  }
  return {
    playlistId: COMBINED_ID,
    combined: true,
    status: { state: 'ready', message: '', progress: 1 },
    channels,
    groups: [...groups.values()],
    byId: new Map(channels.map((c) => [c.id, c])),
    creds: null,
    streamBase: '',
    epg,
    epgList,
    epgSources,
    epgFetchedAt,
    channelsFetchedAt,
    loading: null,
  };
}

function memberNote(m) {
  const health = catalog.healthOf(m.state);
  if (health.state === 'offline') return `${m.row.name}: offline`;
  if (health.state === 'loading') return `${m.row.name}: loading…`;
  if (health.stale && health.message) return `${m.row.name}: ${health.message}`;
  return '';
}

function statusOf(members) {
  const states = members.map((m) => m.state);
  const withChannels = members.filter((m) => m.state.channels.length);
  const loadingEmpty = members.filter((m) => m.state.status.state === 'loading' && !m.state.channels.length);
  const failedEmpty = members.filter((m) => m.state.status.state === 'error' && !m.state.channels.length);
  const notes = members.map(memberNote).filter(Boolean);

  // Cached or already-loaded playlists stay usable while others are still fetching or offline.
  if (withChannels.length) {
    return { state: 'ready', message: notes.join(' · '), progress: 1 };
  }
  if (loadingEmpty.length) {
    const progress = states.reduce((sum, s) => sum + (s.status.state === 'loading' ? s.status.progress || 0 : 1), 0) / Math.max(1, states.length);
    const first = loadingEmpty[0];
    return { state: 'loading', message: `${first.row.name}: ${first.state.status.message || 'Loading…'}`, progress };
  }
  if (failedEmpty.length === members.length && members.length) {
    return { state: 'error', message: failedEmpty.map((m) => `${m.row.name}: ${m.state.status.message}`).join(' · '), progress: 0 };
  }
  if (notes.length) {
    return { state: 'ready', message: notes.join(' · '), progress: 1 };
  }
  return { state: 'ready', message: '', progress: 1 };
}

/** The combined catalog for a user's playlist rows, rebuilt only when one of them changed. */
function stateFor(userId, rows) {
  const members = rows.map((row) => ({ row, pk: pkOf(row.id), state: catalog.getState(row.id) }));
  const sig = signature(members);
  let entry = cache.get(userId);
  if (!entry || entry.sig !== sig) {
    entry = { sig, state: build(members) };
    cache.set(userId, entry);
  }
  entry.state.members = members;
  entry.state.status = statusOf(members);
  return entry.state;
}

/** The real playlist, catalog state and channel behind a combined channel (or the inputs unchanged). */
function resolve(playlist, state, channel) {
  if (!state.combined || !channel._pl) return { playlist, state, channel };
  const member = state.members.find((m) => m.row.id === channel._pl);
  const original = member && member.state.byId.get(channel._src);
  if (!original) {
    const err = new Error('That channel is no longer in its playlist');
    err.status = 404;
    throw err;
  }
  return { playlist: member.row, state: member.state, channel: original };
}

/** Configured guide sources of every playlist, with combined ids and names. */
function sourcesFor(state) {
  const out = [];
  for (const { row, state: s, pk } of state.members) {
    for (const src of catalog.epgSourcesFor(row, s)) {
      out.push({ ...src, id: `${pk}${SEP}${src.id}`, name: `${row.name} · ${src.name}` });
    }
  }
  return out;
}

/** Loads one assigned guide channel into the playlist it belongs to. */
function ensureEpgForKey(state, combined) {
  const parts = memberKeyOf(combined);
  const member = parts && state.members.find((m) => m.pk === parts.pk);
  if (!member || !parts.key) return Promise.resolve(false);
  return catalog.ensureEpgForKey(member.row, member.state, parts.key);
}

/** Guide keys assigned in the combined view that belong to one playlist, as that playlist's own keys. */
function memberTargets(playlistId, combinedValues) {
  const pk = pkOf(playlistId);
  const out = [];
  for (const value of combinedValues) {
    const parts = memberKeyOf(value);
    if (parts && parts.pk === pk && parts.key) out.push(parts.key);
  }
  return out;
}

/**
 * Channel edits made inside each playlist (renames, icons, guide assignments, guide shifts) show in the
 * combined view too; edits made in the combined view win. `getPrefs(playlistId)` reads stored prefs.
 */
function inheritPrefs(prefs, state, getPrefs) {
  const out = {
    ...prefs,
    chNames: { ...prefs.chNames },
    chLogos: { ...prefs.chLogos },
    epgShift: { ...prefs.epgShift },
    epgMap: { ...prefs.epgMap },
  };
  for (const { row, pk } of state.members) {
    const own = getPrefs(row.id);
    const id = (channelId) => `${pk}${SEP}${channelId}`;
    for (const [ch, name] of Object.entries(own.chNames)) if (!(id(ch) in out.chNames)) out.chNames[id(ch)] = name;
    for (const [ch, url] of Object.entries(own.chLogos)) if (!(id(ch) in out.chLogos)) out.chLogos[id(ch)] = url;
    for (const [ch, shift] of Object.entries(own.epgShift)) if (!(id(ch) in out.epgShift)) out.epgShift[id(ch)] = shift;
    for (const [ch, key] of Object.entries(own.epgMap)) {
      if (id(ch) in out.epgMap) continue;
      out.epgMap[id(ch)] = key ? combinedKey(pk, key) : '';
    }
  }
  return out;
}

function forget(userId) {
  if (userId) cache.delete(userId);
  else cache.clear();
}

/** Combined catalog for a subset of playlists (search by type) without replacing the "All playlists" cache. */
function merge(rows) {
  const members = (rows || []).map((row) => ({ row, pk: pkOf(row.id), state: catalog.getState(row.id) }));
  const state = build(members);
  state.members = members;
  state.status = statusOf(members);
  return state;
}

module.exports = {
  COMBINED_ID,
  COMBINED_NAME,
  isOn,
  virtualRow,
  stateFor,
  resolve,
  sourcesFor,
  ensureEpgForKey,
  memberTargets,
  inheritPrefs,
  forget,
  merge,
};
