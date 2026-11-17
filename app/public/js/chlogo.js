/**
 * Channel logos: always go through /api/logo (2s timeout + disk cache + default).
 * Loaded DOM nodes are reused across virtual guide re-renders to stop flicker.
 */

import { esc } from './util.js';

const MAX_PRELOAD = 8;
const preloadQ = [];
let preloadActive = 0;
/** channelId -> HTMLImageElement that has painted successfully */
const liveLogos = new Map();
/** Remote/original URLs that already resolved (success or default) */
const warmed = new Set();

export function logoSources(ch) {
  const list = [];
  if (!ch) return list;
  for (const url of [ch.logo, ch.playlistLogo, ch.epgLogo]) {
    if (url && !list.includes(url)) list.push(url);
  }
  return list;
}

/** Same-origin proxy URL; always returns an image (never a hard 404). */
export function proxiedLogo(url, name = '') {
  const u = String(url || '').trim();
  if (!u) return `/api/logo/default?n=${encodeURIComponent(String(name || '').slice(0, 40))}`;
  if (u.startsWith('/api/logo')) return u;
  return `/api/logo?u=${encodeURIComponent(u)}&n=${encodeURIComponent(String(name || '').slice(0, 40))}`;
}

export function defaultLogoUrl(name = '') {
  return `/api/logo/default?n=${encodeURIComponent(String(name || '').slice(0, 40))}`;
}

function primaryUrl(ch) {
  const sources = logoSources(ch);
  return proxiedLogo(sources[0] || '', ch && ch.name);
}

function markWarm(src) {
  if (!src) return;
  warmed.add(src);
  // Preload success set can grow with huge guides — keep a hard cap.
  if (warmed.size > 600) {
    const drop = [...warmed].slice(0, warmed.size - 600);
    for (const u of drop) warmed.delete(u);
  }
}

/** Remember a painted logo node for a channel (guide virtual scroll reuse). */
export function rememberLogo(chId, img) {
  if (!chId || !img || img.tagName !== 'IMG') return;
  if (img.complete && img.naturalWidth > 0) {
    liveLogos.set(String(chId), img);
    markWarm(img.currentSrc || img.src);
  }
}

export function takeLogo(chId) {
  if (!chId) return null;
  const img = liveLogos.get(String(chId));
  if (!img) return null;
  liveLogos.delete(String(chId));
  return img;
}

/** Detach painted logos before a virtual re-render wipes the DOM. */
export function harvestLogos(root) {
  if (!root) return;
  root.querySelectorAll('.epg-ch[data-ch-id] img.ch-logo, .list-item[data-ch] img.logo').forEach((img) => {
    const host = img.closest('[data-ch-id], [data-ch]');
    const id = host && (host.dataset.chId || host.dataset.ch);
    if (!id || !(img.complete && img.naturalWidth > 0)) return;
    img.remove();
    liveLogos.set(String(id), img);
    markWarm(img.currentSrc || img.src);
  });
  // Cap memory if the user scrolls a huge guide.
  if (liveLogos.size > 400) {
    const drop = [...liveLogos.keys()].slice(0, liveLogos.size - 400);
    for (const id of drop) liveLogos.delete(id);
  }
}

/** After a virtual re-render, put kept logos back so they do not reload. */
export function restoreLogos(root) {
  if (!root) return;
  root.querySelectorAll('.epg-ch[data-ch-id], .list-item[data-ch]').forEach((host) => {
    const id = host.dataset.chId || host.dataset.ch;
    const kept = takeLogo(id);
    if (!kept) return;
    const slot = host.querySelector('img.ch-logo, img.logo, span.ch-logo');
    if (!slot) {
      host.insertBefore(kept, host.firstChild);
      return;
    }
    if (slot !== kept) slot.replaceWith(kept);
  });
}

function pumpPreload() {
  while (preloadActive < MAX_PRELOAD && preloadQ.length) {
    const src = preloadQ.shift();
    if (!src || warmed.has(src)) continue;
    preloadActive += 1;
    const img = new Image();
    img.decoding = 'async';
    img.onload = img.onerror = () => {
      markWarm(src);
      preloadActive -= 1;
      pumpPreload();
    };
    img.src = src;
  }
}

/** Warm the proxy/browser cache without blocking the UI thread. */
export function preloadLogos(channels) {
  const list = Array.isArray(channels) ? channels : [];
  for (const ch of list) {
    const src = primaryUrl(ch);
    if (!src || warmed.has(src)) continue;
    if (!preloadQ.includes(src)) preloadQ.push(src);
  }
  pumpPreload();
}

export function channelLogoHtml(ch) {
  const src = primaryUrl(ch);
  const id = ch && ch.id ? String(ch.id) : '';
  return `<img class="ch-logo" src="${esc(src)}" alt="" `
    + `decoding="async" loading="lazy" data-ch-logo="${esc(id)}" `
    + `referrerpolicy="no-referrer">`;
}

export function channelLogoEl(ch) {
  const src = primaryUrl(ch);
  const img = document.createElement('img');
  img.className = 'logo ch-logo';
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.src = src;
  if (ch && ch.id) {
    img.dataset.chLogo = String(ch.id);
    img.addEventListener('load', () => rememberLogo(ch.id, img), { once: true });
  }
  // Proxy always returns an image — keep the node even if decode fails.
  img.addEventListener('error', () => {
    const fallback = defaultLogoUrl(ch && ch.name);
    if (img.src !== fallback && !img.src.includes('/api/logo/default')) img.src = fallback;
  });
  return img;
}
