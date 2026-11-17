import { get, post } from '../api.js';
import { h, fmtRange, toast, store } from '../util.js';
import { navigate, device } from '../app.js';
import { focusFirst } from '../nav.js';
import { topbar, groupPicker, createPreview, doubleActivator } from './common.js';
import { channelList } from './channelmanage.js';

export async function mount(root, params) {
  const saved = store.get('channels.state', {});
  const phone = device === 'phone';
  let groupId = params.group || null;
  let groupName = '';
  let preview = null;
  let infoReq = 0;
  const isDouble = doubleActivator();

  const titleBar = topbar('Channels');
  const titleEl = titleBar.querySelector('h1');
  const body = h('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:column' });
  root.append(titleBar, body);

  let picker = null;
  let list = null;

  function closePicker() {
    if (picker) picker.destroy();
    picker = null;
  }

  function closeList() {
    if (list) list.destroy();
    list = null;
  }

  async function showGroups() {
    groupId = null;
    if (preview) {
      preview.destroy();
      preview = null;
    }
    closePicker();
    closeList();
    titleEl.textContent = 'Channels';
    body.innerHTML = '';
    const scroll = h('div.scroll');
    body.append(scroll);
    const created = await groupPicker(scroll, (g) => openGroup(g.id, g.name), { selectedId: saved.groupId, titleEl });
    if (!scroll.isConnected) {
      created.destroy();
      return;
    }
    picker = created;
    focusFirst(scroll);
  }

  async function openGroup(id, name, { restored = false } = {}) {
    closePicker();
    closeList();
    groupId = id;
    groupName = name || groupName;
    store.set('channels.state', { ...saved, groupId: id, groupName });
    titleEl.textContent = groupName || 'Channels';
    body.innerHTML = '';

    const listCol = h('div.list-col');
    const side = h('div.side-col');
    const info = h('div.info-card', {}, h('h2', { text: 'Select a channel' }));
    if (phone) {
      // Phones: the whole screen is the list; a tap plays the channel, a long press opens its menu.
      body.append(h('div.channels-layout.phone-list', {}, listCol));
    } else {
      body.append(h('div.channels-layout', {}, listCol, side));
      preview = createPreview(side);
      side.append(info);
    }

    const markActive = () => {
      listCol.querySelectorAll('.list-item.active').forEach((el) => el.classList.remove('active'));
      const shown = info.dataset.shown;
      const item = shown && listCol.querySelector(`[data-ch="${CSS.escape(shown)}"]`);
      if (item) item.classList.add('active');
    };

    const created = await channelList(listCol, {
      groupId: id,
      titleEl,
      restoreId: saved.channelId,
      onActivate: (ch) => activate(ch),
      onRender: markActive,
      showNow: phone,
    });
    if (!listCol.isConnected || groupId !== id) {
      created.destroy();
      return;
    }
    list = created;
    if (!list.channels.length && restored) {
      store.set('channels.state', {});
      await showGroups();
      return;
    }
    const focused = list.channelOf(document.activeElement);
    if (focused && !phone) showInfo(focused);

    function activate(ch) {
      if (phone || isDouble(ch.id) || preview.channelId === ch.id) {
        store.set('channels.state', { groupId, groupName, channelId: ch.id });
        // Free the preview's live socket before the full player claims the account.
        if (preview && preview.stop) preview.stop();
        navigate(`player?ch=${encodeURIComponent(ch.id)}`);
        return;
      }
      showInfo(ch);
      preview.playChannel(ch.id);
    }

    async function showInfo(ch) {
      info.dataset.shown = ch.id;
      markActive();
      const req = ++infoReq;
      const favBtn = h('button.btn.small.focusable', {
        onclick: async () => {
          try {
            const res = await post(`/favorites/${encodeURIComponent(ch.id)}`);
            ch.fav = res.fav;
            favBtn.textContent = ch.fav ? '★ Remove favorite' : '☆ Add favorite';
            toast(ch.fav ? 'Added to favorites' : 'Removed from favorites');
          } catch (err) {
            toast(err.message, { error: true });
          }
        },
      }, ch.fav ? '★ Remove favorite' : '☆ Add favorite');
      const watchBtn = h('button.btn.small.primary.focusable', {
        onclick: () => {
          if (preview && preview.stop) preview.stop();
          navigate(`player?ch=${encodeURIComponent(ch.id)}`);
        },
      }, '▶ Watch');
      info.innerHTML = '';
      info.append(h('h2', { text: ch.name }), h('div.now', { text: 'Loading guide…' }), h('div.next'), h('div.desc'), h('div.actions', {}, watchBtn, favBtn));
      try {
        const now = await get(`/now?ch=${encodeURIComponent(ch.id)}`);
        if (req !== infoReq) return;
        info.querySelector('.now').textContent = now.current ? `Now: ${now.current.title} (${fmtRange(now.current.start, now.current.end)})` : 'No guide information';
        info.querySelector('.next').textContent = now.next ? `Next: ${now.next.title} at ${fmtRange(now.next.start, now.next.end)}` : '';
        info.querySelector('.desc').textContent = now.current ? now.current.desc : '';
      } catch {
        if (req === infoReq) info.querySelector('.now').textContent = '';
      }
    }

    // Keyboard focus moving over the list updates the info card (without starting playback).
    listCol.addEventListener('focusin', (e) => {
      if (phone) return;
      const ch = list && list.channelOf(e.target);
      if (ch) showInfo(ch);
    });
  }

  const cameFrom = params.from || '';
  if (groupId) {
    if (params.ch) saved.channelId = params.ch;
    await openGroup(groupId, params.name || (groupId === saved.groupId ? saved.groupName : ''), { restored: true });
  } else if (saved.groupId) await openGroup(saved.groupId, saved.groupName, { restored: true });
  else await showGroups();

  return {
    manageFocus: true,
    onKey(action, e) {
      if (picker) return picker.onKey(action, e);
      if (list) return list.onKey(action, e);
      return false;
    },
    onBack() {
      if (picker && picker.onBack()) return true;
      if (list && list.onBack()) return true;
      if (groupId && cameFrom) return false;
      if (groupId) {
        store.set('channels.state', {});
        showGroups();
        return true;
      }
      return false;
    },
    onTabReselect() {
      if (!groupId) return;
      store.set('channels.state', {});
      showGroups();
    },
    unmount() {
      closePicker();
      closeList();
      if (preview) preview.destroy();
    },
  };
}
