import { api, get, put } from '../api.js';
import { h, esc, toast, prefs } from '../util.js';
import { StreamPlayer } from '../player.js';
import { back } from '../app.js';
import { keyAction, focusEl, topModal } from '../nav.js';
import { openMenu, promptDialog, confirmDialog } from '../menu.js';
import { createReorder, keepView, reorderButtons } from '../reorder.js';
import { playerLog } from '../player-debug.js';

export function topbar(title, { sub = '', actions = [], back: showBack = true } = {}) {
  const backBtn = showBack
    ? h('button.btn.focusable.topbar-back', { onclick: () => back({ button: true }), 'aria-label': 'Back' },
      h('span.tb-arrow', { text: '←' }), h('span.tb-label', { text: ' Back' }))
    : null;
  return h('div.topbar', {}, backBtn, h('h1', { text: title }), sub ? h('span.sub', { text: sub }) : null, ...actions);
}

const seeAllLast = new WeakMap();

function seeAllRows(cards) {
  const rows = [];
  for (const el of cards) {
    const top = el.getBoundingClientRect().top;
    let row = rows.find((r) => Math.abs(r.top - top) < 24);
    if (!row) {
      row = { top, items: [] };
      rows.push(row);
    }
    row.items.push(el);
  }
  rows.sort((a, b) => a.top - b.top);
  for (const row of rows) {
    row.items.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  }
  return rows;
}

/** Column-aligned See All grid. Up from the first row leaves to the top menu. */
export function seeAllOnKey(root, action) {
  if (!['up', 'down', 'left', 'right'].includes(action)) return false;
  const cards = [...root.querySelectorAll('.hub-card')];
  const active = document.activeElement;
  if (cards.includes(active)) seeAllLast.set(root, active);

  const rows = seeAllRows(cards);
  let ri = -1;
  let ci = -1;
  for (let r = 0; r < rows.length; r++) {
    const c = rows[r].items.indexOf(active);
    if (c >= 0) {
      ri = r;
      ci = c;
      break;
    }
  }
  if (ri < 0) return false;

  const go = (el) => {
    if (!el) return true;
    seeAllLast.set(root, el);
    focusEl(el);
    return true;
  };

  if (action === 'left') return ci > 0 ? go(rows[ri].items[ci - 1]) : true;
  if (action === 'right') return ci < rows[ri].items.length - 1 ? go(rows[ri].items[ci + 1]) : true;
  if (action === 'up') {
    if (ri > 0) {
      const prev = rows[ri - 1].items;
      return go(prev[Math.min(ci, prev.length - 1)]);
    }
    return false;
  }
  if (ri < rows.length - 1) {
    const next = rows[ri + 1].items;
    return go(next[Math.min(ci, next.length - 1)]);
  }
  return true;
}

function stillBusy(status) {
  if (!status) return false;
  if (status.state === 'loading') return true;
  const members = status.members || [];
  if (members.some((m) => m.state === 'loading')) return true;
  return /refreshing|loading tv guide/i.test(status.message || '');
}

/** Polls /api/status while the playlist is loading. Calls onUpdate(status) each time. */
export function watchStatus(onUpdate, { intervalMs = 1500 } = {}) {
  let stopped = false;
  let timer = null;
  let errorTries = 0;
  const tick = async () => {
    if (stopped) return;
    try {
      const status = await get('/status');
      if (stopped) return;
      onUpdate(status);
      if (stillBusy(status)) {
        errorTries = 0;
        timer = setTimeout(tick, intervalMs);
      } else if ((status.state === 'error' || (status.members || []).some((m) => m.state === 'offline')) && errorTries < 8) {
        errorTries += 1;
        timer = setTimeout(tick, status.state === 'error' ? intervalMs * 4 : 15000);
      }
    } catch {
      timer = setTimeout(tick, intervalMs * 3);
    }
  };
  tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export function loadingPanel(message = 'Loading…') {
  return h('div.loading-panel', {},
    h('div.boot-msg', { text: message }),
    h('div.progress.boot-progress', {}, h('div')));
}

export function statusBlock() {
  const text = h('div.status-line');
  const banner = h('div.status-banner');
  banner.hidden = true;
  const bar = h('div.progress', {}, h('div'));
  bar.style.display = 'none';
  const el = h('div', {}, text, banner, bar);
  return {
    el,
    update(status) {
      const loading = status.state === 'loading' || stillBusy(status);
      const members = status.members || [];
      const offline = members.filter((m) => m.state === 'offline');
      const loadingMembers = members.filter((m) => m.state === 'loading');
      text.classList.toggle('is-error', status.state === 'error' || offline.length > 0);
      text.textContent = status.message || (status.state === 'ready' && status.playlist
        ? `${status.playlist.name} · ${(status.channels || 0).toLocaleString()} channels`
        : (status.state === 'error' ? status.message : ''));
      if (offline.length) {
        banner.hidden = false;
        banner.textContent = offline.length === 1
          ? `${offline[0].name} is offline and was skipped.`
          : `${offline.map((m) => m.name).join(', ')} are offline and were skipped.`;
      } else if (loadingMembers.length && status.state === 'ready') {
        banner.hidden = false;
        banner.textContent = `${loadingMembers.map((m) => m.name).join(', ')} still loading. Other playlists are available.`;
      } else {
        banner.hidden = true;
        banner.textContent = '';
      }
      bar.style.display = loading && status.state === 'loading' ? '' : 'none';
      bar.firstChild.style.width = `${Math.round((status.progress || 0) * 100)}%`;
    },
  };
}

const SORT_LABELS = { name: 'Name', playlist: 'Playlist order', count: 'Channel count', custom: 'Custom order' };
const LONG_PRESS_MS = 600;

/**
 * Clickable/focusable group list with management menus (reorder, rename, hide, sort). Preferences are
 * stored on the server per playlist, so the TV Guide and Channels screens share them.
 * onPick(group) is called when a group is chosen. titleEl (the screen title) opens the list menu on
 * right-click. Returns a controller: { onKey(action, e), onBack(), destroy() }.
 */
export async function groupPicker(container, onPick, { selectedId, titleEl } = {}) {
  let data = null;
  let reorder = null;
  let destroyed = false;
  let press = null;
  let optionsBtn = null;

  const byId = (id) => data.groups.find((g) => g.id === id);
  const groupOf = (el) => {
    const item = el && el.closest ? el.closest('[data-group]') : null;
    return item && container.contains(item) ? byId(item.dataset.group) : null;
  };
  const itemEl = (id) => container.querySelector(`[data-group="${CSS.escape(id)}"]`);

  let loadTimer = null;
  let lastSig = '';
  function groupsSig(d) {
    if (!d) return '';
    const ids = (d.groups || []).map((g) => `${g.id}:${g.count}`).join(',');
    const st = d.status || {};
    const members = (st.members || []).map((m) => `${m.id}:${m.state}`).join(',');
    return `${ids}|${st.state}|${st.message || ''}|${members}|${(d.prefs && d.prefs.hiddenCount) || 0}`;
  }
  async function load(focus) {
    try {
      data = await get('/groups');
    } catch (err) {
      if (!destroyed) {
        container.replaceChildren(loadingPanel(err.message || 'Could not load groups'));
      }
      data = null;
      lastSig = '';
      loadTimer = setTimeout(() => load(focus), 4000);
      return;
    }
    if (destroyed) return;
    const sig = groupsSig(data);
    if (sig !== lastSig) {
      lastSig = sig;
      render(focus);
    }
    const status = data && data.status;
    const members = (status && status.members) || [];
    const busy = status && (status.state === 'loading' || members.some((m) => m.state === 'loading'));
    if (busy) loadTimer = setTimeout(() => load(), 1500);
  }

  async function save(path, body, focus, method = 'PUT') {
    let result = null;
    try {
      result = await api(path, { method, body });
    } catch (err) {
      toast(err.message, { error: true });
    }
    await load(typeof focus === 'function' ? focus(result) : focus);
    return result;
  }

  function render(focus = null) {
    const scrollTop = container.scrollTop;
    const keepGroup = !focus && groupOf(document.activeElement);
    container.innerHTML = '';
    const prefsInfo = data.prefs || {};
    if (!data.groups.length && !prefsInfo.hiddenCount) {
      const status = data.status || {};
      const msg = status.state === 'loading'
        ? (status.message || 'Loading playlist…')
        : (status.state === 'error'
          ? (status.message || 'This playlist is offline.')
          : (status.message || 'No channels found in this playlist.'));
      container.replaceChildren(status.state === 'loading'
        ? loadingPanel(msg)
        : h('div.empty', { text: msg }));
      return;
    }

    const list = h('div.list.group-list');
    const members = (data.status && data.status.members) || [];
    const offline = members.filter((m) => m.state === 'offline');
    const loadingMembers = members.filter((m) => m.state === 'loading');
    if (offline.length || loadingMembers.length) {
      const bits = [];
      if (loadingMembers.length) bits.push(`${loadingMembers.map((m) => m.name).join(', ')} still loading`);
      if (offline.length) bits.push(`${offline.map((m) => m.name).join(', ')} offline`);
      list.append(h('div.status-banner', { text: `${bits.join(' · ')}. Other playlists are listed below.` }));
    }
    list.append(reorder ? reorderBar() : headRow(prefsInfo));
    const groups = reorder ? reorder.ids.map(byId) : data.groups;
    for (const group of groups) list.append(groupItem(group, !focus && group.id === selectedId));
    if (!groups.length) list.append(h('div.empty', { text: 'All groups are hidden. Open Options and turn on "Show hidden groups".' }));
    container.append(list);
    container.scrollTop = scrollTop;

    if (focus) {
      const items = list.querySelectorAll('[data-group]');
      const target = (focus.id && itemEl(focus.id))
        || (focus.index !== undefined && items[Math.min(focus.index, items.length - 1)])
        || (focus.head && optionsBtn);
      if (target) focusEl(target);
    } else if (keepGroup) {
      const target = itemEl(keepGroup.id);
      if (target) target.focus({ preventScroll: true });
    }
  }

  function headText(p) {
    const parts = [`Sorted by ${SORT_LABELS[p.sort] || SORT_LABELS.playlist}`];
    if (p.hiddenCount) parts.push(`${p.hiddenCount} hidden${p.showHidden ? ' (shown)' : ''}`);
    return parts.join(' · ');
  }

  function headRow(p) {
    optionsBtn = h('button.btn.small.focusable', {
      text: '⋮ Options',
      onclick: () => listMenu({ anchor: optionsBtn }),
    });
    const row = h('div.list-head', {}, h('span.list-head-text', { text: headText(p) }), optionsBtn);
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      listMenu({ x: e.clientX, y: e.clientY });
    });
    return row;
  }

  function reorderBar() {
    optionsBtn = null;
    const done = h('button.btn.small.primary.focusable', { text: 'Done', onclick: () => finishReorder(true) });
    const cancel = h('button.btn.small.focusable', { text: 'Cancel', onclick: () => finishReorder(false) });
    return h('div.list-head.reorder-bar', {}, h('span.list-head-text', { text: reorderHint() }), cancel, done);
  }

  function reorderHint() {
    return reorder.moving
      ? 'Moving: Up/Down, ▲ ▼ or ⤒ ⤓ for top/bottom · OK drops it'
      : 'Drag groups, or select one to move it · Back saves';
  }

  function groupItem(group, autofocus) {
    const tail = reorder
      ? reorderButtons(h, reorder, group.id)
      : [h('span.count', { text: String(group.count) }), h('span.chev', { text: '›' })];
    const item = h('button.list-item.focusable', {
      'data-group': group.id,
      title: group.renamed ? `Playlist name: ${group.originalName}` : null,
    },
    reorder ? h('span.ro-handle', { text: '⠿', title: 'Drag to move' }) : null,
    h('span.name', { text: group.name }),
    group.custom ? h('span.tag.custom', { text: 'Custom' }) : null,
    group.hidden ? h('span.tag', { text: 'Hidden' }) : null,
    ...tail);
    if (group.hidden) item.classList.add('is-hidden');
    if (reorder) item.classList.add('reordering');
    if (reorder && reorder.moving === group.id) item.classList.add('moving');
    if (autofocus) item.setAttribute('data-autofocus', '');
    item.addEventListener('click', () => {
      if (reorder) {
        if (!reorder.takeClick()) reorder.toggle(group.id);
      } else {
        onPick(group);
      }
    });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (topModal()) return;
      item.focus({ preventScroll: true });
      const at = { x: e.clientX, y: e.clientY };
      if (reorder) reorderMenu(group, at);
      else groupMenu(group, at);
    });
    if (reorder) item.addEventListener('pointerdown', (e) => reorder.beginDrag(e, item, group.id));
    return item;
  }

  function sortItems() {
    const p = data.prefs || {};
    const sorts = ['name', 'playlist', 'count'];
    if (p.hasCustomOrder || p.sort === 'custom') sorts.push('custom');
    return sorts.map((sort) => ({
      label: SORT_LABELS[sort],
      checked: p.sort === sort,
      onSelect: () => {
        if (p.sort !== sort) save('/groups/prefs', { sort }, { index: 0 });
      },
    }));
  }

  function showHiddenItem(focus) {
    const p = data.prefs || {};
    return {
      label: 'Show hidden groups',
      checked: !!p.showHidden,
      hint: p.hiddenCount ? String(p.hiddenCount) : '',
      onSelect: () => save('/groups/prefs', { showHidden: !p.showHidden }, focus),
    };
  }

  function listMenu(at) {
    if (!data || reorder || topModal()) return;
    const custom = data.groups.filter((g) => g.custom);
    openMenu([
      { label: 'Reorder list', disabled: !data.groups.length, onSelect: () => startReorder(null) },
      { separator: true },
      { label: 'Add group', onSelect: () => addGroup(null) },
      {
        label: 'Delete group',
        disabled: !custom.length,
        hint: custom.length ? '' : 'None created',
        submenu: custom.filter((g) => !g.system).map((g) => ({ label: g.name, onSelect: () => deleteGroup(g) })),
      },
      { separator: true },
      { label: 'Order by', submenu: sortItems() },
      showHiddenItem({ head: true }),
    ], at);
  }

  function groupMenu(group, at) {
    openMenu([
      { label: 'Reorder groups', onSelect: () => startReorder(group.id) },
      { label: 'Move to top', onSelect: () => moveGroupToEdge(group, true) },
      { label: 'Move to bottom', onSelect: () => moveGroupToEdge(group, false) },
      { label: 'Rename group', onSelect: () => rename(group) },
      group.hidden
        ? { label: 'Show group', onSelect: () => setHidden(group, false) }
        : { label: 'Hide group', onSelect: () => setHidden(group, true) },
      { separator: true },
      { label: 'Add group', onSelect: () => addGroup(group) },
      { label: 'Copy group', onSelect: () => copyGroup(group) },
      {
        label: 'Delete group',
        disabled: !group.custom || group.system,
        hint: group.system ? 'System group' : group.custom ? '' : 'Playlist group',
        onSelect: () => deleteGroup(group),
      },
      { separator: true },
      { label: 'Order by', submenu: sortItems() },
      showHiddenItem({ id: group.id, index: data.groups.indexOf(group) }),
    ], at);
  }

  function reorderMenu(group, at) {
    openMenu([
      group && { label: 'Move to top', onSelect: () => reorder.moveTo(group.id, 0, { follow: false, pick: false }) },
      group && { label: 'Move to bottom', onSelect: () => reorder.moveTo(group.id, reorder.ids.length - 1, { follow: false, pick: false }) },
      group && { separator: true },
      { label: 'Done', onSelect: () => finishReorder(true) },
      { label: 'Cancel', onSelect: () => finishReorder(false) },
    ], at);
  }

  /** Moves a group to the top/bottom in place (the view stays where it is), then saves the order. */
  async function moveGroupToEdge(group, top) {
    const ids = data.groups.map((g) => g.id).filter((id) => id !== group.id);
    if (top) ids.unshift(group.id);
    else ids.push(group.id);
    const el = itemEl(group.id);
    if (el) {
      keepView(container, '[data-group]', () => {
        const items = container.querySelectorAll('[data-group]');
        const edge = top ? items[0] : items[items.length - 1];
        if (edge !== el) {
          if (top) edge.before(el);
          else edge.after(el);
        }
      }, el);
      el.focus({ preventScroll: true });
    }
    const byOrder = new Map(data.groups.map((g) => [g.id, g]));
    data.groups = ids.map((id) => byOrder.get(id));
    data.prefs = { ...data.prefs, sort: 'custom', hasCustomOrder: true };
    const head = container.querySelector('.list-head:not(.reorder-bar) .list-head-text');
    if (head) head.textContent = headText(data.prefs);
    try {
      await put('/groups/prefs', { order: ids });
    } catch (err) {
      toast(err.message, { error: true });
      await load({ id: group.id });
    }
  }

  async function addGroup(after) {
    const name = await promptDialog({ title: 'Add group', placeholder: 'Group name', okLabel: 'Create' });
    if (name === null || destroyed) return;
    if (!name.trim()) {
      toast('Enter a group name', { error: true });
      return;
    }
    const res = await save('/groups', { name, after: after ? after.id : null }, (r) => (r ? { id: r.id } : null), 'POST');
    if (res) toast('Group created. Long-press or right-click a channel → Add to group…', { ms: 5000 });
  }

  async function copyGroup(group) {
    const name = await promptDialog({ title: 'Copy group', value: `${group.name} (copy)`, okLabel: 'Copy' });
    if (name === null || destroyed) return;
    if (!name.trim()) {
      toast('Enter a group name', { error: true });
      return;
    }
    const res = await save('/groups', { name, copyFrom: group.id }, (r) => (r ? { id: r.id } : { id: group.id }), 'POST');
    if (res) toast(`Copied ${res.count} channel${res.count === 1 ? '' : 's'} into "${name.trim()}"`);
  }

  async function deleteGroup(group) {
    const ok = await confirmDialog({
      title: 'Delete group',
      message: `Delete "${group.name}"? The channels stay in your playlist.`,
      okLabel: 'Delete',
      danger: true,
    });
    if (!ok || destroyed) return;
    const index = data.groups.indexOf(group);
    const res = await save(`/groups/${encodeURIComponent(group.id)}`, undefined, { index: Math.max(0, index) }, 'DELETE');
    if (res) toast(`"${group.name}" deleted`);
  }

  async function rename(group) {
    const name = await promptDialog({
      title: 'Rename group',
      value: group.name,
      placeholder: group.originalName,
      hint: group.renamed
        ? `Playlist name: ${group.originalName}. Clear the field to restore it.`
        : 'Clear the field to restore the playlist name.',
    });
    if (name === null || destroyed) return;
    if (name.trim() === group.name) return;
    await save(`/groups/${encodeURIComponent(group.id)}`, { name }, { id: group.id });
  }

  async function setHidden(group, hidden) {
    const index = data.groups.indexOf(group);
    await save(`/groups/${encodeURIComponent(group.id)}`, { hidden }, { id: group.id, index });
    toast(hidden ? `"${group.name}" hidden` : `"${group.name}" is visible again`);
  }

  function startReorder(movingId) {
    reorder = createReorder(container, { attr: 'group', ids: data.groups.map((g) => g.id), moving: movingId, hint: reorderHint });
    render({ id: movingId, index: 0 });
  }

  async function finishReorder(keep) {
    if (!reorder) return;
    const { ids, moving } = reorder;
    const focusId = moving || (groupOf(document.activeElement) || {}).id;
    const changed = ids.some((id, i) => data.groups[i].id !== id);
    reorder.end();
    reorder = null;
    if (keep && changed) {
      await save('/groups/prefs', { order: ids }, { id: focusId, index: 0 });
      toast('Group order saved');
    } else {
      render({ id: focusId, index: 0 });
    }
  }

  function onKeyUp(e) {
    if (!press || keyAction(e) !== 'enter') return;
    clearTimeout(press.timer);
    const { group } = press;
    press = null;
    onPick(group);
  }

  function onTitleMenu(e) {
    e.preventDefault();
    listMenu({ x: e.clientX, y: e.clientY });
  }

  document.addEventListener('keyup', onKeyUp);
  if (titleEl) titleEl.addEventListener('contextmenu', onTitleMenu);

  container.style.overflowAnchor = 'none';
  container.replaceChildren(loadingPanel('Loading groups…'));
  await load();

  return {
    onKey(action, e) {
      if (!data) return false;
      const active = document.activeElement;
      const group = groupOf(active);
      if (action === 'menu') {
        if (reorder) reorderMenu(group, { anchor: active && container.contains(active) ? active : container, keyboard: true });
        else if (group) groupMenu(group, { anchor: active, keyboard: true });
        else listMenu({ anchor: optionsBtn || titleEl, keyboard: true });
        return true;
      }
      if (reorder) {
        if (action === 'enter' && group) {
          if (!e.repeat) reorder.toggle(group.id);
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
      if (action === 'enter' && group) {
        if (e.repeat || press) return true;
        press = {
          group,
          timer: setTimeout(() => {
            press = null;
            groupMenu(group, { anchor: active, keyboard: true });
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
      clearTimeout(loadTimer);
      if (press) clearTimeout(press.timer);
      press = null;
      document.removeEventListener('keyup', onKeyUp);
      if (titleEl) titleEl.removeEventListener('contextmenu', onTitleMenu);
    },
  };
}

/** Preview player bound to a container. Plays live channels muted-by-policy-aware. */
export function createPreview(container) {
  const video = h('video', { playsinline: true, 'webkit-playsinline': true });
  video.volume = prefs.get('volume', 100) / 100;
  const msg = h('div.overlay-msg', { text: 'Select a channel to preview' });
  const pauseBtn = h('button.pv-btn', {
    type: 'button',
    tabindex: '-1',
    onclick: (e) => {
      e.stopPropagation();
      if (video.paused) engine.resume();
      else engine.pause();
    },
  });
  const muteBtn = h('button.pv-btn', {
    type: 'button',
    tabindex: '-1',
    onclick: (e) => {
      e.stopPropagation();
      const wasPlaying = !video.paused;
      video.muted = !video.muted;
      if (!video.muted && video.volume === 0) video.volume = 1;
      // Browsers may pause media that gets unmuted under their autoplay rules; keep it playing.
      if (wasPlaying) setTimeout(() => { if (video.paused) engine.resume(); }, 0);
    },
  });
  const controls = h('div.pv-controls', {}, pauseBtn, muteBtn);
  const wrap = h('div.preview', {}, video, msg, controls);
  container.append(wrap);

  const syncControls = () => {
    pauseBtn.textContent = video.paused ? '▶' : '❚❚';
    pauseBtn.title = video.paused ? 'Play' : 'Pause';
    muteBtn.textContent = video.muted ? '🔇' : '🔊';
    muteBtn.title = video.muted ? 'Unmute' : 'Mute';
    // Keep the bar visible while the preview is muted by the browser's autoplay policy or paused.
    wrap.classList.toggle('pv-attention', !!playingKey && (video.muted || video.paused));
  };
  for (const evt of ['play', 'pause', 'volumechange', 'emptied']) video.addEventListener(evt, syncControls);
  // Touch screens have no hover: a tap on the video toggles the bar.
  video.addEventListener('click', (e) => {
    e.stopPropagation();
    wrap.classList.toggle('pv-show');
  });

  let channelId = null;
  let playingKey = null;
  let requestId = 0;
  const engine = new StreamPlayer(video, {
    onState(state) {
      if (state === 'playing') msg.textContent = '';
      else if (state === 'loading') msg.textContent = 'Loading…';
      else if (state === 'reconnecting') msg.textContent = 'Reconnecting…';
      else if (state === 'error') msg.textContent = 'This channel could not be played';
      syncControls();
    },
  });

  async function load(id, key, path, live) {
    if (key === playingKey) return;
    channelId = id;
    playingKey = key;
    const req = ++requestId;
    msg.textContent = 'Loading…';
    playerLog('preview.load', live ? 'live' : 'catchup', { id, path });
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => { try { ac?.abort(); } catch { /* ignore */ } }, 20000);
    try {
      const info = await get(path, ac ? { signal: ac.signal } : undefined);
      if (req !== requestId) return;
      playerLog('preview.play', info.kind || 'stream', {
        id,
        urls: Array.isArray(info.urls) ? info.urls.length : 0,
        live: !!live,
      });
      // Native VLC is a full-window underlay — preview must use the HTML video inside `.preview`.
      engine.play(info.urls, info.kind, { live, forceHtml: true });
    } catch (err) {
      const aborted = ac && err && (err.name === 'AbortError' || /abort/i.test(String(err.message || '')));
      const message = aborted ? 'Preview timed out (server busy or stuck)' : (err && err.message);
      playerLog('preview.error', message, { id, path, aborted: !!aborted }, { level: 'error' });
      if (req === requestId) {
        msg.textContent = message;
        toast(message, { error: true });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    el: wrap,
    get channelId() {
      return channelId;
    },
    /** `channelId` for live, `channelId@start` for catch-up. */
    get key() {
      return playingKey;
    },
    playChannel(id) {
      return load(id, id, `/play/live?ch=${encodeURIComponent(id)}`, true);
    },
    playCatchup(id, start, end) {
      return load(id, `${id}@${start}`, `/play/catchup?ch=${encodeURIComponent(id)}&start=${start}${end ? `&end=${end}` : ''}`, false);
    },
    stop() {
      requestId++;
      channelId = null;
      playingKey = null;
      syncControls();
      engine.stop();
      msg.textContent = 'Select a channel to preview';
    },
    destroy() {
      requestId++;
      engine.stop();
    },
  };
}

/** Distinguishes single vs double activation (click / Enter) on the same target. */
export function doubleActivator(ms = 400) {
  let lastKey = null;
  let lastAt = 0;
  return (key) => {
    const now = Date.now();
    const isDouble = key === lastKey && now - lastAt < ms;
    lastKey = isDouble ? null : key;
    lastAt = isDouble ? 0 : now;
    return isDouble;
  };
}
