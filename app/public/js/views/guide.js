import { get, put } from '../api.js';
import { h, esc, fmtTime, fmtRange, dayLabel, store, debounce, toast } from '../util.js';
import { navigate, device } from '../app.js';
import { focusFirst, topModal } from '../nav.js';
import { openMenu } from '../menu.js';
import { groupPicker, createPreview, doubleActivator } from './common.js';
import { channelMenu, channelListMenuItems, listKey } from './channelmanage.js';
import {
  channelLogoHtml, harvestLogos, restoreLogos, preloadLogos, rememberLogo, proxiedLogo,
} from '../chlogo.js';
import { applyHubHighlight } from '../theme.js';
import { playerLog } from '../player-debug.js';

const MIN = 60000;
const SLOT = 30 * MIN;
const HOUR = 60 * MIN;
const BUFFER_ROWS = 4;
const BUFFER_TIME = 90 * MIN;

const floorTo = (t, step) => Math.floor(t / step) * step;

/** Past blocks (shows, or half-hour "No Information" slots) inside a catch-up channel's archive. */
function canCatchup(ch, block, now) {
  const end = block.oe ?? block.e;
  if (!ch.catchup || end > now) return false;
  return (block.os ?? block.s) >= now - (ch.catchupDays || 7) * 24 * HOUR;
}

/** Fills gaps between programmes with "No Information" blocks split on 30-minute boundaries. */
function buildBlocks(programmes, gridStart, gridEnd) {
  const blocks = [];
  const pushGap = (from, to) => {
    let t = from;
    while (t < to) {
      const next = Math.min(to, floorTo(t, SLOT) + SLOT);
      blocks.push({ s: t, e: next, t: 'No Information', ph: true });
      t = next;
    }
  };
  let cursor = gridStart;
  for (const [s, e, title, hasDesc] of programmes) {
    const start = Math.max(s, gridStart);
    const end = Math.min(e, gridEnd);
    if (end <= cursor) continue;
    if (start > cursor) pushGap(cursor, start);
    blocks.push({ s: Math.max(start, cursor), e: end, os: s, oe: e, t: title, d: !!hasDesc, ph: false });
    cursor = end;
  }
  if (cursor < gridEnd) pushGap(cursor, gridEnd);
  return blocks;
}

function blockIndexAt(blocks, time) {
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].e <= time) lo = mid + 1;
    else if (blocks[mid].s > time) hi = mid - 1;
    else return mid;
  }
  return Math.max(0, Math.min(blocks.length - 1, lo));
}

export async function mount(root, params) {
  playerLog('guide.mount', 'open', { params, device });
  const saved = store.get('guide.state', {});
  let settings = {};
  try {
    settings = await get('/settings');
  } catch {
    settings = {};
  }
  applyHubHighlight(settings.hubHighlight);

  const body = h('div.guide-body');
  root.append(body);

  let grid = null;
  let picker = null;

  function closePicker() {
    if (picker) picker.destroy();
    picker = null;
  }

  async function showGroups() {
    if (grid) {
      grid.destroy();
      grid = null;
    }
    closePicker();
    body.innerHTML = '';
    const scroll = h('div.scroll');
    body.append(scroll);
    const created = await groupPicker(scroll, (g) => openGroup(g), { selectedId: saved.groupId });
    if (!scroll.isConnected) {
      created.destroy();
      return;
    }
    picker = created;
    focusFirst(scroll);
  }

  async function openGroup(group, { restored = false } = {}) {
    playerLog('guide.openGroup', restored ? 'restored' : 'pick', {
      id: group && group.id,
      name: group && group.name,
      autoPlayPreview: settings.autoPlayPreview !== false,
      phone: device === 'phone',
    });
    closePicker();
    saved.groupId = group.id;
    saved.groupName = group.name;
    store.set('guide.state', saved);
    body.innerHTML = '<div class="empty">Loading guide…</div>';
    const now = Date.now();
    const gridStart = floorTo(now - (settings.guidePastHours ?? 60) * HOUR, SLOT);
    const gridEnd = floorTo(now + (settings.guideFutureHours ?? 84) * HOUR, SLOT) + SLOT;
    let data;
    try {
      data = await get(`/guide?group=${encodeURIComponent(group.id)}&start=${gridStart}&end=${gridEnd}`);
    } catch (err) {
      playerLog('guide.openGroup.error', err && err.message, { id: group && group.id }, { level: 'error' });
      body.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
      return;
    }
    if (!data.rows.length) {
      if (restored) {
        saved.groupId = null;
        saved.sel = null;
        store.set('guide.state', saved);
        await showGroups();
        return;
      }
      body.innerHTML = '<div class="empty">No channels in this group.</div>';
      return;
    }
    body.innerHTML = '';
    grid = createGuideGrid(body, data, {
      gridStart,
      gridEnd,
      settings,
      saved,
      onGroupChanged: (change) => {
        if (change?.id && grid?.patchChannel && ['epg', 'logo', 'rename', 'hidden'].includes(change.kind)) {
          grid.patchChannel(change.id, { reloading: change.kind === 'epg' && !!change.reloading });
          return;
        }
        if (grid) grid.destroy();
        grid = null;
        openGroup(group);
      },
    });
  }

  if (params.group && params.ch) {
    saved.sel = { ch: params.ch, t: Number(params.t) || Date.now() };
    store.set('guide.state', saved);
  }
  if (params.group) await openGroup({ id: params.group, name: params.name || (params.group === saved.groupId && saved.groupName) || 'TV Guide' }, { restored: true });
  else if (saved.groupId) await openGroup({ id: saved.groupId, name: saved.groupName || 'TV Guide' }, { restored: true });
  else await showGroups();

  return {
    manageFocus: true,
    onKey(action, e) {
      if (grid) return grid.onKey(action);
      return picker ? picker.onKey(action, e) : false;
    },
    onBack() {
      if (picker && picker.onBack()) return true;
      if (grid && grid.onBack()) return true;
      // Guide grid → groups list
      if (grid) {
        saved.groupId = null;
        saved.sel = null;
        store.set('guide.state', saved);
        showGroups();
        return true;
      }
      // Groups list → Home
      navigate('home');
      return true;
    },
    onTabReselect() {
      if (grid) {
        saved.groupId = null;
        saved.sel = null;
        store.set('guide.state', saved);
        showGroups();
        return true;
      }
      return false;
    },
    unmount() {
      closePicker();
      if (grid) grid.destroy();
    },
  };
}

function createGuideGrid(container, data, { gridStart, gridEnd, settings, saved, titleEl, onGroupChanged }) {
  const rows = data.rows.map((r) => ({ ch: r.ch, blocks: buildBlocks(r.p, gridStart, gridEnd) }));
  const isDouble = doubleActivator();

  // ---------- layout ----------
  const epg = h('div.epg', { tabindex: '0' });
  const inner = h('div.epg-inner');
  const header = h('div.epg-header');
  const corner = h('div.epg-corner', { text: 'Today' });
  const ticks = h('div');
  const rowsEl = h('div.epg-rows');
  const nowLine = h('div.epg-now');
  header.append(corner, ticks);
  rowsEl.append(nowLine);
  // Proxy always serves an image; keep the node and remember successful paints.
  rowsEl.addEventListener('load', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.classList.contains('ch-logo')) return;
    const host = img.closest('[data-ch-id]');
    if (host && host.dataset.chId) rememberLogo(host.dataset.chId, img);
  }, true);
  inner.append(header, rowsEl);
  epg.append(inner);
  const wrap = h('div.guide-grid-wrap', {}, epg);
  const previewHost = h('div.guide-dock-preview');
  const previewLive = h('span.hub-live-badge.guide-preview-live', { text: 'LIVE' });
  previewLive.hidden = true;
  const details = h('div.details.guide-dock-copy');
  const poster = h('div.guide-dock-poster');
  poster.hidden = true;
  const dock = h('div.guide-dock', {}, previewHost, details, poster);
  const guide = h('div.guide', {}, wrap, dock);
  container.append(guide);
  // Phones skip the preview player: the grid needs the room, and a tap on a show plays it full screen.
  const phone = device === 'phone';
  const preview = phone
    ? { key: null, channelId: null, playChannel: () => Promise.resolve(), playCatchup: () => Promise.resolve(), destroy() {} }
    : createPreview(previewHost);
  if (phone) previewHost.hidden = true;
  else previewHost.append(previewLive);

  // ---------- metrics ----------
  let rowH = 0;
  let chW = 0;
  let headerH = 0;
  let ppm = 0; // pixels per minute
  const totalMinutes = (gridEnd - gridStart) / MIN;

  function measure() {
    const rootCs = getComputedStyle(document.documentElement);
    const cs = getComputedStyle(guide);
    const rem = parseFloat(rootCs.fontSize) || 16;
    const val = (name) => {
      const raw = (cs.getPropertyValue(name) || rootCs.getPropertyValue(name)).trim();
      return raw.endsWith('rem') ? parseFloat(raw) * rem : parseFloat(raw);
    };
    rowH = val('--row-h');
    chW = val('--ch-w');
    headerH = val('--header-h');
    const width = epg.clientWidth || window.innerWidth;
    const auto = width < 600 ? 1.5 : width < 1000 ? 2.5 : 3.5;
    const hours = settings.guideHoursVisible > 0 ? settings.guideHoursVisible : auto;
    ppm = Math.max(1.2, (width - chW) / (hours * 60));
    inner.style.width = `${chW + totalMinutes * ppm}px`;
    inner.style.height = `${headerH + rows.length * rowH}px`;
    rowsEl.style.height = `${rows.length * rowH}px`;
    header.style.width = `${chW + totalMinutes * ppm}px`;
    renderTicks();
  }

  const xOf = (time) => chW + ((time - gridStart) / MIN) * ppm;
  const timeAtX = (x) => gridStart + ((x - chW) / ppm) * MIN;

  function viewRange() {
    const start = timeAtX(epg.scrollLeft + chW);
    const end = timeAtX(epg.scrollLeft + epg.clientWidth);
    return { start, end };
  }

  function renderTicks() {
    // Only paint ticks for the visible time window (+ buffer). A full 144h grid
    // used to leave ~288 tick nodes in the DOM at all times.
    const range = viewRange();
    const from = Math.max(gridStart, floorTo(range.start - BUFFER_TIME, SLOT));
    const to = Math.min(gridEnd, floorTo(range.end + BUFFER_TIME, SLOT) + SLOT);
    let html = '';
    for (let t = from; t < to; t += SLOT) {
      const d = new Date(t);
      const isDay = d.getHours() === 0 && d.getMinutes() === 0;
      const label = isDay ? `${dayLabel(t)}  ${fmtTime(t)}` : fmtTime(t);
      html += `<div class="epg-tick${isDay ? ' day' : ''}" style="left:${xOf(t)}px;width:${SLOT / MIN * ppm}px">${esc(label)}</div>`;
    }
    ticks.innerHTML = html;
  }

  // ---------- selection ----------
  // `cursor` is the selected 30-minute slot. Up/Down keep it; Left/Right move it one slot at a time.
  let selRow = 0;
  let selBlock = 0;
  let cursor = floorTo(Date.now(), SLOT);
  // Reorder ("move") mode: { id, original: channel ids before the move } while a row is being moved.
  let moving = null;
  const clampSlot = (t) => Math.max(gridStart, Math.min(floorTo(gridEnd - 1, SLOT), floorTo(t, SLOT)));

  function selected() {
    const row = rows[selRow];
    return row ? { row, block: row.blocks[selBlock] } : null;
  }

  // ---------- virtual rendering ----------
  let renderKey = '';
  let rafId = 0;

  function cellHtml(r, b, block, now) {
    const classes = ['epg-cell'];
    if (block.ph) classes.push('ph');
    else if (block.e <= now) classes.push('past');
    else if (block.s <= now) classes.push('live');
    if (canCatchup(rows[r].ch, block, now)) classes.push('cu');
    if (r === selRow && b === selBlock) classes.push('sel');
    const left = xOf(block.s);
    const width = Math.max(4, (block.e - block.s) / MIN * ppm - 3);
    const time = block.ph ? '' : `<span class="s">${esc(fmtTime(block.os ?? block.s))}</span>`;
    return `<div class="${classes.join(' ')}" data-r="${r}" data-b="${b}" style="left:${left}px;width:${width}px">${time}<span class="t">${esc(block.t)}</span></div>`;
  }

  function render(force = false) {
    rafId = 0;
    const top = epg.scrollTop;
    const first = Math.max(0, Math.floor(top / rowH) - BUFFER_ROWS);
    const last = Math.min(rows.length - 1, Math.ceil((top + epg.clientHeight) / rowH) + BUFFER_ROWS);
    const range = viewRange();
    const tFrom = floorTo(range.start - BUFFER_TIME, SLOT);
    const tTo = floorTo(range.end + BUFFER_TIME, SLOT) + SLOT;
    const key = `${first}:${last}:${tFrom}:${tTo}:${selRow}:${selBlock}:${preview.channelId}:${moving ? moving.id : ''}`;
    corner.textContent = dayLabel(range.start + MIN);
    if (!force && key === renderKey) return;
    renderKey = key;

    const now = Date.now();
    const showNum = false;
    // Keep painted logos across virtual re-renders so scrolling does not unload them.
    harvestLogos(rowsEl);
    let html = '';
    const warm = [];
    for (let r = first; r <= last; r++) {
      const { ch, blocks } = rows[r];
      warm.push(ch);
      const chClasses = ['epg-ch'];
      if (preview.channelId === ch.id) chClasses.push('previewing');
      if (ch.hidden) chClasses.push('is-hidden');
      if (moving && moving.id === ch.id) chClasses.push('moving');
      html += `<div class="epg-row${moving && moving.id === ch.id ? ' moving' : ''}" style="top:${r * rowH}px;width:${chW + totalMinutes * ppm}px">`;
      html += `<div class="${chClasses.join(' ')}" data-ch-row="${r}" data-ch-id="${esc(ch.id)}"${ch.renamed ? ` title="${esc(`Playlist name: ${ch.originalName}`)}"` : ''}>`
        + `${showNum ? `<span class="num">${esc(ch.num)}</span>` : ''}`
        + channelLogoHtml(ch)
        + `<span class="nm">${esc(ch.name)}</span>${ch.catchup ? '<span class="cu" title="Catch-up">⟲</span>' : ''}</div>`;
      let b = blockIndexAt(blocks, tFrom);
      for (; b < blocks.length && blocks[b].s < tTo; b++) html += cellHtml(r, b, blocks[b], now);
      html += '</div>';
    }
    rowsEl.innerHTML = html;
    rowsEl.append(nowLine);
    restoreLogos(rowsEl);
    renderTicks();
    // Prefetch nearby + a few ahead so scroll does not wait on dead hosts.
    const ahead = rows.slice(last + 1, last + 25).map((r) => r.ch);
    preloadLogos(warm.concat(ahead));
    updateNowLine();
  }

  function schedule() {
    if (!rafId) rafId = requestAnimationFrame(() => render());
  }

  function updateNowLine() {
    const now = Date.now();
    nowLine.style.display = now >= gridStart && now <= gridEnd ? '' : 'none';
    nowLine.style.left = `${xOf(now)}px`;
  }

  // ---------- details ----------
  let detailReq = 0;

  function episodeFromTitle(title) {
    const m = /\bS(\d{1,2})\s*E(\d{1,3})\b/i.exec(title) || /\b(\d{1,2})x(\d{1,3})\b/i.exec(title);
    if (!m) return '';
    return `S${Number(m[1])} E${Number(m[2])}`;
  }

  function showPoster(src) {
    if (!src) {
      poster.hidden = true;
      poster.replaceChildren();
      return;
    }
    const img = h('img', {
      alt: '',
      referrerpolicy: 'no-referrer',
      onerror: () => { poster.hidden = true; },
    });
    img.src = src;
    poster.hidden = false;
    poster.replaceChildren(img);
  }

  const loadDescription = debounce(async (req, ch, block) => {
    try {
      const p = await get(`/program?ch=${encodeURIComponent(ch.id)}&start=${block.os}`);
      if (req !== detailReq) return;
      const desc = details.querySelector('.desc');
      if (desc && p.desc) desc.textContent = p.desc;
    } catch {
      /* description is optional */
    }
  }, 200);

  const loadArt = debounce(async (req, title, ch) => {
    const fallback = proxiedLogo((ch && (ch.logo || ch.playlistLogo || ch.epgLogo)) || '', ch && ch.name);
    try {
      const art = await get(`/guide/art?title=${encodeURIComponent(title)}`);
      if (req !== detailReq) return;
      const desc = details.querySelector('.desc');
      if (desc && art.plot && !desc.textContent) desc.textContent = art.plot;
      const ratingEl = details.querySelector('[data-rating]');
      if (ratingEl && art.rating && !/^[0-9.]+$/.test(art.rating)) ratingEl.textContent = art.rating;
      showPoster(art.poster || art.backdrop || fallback);
    } catch {
      if (req === detailReq) showPoster(fallback);
    }
  }, 200);

  function renderDetails() {
    const sel = selected();
    if (!sel || !sel.block) return;
    if (moving) {
      previewLive.hidden = true;
      poster.hidden = true;
      if (!details.classList.contains('is-moving')) {
        details.style.setProperty('--details-h', `${details.offsetHeight}px`);
        details.classList.add('is-moving');
      }
      details.innerHTML = `<h2>${esc(`Moving ${sel.row.ch.name}`)}</h2>`
        + '<div class="time">Up/Down moves it · Page Up/Down jumps to top/bottom · click a row to move it there</div>'
        + '<div class="time">OK or Back drops it here</div>';
      const done = h('button.btn.small.primary.focusable', { text: 'Done', onclick: () => endMove(true) });
      const cancel = h('button.btn.small.focusable', { text: 'Cancel', onclick: () => endMove(false) });
      details.append(h('div.actions', { style: 'display:flex;gap:0.5rem;margin-top:0.6rem' }, done, cancel));
      return;
    }
    details.classList.remove('is-moving');
    const { row, block } = sel;
    const now = Date.now();
    const start = block.os ?? block.s;
    const end = block.oe ?? block.e;
    const live = !block.ph && start <= now && end > now;
    const catchup = canCatchup(row.ch, block, now);
    if (live) {
      previewLive.hidden = false;
      previewLive.textContent = 'LIVE';
      previewLive.classList.remove('is-catchup');
    } else if (catchup) {
      previewLive.hidden = false;
      previewLive.textContent = 'CATCH-UP';
      previewLive.classList.add('is-catchup');
    } else {
      previewLive.hidden = true;
      previewLive.classList.remove('is-catchup');
    }
    const meta = [];
    if (row.ch.name) meta.push(row.ch.name);
    const ep = episodeFromTitle(block.t);
    if (ep) meta.push(ep);
    meta.push(`${dayLabel(start)} · ${fmtRange(start, end)}`);
    const badge = live
      ? '<span class="hub-live-badge">LIVE</span>'
      : (catchup ? '<span class="hub-live-badge is-catchup">CATCH-UP</span>' : '');
    details.innerHTML = `<div class="guide-dock-title">${badge}<h2>${esc(block.ph ? row.ch.name : block.t)}</h2></div>`
      + `<div class="chan">${esc(meta.join('  •  '))}<span data-rating></span></div>`
      + '<div class="desc"></div>';
    const req = ++detailReq;
    if (block.ph) {
      showPoster(proxiedLogo(row.ch.logo || row.ch.playlistLogo || row.ch.epgLogo || '', row.ch.name));
    } else {
      if (block.d) loadDescription(req, row.ch, block);
      loadArt(req, block.t, row.ch);
    }
    if (phone) details.append(phoneActions(row, block, start, end, now));
  }

  function phoneActions(row, block, start, end, now) {
    const btn = (text, onclick, primary) => h(`button.btn.small.focusable${primary ? '.primary' : ''}`, { type: 'button', text, onclick });
    const live = start <= now && end > now;
    const buttons = [];
    if (canCatchup(row.ch, block, now)) buttons.push(btn(block.ph ? '⟲ Play from here' : '⟲ Watch', playSelected, true));
    else if (live || block.ph) buttons.push(btn('▶ Watch live', playSelected, true));
    else buttons.push(btn('▶ Watch channel', () => navigate(`player?ch=${encodeURIComponent(row.ch.id)}`), true));
    if (live && row.ch.catchup && !block.ph) {
      buttons.push(btn('⟲ From start', () => navigate(`player?ch=${encodeURIComponent(row.ch.id)}&start=${start}`)));
    }
    buttons.push(btn('⋮', (e) => openChannelMenu(selRow, { anchor: e.currentTarget })));
    return h('div.phone-actions', {}, ...buttons);
  }

  // ---------- navigation ----------
  function ensureVisible() {
    const sel = selected();
    if (!sel) return;
    const visibleH = epg.clientHeight - headerH;
    const rowTop = selRow * rowH;
    if (rowTop < epg.scrollTop) epg.scrollTop = rowTop;
    else if (rowTop + rowH > epg.scrollTop + visibleH) epg.scrollTop = rowTop + rowH - visibleH;

    // The selected 30-minute slot is always the first visible column.
    epg.scrollLeft = Math.max(0, xOf(cursor) - chW);
  }

  function select(r, b, { scroll = true, keepCursor = false } = {}) {
    selRow = Math.max(0, Math.min(rows.length - 1, r));
    const blocks = rows[selRow].blocks;
    selBlock = Math.max(0, Math.min(blocks.length - 1, b));
    const block = blocks[selBlock];
    if (!keepCursor || cursor < floorTo(block.s, SLOT) || cursor >= block.e) {
      cursor = clampSlot(Math.max(block.s, keepCursor ? cursor : viewRange().start));
    }
    saved.sel = { ch: rows[selRow].ch.id, t: cursor };
    store.set('guide.state', saved);
    if (scroll) ensureVisible();
    render(true);
    renderDetails();
  }

  function selectRowAtCursor(r) {
    const row = rows[Math.max(0, Math.min(rows.length - 1, r))];
    select(r, blockIndexAt(row.blocks, cursor), { keepCursor: true });
  }

  /** Moves to the previous/next show; the slot becomes that show's start rounded down to 30 minutes. */
  function moveHorizontal(dir) {
    const neighbour = rows[selRow].blocks[selBlock + dir];
    if (!neighbour) return;
    cursor = clampSlot(neighbour.s);
    select(selRow, selBlock + dir, { keepCursor: true });
  }

  function playSelected() {
    const sel = selected();
    if (!sel) return;
    const { row, block } = sel;
    const now = Date.now();
    const start = block.os ?? block.s;
    const end = block.oe ?? block.e;
    saved.sel = { ch: row.ch.id, t: cursor };
    store.set('guide.state', saved);
    runPreview.cancel();
    // Free the provider connection before the full player opens the same account.
    if (preview && preview.stop) preview.stop();
    if (canCatchup(row.ch, block, now)) {
      navigate(`player?ch=${encodeURIComponent(row.ch.id)}&start=${start}${block.ph ? '' : `&end=${end}`}`);
    } else if (!block.ph && start > now) {
      toast('This programme has not started yet. Playing the channel live.');
      navigate(`player?ch=${encodeURIComponent(row.ch.id)}`);
    } else {
      navigate(`player?ch=${encodeURIComponent(row.ch.id)}`);
    }
  }

  /** Live for current/future; catch-up URL when the selected block is in the archive. */
  function previewTarget(row, block) {
    const now = Date.now();
    if (block && canCatchup(row.ch, block, now)) {
      const start = block.os ?? block.s;
      const end = block.oe ?? block.e;
      return {
        key: `${row.ch.id}@${start}`,
        catchup: true,
        start,
        end: block.ph ? 0 : end,
      };
    }
    return { key: row.ch.id, catchup: false, start: 0, end: 0 };
  }

  /** Debounced so rapid EPG clicks don't thrash mpegts (AbortError on every remount). */
  const runPreview = debounce(() => {
    const sel = selected();
    if (!sel) return;
    const target = previewTarget(sel.row, sel.block);
    if (preview.key === target.key) {
      render(true);
      return;
    }
    const done = () => render(true);
    if (target.catchup) {
      preview.playCatchup(sel.row.ch.id, target.start, target.end || undefined).then(done);
    } else {
      preview.playChannel(sel.row.ch.id).then(done);
    }
    render(true);
  }, 450);

  function startPreview() {
    const sel = selected();
    const target = sel ? previewTarget(sel.row, sel.block) : null;
    playerLog('guide.preview', 'start', {
      ch: sel && sel.row && sel.row.ch && sel.row.ch.id,
      name: sel && sel.row && sel.row.ch && sel.row.ch.name,
      catchup: !!(target && target.catchup),
      start: target && target.start,
      auto: settings.autoPlayPreview !== false,
    });
    runPreview();
  }

  function activateSelection() {
    const sel = selected();
    if (!sel) return;
    const key = `${selRow}:${selBlock}`;
    const target = previewTarget(sel.row, sel.block);
    if (isDouble(key) || preview.key === target.key) {
      playSelected();
      return;
    }
    startPreview();
  }

  // ---------- channel order ----------
  const saveOrder = async () => {
    try {
      await put(`/channel-list/${encodeURIComponent(listKey(saved.groupId))}`, { order: rows.map((r) => r.ch.id) });
      data.prefs = { ...data.prefs, sort: 'custom', hasCustomOrder: true };
      return true;
    } catch (err) {
      toast(err.message, { error: true });
      return false;
    }
  };

  function startMove(r = selRow) {
    if (r !== selRow) selectRowAtCursor(r);
    moving = { id: rows[selRow].ch.id, original: rows.map((row) => row.ch.id) };
    render(true);
    renderDetails();
  }

  /** Moves the row being reordered to index `to`, following it with the selection. */
  function moveSelectedTo(to) {
    const target = Math.max(0, Math.min(rows.length - 1, to));
    if (target === selRow) return;
    const [row] = rows.splice(selRow, 1);
    rows.splice(target, 0, row);
    selRow = target;
    selBlock = blockIndexAt(row.blocks, cursor);
    ensureVisible();
    render(true);
    renderDetails();
  }

  async function endMove(keep) {
    if (!moving) return;
    const { id, original } = moving;
    moving = null;
    if (!keep) {
      const pos = new Map(original.map((cid, i) => [cid, i]));
      rows.sort((a, b) => pos.get(a.ch.id) - pos.get(b.ch.id));
      selRow = rows.findIndex((row) => row.ch.id === id);
      selBlock = blockIndexAt(rows[selRow].blocks, cursor);
      ensureVisible();
    }
    render(true);
    renderDetails();
    if (keep && rows.some((row, i) => row.ch.id !== original[i]) && (await saveOrder())) toast('Channel order saved');
  }

  /** Moves a row to the top/bottom without moving the view; the selection stays on the same screen row. */
  async function moveRowToEdge(r, top) {
    const selectedId = rows[selRow].ch.id;
    const [row] = rows.splice(r, 1);
    if (top) rows.unshift(row);
    else rows.push(row);
    if (selectedId !== row.ch.id) selRow = rows.findIndex((x) => x.ch.id === selectedId);
    selBlock = blockIndexAt(rows[selRow].blocks, cursor);
    saved.sel = { ch: rows[selRow].ch.id, t: cursor };
    store.set('guide.state', saved);
    render(true);
    renderDetails();
    await saveOrder();
  }

  function moveMenu(at) {
    openMenu([
      { label: 'Move to top', onSelect: () => moveSelectedTo(0) },
      { label: 'Move to bottom', onSelect: () => moveSelectedTo(rows.length - 1) },
      { separator: true },
      { label: 'Done', onSelect: () => endMove(true) },
      { label: 'Cancel', onSelect: () => endMove(false) },
    ], at);
  }

  function onMoveKey(action) {
    if (action === 'up' || action === 'down') moveSelectedTo(selRow + (action === 'up' ? -1 : 1));
    else if (action === 'pageup') moveSelectedTo(0);
    else if (action === 'pagedown') moveSelectedTo(rows.length - 1);
    else if (action === 'enter') endMove(true);
    else if (action === 'menu') moveMenu({ anchor: rowsEl.querySelector(`[data-ch-row="${selRow}"]`) || epg, keyboard: true });
    return true;
  }

  function onKey(action) {
    if (moving) return onMoveKey(action);
    const pageRows = Math.max(1, Math.floor((epg.clientHeight - headerH) / rowH) - 1);
    switch (action) {
      case 'left':
        moveHorizontal(-1);
        return true;
      case 'right':
        moveHorizontal(1);
        return true;
      case 'up':
        if (selRow > 0) selectRowAtCursor(selRow - 1);
        return true;
      case 'down':
        if (selRow < rows.length - 1) selectRowAtCursor(selRow + 1);
        return true;
      case 'pageup':
        selectRowAtCursor(selRow - pageRows);
        return true;
      case 'pagedown':
        selectRowAtCursor(selRow + pageRows);
        return true;
      case 'enter':
        activateSelection();
        return true;
      case 'playpause':
        playSelected();
        return true;
      case 'menu': {
        const anchor = rowsEl.querySelector(`[data-ch-row="${selRow}"]`) || epg;
        openChannelMenu(selRow, { anchor, keyboard: true });
        return true;
      }
      default:
        return false;
    }
  }

  function openChannelMenu(r, at) {
    const ch = rows[r].ch;
    channelMenu(ch, at, {
      groupId: saved.groupId,
      listPrefs: data.prefs || {},
      onChanged: onGroupChanged,
      reorder: () => startMove(r),
      moveToEdge: (top) => moveRowToEdge(rows.findIndex((row) => row.ch.id === ch.id), top),
    });
  }

  function onTitleMenu(e) {
    e.preventDefault();
    if (topModal() || moving) return;
    openMenu(channelListMenuItems({
      groupId: saved.groupId,
      listPrefs: data.prefs || {},
      onChanged: onGroupChanged,
      reorder: () => startMove(),
    }), { x: e.clientX, y: e.clientY });
  }
  if (titleEl) titleEl.addEventListener('contextmenu', onTitleMenu);
  corner.addEventListener('contextmenu', onTitleMenu);

  const rowOf = (target) => {
    const cell = target.closest('.epg-cell, .epg-ch');
    if (!cell) return -1;
    const r = Number(cell.classList.contains('epg-ch') ? cell.dataset.chRow : cell.dataset.r);
    return rows[r] ? r : -1;
  };

  rowsEl.addEventListener('contextmenu', (e) => {
    const r = rowOf(e.target);
    if (r < 0) return;
    e.preventDefault();
    if (topModal()) return;
    if (moving) moveMenu({ x: e.clientX, y: e.clientY });
    else openChannelMenu(r, { x: e.clientX, y: e.clientY });
  });

  // ---------- pointer / touch ----------
  rowsEl.addEventListener('click', (e) => {
    if (moving) {
      const r = rowOf(e.target);
      if (r >= 0) moveSelectedTo(r);
      return;
    }
    const cell = e.target.closest('.epg-cell');
    if (cell) {
      const r = Number(cell.dataset.r);
      const b = Number(cell.dataset.b);
      const already = r === selRow && b === selBlock;
      select(r, b, { scroll: false });
      const target = previewTarget(rows[r], rows[r].blocks[b]);
      if ((already || isDouble(`${r}:${b}`)) && (phone || preview.key === target.key)) playSelected();
      else if (!phone) startPreview();
      return;
    }
    const chCell = e.target.closest('.epg-ch');
    if (chCell) {
      const r = Number(chCell.dataset.chRow);
      const ch = rows[r].ch;
      selectRowAtCursor(r);
      const target = previewTarget(rows[r], rows[r].blocks[selBlock]);
      if (phone || preview.key === target.key || preview.key === ch.id) {
        runPreview.cancel();
        if (preview && preview.stop) preview.stop();
        navigate(`player?ch=${encodeURIComponent(ch.id)}`);
      } else if (!phone) startPreview();
    }
  });
  epg.addEventListener('scroll', schedule, { passive: true });
  const onResize = debounce(() => {
    const anchor = viewRange().start;
    measure();
    epg.scrollLeft = Math.max(0, xOf(anchor) - chW);
    render(true);
  }, 150);
  window.addEventListener('resize', onResize);
  // Move the "now" needle only — a full grid rebuild every 30s was pure jank.
  const nowTimer = setInterval(updateNowLine, 30000);

  // ---------- initial state ----------
  measure();
  let initialRow = 0;
  let initialTime = Date.now();
  if (saved.sel) {
    const idx = rows.findIndex((r) => r.ch.id === saved.sel.ch);
    if (idx >= 0) {
      initialRow = idx;
      initialTime = saved.sel.t;
    }
  }
  epg.scrollLeft = Math.max(0, xOf(floorTo(Math.min(initialTime, Date.now()), SLOT)) - chW);
  if (initialTime > Date.now()) epg.scrollLeft = Math.max(0, xOf(floorTo(initialTime, SLOT)) - chW);
  cursor = clampSlot(initialTime);
  select(initialRow, blockIndexAt(rows[initialRow].blocks, cursor), { keepCursor: true });
  epg.focus({ preventScroll: true });
  if (!phone && settings.autoPlayPreview !== false) {
    playerLog('guide.autoPreview', 'enabled — will call startPreview');
    startPreview();
  } else {
    playerLog('guide.autoPreview', phone ? 'skipped (phone)' : 'disabled');
  }

  let patchTimer = null;
  async function patchChannel(id, { reloading = false } = {}) {
    const idx = rows.findIndex((r) => r.ch.id === id);
    if (idx < 0) return;
    if (patchTimer) {
      clearInterval(patchTimer);
      patchTimer = null;
    }
    const apply = async () => {
      const row = await get(`/channels/${encodeURIComponent(id)}/guide?start=${gridStart}&end=${gridEnd}`);
      const i = rows.findIndex((r) => r.ch.id === id);
      if (i < 0) return row;
      const top = epg.scrollTop;
      const left = epg.scrollLeft;
      rows[i].ch = { ...rows[i].ch, ...row.ch };
      rows[i].blocks = buildBlocks(row.p, gridStart, gridEnd);
      renderKey = '';
      render(true);
      if (i === selRow) {
        const block = blockIndexAt(rows[i].blocks, cursor);
        select(i, block, { keepCursor: true, scroll: false });
      } else {
        render(true);
      }
      epg.scrollTop = top;
      epg.scrollLeft = left;
      return row;
    };
    try {
      const row = await apply();
      if (!reloading && !row.pending) return;
      const started = Date.now();
      patchTimer = setInterval(async () => {
        if (Date.now() - started > 120000) {
          clearInterval(patchTimer);
          patchTimer = null;
          return;
        }
        try {
          const next = await apply();
          if (!next.pending) {
            clearInterval(patchTimer);
            patchTimer = null;
          }
        } catch { /* keep the last row */ }
      }, 1500);
    } catch { /* keep grid as-is */ }
  }

  return {
    onKey,
    patchChannel,
    onBack() {
      if (!moving) return false;
      endMove(true);
      return true;
    },
    destroy() {
      if (patchTimer) clearInterval(patchTimer);
      if (titleEl) titleEl.removeEventListener('contextmenu', onTitleMenu);
      corner.removeEventListener('contextmenu', onTitleMenu);
      clearInterval(nowTimer);
      window.removeEventListener('resize', onResize);
      if (rafId) cancelAnimationFrame(rafId);
      loadDescription.cancel();
      loadArt.cancel();
      runPreview.cancel();
      preview.destroy();
    },
  };
}
