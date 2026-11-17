/**
 * Closed captions (CC) control for live + VOD players.
 * Preference key player.subtitles: 'none' (default) or a stable track key.
 */

import { h, prefs } from './util.js';
import { playerLog } from './player-debug.js';

export const SUBTITLE_PREF_KEY = 'player.subtitles';
export const SUBTITLE_NONE = 'none';

export function getSubtitlePref() {
  const v = prefs.get(SUBTITLE_PREF_KEY, SUBTITLE_NONE);
  if (v == null || v === '' || v === false) return SUBTITLE_NONE;
  return String(v);
}

export function setSubtitlePref(key) {
  const next = key == null || key === '' ? SUBTITLE_NONE : String(key);
  prefs.set(SUBTITLE_PREF_KEY, next);
  return next;
}

/** Stable key for remembering a track across streams. */
export function trackKey(track) {
  if (!track) return SUBTITLE_NONE;
  const lang = String(track.language || '').trim().toLowerCase();
  if (lang) return `lang:${lang}`;
  const name = String(track.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (name) return `name:${name}`;
  if (track.id != null && track.id !== -1) return `id:${track.id}`;
  return SUBTITLE_NONE;
}

export function matchTrack(tracks, prefKey) {
  if (!prefKey || prefKey === SUBTITLE_NONE || !Array.isArray(tracks)) return null;
  const exact = tracks.find((t) => trackKey(t) === prefKey);
  if (exact) return exact;
  if (prefKey.startsWith('lang:')) {
    const lang = prefKey.slice(5);
    return tracks.find((t) => String(t.language || '').trim().toLowerCase() === lang) || null;
  }
  if (prefKey.startsWith('name:')) {
    const name = prefKey.slice(5);
    return tracks.find((t) => String(t.name || '').trim().toLowerCase().replace(/\s+/g, ' ') === name) || null;
  }
  if (prefKey.startsWith('id:')) {
    const id = Number(prefKey.slice(3));
    return tracks.find((t) => Number(t.id) === id) || null;
  }
  return null;
}

/**
 * @param {{ getTracks: () => Array<{id:number,name:string,language?:string}>, setTrack: (id:number|null) => void, getCurrentId?: () => number|null, onOpenChange?: (open:boolean) => void }} opts
 */
export function createPlayerSettings(opts) {
  const getTracks = opts.getTracks;
  const setTrack = opts.setTrack;
  const onOpenChange = opts.onOpenChange || (() => {});

  // Persist default once so the preference is explicit going forward.
  if (prefs.get(SUBTITLE_PREF_KEY, null) == null) setSubtitlePref(SUBTITLE_NONE);

  let open = false;

  const button = h('button.cbtn.focusable.cc-btn', {
    type: 'button',
    title: 'Subtitles',
    'aria-label': 'Subtitles',
    'aria-haspopup': 'true',
    'aria-expanded': 'false',
    text: 'CC',
  });

  const title = h('div.ps-title', { text: 'Subtitles' });
  const body = h('div.ps-body');
  const panel = h('div.cc-panel', { hidden: true }, title, body);

  function syncButtonState() {
    const on = getSubtitlePref() !== SUBTITLE_NONE;
    button.classList.toggle('is-on', on);
    button.title = on ? 'Subtitles (on)' : 'Subtitles';
    button.setAttribute('aria-label', button.title);
  }

  function close() {
    if (!open) return;
    open = false;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    onOpenChange(false);
  }

  function openPanel() {
    open = true;
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    render();
    onOpenChange(true);
  }

  function toggle() {
    if (open) close();
    else openPanel();
  }

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle();
  });

  function applyPref(tracks) {
    const pref = getSubtitlePref();
    if (pref === SUBTITLE_NONE) {
      setTrack(-1);
      playerLog('ui.subtitles.apply', 'none');
      syncButtonState();
      return;
    }
    const match = matchTrack(tracks, pref);
    if (match) {
      setTrack(match.id);
      playerLog('ui.subtitles.apply', trackKey(match), { id: match.id, name: match.name });
    } else {
      setTrack(-1);
      playerLog('ui.subtitles.apply', 'fallback-none', { pref });
    }
    syncButtonState();
  }

  function select(key, track) {
    setSubtitlePref(key);
    if (key === SUBTITLE_NONE || !track) setTrack(-1);
    else setTrack(track.id);
    playerLog('ui.subtitles.select', key, track ? { id: track.id, name: track.name } : null);
    syncButtonState();
    render();
  }

  function render() {
    const tracks = (getTracks() || []).filter((t) => t && Number(t.id) !== -1);
    const pref = getSubtitlePref();
    const matched = matchTrack(tracks, pref);
    body.replaceChildren();

    const section = h('div.ps-section');
    section.append(optionRow('None', SUBTITLE_NONE, pref === SUBTITLE_NONE || !matched, () => select(SUBTITLE_NONE, null)));

    if (!tracks.length) {
      section.append(h('div.ps-empty', { text: 'No subtitle tracks on this stream' }));
    } else {
      for (const t of tracks) {
        const key = trackKey(t);
        const selected = matched ? Number(matched.id) === Number(t.id) : pref === key;
        const label = t.name || t.language || `Track ${t.id}`;
        section.append(optionRow(label, key, !!selected, () => select(key, t)));
      }
    }
    body.append(section);
    syncButtonState();
  }

  function optionRow(label, key, selected, onPick) {
    return h(`button.ps-option.focusable${selected ? '.is-selected' : ''}`, {
      type: 'button',
      'data-key': key,
      onclick: (e) => {
        e.stopPropagation();
        onPick();
      },
    },
    h('span.ps-radio', { 'aria-hidden': 'true' }),
    h('span.ps-option-label', { text: label }));
  }

  /** Re-read tracks from the engine and apply the saved preference. */
  function refresh() {
    const tracks = (getTracks() || []).filter((t) => t && Number(t.id) !== -1);
    applyPref(tracks);
    if (open) render();
    else syncButtonState();
    return tracks;
  }

  syncButtonState();

  return {
    button,
    panel,
    toggle,
    open: openPanel,
    close,
    refresh,
    isOpen: () => open,
    destroy() {
      close();
    },
  };
}
