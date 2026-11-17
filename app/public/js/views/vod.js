import { get, post, del } from '../api.js';
import { h, toast, store } from '../util.js';
import { navigate, device } from '../app.js';
import { focusEl } from '../nav.js';
import { playerLog } from '../player-debug.js';
import { topbar, loadingPanel } from './common.js';
import { svgIcon, ICONS, applyHubHighlight } from '../theme.js';

function withPl(path, playlist) {
  if (!playlist) return path;
  return `${path}${path.includes('?') ? '&' : '?'}playlist=${encodeURIComponent(playlist)}`;
}

function catalogKey(kind) {
  return `vod.catalog.${kind === 'series' ? 'shows' : 'movies'}`;
}

function loadCatalogState(kind) {
  return store.get(catalogKey(kind), {}) || {};
}

function saveCatalogState(kind, partial) {
  const prev = loadCatalogState(kind);
  store.set(catalogKey(kind), { ...prev, ...partial, at: Date.now() });
}

function routeForKind(kind) {
  return kind === 'series' ? 'shows' : 'movies';
}

/** Poster card — focus/hover updates the hero; pointer click selects, second click opens (like Recently Watched). */
function card(item, { onOpen, onSelect, showName = false, selectedId = '' } = {}) {
  let viaPointer = false;
  const el = h('button.vod-card.focusable', {
    type: 'button',
    title: item.name,
    'data-id': item.id || '',
    onclick: () => {
      const pointer = viaPointer;
      viaPointer = false;
      el.focus({ preventScroll: true });
      if (pointer && onSelect) {
        onSelect(item, el, { openIfSame: true });
        return;
      }
      onOpen && onOpen(item, el);
    },
    onfocus: () => {
      if (viaPointer) return;
      onSelect && onSelect(item, el);
    },
    onpointerdown: (e) => {
      if (e.pointerType === 'mouse' || e.pointerType === 'touch' || e.pointerType === 'pen') viaPointer = true;
    },
    onmousedown: (e) => {
      if (e.button === 0) e.preventDefault();
    },
  });
  const frame = h('span.vod-frame');
  if (item.poster) {
    frame.append(h('img', {
      src: item.poster,
      alt: '',
      loading: 'lazy',
      referrerpolicy: 'no-referrer',
      onerror: (e) => { e.target.replaceWith(h('span.vod-ph', { text: item.name })); },
    }));
  } else frame.append(h('span.vod-ph', { text: item.name }));
  if (item.progress) {
    frame.append(h('span.vod-progress', {}, h('span', { style: `width:${Math.round(item.progress * 100)}%` })));
  }
  el.append(frame);
  if (showName || !item.poster) el.append(h('span.vod-card-name', { text: item.name }));
  if (onSelect) {
    let timer = null;
    el.addEventListener('mouseenter', () => {
      clearTimeout(timer);
      timer = setTimeout(() => onSelect(item, el), 180);
    });
    el.addEventListener('mouseleave', () => clearTimeout(timer));
  }
  if (selectedId && String(item.id) === String(selectedId)) el.classList.add('on');
  return el;
}

function bindPageLabel(pageLabel, pageIndex, pageCount) {
  if (!pageLabel) return;
  if (pageCount > 1) {
    pageLabel.hidden = false;
    pageLabel.textContent = `${pageIndex + 1}/${pageCount}`;
  } else {
    pageLabel.hidden = true;
    pageLabel.textContent = '';
  }
}

/** One screen of posters. Side arrows page the strip but are skipped by D-pad (data-nav-skip). */
function pagedRow(items, makeCard, { pageLabel } = {}) {
  const track = h('div.vod-track');
  const viewport = h('div.vod-viewport', {}, track);
  const prev = h('button.vod-arrow.left', {
    type: 'button',
    'aria-label': 'Previous',
    'data-nav-skip': '1',
    tabindex: '-1',
  }, '‹');
  const next = h('button.vod-arrow.right', {
    type: 'button',
    'aria-label': 'Next',
    'data-nav-skip': '1',
    tabindex: '-1',
  }, '›');
  const line = h('div.vod-row-line', {}, prev, viewport, next);
  let page = 0;
  let focusAfter = null;
  let lastPageSize = 0;
  let resizeTimer = 0;

  function pageSize() {
    const width = viewport.clientWidth;
    if (width < 8) return 7;
    const cardEl = track.querySelector('.vod-card');
    const raw = cardEl ? cardEl.getBoundingClientRect().width : 0;
    const cardW = raw >= 40 ? raw : 147;
    const gap = 9;
    return Math.max(1, Math.min(14, Math.floor((width + gap) / (cardW + gap))));
  }

  function render() {
    const size = pageSize();
    lastPageSize = size;
    const pages = Math.max(1, Math.ceil(items.length / size));
    page = ((page % pages) + pages) % pages;
    const slice = items.slice(page * size, page * size + size);
    track.replaceChildren();
    for (const item of slice) track.append(makeCard(item));
    const single = pages < 2;
    prev.hidden = single;
    next.hidden = single;
    bindPageLabel(pageLabel, page, pages);
    if (focusAfter) {
      const id = focusAfter;
      focusAfter = null;
      const cardsNow = [...track.querySelectorAll('.vod-card')];
      let el = null;
      if (id === 'first') el = cardsNow[0];
      else if (id === 'last') el = cardsNow[cardsNow.length - 1];
      else el = track.querySelector(`.vod-card[data-id="${CSS.escape(String(id))}"]`) || cardsNow[0];
      if (el) focusEl(el);
    }
  }

  prev.addEventListener('click', () => { page -= 1; focusAfter = 'last'; render(); });
  next.addEventListener('click', () => { page += 1; focusAfter = 'first'; render(); });
  // Debounce + skip when column count is unchanged — many rows each had a live RO that
  // rebuilt every card strip on tiny layout shifts (big Movies/Shows jank on weak PCs).
  const observer = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const size = pageSize();
      if (size === lastPageSize && track.childElementCount) return;
      render();
    }, 120);
  });
  observer.observe(viewport);
  render();
  line.destroy = () => {
    clearTimeout(resizeTimer);
    observer.disconnect();
  };
  line.cards = () => [...track.querySelectorAll('.vod-card')];
  line.firstCard = () => track.querySelector('.vod-card');
  line.lastCard = () => {
    const cardsNow = track.querySelectorAll('.vod-card');
    return cardsNow[cardsNow.length - 1] || null;
  };
  line.pageNext = () => {
    const size = pageSize();
    const pages = Math.max(1, Math.ceil(items.length / size));
    if (pages < 2) return false;
    page = (page + 1) % pages;
    focusAfter = 'first';
    render();
    return true;
  };
  line.pagePrev = () => {
    const size = pageSize();
    const pages = Math.max(1, Math.ceil(items.length / size));
    if (pages < 2) return false;
    page = (page - 1 + pages) % pages;
    // Left off the first poster → previous page, cursor on the rightmost item.
    focusAfter = 'last';
    render();
    return true;
  };
  line.showItem = (id) => {
    const idx = items.findIndex((it) => String(it.id) === String(id));
    if (idx < 0) return null;
    const size = pageSize();
    page = Math.floor(idx / size);
    focusAfter = id;
    render();
    return track.querySelector(`.vod-card[data-id="${CSS.escape(String(id))}"]`);
  };
  line.refresh = render;
  return line;
}

/** Category view: a grid of one page, cycled with the same arrows. */
function pagedGrid(items, makeCard, { pageLabel } = {}) {
  const PER = 24;
  const grid = h('div.vod-grid');
  const prev = h('button.vod-arrow.left', {
    type: 'button', 'aria-label': 'Previous', 'data-nav-skip': '1', tabindex: '-1',
  }, '‹');
  const next = h('button.vod-arrow.right', {
    type: 'button', 'aria-label': 'Next', 'data-nav-skip': '1', tabindex: '-1',
  }, '›');
  const line = h('div.vod-row-line', {}, prev, grid, next);
  let page = 0;
  let focusAfter = null;
  function render() {
    const pages = Math.max(1, Math.ceil(items.length / PER));
    page = ((page % pages) + pages) % pages;
    const slice = items.slice(page * PER, page * PER + PER);
    grid.replaceChildren();
    for (const item of slice) grid.append(makeCard(item));
    prev.hidden = pages < 2;
    next.hidden = pages < 2;
    bindPageLabel(pageLabel, page, pages);
    if (focusAfter) {
      const id = focusAfter;
      focusAfter = null;
      const cardsNow = [...grid.querySelectorAll('.vod-card')];
      let el = null;
      if (id === 'first') el = cardsNow[0];
      else if (id === 'last') el = cardsNow[cardsNow.length - 1];
      else el = grid.querySelector(`.vod-card[data-id="${CSS.escape(String(id))}"]`) || cardsNow[0];
      if (el) focusEl(el);
    }
  }
  prev.addEventListener('click', () => { page -= 1; focusAfter = 'last'; render(); });
  next.addEventListener('click', () => { page += 1; focusAfter = 'first'; render(); });
  render();
  line.destroy = () => {};
  line.cards = () => [...grid.querySelectorAll('.vod-card')];
  line.firstCard = () => grid.querySelector('.vod-card');
  line.pageNext = () => {
    const pages = Math.max(1, Math.ceil(items.length / PER));
    if (pages < 2) return false;
    page = (page + 1) % pages;
    focusAfter = 'first';
    render();
    return true;
  };
  line.pagePrev = () => {
    const pages = Math.max(1, Math.ceil(items.length / PER));
    if (pages < 2) return false;
    page = (page - 1 + pages) % pages;
    focusAfter = 'last';
    render();
    return true;
  };
  line.showItem = (id) => {
    const idx = items.findIndex((it) => String(it.id) === String(id));
    if (idx < 0) return null;
    page = Math.floor(idx / PER);
    focusAfter = id;
    render();
    return grid.querySelector(`.vod-card[data-id="${CSS.escape(String(id))}"]`);
  };
  line.refresh = render;
  return line;
}

function seriesTitle(name) {
  const cleaned = String(name || '')
    .replace(/^\s*(?:EN|NF|US|UK|ES|FR|DE|IT|AR|TR)\s*-\s*/i, '')
    .replace(/\b(?:4K|UHD|FHD|HD|HEVC|HDR|UNCUT)\b/gi, '')
    .replace(/\((?:19|20)\d{2}\)/g, '')
    .replace(/\((?:US|UK|GB|ES|BR|FR|DE|IT|NL|CA|AU)\)/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*[-–]\s*$/, '')
    .trim();
  return cleaned || String(name || '').trim();
}

function seriesKey(name) {
  return seriesTitle(name).toLowerCase();
}

function groupShows(items) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const key = seriesKey(item.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...item, name: seriesTitle(item.name) });
  }
  return out;
}

function hubPill(icon, label, cls, attrs) {
  const el = h('button.focusable', { type: 'button', ...attrs },
    svgIcon(icon, { filled: String(cls).includes('hub-resume') }),
    h('span', { text: label }));
  for (const c of String(cls || '').split(/\s+/)) if (c) el.classList.add(c);
  return el;
}

async function toggleMyList(detail, btn) {
  const body = {
    kind: detail.kind === 'series' ? 'series' : 'movie',
    itemId: detail.id,
    sourcePlaylistId: detail.playlistId || '',
    title: detail.name || '',
    subtitle: detail.genre || '',
    poster: detail.poster || '',
  };
  try {
    if (detail.bookmarked) await del('/bookmarks', body);
    else await post('/bookmarks', body);
    detail.bookmarked = !detail.bookmarked;
    btn.classList.toggle('on', !!detail.bookmarked);
    const label = btn.querySelector('span');
    if (label) label.textContent = detail.bookmarked ? 'In My List' : 'My List';
  } catch (err) {
    toast(err.message || 'My List failed', { error: true });
  }
}

function heroButtons(page) {
  return [...page.querySelectorAll('.vod-hero .hub-resume, .vod-hero .hub-bookmark, .vod-hero .vod-hub-btn')];
}

function selectedVodCard(page) {
  return page.querySelector('.vod-card.on') || null;
}

/** Keep the category / season title visible above the focused posters when moving rows. */
function ensureRowTitleVisible(el) {
  const row = el && el.closest && el.closest('.vod-row, .vod-cat-block');
  const list = row && row.closest('.vod-list');
  if (!row || !list) return;
  const title = row.querySelector('.vod-row-title, .vod-season-title, .vod-cat-title') || row;
  const listRect = list.getBoundingClientRect();
  const titleRect = title.getBoundingClientRect();
  const pad = 6;
  list.scrollTop += titleRect.top - listRect.top - pad;
  // After pinning the title, keep the focused card in view under it.
  if (el.getBoundingClientRect) {
    const cardRect = el.getBoundingClientRect();
    const listRect2 = list.getBoundingClientRect();
    if (cardRect.bottom > listRect2.bottom - pad) {
      list.scrollTop += cardRect.bottom - listRect2.bottom + pad;
    } else if (cardRect.top < title.getBoundingClientRect().bottom + pad) {
      list.scrollTop += cardRect.top - title.getBoundingClientRect().bottom - pad;
    }
  }
}

function moveMoviesFocus(page, action) {
  let active = document.activeElement;
  const go = (el, { revealTitle = false } = {}) => {
    if (!el) return false;
    focusEl(el);
    if (revealTitle) ensureRowTitleVisible(el);
    return true;
  };

  const heroBtns = heroButtons(page);
  const sections = [...page.querySelectorAll('.vod-row, .vod-cat-block')];
  const list = page.querySelector('.vod-list');
  // After Back, ResizeObserver often rebuilds cards and drops focus — resume from the
  // highlighted poster instead of jumping to the first card in the list.
  if (!active || !page.contains(active)) {
    const remembered = selectedVodCard(page);
    if (!remembered) return false;
    active = remembered;
    if (!['left', 'right', 'up', 'down'].includes(action)) {
      return go(remembered, { revealTitle: true });
    }
    // Fall through and move relative to the remembered card.
  }

  if (heroBtns.includes(active)) {
    const i = heroBtns.indexOf(active);
    if (action === 'right') return go(heroBtns[i + 1]) || true;
    if (action === 'left') return i > 0 ? go(heroBtns[i - 1]) : true;
    if (action === 'down') {
      const target = (list && selectedVodCard(list)) || (list && list.querySelector('.vod-card'));
      return go(target, { revealTitle: true }) || true;
    }
    if (action === 'up') return false;
    return true;
  }

  if (active.classList.contains('vod-row-title')) {
    const row = active.closest('.vod-row');
    const line = row && row.querySelector('.vod-row-line');
    const cards = line ? line.cards() : [];
    const rowIdx = sections.indexOf(row);
    if (action === 'down' || action === 'right') {
      return go(selectedVodCard(row) || cards[0], { revealTitle: action === 'down' }) || true;
    }
    if (action === 'left') return true;
    if (action === 'up') {
      if (rowIdx > 0) {
        const prevRow = sections[rowIdx - 1];
        const prevLine = prevRow.querySelector('.vod-row-line');
        const prevCards = prevLine ? prevLine.cards() : [];
        return go(selectedVodCard(prevRow) || prevCards[0], { revealTitle: true }) || true;
      }
      return go(heroBtns[0]) || false;
    }
    return true;
  }

  const cardEl = active.classList.contains('vod-card') ? active : selectedVodCard(page);
  if (!cardEl) return false;

  const row = cardEl.closest('.vod-row, .vod-cat-block') || cardEl.closest('.vod-list');
  const line = row && row.querySelector('.vod-row-line');
  const cards = line ? line.cards() : (row ? [...row.querySelectorAll('.vod-card')] : []);
  const idx = cards.indexOf(cardEl);
  const rowIdx = sections.indexOf(row);

  if (action === 'left') {
    if (idx > 0) return go(cards[idx - 1]);
    if (line && line.pagePrev && line.pagePrev()) return true;
    return true;
  }
  if (action === 'right') {
    if (idx >= 0 && idx < cards.length - 1) return go(cards[idx + 1]);
    if (line && line.pageNext && line.pageNext()) return true;
    const see = row && row.querySelector('.vod-row-title');
    return go(see) || true;
  }
  if (action === 'down') {
    if (rowIdx >= 0 && rowIdx < sections.length - 1) {
      const nextRow = sections[rowIdx + 1];
      const nextLine = nextRow.querySelector('.vod-row-line');
      const nextCards = nextLine ? nextLine.cards() : [];
      return go(nextCards[Math.min(Math.max(idx, 0), nextCards.length - 1)] || nextCards[0], { revealTitle: true }) || true;
    }
    return true;
  }
  if (action === 'up') {
    if (rowIdx > 0) {
      const prevRow = sections[rowIdx - 1];
      const prevLine = prevRow.querySelector('.vod-row-line');
      const prevCards = prevLine ? prevLine.cards() : [];
      return go(prevCards[Math.min(Math.max(idx, 0), prevCards.length - 1)] || prevCards[0], { revealTitle: true }) || true;
    }
    return go(heroBtns[0]) || false;
  }
  return false;
}

export async function mount(root, params) {
  const kind = params.kind === 'series' ? 'series' : 'movies';
  const seriesId = params.show || params.id;
  if (kind === 'series' && seriesId) return mountSeries(root, seriesId, params.playlist);
  if (kind === 'movies' && params.id) return mountMovie(root, params.id, params.playlist);

  const cipher = device !== 'phone';
  const label = kind === 'series' ? 'TV Shows' : 'Movies';
  const page = h('div.vod');
  if (cipher) page.classList.add('vod-cipher', 'vod-fit');
  const heroHost = h('div.vod-hero-host');
  const listHost = h('div.vod-list');

  // Cipher Movies / Shows: app nav only — no back/title bar.
  if (!cipher) {
    root.append(topbar(params.cat ? 'Category' : label));
  }
  if (cipher) root.append(page);
  else root.append(h('div.scroll', {}, page));
  page.append(heroHost, listHost);
  listHost.append(loadingPanel(kind === 'series' ? 'Loading TV shows…' : 'Loading movies…'));

  let unmounted = false;
  if (cipher) {
    try {
      const settings = await get('/settings');
      applyHubHighlight(settings && settings.hubHighlight);
    } catch { /* keep default accent */ }
  }

  const path = withPl(`/vod/${kind}${params.cat ? `?cat=${encodeURIComponent(params.cat)}` : ''}`, params.playlist);
  let data;
  for (;;) {
    try {
      data = await get(path);
    } catch (err) {
      if (!unmounted) listHost.replaceChildren(h('div.empty', { text: err.message }));
      return { unmount() { unmounted = true; } };
    }
    if (unmounted) return { unmount() { unmounted = true; } };
    if (data.loading && !(data.items || []).length) {
      listHost.replaceChildren(loadingPanel(data.error || (kind === 'series' ? 'Loading TV shows…' : 'Loading movies…')));
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    break;
  }
  if (unmounted) return { unmount() { unmounted = true; } };
  if (data.error && !(data.items || []).length) {
    listHost.replaceChildren(h('div.empty', { text: data.error }));
    return { unmount() { unmounted = true; } };
  }

  const prepare = kind === 'series' ? groupShows : (items) => items;
  const byCat = new Map();
  for (const item of data.items || []) {
    if (!byCat.has(item.categoryId)) byCat.set(item.categoryId, []);
    byCat.get(item.categoryId).push(item);
  }
  for (const [id, items] of byCat) byCat.set(id, prepare(items));

  let seq = 0;
  let selectedId = '';
  let pointerArmedId = '';
  const rows = [];

  const syncSelectedClass = () => {
    for (const el of listHost.querySelectorAll('.vod-card')) {
      el.classList.toggle('on', !!selectedId && el.dataset.id === String(selectedId));
    }
  };

  const select = async (item, el, { openIfSame = false } = {}) => {
    if (!item) return;
    const id = String(item.id || '');
    if (openIfSame && pointerArmedId === id && selectedId === id) {
      open(item);
      return;
    }
    if (openIfSame) pointerArmedId = id;
    if (selectedId === id && heroHost.querySelector('.vod-hero:not(.vod-hero-loading)')) {
      if (el) {
        selectedId = id;
        syncSelectedClass();
      }
      return;
    }
    selectedId = id;
    syncSelectedClass();
    const mine = ++seq;
    if (!heroHost.querySelector('.vod-hero')) {
      heroHost.replaceChildren(h('section.vod-hero.vod-hero-loading', {}, h('div.empty', { text: 'Loading…' })));
    }
    let detail;
    try {
      detail = await get(withPl(`/vod/${kind}/${encodeURIComponent(item.id)}`, params.playlist));
    } catch (err) {
      if (mine !== seq) return;
      heroHost.replaceChildren(h('section.vod-hero', {}, h('div.empty', { text: err.message })));
      return;
    }
    if (mine !== seq) return;
    if (kind === 'series') detail = { ...detail, name: seriesTitle(detail.name) };
    if (params.playlist) detail.playlistId = params.playlist;
    heroHost.replaceChildren(renderHero(detail, { cipher, autofocus: false }));
    syncSelectedClass();
  };

  const persistCatalog = () => {
    saveCatalogState(kind, {
      selectedId,
      scrollTop: listHost.scrollTop || 0,
      cat: params.cat || null,
    });
  };

  const open = (item) => {
    persistCatalog();
    if (kind === 'series') {
      navigate(`shows?show=${encodeURIComponent(item.id)}${params.playlist ? `&playlist=${encodeURIComponent(params.playlist)}` : ''}`);
    } else {
      navigate(`movies?id=${encodeURIComponent(item.id)}${params.playlist ? `&playlist=${encodeURIComponent(params.playlist)}` : ''}`);
    }
  };

  const goCatalog = (opts = {}) => {
    const q = new URLSearchParams();
    if (opts.restore) q.set('restore', '1');
    if (params.playlist) q.set('playlist', params.playlist);
    const qs = q.toString();
    navigate(`${routeForKind(kind)}${qs ? `?${qs}` : ''}`);
  };

  const makeCard = (item) => card(item, {
    onOpen: open,
    onSelect: select,
    selectedId,
  });

  listHost.replaceChildren();
  const cat = params.cat ? (data.categories || []).find((c) => c.id === params.cat) : null;
  if (params.cat) {
    const items = byCat.get(params.cat) || [];
    if (!items.length) {
      listHost.append(h('div.empty', { text: 'Nothing in this category.' }));
    } else {
      const pageLabel = h('span.vod-page-num', { hidden: true });
      const grid = pagedGrid(items, makeCard, { pageLabel });
      rows.push(grid);
      listHost.append(
        h('div.vod-cat-block', {},
          h('h2.vod-cat-title', {},
            h('span', { text: (cat && cat.name) || 'Category' }),
            h('span.chev', { text: '>' }),
            pageLabel),
          grid),
      );
    }
  } else if (!(data.categories || []).some((c) => (byCat.get(c.id) || []).length)) {
    listHost.append(h('div.empty', { text: kind === 'series' ? 'No TV shows in this playlist.' : 'No movies in this playlist.' }));
  } else {
    for (const group of data.categories) {
      const items = byCat.get(group.id) || [];
      if (!items.length) continue;
      const pageLabel = h('span.vod-page-num', { hidden: true });
      const line = pagedRow(items, makeCard, { pageLabel });
      rows.push(line);
      const titleBtn = h('button.vod-row-title.focusable', {
        type: 'button',
        onclick: () => {
          persistCatalog();
          navigate(`${routeForKind(kind)}?cat=${encodeURIComponent(group.id)}${params.playlist ? `&playlist=${encodeURIComponent(params.playlist)}` : ''}`);
        },
      }, h('span', { text: group.name }), h('span.chev', { text: '>' }), pageLabel);
      listHost.append(h('section.vod-row', {}, titleBtn, line));
    }
  }

  // Saved scroll/highlight only when returning via Back (?restore=1). Nav bar opens a fresh default.
  const restore = params.restore === '1' || params.restore === 'true';
  const saved = restore ? loadCatalogState(kind) : {};
  const flat = params.cat
    ? (byCat.get(params.cat) || [])
    : [...byCat.values()].flat();
  const sameShelf = restore && (saved.cat || null) === (params.cat || null);
  const restoreId = restore ? (saved.selectedId || '') : '';
  const wanted = flat.find((it) => String(it.id) === String(restoreId))
    || flat.find((it) => it.id === params.id)
    || flat[0];

  const focusSelectedCard = () => {
    if (!cipher || !selectedId) return null;
    let el = listHost.querySelector(`.vod-card[data-id="${CSS.escape(String(selectedId))}"]`);
    if (!el) {
      for (const line of rows) {
        if (line.showItem) {
          el = line.showItem(selectedId);
          if (el) break;
        }
      }
    }
    if (el) {
      el.classList.add('on');
      focusEl(el);
    }
    return el;
  };

  if (wanted) {
    let match = wanted.id ? listHost.querySelector(`.vod-card[data-id="${CSS.escape(String(wanted.id))}"]`) : null;
    if (restore && !match) {
      for (const line of rows) {
        if (line.showItem) {
          match = line.showItem(wanted.id);
          if (match) break;
        }
      }
    }
    await select(wanted, match || undefined);
    if (cipher && restore) {
      // Only steal focus when Back restored a place — never when opened from the nav bar.
      const applyScroll = () => {
        if (sameShelf && Number(saved.scrollTop) > 0) listHost.scrollTop = Number(saved.scrollTop) || 0;
      };
      applyScroll();
      focusSelectedCard();
      requestAnimationFrame(() => {
        applyScroll();
        focusSelectedCard();
        requestAnimationFrame(() => {
          applyScroll();
          focusSelectedCard();
        });
      });
      setTimeout(() => {
        applyScroll();
        focusSelectedCard();
      }, 120);
    } else if (cipher) {
      // Nav / fresh open: pin to the top default view (layout can nudge scroll later).
      const pinTop = () => { listHost.scrollTop = 0; };
      pinTop();
      requestAnimationFrame(pinTop);
      setTimeout(pinTop, 120);
    }
  }

  return {
    manageFocus: cipher,
    onKey(action) {
      if (!cipher || !['up', 'down', 'left', 'right'].includes(action)) return false;
      // Don't pull focus out of the top nav — only move within the page when already inside it.
      const active = document.activeElement;
      const appnavEl = document.getElementById('appnav');
      if (appnavEl && active && appnavEl.contains(active)) return false;
      if (restore && !page.contains(active)) focusSelectedCard();
      if (moveMoviesFocus(page, action)) return true;
      // Top of Movies / Shows: Up highlights this tab in the nav (does not leave the screen).
      if (action === 'up') {
        const link = document.querySelector(`#appnav .appnav-link[data-route="${routeForKind(kind)}"]`);
        if (link) {
          focusEl(link);
          return true;
        }
      }
      return false;
    },
    onBack() {
      persistCatalog();
      if (params.cat) {
        goCatalog({ restore: true });
        return true;
      }
      navigate('home');
      return true;
    },
    unmount() {
      // Keep last place for a future Back restore; nav visits ignore it until then.
      persistCatalog();
      unmounted = true;
      for (const row of rows) if (row.destroy) row.destroy();
    },
  };
}

async function mountSeries(root, id, playlist) {
  const cipher = device !== 'phone';
  const page = h('div.vod');
  if (cipher) page.classList.add('vod-cipher', 'vod-fit', 'vod-series-detail');
  else root.append(topbar('TV Shows'));
  const heroHost = h('div.vod-hero-host', {}, h('div.empty', { text: 'Loading…' }));
  const listHost = h('div.vod-list');
  if (cipher) root.append(page);
  else root.append(h('div.scroll', {}, page));
  page.append(heroHost, listHost);
  if (cipher) {
    try {
      const settings = await get('/settings');
      applyHubHighlight(settings && settings.hubHighlight);
    } catch { /* keep default */ }
  }
  let detail;
  try {
    detail = await get(withPl(`/vod/series/${encodeURIComponent(id)}`, playlist));
  } catch (err) {
    heroHost.replaceChildren(h('div.empty', { text: err.message }));
    return {
      onBack() {
        const q = new URLSearchParams({ restore: '1' });
        if (playlist) q.set('playlist', playlist);
        navigate(`shows?${q}`);
        return true;
      },
    };
  }
  detail = { ...detail, name: seriesTitle(detail.name), playlistId: playlist || detail.playlistId };
  try {
    const marks = await get('/bookmarks');
    detail.bookmarked = Array.isArray(marks) && marks.some((m) => (m.kind === 'series' || m.kind === 'show') && String(m.itemId) === String(detail.id));
  } catch { /* optional */ }

  const rows = [];
  const bySeason = new Map();
  for (const ep of detail.episodes || []) {
    if (!bySeason.has(ep.season)) bySeason.set(ep.season, []);
    bySeason.get(ep.season).push(ep);
  }
  const seasonNums = [...bySeason.keys()].sort((a, b) => a - b);
  for (const season of seasonNums) {
    const eps = bySeason.get(season);
    const pageLabel = h('span.vod-page-num', { hidden: true });
    const line = pagedRow(eps, (ep) => card({
      id: ep.id,
      name: `E${ep.episode} ${ep.title}`,
      poster: ep.poster || detail.poster,
      progress: ep.progress || 0,
    }, {
      showName: true,
      onOpen: () => play({ id: `e:${ep.id}`, series: detail.id }, !!ep.progress, detail),
    }), { pageLabel });
    rows.push(line);
    listHost.append(
      h('section.vod-row', {},
        h('h3.vod-season-title', {},
          h('span', { text: `Season ${season}` }),
          h('span.chev', { text: '>' }),
          pageLabel),
        line),
    );
  }
  if (!seasonNums.length) listHost.append(h('div.empty', { text: 'No episodes for this series yet.' }));
  heroHost.replaceChildren(renderHero(detail, { cipher, autofocus: true, detailPage: true }));
  if (cipher) {
    const start = page.querySelector('[data-autofocus]') || page.querySelector('.hub-resume');
    if (start) focusEl(start);
  }
  return {
    manageFocus: cipher,
    onKey(action) {
      if (!cipher || !['up', 'down', 'left', 'right'].includes(action)) return false;
      if (moveMoviesFocus(page, action)) return true;
      if (action === 'up') {
        const link = document.querySelector('#appnav .appnav-link[data-route="shows"]');
        if (link) { focusEl(link); return true; }
      }
      return false;
    },
    onBack() {
      // Return to Shows catalog at the previous scroll / highlight.
      const q = new URLSearchParams({ restore: '1' });
      if (playlist) q.set('playlist', playlist);
      navigate(`shows?${q}`);
      return true;
    },
    unmount() {
      for (const row of rows) if (row.destroy) row.destroy();
    },
  };
}

/** Detail page for a single movie (search results and deep links). */
async function mountMovie(root, id, playlist) {
  const cipher = device !== 'phone';
  const page = h('div.vod');
  if (cipher) page.classList.add('vod-cipher', 'vod-detail');
  else root.append(topbar('Movies'));
  const host = h('div.vod-detail-host', {}, h('div.empty', { text: 'Loading…' }));
  if (cipher) root.append(page);
  else root.append(h('div.scroll', {}, page));
  page.append(host);
  if (cipher) {
    try {
      const settings = await get('/settings');
      applyHubHighlight(settings && settings.hubHighlight);
    } catch { /* keep default */ }
  }
  let detail;
  try {
    detail = await get(withPl(`/vod/movies/${encodeURIComponent(id)}`, playlist));
  } catch (err) {
    host.replaceChildren(h('div.empty', { text: err.message }));
    return {
      onBack() {
        const q = new URLSearchParams({ restore: '1' });
        if (playlist) q.set('playlist', playlist);
        navigate(`movies?${q}`);
        return true;
      },
    };
  }
  detail = { ...detail, playlistId: playlist || detail.playlistId };
  try {
    const marks = await get('/bookmarks');
    detail.bookmarked = Array.isArray(marks) && marks.some((m) => m.kind === 'movie' && String(m.itemId) === String(detail.id));
  } catch { /* optional */ }
  host.replaceChildren(renderHero(detail, { cipher, autofocus: true, detailPage: true }));
  if (cipher) {
    const start = page.querySelector('[data-autofocus]') || page.querySelector('.hub-resume');
    if (start) focusEl(start);
  }
  return {
    manageFocus: cipher,
    onKey(action) {
      if (!cipher || !['left', 'right', 'up', 'down'].includes(action)) return false;
      const btns = heroButtons(page);
      const active = document.activeElement;
      const i = btns.indexOf(active);
      if (i < 0) {
        if (action === 'down' || action === 'right') {
          focusEl(btns[0]);
          return !!btns[0];
        }
        return false;
      }
      if (action === 'right') {
        if (i < btns.length - 1) { focusEl(btns[i + 1]); return true; }
        return true;
      }
      if (action === 'left') {
        if (i > 0) { focusEl(btns[i - 1]); return true; }
        return true;
      }
      if (action === 'up') {
        const link = document.querySelector('#appnav .appnav-link[data-route="movies"]');
        if (link) { focusEl(link); return true; }
        return false;
      }
      return true;
    },
    onBack() {
      // Return to Movies catalog at the previous scroll / highlight.
      const q = new URLSearchParams({ restore: '1' });
      if (playlist) q.set('playlist', playlist);
      navigate(`movies?${q}`);
      return true;
    },
  };
}

function renderHero(detail, { cipher = false, autofocus = false, detailPage = false } = {}) {
  const art = detail.backdrop || detail.poster || '';
  const box = h('section.vod-hero');
  if (cipher) box.classList.add('vod-hero-cipher');
  if (detailPage) box.classList.add('vod-hero-detail');
  if (art) box.append(h('img.vod-back', { src: art, alt: '', referrerpolicy: 'no-referrer' }));
  box.append(h('div.vod-fade'));
  const trailerSlot = h('div.vod-trailer');
  trailerSlot.hidden = true;
  const showTrailer = () => {
    if (!detail.trailer) return;
    trailerSlot.hidden = false;
    if (trailerSlot.querySelector('iframe')) return;
    trailerSlot.append(h('iframe', {
      src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(detail.trailer)}?autoplay=1&rel=0`,
      title: `${detail.name} trailer`,
      allow: 'autoplay; encrypted-media; picture-in-picture',
      allowfullscreen: true,
    }));
  };
  const target = playTarget(detail);
  const resume = !!(detail.progress || (detail.resume && detail.resume.fraction));
  const posterEl = detail.poster
    ? h('img.vod-poster', { src: detail.poster, alt: '', referrerpolicy: 'no-referrer' })
    : h('div.vod-poster.vod-ph', { text: detail.name });
  const frac = (detail.progress && detail.progress.fraction) || (detail.resume && detail.resume.fraction) || 0;
  const posterWrap = h('div.vod-poster-wrap', {}, posterEl);
  if (frac) posterWrap.append(h('span.vod-progress', {}, h('span', { style: `width:${Math.round(frac * 100)}%` })));

  let actions;
  if (cipher) {
    const primary = hubPill(
      ICONS.play,
      resume ? 'Resume' : 'Watch Now',
      'hub-resume vod-hub-btn',
      { onclick: () => play(target, true, detail), ...(autofocus ? { 'data-autofocus': true } : {}) },
    );
    const listBtn = hubPill(
      ICONS.plus,
      detail.bookmarked ? 'In My List' : 'My List',
      'hub-bookmark vod-hub-btn',
      { onclick: () => toggleMyList(detail, listBtn) },
    );
    listBtn.classList.toggle('on', !!detail.bookmarked);
    const extras = [];
    if (resume) {
      extras.push(hubPill(ICONS.play, 'Start over', 'hub-bookmark vod-hub-btn', {
        onclick: () => play(target, false, detail),
      }));
    }
    if (detail.trailer) {
      extras.push(hubPill(ICONS.info, 'Trailer', 'hub-bookmark vod-hub-btn', { onclick: showTrailer }));
    }
    actions = h('div.vod-actions.hub-actions', {}, primary, listBtn, ...extras);
  } else {
    actions = h('div.vod-actions', {},
      h('button.btn.primary.focusable', { type: 'button', onclick: () => play(target, true, detail) }, resume ? 'Resume' : 'Play'),
      resume ? h('button.btn.focusable', { type: 'button', onclick: () => play(target, false, detail) }, 'Start from beginning') : null,
      detail.trailer ? h('button.btn.focusable', { type: 'button', onclick: showTrailer }, 'Watch trailer') : null);
  }

  const metaBits = [detail.year, detail.genre].filter(Boolean);
  const metaEl = metaBits.length
    ? h('div.vod-meta', {},
      h('span', { text: metaBits.join(' · ') }),
      detail.quality ? h('span.vod-quality', { text: detail.quality }) : null)
    : null;

  const kicker = detailPage
    ? (detail.kind === 'series' ? 'Series' : 'Movie')
    : (resume ? 'Continue Watching' : 'Now Spotlight');
  const titleBlock = cipher
    ? h('div.vod-title-stack', {},
      h('div.hub-kicker.vod-kicker', { text: kicker }),
      h('h2.vod-title', { text: detail.name }))
    : h('h2.vod-title', { text: detail.name });
  const copy = h('div.vod-copy', {},
    titleBlock,
    metaEl,
    actions,
    posterWrap,
    detail.plot ? h('p.vod-plot', { text: detail.plot }) : null);
  box.append(h('div.vod-hero-body', {}, copy), trailerSlot);
  return box;
}

function playTarget(detail) {
  if (detail.kind === 'series') {
    if (detail.resume && detail.resume.episodeId) return { id: `e:${detail.resume.episodeId}`, series: detail.id };
    const first = (detail.episodes || [])[0];
    if (first) return { id: `e:${first.id}`, series: detail.id };
    return null;
  }
  return { id: `m:${detail.id}`, series: '' };
}

function play(target, resume, detail) {
  if (!target || !target.id) return;
  const q = new URLSearchParams({
    id: target.id,
    resume: resume ? '1' : '0',
    kind: detail.kind === 'series' ? 'series' : 'movies',
  });
  if (target.series) q.set('series', target.series);
  if (detail.name) q.set('title', detail.name);
  if (detail.playlistId) q.set('playlist', detail.playlistId);
  playerLog('vod.catalog.play', detail.kind === 'series' ? 'series' : 'movie', {
    id: target.id,
    series: target.series || '',
    resume: !!resume,
    title: detail.name || '',
  });
  navigate(`vodplay?${q}`);
}
