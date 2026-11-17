import { get, post } from '../api.js';
import { h, fmtClock, fmtTime, prefs, toast } from '../util.js';
import { createSeekTip } from '../seek-tip.js';
import { createPlayerSettings } from '../player-settings.js';
import { goBack, device } from '../app.js';
import { focusEl } from '../nav.js';
import { StreamPlayer } from '../player.js';
import { playerLog, playerDebugSession } from '../player-debug.js';

const HIDE_AFTER_MS = 4500;
const SEEK_STEP = 15;
const SEEK_STEP_LONG = 30;
const SEEK_STEP_1M = 60;
const COUNTDOWN_SEC = 15;
/** Trailing idle before one seek commit (resets on every skip press). */
const SEEK_COMMIT_MS = 550;

const svg = (body, fill = true) => `<svg viewBox="0 0 24 24" width="1em" height="1em" ${fill
  ? 'fill="currentColor"'
  : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'}>${body}</svg>`;
const skipIcon = (back, label) => `${svg(back
  ? '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>'
  : '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>', false)}<span class="skip-n">${label}</span>`;
const ICON = {
  play: svg('<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>'),
  pause: svg('<rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/>'),
  rew15: skipIcon(true, '15'),
  fwd15: skipIcon(false, '15'),
  rew30: skipIcon(true, '30'),
  fwd30: skipIcon(false, '30'),
  rew1m: skipIcon(true, '1m'),
  fwd1m: skipIcon(false, '1m'),
  restart: svg('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M10 9v6l5-3z" fill="currentColor"/>', false),
  expand: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', false),
  shrink: svg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>', false),
  volHigh: svg('<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>', false),
  volMed: svg('<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M16 9a4 4 0 0 1 0 6"/>', false),
  volLow: svg('<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M15.5 10.5a2.5 2.5 0 0 1 0 3"/>', false),
  mute: svg('<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M17 9l5 6M22 9l-5 6"/>', false),
};

function native(method, ...args) {
  try {
    if (window.XsNative && typeof window.XsNative[method] === 'function') return window.XsNative[method](...args);
  } catch { /* bridge unavailable */ }
  return undefined;
}

function episodeLabel(ep) {
  return `S${ep.season} E${ep.episode}${ep.title ? ` · ${ep.title}` : ''}`;
}

export async function mount(root, params) {
  playerLog('vod.mount', 'open', {
    id: params.id || '',
    series: params.series || '',
    title: params.title || '',
    resume: params.resume,
    playlist: params.playlist || '',
    session: playerDebugSession(),
  });
  const phone = device === 'phone';
  const video = h('video', { playsinline: true, 'webkit-playsinline': true, autoplay: true, preload: 'auto' });
  const savedVol = Math.max(0, Math.min(100, Number(prefs.get('volume', 100)) || 100));
  const savedMuted = !!prefs.get('muted', false);
  video.volume = (savedMuted ? Math.max(1, savedVol) : savedVol) / 100;
  video.muted = savedMuted;
  const convertAhead = prefs.get('vodConvertAhead', true) !== false;
  const message = h('div.overlay-msg', { text: 'Loading…' });
  const logo = h('img', { alt: '', onerror: () => { logo.style.display = 'none'; } });
  const title = h('div.ttl', { text: params.title || 'Video' });
  const sub = h('div.sub', { text: '' });
  const clock = h('div.clock');
  const bufLayer = h('div.buf-layer');
  const fill = h('div.fill');
  const knob = h('div.knob');
  const seekbar = h('div.seekbar.focusable', { tabindex: '0', role: 'slider', 'aria-label': 'Seek' }, bufLayer, fill, knob);
  const seekTip = createSeekTip(seekbar);
  const posLabel = h('span', { text: '0:00' });
  const endLabel = h('span', { text: '' });

  const btn = (label, onClick, cls = '') => h(`button.cbtn.focusable${cls}`, { type: 'button', onclick: onClick }, label);
  const iconBtn = (icon, label, onClick, cls = '') => {
    const b = h(`button.cbtn.focusable${cls}`, { type: 'button', onclick: onClick, title: label, 'aria-label': label });
    b.innerHTML = icon;
    return b;
  };
  const backBtn = phone
    ? h('button.cbtn.focusable.pb-back', { type: 'button', onclick: () => goBack(), 'aria-label': 'Back' },
      h('span.pb-arrow', { text: '←' }), h('span.pb-label', { text: 'Back' }))
    : btn('←', () => goBack());
  // Desktop: 15s/30s/1m. Phone: ±1m + Restart (+ play/pause).
  const rew30Btn = phone ? null : btn('−30s', () => seekBy(-SEEK_STEP_LONG));
  const rewBtn = phone ? null : btn('−15s', () => seekBy(-SEEK_STEP));
  const playBtn = phone ? iconBtn(ICON.pause, 'Play / pause', () => togglePlay(), '.primary.big') : btn('❚❚', () => togglePlay(), '.primary');
  const fwdBtn = phone ? null : btn('+15s', () => seekBy(SEEK_STEP));
  const fwd30Btn = phone ? null : btn('+30s', () => seekBy(SEEK_STEP_LONG));
  const rew1mBtn = phone
    ? iconBtn(ICON.rew1m, 'Back 1 minute', () => seekBy(-SEEK_STEP_1M), '.skip')
    : btn('−1m', () => seekBy(-SEEK_STEP_1M));
  const fwd1mBtn = phone
    ? iconBtn(ICON.fwd1m, 'Forward 1 minute', () => seekBy(SEEK_STEP_1M), '.skip')
    : btn('+1m', () => seekBy(SEEK_STEP_1M));
  const restartBtn = phone ? iconBtn(ICON.restart, 'Start from the beginning', () => restart()) : btn('⟲ Restart', () => restart());
  const setPaused = (paused) => {
    if (phone) playBtn.innerHTML = paused ? ICON.play : ICON.pause;
    else playBtn.textContent = paused ? '▶' : '❚❚';
  };
  let engine = null;
  let volumeBeforeMute = Math.max(1, savedMuted ? savedVol : savedVol || 100);
  let volumeOpen = false;
  const volume = h('input.vol-slider.focusable', {
    type: 'range', min: '0', max: '100', value: String(savedMuted ? 0 : savedVol),
    'aria-label': 'Volume',
    oninput: (e) => {
      const pct = Math.max(0, Math.min(100, Number(e.target.value) || 0));
      if (pct === 0) {
        if (!(engine && engine.userMuted) && video.volume > 0) {
          volumeBeforeMute = Math.round(video.volume * 100) || volumeBeforeMute;
        }
        applyUserMute(true);
      } else {
        volumeBeforeMute = pct;
        prefs.set('volume', pct);
        if (engine) {
          engine.setVolume(pct / 100);
          applyUserMute(false);
          engine.unlockSound();
        } else {
          video.volume = pct / 100;
          applyUserMute(false);
        }
      }
      setVolumeOpen(true);
      syncVolumeUi();
    },
  });
  const volBtn = h('button.vol-btn.focusable', {
    type: 'button',
    title: 'Mute',
    'aria-label': 'Mute',
    onclick: (e) => {
      e.stopPropagation();
      toggleMute();
      if (!phone) setVolumeOpen(true);
    },
  });
  const volSliderWrap = h('div.vol-slider-wrap', {}, volume);
  const volumeWrap = phone ? null : h('div.volume', {}, volBtn, volSliderWrap);
  if (phone) volBtn.classList.add('phone-mute');

  function setVolumeOpen(open) {
    volumeOpen = !!open;
    if (volumeWrap) volumeWrap.classList.toggle('open', volumeOpen);
    if (volumeOpen) showControls();
  }

  function applyUserMute(muted) {
    prefs.set('muted', !!muted);
    if (engine) engine.setUserMuted(!!muted);
    else video.muted = !!muted;
    if (muted) unmuteBtn.classList.remove('show');
  }

  function syncVolumeUi() {
    const userMuted = engine ? !!engine.userMuted : !!prefs.get('muted', false);
    const level = Math.max(
      0,
      Math.round((engine ? (engine.userMuted ? 0 : video.volume) : video.volume) * 100)
        || volumeBeforeMute
        || Number(prefs.get('volume', 100))
        || 100,
    );
    volume.value = String(userMuted ? 0 : level);
    let icon = ICON.mute;
    if (!userMuted) {
      if (level < 34) icon = ICON.volLow;
      else if (level < 67) icon = ICON.volMed;
      else icon = ICON.volHigh;
    }
    volBtn.innerHTML = icon;
    volBtn.title = userMuted ? 'Unmute' : 'Mute';
    volBtn.setAttribute('aria-label', volBtn.title);
    volBtn.classList.toggle('is-muted', userMuted);
  }

  function toggleMute() {
    const muted = engine ? !!engine.userMuted : !!video.muted;
    if (muted || !(video.volume > 0)) {
      const restore = volumeBeforeMute > 0 ? volumeBeforeMute : 100;
      volume.value = String(restore);
      prefs.set('volume', restore);
      if (engine) {
        engine.setVolume(restore / 100);
        applyUserMute(false);
        engine.unlockSound();
      } else {
        video.volume = restore / 100;
        applyUserMute(false);
      }
    } else {
      volumeBeforeMute = Math.round(video.volume * 100) || volumeBeforeMute || 100;
      applyUserMute(true);
    }
    syncVolumeUi();
    showControls();
  }

  const VOL_STEP = 5;
  function nudgeVolume(delta) {
    const muted = engine ? !!engine.userMuted : !!video.muted;
    const cur = muted
      ? 0
      : Math.max(0, Math.min(100, Math.round((engine ? engine.getVolume() : video.volume) * 100)
        || volumeBeforeMute
        || Number(prefs.get('volume', 100))
        || 100));
    const next = Math.max(0, Math.min(100, cur + delta));
    if (next === 0) {
      if (!muted && video.volume > 0) {
        volumeBeforeMute = Math.round(video.volume * 100) || volumeBeforeMute || 100;
      }
      applyUserMute(true);
    } else {
      volumeBeforeMute = next;
      prefs.set('volume', next);
      if (engine) {
        engine.setVolume(next / 100);
        applyUserMute(false);
        engine.unlockSound();
      } else {
        video.volume = next / 100;
        applyUserMute(false);
      }
    }
    volume.value = String(next);
    syncVolumeUi();
    setVolumeOpen(true);
    showControls();
  }

  syncVolumeUi();

  const fullBtn = !phone ? iconBtn(ICON.expand, 'Full screen', () => toggleFullscreen()) : null;

  let subRefreshTimer = null;
  const playerSettings = createPlayerSettings({
    getTracks: () => (engine ? engine.listSubtitleTracks() : []),
    setTrack: (id) => { if (engine) engine.setSubtitleTrack(id); },
    getCurrentId: () => (engine ? engine.getSubtitleTrackId() : -1),
    onOpenChange: (isOpen) => {
      if (isOpen) showControls();
    },
  });
  function scheduleSubtitleRefresh() {
    clearTimeout(subRefreshTimer);
    let n = 0;
    const tick = () => {
      if (destroyed) return;
      playerSettings.refresh();
      if (++n < 10) subRefreshTimer = setTimeout(tick, 1200);
    };
    tick();
  }

  const ui = phone
    ? h('div.player-ui.phone-ui', {},
      h('div.player-top', {}, backBtn, logo, h('div.pt-text', {}, title, sub), playerSettings.button, volBtn),
      h('div.pc-center', {},
        h('div.pc-row', {}, rew1mBtn, playBtn, fwd1mBtn),
        h('div.pc-row.pc-small', {}, restartBtn)),
      h('div.player-bottom', {}, h('div.seek', {}, posLabel, seekbar, endLabel)))
    : h('div.player-ui', {},
      h('div.player-top', {}, logo, h('div.pt-text', {}, title, sub), clock),
      h('div.player-bottom', {},
        h('div.seek', {}, posLabel, seekbar, endLabel),
        h('div.controls', {}, backBtn, rew1mBtn, rew30Btn, rewBtn, playBtn, fwdBtn, fwd30Btn, fwd1mBtn, restartBtn,
          h('div.spacer'), volumeWrap, playerSettings.button, fullBtn)));

  const upnext = h('div.upnext');
  upnext.hidden = true;
  const still = h('canvas.player-still');
  const unmuteBtn = h('button.unmute-overlay.focusable', { type: 'button', text: 'Tap for sound' });
  const playerEl = h('div.player.vod-player', {}, video, still, message, ui, upnext, unmuteBtn, playerSettings.panel);
  root.append(playerEl);

  let info = null;
  let episodes = [];
  let timer = null;
  let hideTimer = null;
  let destroyed = false;
  let scrub = null;
  let switching = false;
  let holdAdvance = false;
  let cacheInfo = { bytes: 0, total: 0, done: false };
  let lastCacheLogBytes = 0;
  let lastCacheLogAt = 0;
  /** Accumulated ±skip during a button/key burst (seconds). */
  let pendingSeekDelta = 0;
  let seekAnchor = 0;
  let seekTimer = null;
  /** Avoid reconnect storms when remux EOS fires repeatedly mid-episode. */
  let earlyEndAt = 0;
  let earlyEndCount = 0;

  function cachePath() {
    const url = info && info.urls && info.urls[0];
    if (!url) return '';
    try {
      return `/stream-cache${new URL(url, location.origin).search}`;
    } catch {
      return '';
    }
  }

  async function pollCache() {
    if (destroyed || !info || !info.prefetch) return;
    const path = cachePath();
    if (!path) return;
    try {
      cacheInfo = await get(path);
      const now = Date.now();
      const grew = (cacheInfo.bytes || 0) - lastCacheLogBytes >= 2 * 1024 * 1024;
      const timed = now - lastCacheLogAt >= 5000;
      if ((grew || timed || cacheInfo.done) && (cacheInfo.bytes || cacheInfo.done)) {
        lastCacheLogBytes = cacheInfo.bytes || 0;
        lastCacheLogAt = now;
        playerLog('vod.cache', cacheInfo.done ? 'done' : 'progress', {
          bytes: cacheInfo.bytes,
          total: cacheInfo.total,
          done: !!cacheInfo.done,
          error: cacheInfo.error || '',
          itemId: info.itemId,
        });
      }
    } catch { /* ignore */ }
  }

  function setUnmute(show) {
    unmuteBtn.classList.toggle('show', !!show);
  }

  engine = new StreamPlayer(video, {
    still,
    onState(state) {
      playerLog('vod.state', state, {
        itemId: info && info.itemId,
        episodeId: info && info.episodeId,
        transcode: !!(info && info.transcode),
        prefetch: !!(info && info.prefetch),
        pos: engine.position(),
        buffered: (() => {
          try {
            if (!video.buffered || !video.buffered.length) return 0;
            return Math.round(video.buffered.end(video.buffered.length - 1) * 10) / 10;
          } catch { return 0; }
        })(),
        impl: engine.impl && engine.impl.type,
      });
      if (state === 'playing') {
        message.textContent = '';
        setPaused(false);
        engine.applyMuteState();
        if (!video.muted && !engine.soundBlocked) setUnmute(false);
        syncVolumeUi();
        scheduleSubtitleRefresh();
      } else if (state === 'loading') message.textContent = 'Loading…';
      else if (state === 'reconnecting') {
        // Before first frame, reconnect is remux warmup — not a user seek.
        message.textContent = engine.hasPlayed ? 'Seeking…' : 'Loading…';
      }
      else if (state === 'paused') setPaused(true);
      else if (state === 'muted') {
        if (engine.soundBlocked && !engine.userMuted) {
          setUnmute(true);
          toast('Sound was blocked. Tap the screen or Unmute.');
        } else setUnmute(false);
        syncVolumeUi();
      } else if (state === 'unmuted') {
        setUnmute(false);
        syncVolumeUi();
      }
      else if (state === 'error') message.textContent = 'Playback failed';
    },
  });
  engine.setUserMuted(savedMuted);
  engine.setVolume(savedVol / 100);
  syncVolumeUi();
  unmuteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (engine.userMuted) {
      engine.applyMuteState();
      unmuteBtn.classList.remove('show');
      syncVolumeUi();
      return;
    }
    if (!(video.volume > 0)) video.volume = (volumeBeforeMute || 100) / 100;
    engine.unlockSound();
    unmuteBtn.classList.remove('show');
    syncVolumeUi();
  });
  playerEl.addEventListener('pointerdown', (e) => {
    if (unmuteBtn.contains(e.target)) return;
    if (engine.soundBlocked && !engine.userMuted) engine.unlockSound();
    if (volumeOpen && volumeWrap && !volumeWrap.contains(e.target)) setVolumeOpen(false);
    if (playerSettings.isOpen()
        && !playerSettings.panel.contains(e.target)
        && !playerSettings.button.contains(e.target)) {
      playerSettings.close();
    }
  });
  video.addEventListener('volumechange', () => {
    if (engine.userMuted || engine.soundBlocked) engine.applyMuteState();
    syncVolumeUi();
  });

  function report() {
    if (!info || destroyed) return;
    const position = engine.position();
    const duration = mediaDuration();
    const ep = currentEpisode();
    const knownDur = duration > 1 ? duration : Number((info && info.duration) || (ep && ep.duration) || 0);
    if (Number.isFinite(position) && position > 0) {
      post('/vod/progress', {
        itemId: info.itemId,
        position,
        duration: knownDur || 0,
        seriesId: info.seriesId || undefined,
        episodeId: info.episodeId || undefined,
        playlist: params.playlist || undefined,
      }).catch(() => {});
    }
    const watchTitle = info.title || params.title || '';
    if (watchTitle) {
      post('/watch', {
        kind: info.seriesId ? 'series' : 'movie',
        itemId: info.seriesId || info.itemId,
        seriesId: info.seriesId || undefined,
        episodeId: info.episodeId || undefined,
        season: info.season || undefined,
        episode: info.episode || undefined,
        title: watchTitle,
        subtitle: info.subtitle || '',
        poster: info.poster || '',
        position: Number.isFinite(position) && position > 0 ? position : 0,
        duration: knownDur || 0,
        playlist: params.playlist || undefined,
      }).catch(() => {});
    }
  }

  /** Tell the server to drop the IPTV download / remux so leaving the player frees the account. */
  function stopUpstream() {
    const body = {};
    const link = info && info.urls && info.urls[0];
    if (link) {
      try {
        const u = new URL(link, location.origin);
        const p = u.searchParams.get('p');
        const s = u.searchParams.get('s');
        if (p && s) {
          body.p = p;
          body.s = s;
        }
      } catch { /* fall through */ }
    }
    // Always include playlist so an expired stream link still clears the account download.
    if (params.playlist) body.playlist = params.playlist;
    playerLog('vod.stopUpstream', body.p ? 'link' : (body.playlist ? 'playlist' : 'active'), {
      itemId: info && info.itemId,
    });
    const json = JSON.stringify(body);
    try {
      if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
        const ok = navigator.sendBeacon('/api/play/vod/stop', new Blob([json], { type: 'application/json' }));
        if (ok) return;
      }
    } catch { /* fall through to fetch */ }
    post('/play/vod/stop', body).catch(() => {});
  }

  const onPageHide = () => {
    if (destroyed) return;
    stopUpstream();
  };
  window.addEventListener('pagehide', onPageHide);

  function mediaDuration() {
    const d = engine.duration();
    if (d > 1) return d;
    if (info && info.duration > 1) return Number(info.duration);
    if (engine.transcode || (engine.impl && engine.impl.type === 'mse')) return 0;
    const v = video.duration;
    return Number.isFinite(v) && v > 1 ? v : 0;
  }

  function duration() {
    return mediaDuration();
  }

  function currentEpisode() {
    const id = String((info && info.episodeId) || '');
    return episodes.find((ep) => ep.id === id) || null;
  }

  function nextInSeason() {
    const cur = currentEpisode();
    if (!cur) return null;
    const same = episodes.filter((ep) => ep.season === cur.season).sort((a, b) => a.episode - b.episode);
    const index = same.findIndex((ep) => ep.id === cur.id);
    return index >= 0 ? same[index + 1] || null : null;
  }

  function firstOfSeason(season) {
    return episodes
      .filter((ep) => ep.season === season)
      .sort((a, b) => a.episode - b.episode)[0] || null;
  }

  function seasonChoices() {
    const cur = currentEpisode();
    if (!cur) return [];
    const seasons = [...new Set(episodes.map((ep) => ep.season))].sort((a, b) => a - b);
    const index = seasons.indexOf(cur.season);
    const out = [];
    if (seasons[index + 1] != null) out.push(seasons[index + 1]);
    const earlier = seasons.slice(Math.max(0, index - 2), index).reverse();
    out.push(...earlier);
    return out;
  }

  function showCountdown(ep, seconds) {
    upnext.hidden = false;
    upnext.replaceChildren(
      h('div.upnext-kicker', { text: 'Next episode' }),
      h('div.upnext-title', { text: episodeLabel(ep) }),
      h('div.upnext-count', { text: String(seconds) }),
      h('button.btn.primary.focusable', { type: 'button', onclick: () => startEpisode(ep, false) }, 'Play now'));
  }

  function showSeasons() {
    const choices = seasonChoices();
    upnext.hidden = false;
    const buttons = choices.map((season) => h('button.btn.focusable.upnext-season', {
      type: 'button',
      onclick: () => {
        const ep = firstOfSeason(season);
        if (ep) startEpisode(ep, false);
      },
    }, `Season ${season}`));
    upnext.replaceChildren(
      h('div.upnext-kicker', { text: choices.length ? 'More seasons' : 'End of series' }),
      h('div.upnext-title', { text: choices.length ? 'Start a season' : 'Nothing else queued' }),
      buttons.length ? h('div.upnext-seasons', {}, ...buttons) : null);
  }

  function updateUpNext() {
    if (switching || holdAdvance || seekTimer || !info || !info.episodeId || !episodes.length) {
      if (switching || holdAdvance || seekTimer) upnext.hidden = true;
      return;
    }
    // Hard seek / remux reopen in flight — never show "next episode" off a stale clock.
    if (engine.pendingSeek != null || !engine.hasPlayed) {
      upnext.hidden = true;
      return;
    }
    const dur = duration();
    const cur = engine.position();
    if (!dur) return;
    const left = dur - cur;
    const nxt = nextInSeason();
    if (nxt && left <= COUNTDOWN_SEC && left > 0.4) {
      showCountdown(nxt, Math.max(1, Math.ceil(left)));
      return;
    }
    if (!nxt && left <= COUNTDOWN_SEC) {
      showSeasons();
      return;
    }
    upnext.hidden = true;
  }

  /** True when the playhead is at the real end of the title (not a short remux EOS). */
  function nearEpisodeEnd() {
    const dur = duration();
    const cur = engine.position();
    if (!(dur > 30) || !Number.isFinite(cur)) return false;
    return cur >= dur - 1.5;
  }

  async function startEpisode(ep, resume) {
    if (!ep || destroyed || switching) return;
    switching = true;
    holdAdvance = true;
    clearSeekBurst();
    earlyEndCount = 0;
    upnext.hidden = true;
    message.textContent = 'Loading…';
    playerLog('vod.episode', resume ? 'resume' : 'start', {
      episodeId: ep.id,
      season: ep.season,
      episode: ep.episode,
      title: ep.title || '',
    });
    try {
      report();
      const q = new URLSearchParams({
        id: `e:${ep.id}`,
        resume: resume ? '1' : '0',
        series: params.series || (info && info.seriesId) || '',
      });
      if (params.playlist) q.set('playlist', params.playlist);
      const next = await get(`/play/vod?${q}`);
      if (destroyed) return;
      info = next;
      cacheInfo = { bytes: 0, total: 0, done: false };
      lastCacheLogBytes = 0;
      title.textContent = next.title || params.title || 'Video';
      sub.textContent = next.subtitle || episodeLabel(ep);
      if (next.poster) {
        logo.src = next.poster;
        logo.style.display = '';
      }
      playerLog('vod.play', 'episode engine.play', {
        kind: next.kind,
        transcode: !!next.transcode,
        prefetch: !!next.prefetch,
        start: next.start || 0,
        duration: next.duration || 0,
        itemId: next.itemId,
        episodeId: next.episodeId,
        videoCodec: next.videoCodec || '',
        audioCodec: next.audioCodec || '',
        url0: next.urls && next.urls[0] ? String(next.urls[0]).slice(0, 160) : '',
      });
      engine.play(next.urls, next.kind, {
        live: false,
        start: next.start || 0,
        duration: next.duration || 0,
        convertAhead,
        transcode: !!next.transcode,
        prefetch: !!next.prefetch,
        videoCodec: next.videoCodec || '',
        audioCodec: next.audioCodec || '',
      });
      tick();
    } catch (err) {
      playerLog('vod.episode.error', err && err.message);
      message.textContent = err.message;
    } finally {
      switching = false;
    }
  }

  function updateBuffer() {
    const dur = duration();
    bufLayer.replaceChildren();
    if (!dur) return;
    // Disk download progress (native MP4 and remux-from-cache titles).
    if (info && info.prefetch) {
      const frac = cacheInfo.total > 0
        ? Math.max(0, Math.min(1, cacheInfo.bytes / cacheInfo.total))
        : (cacheInfo.bytes > 0 ? Math.min(0.95, cacheInfo.bytes / (40 * 1024 * 1024)) : 0);
      if (frac > 0) {
        const el = h('div.buf');
        el.style.left = '0';
        el.style.width = `${frac * 100}%`;
        bufLayer.append(el);
      }
      return;
    }
    if (!convertAhead || !info || !info.transcode || !video.buffered) return;
    const offset = engine.seekOffset || 0;
    try {
      for (let i = 0; i < video.buffered.length; i++) {
        const start = Math.max(0, Math.min(1, (offset + video.buffered.start(i)) / dur));
        const end = Math.max(0, Math.min(1, (offset + video.buffered.end(i)) / dur));
        if (end <= start) continue;
        const el = h('div.buf');
        el.style.left = `${start * 100}%`;
        el.style.width = `${(end - start) * 100}%`;
        bufLayer.append(el);
      }
    } catch { /* TimeRanges not ready */ }
  }

  function clearSeekBurst() {
    clearTimeout(seekTimer);
    seekTimer = null;
    pendingSeekDelta = 0;
    seekAnchor = 0;
    if (seekTip.mode === 'delta') seekTip.hide({ delay: 450 });
  }

  function updateSeekTipForBurst() {
    if (!seekTimer || !pendingSeekDelta) return;
    const dur = duration() || 1;
    const cur = displayPosition();
    const frac = Math.max(0, Math.min(1, cur / dur));
    seekTip.showDelta(frac, fmtClock(cur * 1000), pendingSeekDelta * 1000);
  }

  /** Playhead for UI: prefer in-progress skip burst, then engine (incl. pending hard seek). */
  function displayPosition() {
    if (seekTimer && seekAnchor >= 0) {
      const dur = duration();
      let t = seekAnchor + pendingSeekDelta;
      if (t < 0) t = 0;
      if (dur && t > dur - 0.25) t = Math.max(0, dur - 0.25);
      return t;
    }
    return engine.position();
  }

  function tick() {
    clock.textContent = fmtTime(Date.now());
    const dur = duration();
    const cur = displayPosition();
    if (holdAdvance && dur && cur < 2) holdAdvance = false;
    updateBuffer();
    if (scrub || switching) return;
    posLabel.textContent = seekTimer
      ? `→ ${fmtClock(cur * 1000)}`
      : fmtClock(cur * 1000);
    endLabel.textContent = dur ? fmtClock(dur * 1000) : '';
    const frac = dur ? Math.max(0, Math.min(1, cur / dur)) : 0;
    fill.style.width = `${frac * 100}%`;
    knob.style.left = `${frac * 100}%`;
    updateUpNext();
    const nxt = nextInSeason();
    // Only auto-advance at the real end — remux hard-seeks start currentTime at 0 and
    // a short fMP4 can fire ended/near-end logic while still mid-episode.
    if (
      !holdAdvance
      && !seekTimer
      && !switching
      && engine.hasPlayed
      && engine.pendingSeek == null
      && nxt
      && nearEpisodeEnd()
    ) {
      holdAdvance = true;
      startEpisode(nxt, false);
    }
  }

  function seekAnchorNow() {
    // Stack on an in-flight hard-seek target so bursts during remux reopen don't jump back.
    if (engine.pendingSeek != null) return engine.pendingSeek;
    return engine.position();
  }

  function seekTo(seconds) {
    const from = engine.position();
    playerLog('vod.seek', '', {
      from,
      to: seconds,
      delta: Math.round(seconds - from),
      itemId: info && info.itemId,
      transcode: !!(info && info.transcode),
      convertAhead,
    });
    const mode = engine.seek(seconds);
    playerLog('vod.seek.mode', mode || 'local', { to: seconds });
    if (mode === 'network') message.textContent = 'Seeking…';
    showControls();
    tick();
  }

  function commitSeekBurst() {
    const total = pendingSeekDelta;
    const from = seekAnchor;
    clearSeekBurst();
    if (!total) return;
    const to = from + total;
    playerLog('vod.queueSeek.commit', '', { from, total, to });
    seekTo(to);
  }

  /**
   * Skip/FF/RW: trailing-edge coalesce — every press extends the idle timer.
   * Stream is touched only after the user stops bursting for SEEK_COMMIT_MS.
   */
  function queueSeek(delta) {
    if (switching) return;
    if (!seekTimer && pendingSeekDelta === 0) {
      seekAnchor = seekAnchorNow();
    }
    pendingSeekDelta += delta;
    const dur = duration();
    let to = seekAnchor + pendingSeekDelta;
    if (to < 0) pendingSeekDelta = -seekAnchor;
    if (dur > 0 && to > dur - 0.25) pendingSeekDelta = (dur - 0.25) - seekAnchor;
    clearTimeout(seekTimer);
    seekTimer = setTimeout(commitSeekBurst, SEEK_COMMIT_MS);
    playerLog('vod.queueSeek', '', {
      delta,
      pending: pendingSeekDelta,
      to: seekAnchor + pendingSeekDelta,
      anchor: seekAnchor,
    });
    showControls();
    tick();
    updateSeekTipForBurst();
  }

  function seekBy(seconds) {
    queueSeek(seconds);
  }

  function restart() {
    playerLog('vod.restart', '', { itemId: info && info.itemId });
    clearSeekBurst();
    seekTo(0);
  }

  function togglePlay() {
    playerLog('vod.togglePlay', engine.paused ? 'resume' : 'pause', {
      pos: engine.position(),
      itemId: info && info.itemId,
    });
    if (engine.paused) {
      engine.resume();
      setPaused(false);
    } else {
      engine.pause();
      setPaused(true);
    }
    showControls();
  }

  function requestFs(el) {
    const fn = el && (el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen);
    if (!fn) return Promise.reject(new Error('unsupported'));
    try {
      return Promise.resolve(fn.call(el, { navigationUI: 'hide' }));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function setFullscreenUi(full) {
    playerEl.classList.toggle('is-full', !!full);
    if (!fullBtn) return;
    fullBtn.innerHTML = full ? ICON.shrink : ICON.expand;
    fullBtn.title = full ? 'Exit full screen' : 'Full screen';
    fullBtn.setAttribute('aria-label', fullBtn.title);
  }

  function hasNative(method) {
    return !!(window.XsNative && typeof window.XsNative[method] === 'function');
  }

  function isFullscreen() {
    if (hasNative('isFullscreen')) return !!native('isFullscreen');
    return !!(document.fullscreenElement || document.webkitFullscreenElement || playerEl.classList.contains('is-full'));
  }

  function toggleFullscreen() {
    // Desktop WinForms: borderless window fullscreen (HTML Fullscreen API is a no-op in WebView2).
    if (hasNative('setFullscreen')) {
      const next = !isFullscreen();
      native('setFullscreen', next);
      setFullscreenUi(next);
      return;
    }
    const full = document.fullscreenElement || document.webkitFullscreenElement;
    if (full) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document).catch(() => {});
      return;
    }
    if (phone) native('setLandscape', true);
    requestFs(playerEl)
      .catch(() => requestFs(document.documentElement))
      .catch(() => requestFs(video))
      .catch(() => {
        setFullscreenUi(true);
        if (phone) native('setLandscape', false);
      });
  }

  function onFullscreenChange() {
    const full = !!(document.fullscreenElement || document.webkitFullscreenElement);
    setFullscreenUi(full);
    if (device === 'phone') native('setLandscape', full);
  }
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
  window.__onNativeFullscreen = (on) => setFullscreenUi(!!on);
  native('setImmersive', true);

  function controlsVisible() {
    return !ui.classList.contains('hidden');
  }

  function hidePlayerChrome() {
    ui.classList.add('hidden');
    playerEl.classList.add('ui-idle');
    setVolumeOpen(false);
    playerSettings.close();
  }

  function showControls(focus) {
    ui.classList.remove('hidden');
    playerEl.classList.remove('ui-idle');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (scrub || volumeOpen) showControls();
      else if (!engine || !engine.paused) hidePlayerChrome();
    }, HIDE_AFTER_MS);
    if (focus && !ui.contains(document.activeElement)) focusEl(playBtn);
  }

  function toggleControls() {
    if (controlsVisible()) {
      clearTimeout(hideTimer);
      hidePlayerChrome();
    } else {
      showControls();
    }
  }

  function fracAt(clientX) {
    const rect = seekbar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / (rect.width || 1)));
  }

  function showScrub(clientX) {
    const dur = duration() || 2 * 3600;
    scrub.frac = fracAt(clientX);
    fill.style.width = `${scrub.frac * 100}%`;
    knob.style.left = `${scrub.frac * 100}%`;
    const label = fmtClock(scrub.frac * dur * 1000);
    posLabel.textContent = label;
    seekTip.showHover(scrub.frac, label);
  }

  function endScrub(e, commit) {
    if (!scrub || e.pointerId !== scrub.id) return;
    const dur = duration() || 2 * 3600;
    const frac = scrub.frac;
    scrub = null;
    seekbar.classList.remove('scrubbing');
    if (commit) seekTo(frac * dur);
    seekTip.hide();
    tick();
    showControls();
  }

  function hoverSeekTip(clientX) {
    if (scrub || seekTimer) return;
    const dur = duration() || 2 * 3600;
    const frac = fracAt(clientX);
    seekTip.showHover(frac, fmtClock(frac * dur * 1000));
  }

  seekbar.addEventListener('click', (e) => e.stopPropagation());
  seekbar.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    scrub = { id: e.pointerId, frac: 0 };
    try { seekbar.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    seekbar.classList.add('scrubbing');
    showControls();
    showScrub(e.clientX);
  });
  seekbar.addEventListener('pointermove', (e) => {
    if (scrub && e.pointerId === scrub.id) showScrub(e.clientX);
    else if (e.pointerType === 'mouse') hoverSeekTip(e.clientX);
  });
  seekbar.addEventListener('pointerenter', (e) => {
    if (e.pointerType === 'mouse' && !scrub && !seekTimer) hoverSeekTip(e.clientX);
  });
  seekbar.addEventListener('pointerleave', () => {
    if (!scrub && seekTip.mode === 'hover') seekTip.hide();
  });
  seekbar.addEventListener('pointerup', (e) => {
    clearSeekBurst();
    endScrub(e, true);
  });
  seekbar.addEventListener('pointercancel', (e) => endScrub(e, false));

  let pointerKind = 'mouse';
  playerEl.addEventListener('pointerdown', (e) => { pointerKind = e.pointerType; }, true);
  playerEl.addEventListener('mousemove', () => showControls());
  playerEl.addEventListener('click', (e) => {
    if (e.target.closest('button, input, .seekbar, .upnext, .volume, .vol-btn, .cc-panel, .cc-btn')) return;
    if (engine && engine.soundBlocked && !engine.userMuted) {
      engine.unlockSound();
      showControls();
      return;
    }
    // Picture click only shows/hides chrome — play/pause is the button only.
    if (pointerKind === 'mouse' && e.detail === 0) return;
    toggleControls();
  });
  playerEl.addEventListener('dblclick', (e) => {
    if (e.target.closest('button, input, .seekbar, .upnext, .volume, .vol-btn')) return;
    if (fullBtn) toggleFullscreen();
  });
  video.addEventListener('timeupdate', tick);
  video.addEventListener('progress', updateBuffer);
  // Native VLC never fires video timeupdate — keep the bar/clock alive on a timer
  // (same idea as the live player). HTML path still gets finer updates from timeupdate.
  const tickTimer = setInterval(tick, 500);
  const bufTimer = setInterval(() => {
    pollCache();
    updateBuffer();
  }, 400);
  video.addEventListener('ended', () => {
    if (switching || holdAdvance || seekTimer) return;
    const pos = engine.position();
    const dur = duration();
    // Remux/fMP4 often hits EOS when ffmpeg stops (growing cache / seek lead) — that is
    // NOT the end of the episode. Continue from the absolute playhead instead of
    // jumping to the next episode (which looks like a reset to 0).
    if (!nearEpisodeEnd()) {
      // Still collecting skip presses — don't fight the burst with reconnects.
      if (seekTimer || engine.pendingSeek != null) {
        playerLog('vod.ended.early', 'defer-burst', { pos, dur });
        return;
      }
      const now = Date.now();
      if (now - earlyEndAt > 20000) earlyEndCount = 0;
      earlyEndAt = now;
      earlyEndCount += 1;
      playerLog('vod.ended.early', earlyEndCount > 6 ? 'hold' : 'continue', {
        pos,
        dur,
        n: earlyEndCount,
        itemId: info && info.itemId,
        transcode: !!(info && info.transcode),
      });
      // Never surface "Playback failed" for a short remux EOS — keep trying or wait.
      if (earlyEndCount > 6) {
        message.textContent = 'Seeking…';
        return;
      }
      if (info && info.transcode) {
        message.textContent = 'Seeking…';
        engine.reconnectAt(Math.max(0, pos));
      } else {
        try {
          video.currentTime = Math.max(0, pos);
          engine.tryPlay();
        } catch { /* ignore */ }
      }
      return;
    }
    const nxt = nextInSeason();
    playerLog('vod.ended', nxt ? 'next episode' : 'seasons', {
      itemId: info && info.itemId,
      nextId: nxt && nxt.id,
      pos,
      dur,
    });
    if (nxt) startEpisode(nxt, false);
    else showSeasons();
  });

  try {
    const q = new URLSearchParams({ id: params.id || '', resume: params.resume === '0' ? '0' : '1' });
    if (params.series) q.set('series', params.series);
    if (params.playlist) q.set('playlist', params.playlist);
    playerLog('vod.play.request', '', { query: q.toString() });
    const t0 = Date.now();
    const jobs = [get(`/play/vod?${q}`)];
    if (params.series) jobs.push(get(`/vod/series/${encodeURIComponent(params.series)}${params.playlist ? `?playlist=${encodeURIComponent(params.playlist)}` : ''}`).catch(() => null));
    const [playback, series] = await Promise.all(jobs);
    if (destroyed) return {};
    info = playback;
    episodes = (series && series.episodes) || [];
    playerLog('vod.play.response', playback.title || '', {
      ms: Date.now() - t0,
      kind: playback.kind,
      transcode: !!playback.transcode,
      prefetch: !!playback.prefetch,
      start: playback.start || 0,
      duration: playback.duration || 0,
      itemId: playback.itemId,
      episodeId: playback.episodeId || '',
      seriesId: playback.seriesId || '',
      episodes: episodes.length,
      convertAhead,
      url0: playback.urls && playback.urls[0] ? String(playback.urls[0]).slice(0, 160) : '',
    });
    title.textContent = info.title || params.title || 'Video';
    sub.textContent = info.subtitle || '';
    if (info.poster) {
      logo.src = info.poster;
      logo.style.display = '';
    } else logo.style.display = 'none';
    playerLog('vod.play', 'engine.play', {
      kind: info.kind,
      transcode: !!info.transcode,
      prefetch: !!info.prefetch,
      start: info.start || 0,
      duration: info.duration || 0,
      videoCodec: info.videoCodec || '',
      audioCodec: info.audioCodec || '',
    });
    engine.play(info.urls, info.kind, {
      live: false,
      start: info.start || 0,
      duration: info.duration || 0,
      convertAhead,
      transcode: !!info.transcode,
      prefetch: !!info.prefetch,
      videoCodec: info.videoCodec || '',
      audioCodec: info.audioCodec || '',
    });
    // Paint resume position immediately (don't wait for the first VLC Time= / timeupdate).
    tick();
    timer = setInterval(report, 8000);
    report();
    showControls(true);
  } catch (err) {
    playerLog('vod.play.error', err && err.message);
    message.textContent = err.message;
  }

  return {
    manageFocus: true,
    onKey(action, e) {
      if (action === 'back') {
        if (isFullscreen()) {
          toggleFullscreen();
          return true;
        }
        return false;
      }
      if (action === 'playpause') {
        togglePlay();
        return true;
      }
      if (action === 'enter' && document.activeElement === playBtn) {
        togglePlay();
        return true;
      }
      if (action === 'mute') {
        toggleMute();
        setVolumeOpen(true);
        return true;
      }
      if (action === 'up' || action === 'down') {
        nudgeVolume(action === 'up' ? VOL_STEP : -VOL_STEP);
        return true;
      }
      if (document.activeElement === volume && (action === 'left' || action === 'right')) return false;
      if (action === 'left' || action === 'rew') {
        seekBy(phone ? -SEEK_STEP_1M : (e && e.shiftKey ? -SEEK_STEP_LONG : -SEEK_STEP));
        return true;
      }
      if (action === 'right' || action === 'ff') {
        seekBy(phone ? SEEK_STEP_1M : (e && e.shiftKey ? SEEK_STEP_LONG : SEEK_STEP));
        return true;
      }
      if (action === 'enter') {
        showControls();
        return true;
      }
      return false;
    },
    unmount() {
      playerLog('vod.unmount', '', { itemId: info && info.itemId, pos: engine.position() });
      destroyed = true;
      clearSeekBurst();
      report();
      if (timer) clearInterval(timer);
      clearInterval(bufTimer);
      clearTimeout(hideTimer);
      clearTimeout(subRefreshTimer);
      clearInterval(tickTimer);
      playerSettings.destroy();
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
      window.__onNativeFullscreen = null;
      window.removeEventListener('pagehide', onPageHide);
      if (hasNative('setFullscreen') && isFullscreen()) native('setFullscreen', false);
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) exit.call(document).catch(() => {});
      }
      native('setImmersive', false);
      // Kill IPTV download / remux before tearing down the element (keeps connection free).
      stopUpstream();
      engine.stop();
    },
  };
}
