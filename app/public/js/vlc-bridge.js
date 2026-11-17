/**
 * Thin wrapper around window.XsNative libVLC methods (Android / Windows shells).
 * When unavailable, callers fall back to the MSE / mpegts HTML path.
 */

import { playerLog } from './player-debug.js';

export function hasNativeVlc() {
  try {
    const n = window.XsNative;
    if (!n) return false;
    if (typeof n.hasVlc === 'function') return !!n.hasVlc();
    return typeof n.vlcOpen === 'function';
  } catch (err) {
    playerLog('vlc.hasNative.error', err && err.message, null, { level: 'warn' });
    return false;
  }
}

function native() {
  return window.XsNative || null;
}

export function vlcOpen(url, { start = 0, live = true } = {}) {
  const n = native();
  if (!n || typeof n.vlcOpen !== 'function') {
    playerLog('vlc.open.skip', 'no XsNative.vlcOpen', { url: String(url || '').slice(0, 120) }, { level: 'warn' });
    return false;
  }
  const abs = new URL(url, window.location.origin).href;
  playerLog('vlc.open', live ? 'live' : 'vod', {
    start: Number(start) || 0,
    url: abs.slice(0, 200),
  });
  try {
    n.vlcOpen(abs, JSON.stringify({ start: Number(start) || 0, live: !!live }));
    return true;
  } catch (err) {
    playerLog('vlc.open.error', err && err.message, { url: abs.slice(0, 200) }, { level: 'error' });
    return false;
  }
}

export function vlcPlay() {
  const n = native();
  if (n && typeof n.vlcPlay === 'function') n.vlcPlay();
}

export function vlcPause() {
  const n = native();
  if (n && typeof n.vlcPause === 'function') n.vlcPause();
}

export function vlcStop() {
  const n = native();
  if (n && typeof n.vlcStop === 'function') n.vlcStop();
}

export function vlcSeek(seconds) {
  const n = native();
  if (n && typeof n.vlcSeek === 'function') n.vlcSeek(Number(seconds) || 0);
}

export function vlcGetTime() {
  const n = native();
  if (n && typeof n.vlcGetTime === 'function') return Number(n.vlcGetTime()) || 0;
  return 0;
}

export function vlcGetLength() {
  const n = native();
  if (n && typeof n.vlcGetLength === 'function') return Number(n.vlcGetLength()) || 0;
  return 0;
}

export function vlcIsPlaying() {
  const n = native();
  if (n && typeof n.vlcIsPlaying === 'function') return !!n.vlcIsPlaying();
  return false;
}

export function vlcSetVolume(level) {
  const n = native();
  if (n && typeof n.vlcSetVolume === 'function') n.vlcSetVolume(Math.max(0, Math.min(1, Number(level) || 0)));
}

export function vlcGetVolume() {
  const n = native();
  if (n && typeof n.vlcGetVolume === 'function') {
    const v = Number(n.vlcGetVolume());
    if (Number.isFinite(v)) return Math.max(0, Math.min(1, v));
  }
  return 1;
}

/** @returns {{ id: number, name: string, language?: string }[]} */
export function vlcGetSubtitleTracks() {
  const n = native();
  if (!n || typeof n.vlcGetSubtitleTracks !== 'function') return [];
  try {
    const raw = n.vlcGetSubtitleTracks();
    const list = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || []);
    if (!Array.isArray(list)) return [];
    return list
      .map((t) => ({
        id: Number(t.id),
        name: String(t.name || `Track ${t.id}`),
        language: t.language ? String(t.language) : '',
      }))
      .filter((t) => Number.isFinite(t.id) && t.id !== -1);
  } catch {
    return [];
  }
}

export function vlcGetSubtitleTrack() {
  const n = native();
  if (!n || typeof n.vlcGetSubtitleTrack !== 'function') return -1;
  try {
    const id = Number(n.vlcGetSubtitleTrack());
    return Number.isFinite(id) ? id : -1;
  } catch {
    return -1;
  }
}

/** Pass -1 (or null) to disable subtitles. */
export function vlcSetSubtitleTrack(id) {
  const n = native();
  if (!n || typeof n.vlcSetSubtitleTrack !== 'function') return;
  const spu = id == null || id === '' ? -1 : Number(id);
  try { n.vlcSetSubtitleTrack(Number.isFinite(spu) ? spu : -1); } catch { /* ignore */ }
}

/** Subscribe to native state pushes. Returns an unsubscribe function. */
export function onVlcState(handler) {
  const prev = window.__vlcOnState;
  let lastLogged = '';
  window.__vlcOnState = (payload) => {
    const p = payload || {};
    const state = String(p.state || '');
    if (state && state !== lastLogged) {
      lastLogged = state;
      playerLog('vlc.state', state, {
        time: p.time,
        length: p.length,
        buffering: p.buffering,
        error: p.error || null,
      }, { level: state === 'error' ? 'error' : 'info' });
    }
    try { handler(p); } catch (err) {
      playerLog('vlc.state.handler.error', err && err.message, null, { level: 'error' });
    }
  };
  return () => {
    if (window.__vlcOnState === handler || true) window.__vlcOnState = prev || null;
  };
}

/** Hide HTML &lt;video&gt; so the native VLC surface shows through a transparent WebView. */
export function setHtmlVideoHidden(video, hidden) {
  if (!video) return;
  const was = document.documentElement.classList.contains('vlc-native');
  video.style.opacity = hidden ? '0' : '';
  video.style.pointerEvents = hidden ? 'none' : '';
  if (hidden) {
    try { video.removeAttribute('src'); video.load(); } catch { /* ignore */ }
  }
  document.documentElement.classList.toggle('vlc-native', !!hidden);
  if (was !== !!hidden) {
    playerLog('vlc.chrome', hidden ? 'transparent (native underlay)' : 'opaque (html video)', {
      vlcNativeClass: !!hidden,
    });
  }
}
