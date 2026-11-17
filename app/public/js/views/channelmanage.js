import { get, put, api } from '../api.js';
import { h, esc, toast, debounce } from '../util.js';
import { keyAction, focusEl, topModal, pushModal, moveFocus, isTextInput } from '../nav.js';
import { openMenu, promptDialog, groupPickerDialog } from '../menu.js';
import { createReorder, keepView, reorderButtons } from '../reorder.js';
import { openEpgBrowser } from './epgbrowser.js';
import { channelLogoEl, preloadLogos, harvestLogos, restoreLogos } from '../chlogo.js';

/**
 * Channel management shared by the Channels screen and the TV Guide: a context menu (reorder, rename,
 * hide, guide assignment and time shift, custom groups, sort) and the EPG search dialog. Preferences are
 * stored per playlist on the server, so both screens see the same order, names and guide choices.
 */

const enc = encodeURIComponent;
const SORT_LABELS = { playlist: 'Playlist order', name: 'Name', number: 'Channel number', custom: 'Custom order' };
const SHIFTS = [-3, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 3];
const LONG_PRESS_MS = 600;

const isCustomGroup = (id) => String(id || '').startsWith('cg_');
export const UNUSED_GROUP_ID = 'cg__unused';
const isUnusedGroup = (id) => id === UNUSED_GROUP_ID;
export const listKey = (groupId) => groupId || '__all';
const shiftLabel = (v) => (v ? `${v > 0 ? '+' : ''}${v} h` : 'None');

async function attempt(fn) {
  try {
    return (await fn()) || true;
  } catch (err) {
    toast(err.message, { error: true });
    return null;
  }
}

function sortItems(groupId, listPrefs, onChanged) {
  const sorts = ['playlist', 'name', 'number'];
  if (listPrefs.hasCustomOrder || listPrefs.sort === 'custom') sorts.push('custom');
  return sorts.map((sort) => ({
    label: SORT_LABELS[sort],
    checked: (listPrefs.sort || 'playlist') === sort,
    onSelect: async () => {
      if (listPrefs.sort === sort) return;
      if (await attempt(() => put(`/channel-list/${enc(listKey(groupId))}`, { sort }))) onChanged({ kind: 'sort' });
    },
  }));
}

function showHiddenItem(groupId, listPrefs, onChanged) {
  return {
    label: 'Show hidden channels',
    checked: !!listPrefs.showHidden,
    hint: listPrefs.hiddenCount ? String(listPrefs.hiddenCount) : '',
    onSelect: async () => {
      if (await attempt(() => put(`/channel-list/${enc(listKey(groupId))}`, { showHidden: !listPrefs.showHidden }))) {
        onChanged({ kind: 'showHidden' });
      }
    },
  };
}

/** Menu items for the list as a whole (list header / screen title). */
export function channelListMenuItems({ groupId, listPrefs = {}, onChanged = () => {}, reorder = null, empty = false }) {
  return [
    { header: true, label: 'Order channel' },
    reorder && { label: 'Reorder channels', disabled: empty, onSelect: reorder },
    { label: 'Order by', submenu: sortItems(groupId, listPrefs, onChanged) },
    showHiddenItem(groupId, listPrefs, onChanged),
  ];
}

async function renameChannel(ch, onChanged) {
  const name = await promptDialog({
    title: 'Rename channel',
    value: ch.name,
    placeholder: ch.originalName || ch.name,
    hint: ch.renamed
      ? `Playlist name: ${ch.originalName}. Clear the field to restore it.`
      : 'Clear the field to restore the playlist name.',
  });
  if (name === null || name.trim() === ch.name) return;
  if (await attempt(() => put(`/channels/${enc(ch.id)}`, { name }))) onChanged({ kind: 'rename', id: ch.id });
}

async function setHidden(ch, hidden, onChanged) {
  if (!(await attempt(() => put(`/channels/${enc(ch.id)}`, { hidden })))) return;
  toast(hidden ? `"${ch.name}" hidden` : `"${ch.name}" is visible again`);
  onChanged({ kind: 'hidden', id: ch.id, hidden });
}

async function loadCustomGroups(ch) {
  let custom = [];
  let memberIds = new Set();
  try {
    const data = await get('/groups');
    custom = (data.groups || []).filter((g) => g.custom);
  } catch (err) {
    console.warn('Could not load groups', err);
  }
  try {
    const membership = await get(`/channels/${enc(ch.id)}/groups`);
    memberIds = new Set((membership.groups || []).map((g) => g.id));
  } catch {
    // Older builds lack this route; group pickers still work, membership starts empty.
  }
  return { custom, memberIds };
}

async function addToGroupsDialog(ch, onChanged) {
  const { custom, memberIds } = await loadCustomGroups(ch);
  if (!custom.length) {
    toast('Could not load groups. Restart the app or refresh the page, then try again.', { error: true, ms: 5500 });
    return;
  }
  const pick = await groupPickerDialog({
    title: 'Add to group',
    okLabel: 'Add',
    multi: true,
    hint: 'Select one or more groups. The channel stays in any groups it is already in.',
    groups: custom.map((g) => ({
      id: g.id,
      name: g.name,
      count: g.count,
      checked: memberIds.has(g.id),
      disabled: memberIds.has(g.id),
      disabledHint: 'Already in this group',
    })),
  });
  if (!pick || !pick.length) return;
  let added = 0;
  for (const id of pick) {
    if (memberIds.has(id)) continue;
    if (await attempt(() => put(`/groups/${enc(id)}/channels/${enc(ch.id)}`))) added += 1;
  }
  if (added) {
    toast(`Added "${ch.name}" to ${added} group${added === 1 ? '' : 's'}`);
    onChanged({ kind: 'groups' });
  }
}

async function moveToGroupDialog(ch, onChanged) {
  const { custom } = await loadCustomGroups(ch);
  if (!custom.length) {
    toast('No custom groups yet. Use "New group…" first.', { error: true });
    return;
  }
  const target = await groupPickerDialog({
    title: 'Move to group',
    okLabel: 'Move',
    multi: false,
    hint: 'The channel is removed from your other custom groups and placed only in the group you pick. Its playlist group does not change.',
    groups: custom.map((g) => ({ id: g.id, name: g.name, count: g.count })),
  });
  if (!target) return;
  const name = custom.find((g) => g.id === target)?.name || 'group';
  if (await attempt(() => api(`/channels/${enc(ch.id)}/move-group`, { method: 'POST', body: { groupId: target } }))) {
    toast(`Moved "${ch.name}" to "${name}"`);
    onChanged({ kind: 'groups', id: ch.id });
  }
}

async function removeFromGroup(ch, groupId, onChanged) {
  if (await attempt(() => api(`/groups/${enc(groupId)}/channels/${enc(ch.id)}`, { method: 'DELETE' }))) {
    toast(isUnusedGroup(groupId) ? `"${ch.name}" removed from Unused` : `Removed "${ch.name}" from this group`);
    onChanged({ kind: 'removed', id: ch.id });
  }
}

async function pickImageFile() {
  const fileInput = h('input', { type: 'file', accept: 'image/*', style: 'display:none' });
  document.body.append(fileInput);
  return new Promise((resolve) => {
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      fileInput.remove();
      if (!file) return resolve(null);
      if (file.size > 512 * 1024) {
        toast('Image is too large (max 512 KB)', { error: true });
        return resolve(null);
      }
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(file);
    }, { once: true });
    fileInput.click();
  });
}

async function setChannelIconFromUrl(ch, onChanged) {
  const url = await promptDialog({
    title: 'Icon from URL',
    placeholder: 'https://…',
    value: ch.logoCustom && /^https?:\/\//i.test(ch.logo || '') ? ch.logo : '',
  });
  if (url === null) return;
  if (!url.trim()) {
    if (await attempt(() => put(`/channels/${enc(ch.id)}`, { logoCustom: false }))) {
      toast('Using the playlist icon');
      onChanged({ kind: 'logo', id: ch.id });
    }
    return;
  }
  if (await attempt(() => put(`/channels/${enc(ch.id)}`, { logoUrl: url.trim() }))) {
    toast('Channel icon updated');
    onChanged({ kind: 'logo', id: ch.id });
  }
}

async function uploadChannelIcon(ch, onChanged) {
  const data = await pickImageFile();
  if (!data) return;
  if (await attempt(() => put(`/channels/${enc(ch.id)}`, { imageDataUrl: data }))) {
    toast('Channel icon updated');
    onChanged({ kind: 'logo', id: ch.id });
  }
}

async function useEpgIcon(ch, onChanged) {
  let url = '';
  try {
    const data = await get(`/epg/search?ch=${enc(ch.id)}&limit=1`);
    const cur = data.current || {};
    url = cur.icon || '';
    if (!url) {
      const q = enc(cur.name || cur.autoName || ch.originalName || ch.name || '');
      const page = await get(`/epg/search?ch=${enc(ch.id)}&q=${q}&limit=80`);
      const live = page.current || cur;
      url = live.icon || '';
      if (!url && page.results) {
        const key = String(live.mode === 'custom' ? live.id : live.autoId || '').toLowerCase();
        const bare = key.includes('::') ? key.slice(key.lastIndexOf('::') + 2) : key;
        const label = String(live.name || live.autoName || '').toLowerCase();
        const hit = page.results.find((e) => e.icon && (
          (key && String(e.key).toLowerCase() === key)
          || (bare && String(e.id).toLowerCase() === bare)
          || (label && String(e.name).toLowerCase() === label)
        ));
        if (hit) url = hit.icon;
      }
    }
  } catch { /* toast below */ }
  if (!url) {
    toast('This guide channel has no icon', { error: true });
    return;
  }
  if (await attempt(() => put(`/channels/${enc(ch.id)}`, { logoUrl: url }))) {
    toast('Using the guide icon');
    onChanged({ kind: 'logo', id: ch.id });
  }
}

async function usePlaylistIcon(ch, onChanged) {
  if (await attempt(() => put(`/channels/${enc(ch.id)}`, { logoCustom: false }))) {
    toast(ch.playlistLogo ? 'Using the playlist icon' : 'Custom icon cleared');
    onChanged({ kind: 'logo', id: ch.id });
  }
}

async function removeFromGroupDialog(ch, onChanged) {
  const { custom, memberIds } = await loadCustomGroups(ch);
  const inGroups = custom.filter((g) => memberIds.has(g.id));
  if (!inGroups.length) {
    toast('This channel is not in any custom group', { error: true });
    return;
  }
  const onlyUnused = inGroups.length === 1 && isUnusedGroup(inGroups[0].id);
  if (onlyUnused) {
    toast('Add this channel to another group before removing it from Unused', { error: true });
    return;
  }
  const pick = await groupPickerDialog({
    title: 'Remove from group',
    okLabel: 'Remove',
    multi: false,
    hint: 'If the channel would not belong to any group, it is placed in Unused.',
    groups: inGroups.map((g) => ({
      id: g.id,
      name: g.name,
      count: g.count,
      disabled: isUnusedGroup(g.id) && inGroups.length === 1,
      disabledHint: 'Add the channel to another group first',
    })),
  });
  if (!pick) return;
  await removeFromGroup(ch, pick, onChanged);
}

/**
 * Right-click / Menu-key menu for a channel.
 * ctx: { groupId, listPrefs, onChanged(change), reorder(): start reorder mode, moveToEdge(top) }
 */
export async function channelMenu(ch, at, ctx = {}, prepend = []) {
  if (topModal()) return;
  const { groupId = null, listPrefs = {}, onChanged = () => {}, reorder = null, moveToEdge = null } = ctx;
  const { memberIds } = await loadCustomGroups(ch);
  if (topModal()) return;

  const addToNew = async () => {
    const name = await promptDialog({ title: 'New group', placeholder: 'Group name', okLabel: 'Create' });
    if (!name || !name.trim()) return;
    const res = await attempt(() => api('/groups', { method: 'POST', body: { name } }));
    if (res && res.id && await attempt(() => put(`/groups/${enc(res.id)}/channels/${enc(ch.id)}`))) {
      toast(`Added "${ch.name}" to "${name.trim()}"`);
      onChanged({ kind: 'groups', id: ch.id });
    }
  };

  const inCustom = memberIds.size > 0;
  const onlyInUnused = inCustom && memberIds.size === 1 && memberIds.has(UNUSED_GROUP_ID);
  const canRemoveHere = isCustomGroup(groupId) && !(isUnusedGroup(groupId) && onlyInUnused);
  const epgHint = ch.epg === 'custom' ? 'Custom' : ch.epg === 'none' ? 'Off' : '';

  const lead = (prepend || []).filter(Boolean);
  openMenu([
    ...lead,
    lead.length ? { separator: true } : null,
    { header: true, label: 'Order channel' },
    reorder && { label: 'Reorder channels', onSelect: reorder },
    moveToEdge && { label: 'Move to top', onSelect: () => moveToEdge(true) },
    moveToEdge && { label: 'Move to bottom', onSelect: () => moveToEdge(false) },
    { label: 'Rename channel', onSelect: () => renameChannel(ch, onChanged) },
    { label: 'Order by', submenu: sortItems(groupId, listPrefs, onChanged) },
    showHiddenItem(groupId, listPrefs, onChanged),
    { separator: true },
    { header: true, label: 'Edit channel' },
    ch.hidden
      ? { label: 'Show channel', onSelect: () => setHidden(ch, false, onChanged) }
      : { label: 'Hide channel', onSelect: () => setHidden(ch, true, onChanged) },
    {
      label: 'Add to group…',
      onSelect: () => addToGroupsDialog(ch, onChanged),
    },
    {
      label: 'Move to group…',
      onSelect: () => moveToGroupDialog(ch, onChanged),
    },
    canRemoveHere && {
      label: 'Remove from group',
      onSelect: () => removeFromGroup(ch, groupId, onChanged),
    },
    (isCustomGroup(groupId) ? false : inCustom) && !onlyInUnused && {
      label: 'Remove from group…',
      onSelect: () => removeFromGroupDialog(ch, onChanged),
    },
    { label: 'New group…', onSelect: addToNew },
    {
      label: 'Channel Icon',
      submenu: [
        { label: 'From URL...', onSelect: () => setChannelIconFromUrl(ch, onChanged) },
        { label: 'From File...', onSelect: () => uploadChannelIcon(ch, onChanged) },
        { label: 'From EPG...', onSelect: () => useEpgIcon(ch, onChanged) },
        { label: 'From Playlist...', onSelect: () => usePlaylistIcon(ch, onChanged) },
      ],
    },
    { separator: true },
    { label: 'Choose guide (EPG)…', hint: epgHint, onSelect: () => openEpgDialog(ch, { onChanged }) },
    {
      label: 'Guide time shift',
      hint: ch.epgShift ? shiftLabel(ch.epgShift) : '',
      submenu: SHIFTS.map((v) => ({
        label: shiftLabel(v),
        checked: (ch.epgShift || 0) === v,
        onSelect: async () => {
          if (await attempt(() => put(`/channels/${enc(ch.id)}`, { epgShift: v }))) {
            toast(v ? `Guide for "${ch.name}" shifted ${shiftLabel(v)}` : `Guide time shift cleared for "${ch.name}"`);
            onChanged({ kind: 'epg', id: ch.id });
          }
        },
      })),
    },
  ], at);
}

/** Guide browser for one channel: search the guide sources and assign a guide channel to it. */
export function openEpgDialog(ch, { onChanged = () => {} } = {}) {
  return openEpgBrowser({ channel: ch, onChanged });
}

/**
 * Manageable channel list for one group (Channels screen): list header with sort + Options, reorder
 * mode (drag, ▲ ▼ ⤒ ⤓, remote), context menu, long-press OK for the menu.
 * opts: { groupId, onActivate(ch, item), onRender(), titleEl, restoreId }
 * Returns { onKey, onBack, destroy, channelOf(el), channels }.
 */
export async function channelList(container, { groupId, onActivate, onRender, titleEl, restoreId, showNow = false } = {}) {
  let data = null;
  let reorder = null;
  let destroyed = false;
  let press = null;
  let optionsBtn = null;

  const byId = (id) => data.channels.find((c) => c.id === id);
  const channelOf = (el) => {
    const item = el && el.closest ? el.closest('[data-ch]') : null;
    return item && container.contains(item) && data ? byId(item.dataset.ch) : null;
  };
  const itemEl = (id) => container.querySelector(`[data-ch="${CSS.escape(id)}"]`);

  async function load(focus) {
    try {
      data = await get(`/channels?group=${enc(groupId || '')}${showNow ? '&now=1' : ''}`);
    } catch (err) {
      if (!destroyed) container.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
      data = null;
      return;
    }
    if (!destroyed) render(focus);
  }

  /** Reloads after a change, keeping focus on the same channel (or the same position if it left the list). */
  function reloadAt(id) {
    const index = data ? data.channels.findIndex((c) => c.id === id) : 0;
    return load({ id, index: Math.max(0, index) });
  }

  async function patchChannel(id) {
    try {
      const ch = await get(`/channels/${enc(id)}?now=${showNow ? 1 : 0}`);
      const i = data.channels.findIndex((c) => c.id === id);
      if (i >= 0) data.channels[i] = { ...data.channels[i], ...ch };
      const el = itemEl(id);
      if (!el) return reloadAt(id);
      const scrollTop = container.scrollTop;
      const logo = el.querySelector('img.logo, span.ch-logo');
      if (logo) logo.replaceWith(channelLogoEl(ch));
      const nameEl = el.querySelector('.name, .ch-text .name');
      if (nameEl) nameEl.textContent = ch.name;
      el.querySelectorAll('.tag.custom, .tag').forEach((t) => {
        if (t.textContent === 'EPG' || t.textContent === 'No EPG') t.remove();
      });
      if (ch.epg === 'custom') el.append(h('span.tag.custom', { text: 'EPG', title: 'Guide chosen manually' }));
      if (ch.epg === 'none') el.append(h('span.tag', { text: 'No EPG' }));
      if (ch.hidden) el.classList.add('is-hidden');
      else el.classList.remove('is-hidden');
      container.scrollTop = scrollTop;
      el.focus({ preventScroll: true });
    } catch {
      return reloadAt(id);
    }
  }

  function onChannelChanged(change) {
    const id = change && change.id;
    if (!id) return load({ head: true });
    if (change.kind === 'removed') return reloadAt(id);
    if (['epg', 'rename', 'hidden', 'logo', 'groups'].includes(change.kind)) return patchChannel(id);
    return reloadAt(id);
  }

  function headText(p) {
    const parts = [`${data.channels.length.toLocaleString()} channel${data.channels.length === 1 ? '' : 's'}`, `Sorted by ${SORT_LABELS[p.sort] || SORT_LABELS.playlist}`];
    if (p.hiddenCount) parts.push(`${p.hiddenCount} hidden${p.showHidden ? ' (shown)' : ''}`);
    return parts.join(' · ');
  }

  function reorderHint() {
    return reorder.moving
      ? 'Moving: Up/Down, ▲ ▼ or ⤒ ⤓ for top/bottom · OK drops it'
      : 'Drag channels, or select one to move it · Back saves';
  }

  function render(focus = null) {
    const scrollTop = container.scrollTop;
    harvestLogos(container);
    container.innerHTML = '';
    const list = h('div.list.managed-list');
    if (reorder) {
      optionsBtn = null;
      const done = h('button.btn.small.primary.focusable', { text: 'Done', onclick: () => finishReorder(true) });
      const cancel = h('button.btn.small.focusable', { text: 'Cancel', onclick: () => finishReorder(false) });
      list.append(h('div.list-head.reorder-bar', {}, h('span.list-head-text', { text: reorderHint() }), cancel, done));
    } else {
      optionsBtn = h('button.btn.small.focusable', { text: '⋮ Options', onclick: () => listMenu({ anchor: optionsBtn }) });
      const head = h('div.list-head', {}, h('span.list-head-text', { text: headText(data.prefs) }), optionsBtn);
      head.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        listMenu({ x: e.clientX, y: e.clientY });
      });
      list.append(head);
    }
    const channels = reorder ? reorder.ids.map(byId) : data.channels;
    for (const ch of channels) list.append(channelItem(ch));
    if (!channels.length) {
      list.append(h('div.empty', {
        text: data.prefs.hiddenCount ? 'All channels in this group are hidden. Open Options and turn on "Show hidden channels".' : 'No channels in this group.',
      }));
    }
    container.append(list);
    restoreLogos(list);
    container.scrollTop = scrollTop;
    preloadLogos(channels);

    const items = list.querySelectorAll('[data-ch]');
    let target = null;
    if (focus) {
      target = (focus.id && itemEl(focus.id))
        || (focus.index !== undefined && items[Math.min(focus.index, items.length - 1)])
        || (focus.head && optionsBtn);
    } else if (restoreId) {
      target = itemEl(restoreId);
      restoreId = null;
    }
    if (!focus && !target) target = items[0];
    if (target) {
      target.focus({ preventScroll: true });
      target.classList.add('kb-focus');
    }
    if (onRender) onRender();
  }

  function nameWithNow(ch) {
    const p = ch.now;
    const now = Date.now();
    const frac = p ? Math.max(0, Math.min(1, (now - p.start) / (p.end - p.start))) : 0;
    return h('span.ch-text', {},
      h('span.name', { text: ch.name }),
      h('span.ch-now', { text: p ? p.title : 'No guide information' }),
      p ? h('span.ch-progress', {}, h('span', { style: `width:${(frac * 100).toFixed(1)}%` })) : null);
  }

  function channelItem(ch) {
    const item = h('button.list-item.focusable', {
      'data-ch': ch.id,
      title: ch.renamed ? `Playlist name: ${ch.originalName}` : null,
    },
    reorder ? h('span.ro-handle', { text: '⠿', title: 'Drag to move' }) : null,
    channelLogoEl(ch),
    h('span.meta', { text: String(ch.num) }),
    showNow && !reorder ? nameWithNow(ch) : h('span.name', { text: ch.name }),
    ch.hidden ? h('span.tag', { text: 'Hidden' }) : null,
    ch.epg === 'custom' ? h('span.tag.custom', { text: 'EPG', title: 'Guide chosen manually' }) : null,
    ch.epg === 'none' ? h('span.tag', { text: 'No EPG' }) : null,
    !reorder && ch.catchup ? h('span.meta', { text: '⟲', title: 'Catch-up available' }) : null,
    !reorder && ch.fav ? h('span.meta', { text: '★' }) : null,
    ...(reorder ? reorderButtons(h, reorder, ch.id) : []));
    if (ch.hidden) item.classList.add('is-hidden');
    if (reorder) item.classList.add('reordering');
    if (reorder && reorder.moving === ch.id) item.classList.add('moving');
    item.addEventListener('click', () => {
      if (reorder) {
        if (!reorder.takeClick()) reorder.toggle(ch.id);
      } else if (onActivate) {
        onActivate(ch, item);
      }
    });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (topModal()) return;
      item.focus({ preventScroll: true });
      const at = { x: e.clientX, y: e.clientY };
      if (reorder) reorderMenu(ch, at);
      else menu(ch, at);
    });
    if (reorder) item.addEventListener('pointerdown', (e) => reorder.beginDrag(e, item, ch.id));
    return item;
  }

  function menu(ch, at) {
    channelMenu(ch, at, {
      groupId,
      listPrefs: data.prefs,
      onChanged: onChannelChanged,
      reorder: () => startReorder(ch.id),
      moveToEdge: (top) => moveToEdge(ch, top),
    });
  }

  function listMenu(at) {
    if (!data || reorder || topModal()) return;
    openMenu(channelListMenuItems({
      groupId,
      listPrefs: data.prefs,
      onChanged: () => load({ head: true }),
      reorder: () => startReorder(null),
      empty: !data.channels.length,
    }), at);
  }

  function reorderMenu(ch, at) {
    openMenu([
      ch && { label: 'Move to top', onSelect: () => reorder.moveTo(ch.id, 0, { follow: false, pick: false }) },
      ch && { label: 'Move to bottom', onSelect: () => reorder.moveTo(ch.id, reorder.ids.length - 1, { follow: false, pick: false }) },
      ch && { separator: true },
      { label: 'Done', onSelect: () => finishReorder(true) },
      { label: 'Cancel', onSelect: () => finishReorder(false) },
    ], at);
  }

  /** Moves a channel to the top/bottom in place (the view stays where it is), then saves the order. */
  async function moveToEdge(ch, top) {
    const ids = data.channels.map((c) => c.id).filter((id) => id !== ch.id);
    if (top) ids.unshift(ch.id);
    else ids.push(ch.id);
    const el = itemEl(ch.id);
    if (el) {
      keepView(container, '[data-ch]', () => {
        const items = container.querySelectorAll('[data-ch]');
        const edge = top ? items[0] : items[items.length - 1];
        if (edge !== el) {
          if (top) edge.before(el);
          else edge.after(el);
        }
      }, el);
      el.focus({ preventScroll: true });
    }
    data.channels = ids.map(byId);
    data.prefs = { ...data.prefs, sort: 'custom', hasCustomOrder: true };
    const head = container.querySelector('.list-head:not(.reorder-bar) .list-head-text');
    if (head) head.textContent = headText(data.prefs);
    if (!(await attempt(() => put(`/channel-list/${enc(listKey(groupId))}`, { order: ids })))) await load({ id: ch.id });
  }

  function startReorder(movingId) {
    reorder = createReorder(container, { attr: 'ch', ids: data.channels.map((c) => c.id), moving: movingId, hint: reorderHint });
    render({ id: movingId, index: 0 });
  }

  async function finishReorder(keep) {
    if (!reorder) return;
    const { ids, moving } = reorder;
    const focusId = moving || (channelOf(document.activeElement) || {}).id;
    const changed = ids.some((id, i) => data.channels[i].id !== id);
    reorder.end();
    reorder = null;
    if (keep && changed) {
      if (await attempt(() => put(`/channel-list/${enc(listKey(groupId))}`, { order: ids }))) toast('Channel order saved');
      await load({ id: focusId, index: 0 });
    } else {
      render({ id: focusId, index: 0 });
    }
  }

  function onKeyUp(e) {
    if (!press || keyAction(e) !== 'enter') return;
    clearTimeout(press.timer);
    const { ch, item } = press;
    press = null;
    if (onActivate && document.contains(item)) onActivate(ch, item);
  }

  function onTitleMenu(e) {
    e.preventDefault();
    listMenu({ x: e.clientX, y: e.clientY });
  }

  document.addEventListener('keyup', onKeyUp);
  if (titleEl) titleEl.addEventListener('contextmenu', onTitleMenu);
  container.style.overflowAnchor = 'none';
  container.innerHTML = '<div class="empty">Loading channels…</div>';
  await load();

  return {
    get channels() {
      return data ? data.channels : [];
    },
    channelOf,
    onKey(action, e) {
      if (!data) return false;
      const active = document.activeElement;
      const ch = channelOf(active);
      if (action === 'menu') {
        if (reorder) reorderMenu(ch, { anchor: active && container.contains(active) ? active : container, keyboard: true });
        else if (ch) menu(ch, { anchor: active, keyboard: true });
        else listMenu({ anchor: optionsBtn || titleEl, keyboard: true });
        return true;
      }
      if (reorder) {
        if (action === 'enter' && ch) {
          if (!e.repeat) reorder.toggle(ch.id);
          return true;
        }
        if ((action === 'up' || action === 'down') && reorder.moving) {
          reorder.move(reorder.moving, action === 'up' ? -1 : 1);
          return true;
        }
        if ((action === 'pageup' || action === 'pagedown') && reorder.moving) {
          reorder.moveTo(reorder.moving, action === 'pageup' ? 0 : reorder.ids.length - 1);
          return true;
        }
        return false;
      }
      if (action === 'enter' && ch) {
        if (e.repeat || press) return true;
        const item = active.closest('[data-ch]');
        press = {
          ch,
          item,
          timer: setTimeout(() => {
            press = null;
            menu(ch, { anchor: item, keyboard: true });
          }, LONG_PRESS_MS),
        };
        return true;
      }
      return false;
    },
    onBack() {
      if (!reorder) return false;
      if (reorder.moving) {
        reorder.moving = null;
        reorder.sync();
      } else {
        finishReorder(true);
      }
      return true;
    },
    destroy() {
      destroyed = true;
      if (press) clearTimeout(press.timer);
      press = null;
      document.removeEventListener('keyup', onKeyUp);
      if (titleEl) titleEl.removeEventListener('contextmenu', onTitleMenu);
    },
  };
}
