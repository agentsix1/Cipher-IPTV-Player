'use strict';

const db = require('./db');

/**
 * Per user + playlist list preferences, shared by the TV Guide and Channels screens: the group list
 * (sort, order, renames, hidden, user-made groups) and the channels (per-group sort and order, renames,
 * hidden channels, EPG assignments and per-channel guide time shift).
 */
const SORTS = ['playlist', 'name', 'count', 'custom'];
const CHANNEL_SORTS = ['playlist', 'name', 'number', 'custom'];
const DEFAULTS = {
  sort: 'playlist',
  showHidden: false,
  order: [],
  hidden: [],
  names: {},
  custom: [],
  chSort: {},
  chOrder: {},
  chNames: {},
  chHidden: [],
  chShowHidden: false,
  epgMap: {},
  epgShift: {},
  chLogos: {},
};
const CUSTOM_PREFIX = 'cg_';
const UNUSED_GROUP_ID = `${CUSTOM_PREFIX}__unused`;
const UNUSED_GROUP_NAME = 'Unused';
const ALL_CHANNELS = '__all';
const MAX_CUSTOM_CHANNELS = 5000;
const MAX_LIST = 50000;
const COMBINED_PREFS_ID = 'combined';

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const isCustom = (groupId) => String(groupId).startsWith(CUSTOM_PREFIX);

function get(userId, playlistId) {
  const row = db.get('SELECT json FROM group_prefs WHERE user_id = ? AND playlist_id = ?', [userId, playlistId]);
  let stored = {};
  try {
    stored = row ? JSON.parse(row.json) : {};
  } catch {
    stored = {};
  }
  const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {});
  const arr = (value) => (Array.isArray(value) ? value : []);
  return {
    ...DEFAULTS,
    ...stored,
    names: obj(stored.names),
    custom: arr(stored.custom),
    chSort: obj(stored.chSort),
    chOrder: obj(stored.chOrder),
    chNames: obj(stored.chNames),
    chHidden: arr(stored.chHidden),
    epgMap: obj(stored.epgMap),
    epgShift: obj(stored.epgShift),
    chLogos: obj(stored.chLogos),
  };
}

function save(userId, playlistId, prefs) {
  const json = JSON.stringify(prefs);
  const exists = db.get('SELECT 1 AS x FROM group_prefs WHERE user_id = ? AND playlist_id = ?', [userId, playlistId]);
  if (exists) db.run('UPDATE group_prefs SET json = ? WHERE user_id = ? AND playlist_id = ?', [json, userId, playlistId]);
  else db.run('INSERT INTO group_prefs (user_id, playlist_id, json) VALUES (?, ?, ?)', [userId, playlistId, json]);
  return prefs;
}

const idList = (value) => (Array.isArray(value) ? [...new Set(value.map(String))].slice(0, 5000) : null);

/** Updates list-level preferences: sort mode, show hidden, custom order. */
function updateList(userId, playlistId, body) {
  const prefs = get(userId, playlistId);
  if (body.sort !== undefined) {
    if (!SORTS.includes(body.sort)) throw badRequest('Invalid sort');
    prefs.sort = body.sort;
  }
  if (body.showHidden !== undefined) prefs.showHidden = !!body.showHidden;
  if (body.order !== undefined) {
    const order = idList(body.order);
    if (!order) throw badRequest('Invalid order');
    const given = new Set(order);
    prefs.order = [...order, ...prefs.order.filter((id) => !given.has(id))];
    prefs.sort = 'custom';
  }
  return save(userId, playlistId, prefs);
}

/** Updates one group: custom name (empty restores the playlist name) and hidden flag. */
function updateGroup(userId, playlistId, groupId, body) {
  const prefs = get(userId, playlistId);
  if (body.name !== undefined) {
    const name = String(body.name || '').trim().slice(0, 120);
    const custom = prefs.custom.find((c) => c.id === groupId);
    if (custom) {
      if (name) custom.name = name;
    } else if (name) {
      prefs.names[groupId] = name;
    } else {
      delete prefs.names[groupId];
    }
  }
  if (body.hidden !== undefined) {
    const hidden = new Set(prefs.hidden);
    if (body.hidden) hidden.add(groupId);
    else hidden.delete(groupId);
    prefs.hidden = [...hidden];
  }
  return save(userId, playlistId, prefs);
}

/**
 * Creates a user-defined group, optionally pre-filled with channel ids (Copy group). When the list has
 * a custom order the new group is placed right after `after` (or at the top).
 */
function createCustom(userId, playlistId, { name, channels = [], after = null }) {
  ensureUnusedGroup(userId, playlistId);
  const prefs = get(userId, playlistId);
  const clean = String(name || '').trim().slice(0, 120);
  if (!clean) throw badRequest('Group name is required');
  const id = `${CUSTOM_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  prefs.custom.push({ id, name: clean, channels: [...new Set(channels.map(String))].slice(0, MAX_CUSTOM_CHANNELS) });
  if (prefs.order.length) {
    const at = after ? prefs.order.indexOf(after) : -1;
    prefs.order.splice(at + 1, 0, id);
  }
  save(userId, playlistId, prefs);
  return id;
}

function ensureUnusedGroup(userId, playlistId) {
  const prefs = get(userId, playlistId);
  if (prefs.custom.some((c) => c.id === UNUSED_GROUP_ID)) return prefs;
  prefs.custom.unshift({ id: UNUSED_GROUP_ID, name: UNUSED_GROUP_NAME, channels: [] });
  save(userId, playlistId, prefs);
  return prefs;
}

function customGroupsForChannel(prefs, channelId) {
  return prefs.custom.filter((c) => c.channels.includes(channelId));
}

function setCustomChannelOnPrefs(prefs, groupId, channelId, add) {
  const custom = prefs.custom.find((c) => c.id === groupId);
  if (!custom) throw badRequest('Channels can only be added to groups you created');
  const channels = custom.channels.filter((id) => id !== channelId);
  if (add) {
    if (channels.length >= MAX_CUSTOM_CHANNELS) throw badRequest('This group is full');
    channels.push(channelId);
  }
  custom.channels = channels;
}

function deleteCustom(userId, playlistId, groupId) {
  if (groupId === UNUSED_GROUP_ID) throw badRequest('The Unused group cannot be deleted');
  const prefs = get(userId, playlistId);
  if (!prefs.custom.some((c) => c.id === groupId)) {
    throw badRequest(isCustom(groupId) ? 'Group not found' : 'Playlist groups cannot be deleted, only hidden');
  }
  prefs.custom = prefs.custom.filter((c) => c.id !== groupId);
  prefs.order = prefs.order.filter((id) => id !== groupId);
  prefs.hidden = prefs.hidden.filter((id) => id !== groupId);
  save(userId, playlistId, prefs);
}

/** Adds one channel to a user-defined group. */
function setCustomChannel(userId, playlistId, groupId, channelId, add) {
  const prefs = get(userId, playlistId);
  ensureUnusedGroup(userId, playlistId);
  const fresh = get(userId, playlistId);
  setCustomChannelOnPrefs(fresh, groupId, channelId, add);
  save(userId, playlistId, fresh);
}

/** Removes a channel from a custom group; if it would belong nowhere, it is placed in Unused. */
function removeCustomChannel(userId, playlistId, groupId, channelId) {
  ensureUnusedGroup(userId, playlistId);
  const prefs = get(userId, playlistId);
  if (groupId === UNUSED_GROUP_ID) {
    const elsewhere = customGroupsForChannel(prefs, channelId).filter((c) => c.id !== UNUSED_GROUP_ID);
    if (!elsewhere.length) throw badRequest('Add this channel to another group before removing it from Unused');
  }
  setCustomChannelOnPrefs(prefs, groupId, channelId, false);
  if (!customGroupsForChannel(prefs, channelId).length) {
    setCustomChannelOnPrefs(prefs, UNUSED_GROUP_ID, channelId, true);
  }
  save(userId, playlistId, prefs);
}

/** Leaves only the target custom group (playlist group is unchanged). */
function moveCustomChannel(userId, playlistId, channelId, targetGroupId) {
  ensureUnusedGroup(userId, playlistId);
  const prefs = get(userId, playlistId);
  const target = prefs.custom.find((c) => c.id === targetGroupId);
  if (!target) throw badRequest('Group not found');
  for (const custom of prefs.custom) custom.channels = custom.channels.filter((id) => id !== channelId);
  setCustomChannelOnPrefs(prefs, targetGroupId, channelId, true);
  save(userId, playlistId, prefs);
}

/**
 * Applies preferences to the playlist's groups (given in playlist order).
 * Hidden groups are dropped unless `showHidden` is on, in which case they are flagged.
 */
function apply(groups, prefs) {
  const hidden = new Set(prefs.hidden);
  let list = groups.map((g, index) => ({
    ...g,
    name: prefs.names[g.id] || g.name,
    originalName: g.name,
    renamed: !!prefs.names[g.id],
    hidden: hidden.has(g.id),
    index,
  }));
  const pinned = (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
  if (prefs.sort === 'name') list.sort((a, b) => pinned(a, b) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  else if (prefs.sort === 'count') list.sort((a, b) => pinned(a, b) || b.count - a.count || a.index - b.index);
  else if (prefs.sort === 'custom') {
    const pos = new Map(prefs.order.map((id, i) => [id, i]));
    list.sort((a, b) => (pos.get(a.id) ?? 1e9 + a.index) - (pos.get(b.id) ?? 1e9 + b.index));
  }
  if (!prefs.showHidden) list = list.filter((g) => !g.hidden);
  return list.map(({ index, ...g }) => g);
}

const listKey = (groupId) => String(groupId || ALL_CHANNELS);
const cleanShift = (value) => {
  const n = Math.round(Number(value) * 4) / 4;
  return Number.isFinite(n) ? Math.max(-24, Math.min(24, n)) : 0;
};

/** Updates one group's channel list: sort mode and custom order. `showHidden` applies to every list. */
function updateChannelList(userId, playlistId, groupId, body) {
  const prefs = get(userId, playlistId);
  const key = listKey(groupId);
  if (body.sort !== undefined) {
    if (!CHANNEL_SORTS.includes(body.sort)) throw badRequest('Invalid sort');
    prefs.chSort[key] = body.sort;
  }
  if (body.showHidden !== undefined) prefs.chShowHidden = !!body.showHidden;
  if (body.order !== undefined) {
    const order = Array.isArray(body.order) ? [...new Set(body.order.map(String))].slice(0, MAX_LIST) : null;
    if (!order) throw badRequest('Invalid order');
    const given = new Set(order);
    prefs.chOrder[key] = [...order, ...(prefs.chOrder[key] || []).filter((id) => !given.has(id))];
    prefs.chSort[key] = 'custom';
  }
  return save(userId, playlistId, prefs);
}

/**
 * Updates one channel: custom name (empty restores the playlist name), hidden flag, EPG assignment
 * (`epgId`: null = automatic, '' = no guide, otherwise an XMLTV channel id) and guide time shift in hours.
 */
function updateChannel(userId, playlistId, channelId, body) {
  const prefs = get(userId, playlistId);
  if (body.name !== undefined) {
    const name = String(body.name || '').trim().slice(0, 120);
    if (name) prefs.chNames[channelId] = name;
    else delete prefs.chNames[channelId];
  }
  if (body.hidden !== undefined) {
    const hidden = new Set(prefs.chHidden);
    if (body.hidden) hidden.add(channelId);
    else hidden.delete(channelId);
    prefs.chHidden = [...hidden];
  }
  if (body.epgId !== undefined) {
    if (body.epgId === null) delete prefs.epgMap[channelId];
    else prefs.epgMap[channelId] = String(body.epgId).trim().slice(0, 200);
  }
  if (body.epgShift !== undefined) {
    const shift = cleanShift(body.epgShift);
    if (shift) prefs.epgShift[channelId] = shift;
    else delete prefs.epgShift[channelId];
  }
  if (body.logoUrl !== undefined) {
    const url = String(body.logoUrl || '').trim().slice(0, 2000);
    if (url) prefs.chLogos[channelId] = url;
    else delete prefs.chLogos[channelId];
  }
  if (body.logoCustom === false) delete prefs.chLogos[channelId];
  return save(userId, playlistId, prefs);
}

/** Channel list preferences for one group, as reported to the client. */
function channelListInfo(prefs, groupId, channels) {
  const key = listKey(groupId);
  const hidden = new Set(prefs.chHidden);
  return {
    sort: prefs.chSort[key] || 'playlist',
    showHidden: !!prefs.chShowHidden,
    hiddenCount: channels.filter((c) => hidden.has(c.id)).length,
    hasCustomOrder: !!(prefs.chOrder[key] && prefs.chOrder[key].length),
  };
}

/**
 * Applies channel preferences to a group's channels (given in playlist order): renames, sort/order and
 * hidden channels (dropped unless `chShowHidden`, then flagged). Returns decorated copies.
 */
function applyChannels(channels, groupId, prefs) {
  const key = listKey(groupId);
  const hidden = new Set(prefs.chHidden);
  const sort = prefs.chSort[key] || 'playlist';
  let list = channels.map((c, index) => ({
    ...c,
    name: prefs.chNames[c.id] || c.name,
    originalName: c.name,
    renamed: !!prefs.chNames[c.id],
    hidden: hidden.has(c.id),
    index,
  }));
  if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  else if (sort === 'number') list.sort((a, b) => (Number(a.num) || 1e9) - (Number(b.num) || 1e9) || a.index - b.index);
  else if (sort === 'custom') {
    const pos = new Map((prefs.chOrder[key] || []).map((id, i) => [id, i]));
    list.sort((a, b) => (pos.get(a.id) ?? 1e9 + a.index) - (pos.get(b.id) ?? 1e9 + b.index));
  }
  if (!prefs.chShowHidden) list = list.filter((c) => !c.hidden);
  return list.map(({ index, ...c }) => c);
}

/**
 * XMLTV channel ids assigned to channels of a playlist (by any user), so the guide loader keeps them.
 * Assignments made in the "All playlists" view count for the playlist each key belongs to.
 */
function epgTargets(playlistId) {
  const ids = new Set();
  const combinedValues = [];
  for (const row of db.all('SELECT playlist_id, json FROM group_prefs WHERE playlist_id = ? OR playlist_id = ?', [playlistId, COMBINED_PREFS_ID])) {
    try {
      const map = JSON.parse(row.json).epgMap || {};
      for (const id of Object.values(map)) {
        if (!id) continue;
        if (row.playlist_id === COMBINED_PREFS_ID) combinedValues.push(id);
        else ids.add(String(id).toLowerCase());
      }
    } catch {
      // ignore a malformed row
    }
  }
  if (combinedValues.length) {
    for (const key of require('./combined').memberTargets(playlistId, combinedValues)) ids.add(key);
  }
  return ids;
}

/** Replaces all list preferences for a playlist (config/layout import), keeping only well-formed values. */
function replace(userId, playlistId, input) {
  const ids = (value, max = 5000) => (Array.isArray(value) ? [...new Set(value.map(String))].slice(0, max) : []);
  const textMap = (value, max = 120, keepEmpty = false) => {
    const out = {};
    if (!value || typeof value !== 'object') return out;
    for (const [id, text] of Object.entries(value).slice(0, MAX_LIST)) {
      const clean = String(text ?? '').trim().slice(0, max);
      if (clean || keepEmpty) out[String(id)] = clean;
    }
    return out;
  };
  const custom = (Array.isArray(input.custom) ? input.custom : [])
    .filter((c) => c && isCustom(c.id) && String(c.name || '').trim())
    .slice(0, 500)
    .map((c) => ({ id: String(c.id), name: String(c.name).trim().slice(0, 120), channels: ids(c.channels, MAX_CUSTOM_CHANNELS) }));
  const chSort = {};
  for (const [key, sort] of Object.entries(input.chSort && typeof input.chSort === 'object' ? input.chSort : {})) {
    if (CHANNEL_SORTS.includes(sort)) chSort[String(key)] = sort;
  }
  const chOrder = {};
  for (const [key, order] of Object.entries(input.chOrder && typeof input.chOrder === 'object' ? input.chOrder : {}).slice(0, 2000)) {
    const list = ids(order, MAX_LIST);
    if (list.length) chOrder[String(key)] = list;
  }
  const epgShift = {};
  for (const [id, value] of Object.entries(input.epgShift && typeof input.epgShift === 'object' ? input.epgShift : {}).slice(0, MAX_LIST)) {
    const shift = cleanShift(value);
    if (shift) epgShift[String(id)] = shift;
  }
  save(userId, playlistId, {
    sort: SORTS.includes(input.sort) ? input.sort : DEFAULTS.sort,
    showHidden: !!input.showHidden,
    order: ids(input.order),
    hidden: ids(input.hidden),
    names: textMap(input.names),
    custom,
    chSort,
    chOrder,
    chNames: textMap(input.chNames),
    chHidden: ids(input.chHidden, MAX_LIST),
    chShowHidden: !!input.chShowHidden,
    epgMap: textMap(input.epgMap, 200, true),
    epgShift,
    chLogos: textMap(input.chLogos, 2000),
  });
}

module.exports = {
  UNUSED_GROUP_ID,
  get,
  updateList,
  updateGroup,
  createCustom,
  deleteCustom,
  ensureUnusedGroup,
  customGroupsForChannel,
  setCustomChannel,
  removeCustomChannel,
  moveCustomChannel,
  updateChannelList,
  updateChannel,
  channelListInfo,
  applyChannels,
  epgTargets,
  replace,
  apply,
  isCustom,
};
