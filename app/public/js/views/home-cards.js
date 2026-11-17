import { h } from '../util.js';
import { navigate } from '../app.js';
import { proxiedLogo, defaultLogoUrl } from '../chlogo.js';
import { timeAgo } from '../theme.js';

export function openItem(item) {
  if (item && item.href) navigate(item.href);
}

function posterImg(src, name) {
  if (!src) return h('span.hub-ph', { text: name || '' });
  return h('img', {
    src,
    alt: '',
    loading: 'lazy',
    referrerpolicy: 'no-referrer',
    onerror: (e) => { e.target.replaceWith(h('span.hub-ph', { text: name || '' })); },
  });
}

function ratingLabel(item) {
  const r = item && item.rating;
  if (r == null || r === '') return '';
  const s = String(r);
  if (/^[0-9.]+$/.test(s)) return '';
  return s;
}

export function itemKey(item) {
  if (!item) return '';
  return [item.kind, item.channelId || item.itemId || item.bookmarkId, item.href || ''].join(':');
}

export function sameItem(a, b) {
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'live' || a.kind === 'catchup') {
    return String(a.channelId || a.itemId) === String(b.channelId || b.itemId);
  }
  return itemKey(a) === itemKey(b);
}

export function hasLiveEpg(item) {
  return !!(item && item.kind === 'live' && Number(item.end) > Number(item.start));
}

export function liveProgressNow(item) {
  if (!item || item.kind !== 'live') return item && item.progress ? item.progress : null;
  const start = Number(item.start) || 0;
  const end = Number(item.end) || 0;
  if (!(end > start)) return null;
  const duration = (end - start) / 1000;
  const position = Math.max(0, (Date.now() - start) / 1000);
  const fraction = Math.max(0, Math.min(1, position / duration));
  return {
    position,
    duration,
    fraction,
    watchedMin: Math.max(0, Math.round(position / 60)),
    leftMin: Math.max(0, Math.round(Math.max(0, duration - position) / 60)),
  };
}

export function liveEnded(item) {
  return !!(item && item.kind === 'live' && Number(item.end) > 0 && Date.now() >= Number(item.end) - 2000);
}

export function progressLabel(item) {
  const bits = [];
  const p = item && item.kind === 'live'
    ? (hasLiveEpg(item) ? liveProgressNow(item) : null)
    : (item && item.progress);
  if (p) bits.push(`${p.watchedMin}m watched`, `${p.leftMin}m left`);
  const rating = ratingLabel(item);
  if (rating) bits.push(rating);
  return bits.join(' • ');
}

export function episodeBits(item) {
  const bits = [];
  if (item.season) bits.push(`S${item.season}`);
  if (item.episode) bits.push(`E${item.episode}`);
  if (item.episodeTitle) bits.push(item.episodeTitle);
  return bits.join(' • ');
}

export function forYouSub(item) {
  const bits = [];
  if (item.season || item.episode) bits.push([item.season ? `S${item.season}` : '', item.episode ? `E${item.episode}` : ''].filter(Boolean).join(' '));
  const genre = String(item.genre || '').split(',')[0].trim();
  if (genre) bits.push(genre);
  else if (item.kind === 'movie') bits.push('Movie');
  return bits.join(' • ') || item.subtitle || '';
}

function progressBar(item) {
  const p = item && item.progress;
  if (!p || !(p.fraction > 0)) return null;
  return h('span.hub-card-progress', {}, h('span', { style: `width:${Math.round(p.fraction * 100)}%` }));
}

export function recentCard(item, { selected = false, onSelect, onOpen } = {}) {
  const live = item.kind === 'live' || item.kind === 'catchup';
  const channelName = live ? String(item.subtitle || item.title || 'Channel').replace(/\s*[·•].*$/, '') : '';
  const title = (item.title || channelName || '').trim();
  if (!title || /^untitled$/i.test(title)) return null;
  const showArt = live && (item.backdrop || (item.poster && item.poster !== item.logo));
  const src = showArt
    ? (item.backdrop || item.poster)
    : live
      ? proxiedLogo(item.logo || item.poster || '', channelName || title)
      : (item.backdrop || item.poster || item.logo || '');
  let viaPointer = false;
  const el = h('button.hub-card.hub-card-recent.focusable', {
    type: 'button',
    title,
    'data-hub-key': itemKey(item),
    onclick: () => {
      const pointer = viaPointer;
      viaPointer = false;
      el.focus({ preventScroll: true });
      if (pointer && onSelect) {
        onSelect(item, { openIfSame: true });
        return;
      }
      (onOpen || openItem)(item);
    },
    onfocus: () => {
      if (viaPointer) return;
      onSelect && onSelect(item);
    },
    onpointerdown: (e) => {
      if (e.pointerType === 'mouse' || e.pointerType === 'touch' || e.pointerType === 'pen') viaPointer = true;
    },
    onmousedown: (e) => {
      if (e.button === 0) e.preventDefault();
    },
  });
  if (selected) el.classList.add('is-selected');
  const img = posterImg(src, title);
  if (live && !showArt) {
    img.classList.add('is-logo');
    img.onerror = (e) => {
      const fallback = defaultLogoUrl(channelName || title);
      if (e.target.src !== fallback) e.target.src = fallback;
    };
  }
  const artKids = [img];
  if (item.kind === 'live') artKids.push(h('span.hub-live-badge.hub-live-on-art', { text: 'LIVE' }));
  const copy = h('span.hub-card-copy');
  copy.append(h('span.hub-card-name', { text: title }));
  if (live) {
    const channel = channelName && channelName !== title ? channelName : (item.kind === 'catchup' ? 'Catch-up' : 'Live');
    copy.append(h('span.hub-card-sub', { text: channel }));
  } else {
    const sub = [episodeBits(item) || item.subtitle, timeAgo(item.updatedAt)].filter(Boolean).join(' • ');
    if (sub) copy.append(h('span.hub-card-sub', { text: sub }));
  }
  const bar = progressBar(item);
  if (bar) copy.append(bar);
  el.append(h('span.hub-card-art', {}, ...artKids), copy);
  return el;
}

export function forYouCard(item, { onSelect, onOpen } = {}) {
  const title = String((item && item.title) || '').trim();
  if (!title || /^untitled$/i.test(title)) return null;
  let viaPointer = false;
  const el = h('button.hub-card.hub-card-wide.focusable', {
    type: 'button',
    title,
    onclick: () => {
      const pointer = viaPointer;
      viaPointer = false;
      el.focus({ preventScroll: true });
      if (pointer && onSelect) {
        onSelect(item, { openIfSame: true });
        return;
      }
      (onOpen || openItem)(item);
    },
    onpointerdown: (e) => {
      if (e.pointerType === 'mouse' || e.pointerType === 'touch' || e.pointerType === 'pen') viaPointer = true;
    },
    onmousedown: (e) => {
      if (e.button === 0) e.preventDefault();
    },
  });
  el.append(h('span.hub-card-art', {}, posterImg(item.backdrop || item.poster || item.logo, title)));
  el.append(h('span.hub-card-name', { text: title }));
  const sub = forYouSub(item);
  if (sub) el.append(h('span.hub-card-sub', { text: sub }));
  return el;
}

export function paintStrip(host, items, makeCard, empty = 'Watch something to fill this list') {
  if (!items || !items.length) {
    host.replaceChildren(h('div.hub-empty', { text: empty }));
    return;
  }
  const nodes = items.map((item) => makeCard(item)).filter(Boolean);
  if (!nodes.length) {
    host.replaceChildren(h('div.hub-empty', { text: empty }));
    return;
  }
  host.replaceChildren(...nodes);
}

export function paintGrid(host, items, { large = false, empty = 'Watch something to fill this list' } = {}) {
  if (!items || !items.length) {
    host.replaceChildren(h('div.hub-empty', { text: empty }));
    return;
  }
  host.classList.add(large ? 'hub-grid-wide' : 'hub-grid-recent');
  const nodes = items.map((item) => (large ? forYouCard(item) : recentCard(item))).filter(Boolean);
  if (!nodes.length) {
    host.replaceChildren(h('div.hub-empty', { text: empty }));
    return;
  }
  host.replaceChildren(...nodes);
}
