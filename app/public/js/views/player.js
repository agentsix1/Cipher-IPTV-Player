import { get, post } from '../api.js';
import { h, esc, fmtTime, fmtRange, fmtClock, prefs, toast } from '../util.js';
import { createSeekTip } from '../seek-tip.js';
import { createPlayerSettings } from '../player-settings.js';
import { goBack, device } from '../app.js';
import { focusEl } from '../nav.js';
import { StreamPlayer } from '../player.js';
import { playerLog, playerDebugSession } from '../player-debug.js';
import { proxiedLogo, defaultLogoUrl } from '../chlogo.js';
import { hasNativeVlc } from '../vlc-bridge.js';
import {
  MIN as POLICY_MIN,
  LIVE_EDGE_MS as POLICY_LIVE_EDGE_MS,
  MSE_ROLL_KEEP_MS,
  decideRollAction,
  decideSeekAction,
  rebaseWindowStart,
  rebaseResumeAt,
  planHardSeekWindow,
} from '../mse-policy.mjs';

const MIN = POLICY_MIN || 60000;
const HIDE_AFTER_MS = 4500;
const SEEK_STEP_MS = 15 * 1000;
const SEEK_STEP_MED_MS = 30 * 1000;
const SEEK_STEP_LONG_MS = 60 * 1000;
/** Collect seek-button clicks for this long, then apply the total once. */
const SEEK_COMMIT_MS = 1000;
const LIVE_EDGE_MS = POLICY_LIVE_EDGE_MS || 15 * 1000;
/** mpegts timeshift cannot jump hours ahead; open near the resume point instead. */
const CATCHUP_LOCAL_JUMP_MS = 90 * 1000;
/** Match live MSE DVR retention — used only while the behind-buffer is still filling. */
const LIVE_DVR_MS = 120 * 1000;
/** Live freeze: underrun at the buffer tip this long → recover (live edge only). */
const LIVE_FREEZE_MS = 5000;
/** Do not arm until playback has been healthy this long after tune/recover. */
const LIVE_FREEZE_ARM_MS = 10000;
/** Avoid reconnect storms when the provider is briefly flaky. */
const LIVE_FREEZE_COOLDOWN_MS = 15000;
/** Stall recovery: abandon broken tip timeshift this close to live. */
const CATCHUP_LIVE_LOOKBACK_MS = 90 * 1000;
/** Buffer end not growing this long (and short of live/settings) → missing timeshift data. */
const GAP_BUFFER_STALL_MS = 2500;
/** Act once the playhead is this close to a dead buffer end. */
const GAP_APPROACH_MS = 5000;
/** Soft-reboot to refill when ahead falls below this and download is stuck (MSE full). */
const CATCHUP_REFILL_AHEAD_MS = 55 * 1000;
/** Target MSE buffer ahead of playhead (slightly above the 2-minute roll keep). */
const MSE_BUFFER_AHEAD_SEC = 150;
const MSE_REFILL_STALL_MS = 1500;
const MSE_ROLL_COOLDOWN_MS = 15000;
const MSE_REFILL_COOLDOWN_MS = 4000;
const GAP_SKIP_COOLDOWN_MS = 4500;
const GAP_MAX_SKIPS = 25;
/** Treat a second stall within this of the first as the same hole (reboot failed). */
const GAP_SAME_HOLE_MS = 45 * 1000;
const SLOT_MS = 30 * MIN;
const RECENT_MAX = 20;
const DOUBLE_TAP_MS = 300;
const SEEK_STREAK_MS = 800;
const TAP_SLOP_PX = 40;

const HOLD_MS = 2000;
const HOLD_SLOP_PX = 14;
const ADJUST_RANGE = 0.6; // dragging across 60% of the screen height covers the whole 0-100% range
const ADJUST_HIDE_MS = 900;

const svg = (body, fill = true) => `<svg viewBox="0 0 24 24" width="1em" height="1em" ${fill
  ? 'fill="currentColor"'
  : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'}>${body}</svg>`;
const ICON = {
  play: svg('<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>'),
  pause: svg('<rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/>'),
  rew15: `${svg('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>', false)}<span class="skip-n">15</span>`,
  fwd15: `${svg('<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>', false)}<span class="skip-n">15</span>`,
  rew30: `${svg('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>', false)}<span class="skip-n">30</span>`,
  fwd30: `${svg('<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>', false)}<span class="skip-n">30</span>`,
  rew: `${svg('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>', false)}<span class="skip-n">1m</span>`,
  fwd: `${svg('<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>', false)}<span class="skip-n">1m</span>`,
  restart: svg('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M10 9v6l5-3z" fill="currentColor"/>', false),
  expand: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', false),
  shrink: svg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>', false),
  volHigh: svg('<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>', false),
  volMed: svg('<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M16 9a4 4 0 0 1 0 6"/>', false),
  volLow: svg('<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M15.5 10.5a2.5 2.5 0 0 1 0 3"/>', false),
  mute: svg('<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M17 9l5 6M22 9l-5 6"/>', false),
  volume: svg('<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>', false),
  sun: svg('<circle cx="12" cy="12" r="4" fill="currentColor"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>', false),
};

/** Calls an optional Android app bridge method (window.XsNative) when present; returns its result. */
function native(method, ...args) {
  try {
    if (window.XsNative && typeof window.XsNative[method] === 'function') return window.XsNative[method](...args);
  } catch { /* bridge unavailable */ }
  return undefined;
}
const hasNative = (method) => !!(window.XsNative && typeof window.XsNative[method] === 'function');

/** Remembers watched channels (newest first) for Search and Home suggestions. */
function rememberChannel(id) {
  const list = prefs.get('recent.channels', []).filter((x) => x !== id);
  list.unshift(id);
  prefs.set('recent.channels', list.slice(0, RECENT_MAX));
}

export async function mount(root, params) {
  const channelId = params.ch;
  playerLog('ui.mount', 'player open', {
    channelId,
    start: params.start || null,
    end: params.end || null,
    session: playerDebugSession(),
  });
  const video = h('video', { playsinline: true, 'webkit-playsinline': true, autoplay: true });
  const savedVol = Math.max(0, Math.min(100, Number(prefs.get('volume', 100)) || 100));
  const savedMuted = !!prefs.get('muted', false);
  video.volume = (savedMuted ? Math.max(1, savedVol) : savedVol) / 100;
  video.muted = savedMuted;
  const message = h('div.overlay-msg', { text: 'Loading…' });

  const logo = h('img', { alt: '', referrerpolicy: 'no-referrer' });
  const title = h('div.ttl');
  const sub = h('div.sub');
  const clock = h('div.clock');
  const fill = h('div.fill');
  const liveEdge = h('div.live-edge');
  const bufLayer = h('div.buf-layer');
  const knob = h('div.knob');
  const seekbar = h('div.seekbar.focusable', { tabindex: '0', role: 'slider', 'aria-label': 'Seek' }, liveEdge, bufLayer, fill, knob);
  const seekTip = createSeekTip(seekbar);
  const posLabel = h('span', { text: '' });
  const endLabel = h('span', { text: '' });

  const phone = device === 'phone';
  const btn = (label, onClick, cls = '') => h(`button.cbtn.focusable${cls}`, { onclick: onClick, title: label.title || '' }, label.text || label);
  const iconBtn = (icon, label, onClick, cls = '') => {
    const b = h(`button.cbtn.focusable${cls}`, { type: 'button', onclick: onClick, title: label, 'aria-label': label });
    b.innerHTML = icon;
    return b;
  };
  const backBtn = phone
    ? h('button.cbtn.focusable.pb-back', { type: 'button', onclick: () => goBack(), 'aria-label': 'Back' },
      h('span.pb-arrow', { text: '←' }), h('span.pb-label', { text: 'Back' }))
    : btn('←', () => goBack());
  // Live / catch-up: ±1 minute only (no 15s / 30s).
  const playBtn = phone ? iconBtn(ICON.pause, 'Play / pause', () => togglePlay(), '.primary.big') : btn('❚❚', () => togglePlay(), '.primary');
  const rew1mBtn = phone ? iconBtn(ICON.rew, 'Back 1 minute', () => queueSeek(-SEEK_STEP_LONG_MS), '.skip') : btn('−1m', () => queueSeek(-SEEK_STEP_LONG_MS));
  const fwd1mBtn = phone ? iconBtn(ICON.fwd, 'Forward 1 minute', () => queueSeek(SEEK_STEP_LONG_MS), '.skip') : btn('+1m', () => queueSeek(SEEK_STEP_LONG_MS));
  const restartBtn = phone ? iconBtn(ICON.restart, 'Restart this programme', () => restartProgramme()) : btn('⟲ Restart', () => restartProgramme());
  const liveBtn = btn('● LIVE', () => goLive(), '.live');
  const setPaused = (paused) => {
    if (phone) playBtn.innerHTML = paused ? ICON.play : ICON.pause;
    else playBtn.textContent = paused ? '▶' : '❚❚';
  };

  /** Set before StreamPlayer is constructed so volume helpers can safely reference it. */
  let engine = null;
  /** Volume before mute — restored when unmuting (M key or speaker click). */
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
      // Desktop: reveal the slider. Phone: mute button only (no slider in the chrome).
      if (!phone) setVolumeOpen(true);
    },
  });
  const volSliderWrap = h('div.vol-slider-wrap', {}, volume);
  // Desktop: speaker + hover/click slider. Phone: speaker mute only (hold-right still adjusts level).
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
    // Volume-bar mute is separate from autoplay — hide "Tap for sound".
    if (muted) unmuteBtn.classList.remove('show');
  }

  function syncVolumeUi() {
    // Volume bar follows user intent only — not browser autoplay mute.
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

  // Phones have no full-screen button: double-tap the middle of the picture instead.
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

  // Phones: Back top-left; mute top-right; ±1m / Play centre; Restart/Live under them;
  // progress along the bottom. Volume/brightness still use press-and-hold on the picture.
  const ui = phone
    ? h('div.player-ui.phone-ui', {},
      h('div.player-top', {}, backBtn, logo, h('div.pt-text', {}, title, sub), playerSettings.button, volBtn),
      h('div.pc-center', {},
        h('div.pc-row', {}, rew1mBtn, playBtn, fwd1mBtn),
        h('div.pc-row.pc-small', {}, restartBtn, liveBtn)),
      h('div.player-bottom', {}, h('div.seek', {}, posLabel, seekbar, endLabel)))
    : h('div.player-ui', {},
      h('div.player-top', {}, logo, h('div.pt-text', {}, title, sub), clock),
      h('div.player-bottom', {},
        h('div.seek', {}, posLabel, seekbar, endLabel),
        h('div.controls', {}, backBtn, rew1mBtn, playBtn, fwd1mBtn, restartBtn, liveBtn, h('div.spacer'),
          volumeWrap, playerSettings.button, fullBtn)));
  const seekFlash = h('div.seek-flash');
  const adjustIcon = h('div.adj-icon');
  const adjustFill = h('div.adj-fill');
  const adjustValue = h('div.adj-value');
  const adjustPanel = h('div.adjust-panel', {}, adjustIcon, h('div.adj-track', {}, adjustFill), adjustValue);

  const still = h('canvas.player-still');
  const unmuteBtn = h('button.unmute-overlay.focusable', { type: 'button', text: 'Tap for sound' });
  const playerEl = h('div.player', {}, video, still, message, seekFlash, ui, adjustPanel, unmuteBtn, playerSettings.panel);
  root.append(playerEl);

  // ---------- state ----------
  let channel = null;
  let mode = 'live'; // 'live' | 'catchup'
  let lastWatchKey = '';
  let lastWatchAt = 0;
  let streamBase = Date.now(); // real time at stream position 0 (catch-up)
  let windowEnd = 0; // catch-up window end (programme end + preload hours)
  let programme = null;
  let pendingSeek = 0; // accumulated button delta during a burst
  let seekAnchorMs = 0; // real media/bar position frozen at the start of a button burst
  let seekTimer = null;
  let hideTimer = null;
  let tickTimer = null;
  let loadReq = 0;
  let destroyed = false;
  let scrub = null; // { id: pointerId, frac } while the seek bar is being dragged
  let lastBufEndMs = 0;
  let bufGrewAt = 0;
  let gapSkipAt = 0;
  let gapSkips = 0;
  let gapRetried = false; // already rebooted once for the current dead buffer end
  let gapRetryFrom = 0;
  let gapWatchTimer = null;
  let catchupPrefetch = false;
  let catchupPlayUrl = '';
  /** Last catch-up URL that produced sync_byte / demux failure — never same-URL remount. */
  let poisonedCatchupUrl = '';
  let badMediaRecoveries = 0;
  const MAX_BAD_MEDIA_RECOVERIES = 2;
  let cacheInfo = { bytes: 0, total: 0, done: false };
  let cachePollTimer = null;
  /** After a committed seek, keep UI on the target until video.currentTime catches up. */
  let playheadMs = 0;
  let playheadStickyUntil = 0;
  /** Block gap-skip / stall remounts while a seek is landing (stops timestamp thrashing). */
  let seekingUntil = 0;
  let remountTimer = null;
  let remountJumpTimer = null;
  /**
   * Last *automatic* same-URL remount / roll reopen. Must not gate user hard-seeks
   * or soft seeks after leaving MSE — only stops refill storms.
   */
  let lastAutoRemountAt = 0;
  /** Live-only freeze watchdog (underrun at tip while watching at the live edge). */
  let liveMediaTime = -1;
  let liveStallSince = 0;
  let liveStableAt = 0;
  let liveFreezeRecoveries = 0;
  let lastLiveFreezeRecoverAt = 0;
  let liveTuneInFlight = false;

  function preloadPadMs() {
    const hours = Number(prefs.get('catchupPreloadHours', 1));
    return (Number.isFinite(hours) ? Math.max(0, hours) : 1) * 3600000;
  }

  engine = new StreamPlayer(video, {
    still,
    onState(state) {
      playerLog('ui.state', state, {
        mode,
        streamBase,
        playheadMs,
        catchupPrefetch,
        url: catchupPlayUrl ? String(catchupPlayUrl).slice(0, 120) : '',
        badMediaRecoveries,
      });
      if (state === 'playing') {
        message.textContent = '';
        badMediaRecoveries = 0;
        poisonedCatchupUrl = '';
        liveStallSince = 0;
        liveMediaTime = video.currentTime || 0;
        if (!liveStableAt) liveStableAt = Date.now();
        setPaused(false);
        engine.applyMuteState();
        syncVolumeUi();
        if (!video.muted && !engine.soundBlocked) unmuteBtn.classList.remove('show');
        scheduleSubtitleRefresh();
      } else if (state === 'loading') message.textContent = 'Loading…';
      else if (state === 'reconnecting') message.textContent = 'Reconnecting…';
      else if (state === 'buffering') message.textContent = '';
      else if (state === 'catchup-gap') {
        // Seek/remount aborts look like gaps — ignore until the playhead has landed.
        if (isSeekSettling() || engine.useVlc) return;
        if (catchupPrefetch) skipCatchupGapLocal(streamBase + bufferedEndSec() * 1000);
        else recoverCatchupGap(streamBase + bufferedEndSec() * 1000);
      } else if (state === 'catchup-bad-media') {
        // Native VLC demuxes itself — HTML sync_byte recovery would reopen-loop.
        if (engine.useVlc) return;
        // Demux saw non-TS (tip HTML/zeros) — never remount the same poisoned cache.
        if (catchupPlayUrl) poisonedCatchupUrl = catchupPlayUrl;
        if (!recoverCatchupBadMedia(Math.max(mediaPosition(), playheadMs || 0, streamBase || 0))) {
          playerLog('ui.badMedia.giveUp', 'catch-up stream failed', {
            recoveries: badMediaRecoveries,
            poisoned: poisonedCatchupUrl ? String(poisonedCatchupUrl).slice(0, 120) : '',
          });
          message.textContent = 'Catch-up stream failed. Try a different time or go live.';
        }
      } else if (state === 'catchup-refill') {
        // Prefetch HTTP ended — continue from the playhead (never reload show-start into view).
        if (isSeekSettling() || !catchupPrefetch || engine.useVlc) return;
        refillCatchupMse();
      } else if (state === 'paused') setPaused(true);
      else if (state === 'muted') {
        // Autoplay policy only — hide when the volume bar already has mute on.
        if (engine.soundBlocked && !engine.userMuted) {
          unmuteBtn.classList.add('show');
          toast('Sound was blocked. Tap the screen or Unmute.');
        } else {
          unmuteBtn.classList.remove('show');
        }
        syncVolumeUi();
      } else if (state === 'unmuted') {
        unmuteBtn.classList.remove('show');
        syncVolumeUi();
      }
      else if (state === 'error') {
        message.textContent = mode === 'catchup'
          ? 'Catch-up stream failed. Try a different time or adjust the catch-up shift in Settings.'
          : 'This channel could not be played.';
      }
    },
  });
  // Honour the volume bar / saved mute across the whole session.
  engine.setUserMuted(savedMuted);
  syncVolumeUi();

  unmuteBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Autoplay unlock only. If the volume bar is muted, stay muted.
    if (engine.userMuted) {
      engine.soundBlocked = false;
      engine.applyMuteState();
      engine.tryPlay();
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
    // Don't treat "Tap for sound" as a generic unlock click.
    if (unmuteBtn.contains(e.target)) return;
    // Only clear browser autoplay mute — never undo a user mute.
    if (engine.soundBlocked && !engine.userMuted) engine.unlockSound();
    // Volume slider opens only from speaker click / slider drag — close on outside click.
    if (volumeOpen && volumeWrap && !volumeWrap.contains(e.target)) setVolumeOpen(false);
    if (playerSettings.isOpen()
        && !playerSettings.panel.contains(e.target)
        && !playerSettings.button.contains(e.target)) {
      playerSettings.close();
    }
  });
  video.addEventListener('volumechange', () => {
    // Keep element muted in sync, but never let autoplay rewrite the volume-bar UI.
    if (engine.userMuted || engine.soundBlocked) engine.applyMuteState();
    syncVolumeUi();
  });

  /**
   * While at the live tip, keep streamBase aligned so
   * streamBase + currentTime ≈ wall clock. When the user rewinds into the
   * MSE DVR window, freeze streamBase so local seeks stay consistent.
   */
  function syncLiveTimeline() {
    if (mode !== 'live') return;
    // Native VLC live has no HTML DVR clock — pin streamBase to "now" so position ≈ wall.
    if (engine && engine.useVlc) {
      streamBase = Date.now();
      return;
    }
    const v = video.currentTime || 0;
    let end = 0;
    try {
      if (video.buffered && video.buffered.length) end = video.buffered.end(video.buffered.length - 1);
    } catch { /* ignore */ }
    const atTip = !end || end - v < 2.5;
    if (atTip || !streamBase) streamBase = Date.now() - v * 1000;
  }

  /** Where playback actually is (progress bar / video clock) — not button math. */
  function mediaPosition() {
    // Native VLC live: wall clock (no HTML DVR). Catch-up: streamBase + VLC Time=.
    if (engine && engine.useVlc) {
      if (mode === 'live') return Date.now();
      return (streamBase || 0) + engine.position() * 1000;
    }
    const relSec = video.currentTime || 0;
    if (mode === 'live') {
      if (!streamBase) return Date.now();
      return streamBase + relSec * 1000;
    }
    return (streamBase || 0) + relSec * 1000;
  }

  /** Catch-up seeks land on whole minutes (e.g. 12:21:15 − 1m → 12:20:00). */
  function alignCatchupMinute(ms) {
    return Math.floor(Math.max(0, Number(ms) || 0) / MIN) * MIN;
  }

  /**
   * Native VLC catch-up: always mint a timeshift URL at the target minute.
   * Provider MPEG-TS ignores VLC Time= seeks (pos never jumps), and using
   * windowEnd as a "tip" made every seek take that dead path.
   */
  function seekCatchupVlc(targetMs) {
    const aligned = alignCatchupMinute(targetMs);
    const clamped = clampCatchupTarget(aligned);
    const from = mediaPosition();
    playerLog('ui.seekTo.catchupVlc', '', { targetMs, aligned, clamped, streamBase, from });
    setPlayhead(clamped);
    const now = Date.now();
    if (clamped >= now - LIVE_EDGE_MS) {
      goLive();
      return true;
    }
    // Already on (or within ~2s of) the target minute — no remount.
    if (Math.abs(from - clamped) < 2500) {
      playerLog('ui.seekTo.action', 'vlcAlreadyThere', { from, clamped });
      return true;
    }
    playerLog('ui.seekTo.action', 'vlcHardSeek', { clamped, from });
    hardSeekCatchup(clamped, { resumeAt: clamped });
    return true;
  }

  function position() {
    // Seek-button burst: preview from the frozen bar position + total delta.
    if (pendingSeek && seekAnchorMs > 0) {
      // Live may preview past MSE into catch-up; catch-up stays on the open window floor.
      const floor = mode === 'live' ? catchupEarliestMs() : (streamBase || 0);
      return Math.max(floor, Math.min(Date.now(), seekAnchorMs + pendingSeek));
    }
    if (mode === 'live') syncLiveTimeline();
    const fromVideo = mediaPosition();
    // While a seek is landing, show the intended time. Covers forward seeks (video
    // briefly snaps to 0) and backward ones like Restart (video still at the old spot).
    if (playheadMs > 0 && (Date.now() < playheadStickyUntil || Date.now() < seekingUntil)) {
      if (Math.abs(fromVideo - playheadMs) > 500) return playheadMs;
    }
    return fromVideo;
  }

  function setPlayhead(ms) {
    const now = Date.now();
    // Catch-up / live→catch-up may target before the current MSE origin (Restart, hard seek).
    let floor = streamBase || 0;
    if (mode === 'catchup' && programme) floor = Math.min(floor, programme.start);
    else if (mode === 'live' && canSeek()) floor = catchupEarliestMs();
    playheadMs = Math.max(floor, Math.min(Number(ms) || 0, now));
    // Stick longer under VLC — Time= / timeshift mint can take a few seconds.
    playheadStickyUntil = now + (hasNativeVlc() ? 8000 : 4000);
  }

  function beginSeekSettle(ms = 5000) {
    const now = Date.now();
    seekingUntil = Math.max(seekingUntil, now + Math.max(0, ms));
    if (engine && engine.ignoreMediaErrors) engine.ignoreMediaErrors(ms);
  }

  function isSeekSettling() {
    return !!pendingSeek || !!scrub || Date.now() < seekingUntil;
  }

  function clearSeekBurst() {
    pendingSeek = 0;
    seekAnchorMs = 0;
    clearTimeout(seekTimer);
    seekTimer = null;
    if (seekTip.mode === 'delta') seekTip.hide({ delay: 450 });
  }

  function updateSeekTipForBurst() {
    if (!pendingSeek || !seekAnchorMs) return;
    const from = barStartMs();
    const to = barEndMs();
    const span = Math.max(1, to - from);
    const pos = position();
    const frac = Math.max(0, Math.min(1, (pos - from) / span));
    seekTip.showDelta(frac, fmtTime(pos), pendingSeek);
  }

  function canSeek() {
    return !!(channel && channel.catchup);
  }

  /** Without guide data, catch-up channels get half-hour blocks so Restart and the seek bar still work. */
  function blockAt(at) {
    const start = Math.floor(at / SLOT_MS) * SLOT_MS;
    return { start, end: start + SLOT_MS, title: channel.name, desc: '', synthetic: true };
  }

  async function loadProgramme(at) {
    try {
      programme = await get(`/program-at?ch=${encodeURIComponent(channelId)}&t=${Math.round(at)}`);
    } catch {
      programme = null;
    }
    if (!programme && canSeek()) programme = blockAt(at);
    updateInfo();
  }

  function nearLive() {
    return position() >= Date.now() - LIVE_EDGE_MS;
  }

  function updateInfo() {
    if (!channel) return;
    const logoUrl = proxiedLogo(channel.logo || channel.playlistLogo || channel.epgLogo || '', channel.name);
    logo.src = logoUrl;
    logo.style.display = '';
    logo.onerror = () => {
      const fallback = defaultLogoUrl(channel.name);
      if (logo.src !== fallback && !String(logo.src).includes('/api/logo/default')) logo.src = fallback;
    };
    const liveNow = mode === 'live' || nearLive();
    const pill = liveNow ? '<span class="mode-pill">LIVE</span>' : '<span class="mode-pill cu">CATCH-UP</span>';
    title.innerHTML = `${esc(programme ? programme.title : channel.name)} ${pill}`;
    const range = programme ? ` · ${fmtRange(programme.start, programme.end)}${programme.synthetic ? ' · No guide information' : ''}` : '';
    sub.textContent = `${channel.num} · ${channel.name}${range}`;
    restartBtn.title = programme && programme.synthetic ? `Restart from ${fmtTime(programme.start)}` : 'Restart this programme';
    const seekable = canSeek();
    const vis = (el, on) => {
      if (!el) return;
      el.style[phone ? 'visibility' : 'display'] = on ? '' : phone ? 'hidden' : 'none';
    };
    // Phones keep Play centred: skip buttons turn invisible rather than collapsing.
    for (const el of [rew1mBtn, fwd1mBtn]) vis(el, seekable);
    restartBtn.style.display = seekable && programme ? '' : 'none';
    liveBtn.style.display = seekable ? '' : 'none';
    liveBtn.classList.toggle('off', !liveNow);
  }

  /**
   * Seek bar always spans the current show (or the synthetic no-info slot).
   * Catch-up download window / streamBase must not stretch or shrink the bar.
   */
  function barStartMs() {
    if (programme) return programme.start;
    return streamBase || Date.now();
  }

  function barEndMs() {
    if (programme) return programme.end;
    return (streamBase || Date.now()) + SLOT_MS;
  }

  /** Download goal: settings window end, but not past what has aired (live). */
  function bufferGoalMs() {
    const now = Date.now();
    const settingsEnd = windowEnd || now;
    return Math.min(now, settingsEnd);
  }

  function cachePath() {
    if (!catchupPlayUrl) return '';
    try {
      return `/stream-cache${new URL(catchupPlayUrl, location.origin).search}`;
    } catch {
      return '';
    }
  }

  async function pollCatchupCache() {
    if (destroyed || mode !== 'catchup' || !catchupPrefetch) return;
    const path = cachePath();
    if (!path) return;
    try {
      cacheInfo = await get(path);
      if (cacheInfo && cacheInfo.error && /disk space|1 GB/i.test(cacheInfo.error)) {
        toast(cacheInfo.error, { error: true, ms: 6000 });
        catchupPrefetch = false;
        clearInterval(cachePollTimer);
      }
    } catch { /* ignore */ }
  }

  /** Wall-clock time covered by the on-disk catch-up download. */
  function cachedUntilMs() {
    if (!catchupPrefetch || !streamBase || !(windowEnd > streamBase)) return streamBase;
    const mseEnd = streamBase + bufferedEndSec() * 1000;
    if (cacheInfo.bytes > 0) {
      // Estimate media duration from bytes (~2 Mbps IPTV TS). Never claim the whole
      // windowEnd just because the download finished — that forced tip remount loops
      // and re-opened expired timeshift URLs (non-TS → sync_byte spam).
      const estMs = (cacheInfo.bytes / (2 * 1024 * 1024 / 8)) * 1000;
      let until = streamBase + estMs;
      if (cacheInfo.total > 0 && !cacheInfo.done) {
        const frac = Math.max(0, Math.min(1, cacheInfo.bytes / cacheInfo.total));
        until = Math.max(until, streamBase + frac * (windowEnd - streamBase));
      }
      // Finished download: once MSE has eaten the file, trust the playable tip — not an
      // inflated byte estimate. Soft-refill past EOF was black screen + endless Loading.
      if (cacheInfo.done && mseEnd > streamBase + 2000) {
        until = Math.min(until, mseEnd + 3000);
      }
      return Math.min(windowEnd, Math.max(mseEnd, until), Date.now());
    }
    return mseEnd;
  }

  function clampCatchupTarget(targetMs) {
    const now = Date.now();
    // Native VLC has no HTML MSE buffer — do not clamp to streamBase/empty buffered tip
    // (that made −1m a no-op and blocked Time= seeks into already-played minutes).
    if (hasNativeVlc() && (engine && engine.useVlc || mode === 'catchup')) {
      const earliest = catchupEarliestMs();
      return Math.max(earliest, Math.min(Number(targetMs) || 0, now - LIVE_EDGE_MS));
    }
    const cached = cachedUntilMs();
    const maxT = Math.max(streamBase, Math.min(cached - 250, now));
    return Math.max(streamBase, Math.min(targetMs, maxT));
  }

  /** Paint only what MSE can play right now (not the backend disk download). */
  function updateBuffer() {
    bufLayer.replaceChildren();
    if (!programme || !streamBase || !video.buffered) return;
    if (mode !== 'live' && mode !== 'catchup') return;
    const from = barStartMs();
    const to = barEndMs();
    const span = to - from;
    if (!(span > 0)) return;
    try {
      for (let i = 0; i < video.buffered.length; i++) {
        const startMs = streamBase + video.buffered.start(i) * 1000;
        const endMs = streamBase + video.buffered.end(i) * 1000;
        const start = Math.max(0, Math.min(1, (startMs - from) / span));
        const end = Math.max(0, Math.min(1, (endMs - from) / span));
        if (end <= start) continue;
        const el = h('div.buf');
        el.style.left = `${start * 100}%`;
        el.style.width = `${(end - start) * 100}%`;
        bufLayer.append(el);
      }
    } catch { /* TimeRanges not ready */ }
  }

  function reportWatch(force = false) {
    if (!channel || destroyed) return;
    const kind = mode === 'catchup' ? 'catchup' : 'live';
    const start = kind === 'catchup' ? ((programme && programme.start) || streamBase || 0) : 0;
    const end = kind === 'catchup' ? ((programme && programme.end) || windowEnd || 0) : 0;
    const key = `${kind}:${channelId}:${start || 0}`;
    const now = Date.now();
    if (!force && key === lastWatchKey && now - lastWatchAt < 15000) return;
    lastWatchKey = key;
    lastWatchAt = now;
    const pos = programme && kind === 'catchup' ? Math.max(0, (position() - programme.start) / 1000) : 0;
    const dur = programme ? Math.max(0, (programme.end - programme.start) / 1000) : 0;
    post('/watch', {
      kind,
      itemId: channelId,
      start: start || undefined,
      end: end || undefined,
      title: (programme && programme.title) || channel.name,
      subtitle: channel.name,
      poster: channel.logo || channel.playlistLogo || '',
      position: pos,
      duration: dur,
    }).catch(() => {});
  }

  function tick() {
    clock.textContent = fmtTime(Date.now());
    reportWatch();
    const now = Date.now();
    const pos = position();
    if (programme && (pos >= programme.end || pos < programme.start) && !pendingSeek) {
      loadProgramme(pos);
    }
    updateBuffer();
    checkCatchupStall();
    if (scrub) return;
    if (programme) {
      const from = barStartMs();
      const to = barEndMs();
      const span = to - from;
      const frac = span > 0 ? Math.max(0, Math.min(1, (pos - from) / span)) : 0;
      const liveFrac = span > 0 ? Math.max(0, Math.min(1, (now - from) / span)) : 0;
      fill.style.width = `${frac * 100}%`;
      knob.style.left = `${frac * 100}%`;
      liveEdge.style.width = `${liveFrac * 100}%`;
      posLabel.textContent = pendingSeek ? `→ ${fmtTime(pos)}` : fmtTime(pos);
      if (mode === 'live' && nearLive()) endLabel.textContent = fmtTime(programme.end);
      else endLabel.textContent = `-${fmtClock(Math.max(0, now - pos))} behind`;
    } else {
      // No guide row yet — still use the synthetic slot length (30m), not a growing live span.
      const from = barStartMs();
      const to = barEndMs();
      const span = Math.max(1, to - from);
      const frac = Math.max(0, Math.min(1, (pos - from) / span));
      const liveFrac = Math.max(0, Math.min(1, (now - from) / span));
      fill.style.width = `${frac * 100}%`;
      knob.style.left = `${frac * 100}%`;
      liveEdge.style.width = `${liveFrac * 100}%`;
      posLabel.textContent = fmtTime(pos);
      endLabel.textContent = '';
    }
  }

  async function playLive() {
    const req = ++loadReq;
    liveTuneInFlight = true;
    playerLog('ui.playLive', 'start', { channelId, req, session: playerDebugSession() });
    // Stop catch-up MSE/fetch before minting live — same single provider connection.
    try { engine.stop(); } catch { /* ignore */ }
    mode = 'live';
    liveStallSince = 0;
    liveMediaTime = -1;
    liveStableAt = 0;
    windowEnd = 0;
    catchupPrefetch = false;
    catchupPlayUrl = '';
    streamBase = 0;
    playheadMs = 0;
    clearInterval(cachePollTimer);
    cachePollTimer = null;
    clearTimeout(remountTimer);
    remountTimer = null;
    clearInterval(remountJumpTimer);
    remountJumpTimer = null;
    lastAutoRemountAt = 0;
    message.textContent = 'Loading…';
    try {
      // True live first. Opening timeshift on every tune stole the provider connection
      // and made MAG/Xtream look broken whenever archive was flaky. Seek/Restart still
      // switch into the catch-up window via hardSeekCatchup / playCatchupWindow.
      const info = await get(`/play/live?ch=${encodeURIComponent(channelId)}`);
      if (req !== loadReq || destroyed) return;
      channel = info.channel;
      await loadProgramme(Date.now());
      if (req !== loadReq || destroyed) return;
      playerLog('ui.playLive', 'engine.play', {
        kind: info.kind,
        urls: (info.urls || []).length,
        url0: info.urls && info.urls[0] ? String(info.urls[0]).slice(0, 160) : '',
      });
      engine.play(info.urls, info.kind, { live: true });
      reportWatch(true);
      // Join at the live tip, then keep ~2–3 minutes behind in MSE for instant replay.
      let tipTries = 0;
      const joinTip = () => {
        if (req !== loadReq || destroyed || mode !== 'live') return;
        try {
          const b = video.buffered;
          if (b && b.length) {
            const end = b.end(b.length - 1);
            const v = video.currentTime || 0;
            if (end - v > 2.5) {
              video.currentTime = Math.max(0, end - 0.4);
              if (++tipTries < 8) setTimeout(joinTip, 400);
              else syncLiveTimeline();
              return;
            }
          }
        } catch { /* ignore */ }
        syncLiveTimeline();
      };
      video.addEventListener('playing', joinTip, { once: true });
      video.addEventListener('canplay', joinTip, { once: true });
    } catch (err) {
      playerLog('ui.playLive.error', err && err.message);
      if (req === loadReq) message.textContent = err.message;
    } finally {
      if (req === loadReq) liveTuneInFlight = false;
    }
  }

  async function playCatchup(start, end) {
    const pad = preloadPadMs();
    const baseEnd = end || (programme && !programme.synthetic ? programme.end : start + 3600000);
    playerLog('ui.playCatchup', '', { start, end: baseEnd + pad, pad });
    await playCatchupWindow(start, baseEnd + pad, start, ++loadReq);
  }

  async function playCatchupWindow(start, end, resumeAt, req = ++loadReq, opts = {}) {
    const now = Date.now();
    playerLog('ui.playCatchupWindow', opts.forceNew ? 'forceNew' : (opts.roll ? 'roll' : 'open'), {
      start,
      end,
      resumeAt,
      req,
      forceNew: !!opts.forceNew,
      roll: !!opts.roll,
      streamBase,
      catchupPlayUrl: catchupPlayUrl ? String(catchupPlayUrl).slice(0, 120) : '',
    });
    const windowStart = Math.floor(Math.max(0, start) / MIN) * MIN;
    const baseUntil = end || (windowStart + 3600000);
    // Hard seeks re-record from the rewind point — never inflate duration toward live
    // (that stalls first bytes). Soft opens of still-airing shows keep a short live tail.
    let windowUntil = baseUntil;
    if (opts.forceNew) {
      windowUntil = Math.min(baseUntil, now);
    } else if (baseUntil >= now - 2 * MIN) {
      windowUntil = Math.max(baseUntil, now + 5 * MIN);
    }
    const resume = Math.min(Math.max(resumeAt || windowStart, windowStart), now);
    // Record/timeshift origin — for hard seeks this is the rewind minute, not show start.
    const streamStart = windowStart;

    // Already on this window — local / same-cache seek when not forcing a new timeshift URL.
    if (!opts.forceNew && mode === 'catchup' && catchupPrefetch && catchupPlayUrl && streamBase === streamStart) {
      windowEnd = Math.max(windowEnd || 0, windowUntil);
      if (seekCatchupPrefetch(resume)) {
        await loadProgramme(resume);
        return true;
      }
      // Same download covers the target — remount that file instead of a new timeshift minute.
      if (canSeekCached(resume) && remountSameCatchup(resume)) {
        await loadProgramme(resume);
        return true;
      }
      // Past what disk has — reopen timeshift at the nearest minute.
      if (Math.abs(resume - streamStart) > 15000) {
        hardSeekCatchup(resume);
        await loadProgramme(resume);
        return true;
      }
    }

    mode = 'catchup';
    clearInterval(cachePollTimer);
    cachePollTimer = null;

    if (!opts.roll) message.textContent = `Loading catch-up from ${fmtTime(streamStart)}…`;
    try {
      // Freeze the current frame, mint the new timeshift URL, THEN tear down the old
      // loader — stopping first left a black screen for the whole /play/catchup RTT.
      try { engine.freezeFrame(); } catch { /* optional */ }
      const qs = `ch=${encodeURIComponent(channelId)}&start=${Math.round(streamStart)}&end=${Math.round(windowUntil)}`;
      const info = await get(`/play/catchup?${qs}`);
      if (req !== loadReq || destroyed) return false;
      clearTimeout(remountTimer);
      remountTimer = null;
      clearInterval(remountJumpTimer);
      remountJumpTimer = null;
      try { engine.stop(); } catch { /* ignore */ }
      channel = info.channel;
      streamBase = info.start;
      windowEnd = info.end || windowUntil;
      reportWatch(true);
      catchupPrefetch = !!info.prefetch;
      const prevUrl = catchupPlayUrl;
      catchupPlayUrl = (info.urls && info.urls[0]) || '';
      setPlayhead(resume);
      // New timeshift minute / URL must not inherit the previous download's byte estimate
      // (that made the second hard-seek think disk already covered the new window).
      if (opts.forceNew || !catchupPrefetch || !prevUrl || prevUrl !== catchupPlayUrl) {
        cacheInfo = { bytes: 0, total: 0, done: false };
      } else if (!(cacheInfo.bytes > 0)) {
        cacheInfo = { bytes: 0, total: 0, done: false };
      }
      lastBufEndMs = streamBase;
      bufGrewAt = Date.now();
      if (info.prefetchError) toast(info.prefetchError, { error: true, ms: 6000 });
      const durationSec = Math.max(60, Number(info.duration) || ((windowEnd - streamBase) / 1000));
      beginSeekSettle(hasNativeVlc() ? 2500 : (catchupPrefetch ? 8000 : 4000));
      const want = Math.max(0, (resume - streamBase) / 1000);
      // Native VLC: timeshift URL already starts near `resume` — play immediately (no HTML buffer wait).
      const useVlc = hasNativeVlc();
      const holdPlay = !useVlc && want > 0.8;
      playerLog('ui.playCatchupWindow.play', '', {
        streamBase,
        windowEnd,
        resume,
        want,
        holdPlay,
        useVlc,
        prefetch: catchupPrefetch,
        kind: info.kind,
        url: catchupPlayUrl ? String(catchupPlayUrl).slice(0, 160) : '',
        prefetchError: info.prefetchError || '',
      });
      engine.play(info.urls, info.kind, {
        live: false,
        duration: durationSec,
        prefetch: catchupPrefetch,
        bufferAhead: MSE_BUFFER_AHEAD_SEC,
        start: useVlc ? Math.min(want, 45) : (holdPlay ? want : 0),
        paused: holdPlay,
      });
      if (catchupPrefetch) {
        clearInterval(cachePollTimer);
        cachePollTimer = setInterval(pollCatchupCache, 1000);
        pollCatchupCache();
      }
      // Prefetch/HTML only: wait for MSE lead. VLC seeks via Time= / new timeshift URL.
      if (!useVlc && holdPlay && (catchupPrefetch || want * 1000 <= CATCHUP_LOCAL_JUMP_MS)) {
        let tries = 0;
        const resumePlay = () => {
          // Bad-media abort holds pause until a fresh forceNew window lands.
          if (engine._badMediaAbort) return;
          engine.pausedByUser = false;
          if (message.textContent === 'Loading…' || message.textContent.startsWith('Loading catch-up')
            || message.textContent.startsWith('Seeking') || message.textContent.startsWith('Reloading')) {
            message.textContent = '';
          }
          engine.tryPlay();
        };
        const jump = () => {
          if (destroyed || req !== loadReq || engine._badMediaAbort) return;
          try {
            if (!video.paused && Math.abs((video.currentTime || 0) - want) > 2) {
              video.pause();
            }
            if (Math.abs((video.currentTime || 0) - want) < 1.5) {
              clearInterval(remountJumpTimer);
              remountJumpTimer = null;
              resumePlay();
              return;
            }
            const buf = bufferedEndSec();
            // After ~5s, play whatever is buffered instead of black Loading forever.
            // If tip never reaches the resume point, keep waiting — early resume unblocks
            // start-timeout same-URL reconnects on poisoned timeshift tips.
            if (buf > 1.5 && tries > 25 && buf >= want - 2) {
              video.currentTime = Math.min(want, Math.max(0, buf - 0.5));
              resumePlay();
              clearInterval(remountJumpTimer);
              remountJumpTimer = null;
              return;
            }
            if (buf < want - 0.5) return;
            video.currentTime = want;
            if (Math.abs((video.currentTime || 0) - want) < 1.5) resumePlay();
          } catch { /* ignore */ }
        };
        video.addEventListener('loadedmetadata', jump, { once: true });
        video.addEventListener('canplay', jump, { once: true });
        clearInterval(remountJumpTimer);
        remountJumpTimer = setInterval(() => {
          if (++tries > 180 || destroyed || req !== loadReq) {
            clearInterval(remountJumpTimer);
            remountJumpTimer = null;
            if (engine._badMediaAbort) return;
            // Last resort: show something rather than endless Loading on a black frame.
            try {
              const buf = bufferedEndSec();
              if (buf > 1) video.currentTime = Math.min(want, Math.max(0, buf - 0.5));
            } catch { /* ignore */ }
            resumePlay();
            return;
          }
          jump();
        }, 200);
      }
      await loadProgramme(resume);
      return true;
    } catch (err) {
      if (req !== loadReq) return false;
      playerLog('ui.playCatchupWindow.error', err && err.message, { req });
      message.textContent = err.message;
      toast(err.message, { error: true });
      return false;
    }
  }

  function bufferedEndSec() {
    try {
      const b = video.buffered;
      if (!b || !b.length) return 0;
      return b.end(b.length - 1);
    } catch {
      return 0;
    }
  }

  function bufferedStartSec() {
    try {
      const b = video.buffered;
      if (!b || !b.length) return 0;
      return b.start(0);
    } catch {
      return 0;
    }
  }

  /** Wall-clock end of what MSE can actually play right now. */
  function mseBufferedEndMs() {
    if (!streamBase) return 0;
    return streamBase + bufferedEndSec() * 1000;
  }

  /** Wall-clock start of retained MSE (after autoCleanup) — quick RW floor. */
  function mseBufferedStartMs() {
    if (!streamBase) return 0;
    return streamBase + bufferedStartSec() * 1000;
  }

  /** Real-time range covered by instant MSE seeks (the ±~2 min quick-seek window). */
  function bufferedRangeMs() {
    if (mode !== 'catchup' || !streamBase) return null;
    const start = mseBufferedStartMs();
    const end = mseBufferedEndMs();
    if (!(end > start + 400)) return { start: streamBase, end: streamBase };
    return { start, end };
  }

  /**
   * True when a seek can stay on the current catch-up URL (MSE jump or same-file remount).
   * Instant seeks use the retained MSE range; disk coverage allows a soft remount.
   */
  function canSeekLocal(targetMs) {
    if (mode !== 'catchup' || !streamBase) return false;
    const range = bufferedRangeMs();
    const mseSlack = catchupPrefetch ? 8000 : 250;
    if (range && targetMs >= range.start - 250 && targetMs <= range.end + mseSlack) return true;
    if (catchupPrefetch) {
      // Disk already has this moment — soft remount/jump on the same cache URL.
      return targetMs >= streamBase && targetMs <= cachedUntilMs() - 500;
    }
    return false;
  }

  /** Target is on disk (or MSE) but may need a same-URL remount to enter MSE. */
  function canSeekCached(targetMs) {
    if (mode !== 'catchup' || !streamBase || !catchupPrefetch) return false;
    if (targetMs < streamBase) return false;
    return targetMs <= cachedUntilMs() - 500;
  }

  /** Snapshot for the shared MSE decision policy. */
  function msePolicyState() {
    const now = Date.now();
    const mseStart = mseBufferedStartMs();
    const mseEnd = mseBufferedEndMs();
    return {
      mode,
      streamBase,
      pos: Math.max(mediaPosition(), playheadMs || 0, streamBase || 0),
      mseStart: mseStart || streamBase,
      mseEnd: Math.max(mseEnd, mseStart || streamBase),
      cachedUntil: cachedUntilMs(),
      windowEnd: windowEnd || 0,
      now,
      tipGrowing: !!(bufGrewAt && (now - bufGrewAt < 2500)),
      nearLive: nearLiveCatchup(Math.max(mediaPosition(), playheadMs || 0)),
      prefetch: !!catchupPrefetch,
      settleActive: isSeekSettling() || !!remountJumpTimer,
    };
  }

  /** Timeshift reconnects are minute-aligned — snap to the closest whole minute. */
  function snapHardSeekMs(targetMs) {
    const now = Date.now();
    let t = Math.min(Math.max(0, targetMs), now);
    t = Math.round(t / MIN) * MIN;
    if (t > now - LIVE_EDGE_MS) t = Math.floor((now - LIVE_EDGE_MS) / MIN) * MIN;
    if (t < 0) t = 0;
    return t;
  }

  /**
   * Timeshift/record end after a hard rewind: start at the new playhead and only
   * pull aired video (never un-aired "future" toward live). Restart from show
   * start covers the full aired portion; mid-show seeks use a rolling window.
   */
  function hardSeekUntilMs(fromMs) {
    const now = Date.now();
    if (programme && fromMs <= programme.start + 2 * MIN) {
      if (programme.end <= now) return Math.max(fromMs + 15 * MIN, Math.min(programme.end + preloadPadMs(), now));
      return Math.max(fromMs + 15 * MIN, Math.min(programme.end, now));
    }
    const rolling = fromMs + 45 * MIN;
    let until = rolling;
    if (programme) {
      if (programme.end <= now) {
        until = Math.min(Math.max(rolling, programme.end), programme.end + preloadPadMs());
      } else {
        until = Math.min(rolling, programme.end, now);
      }
    }
    until = Math.max(until, fromMs + 15 * MIN);
    until = Math.min(until, now);
    if (until <= fromMs) until = Math.min(now, fromMs + 15 * MIN);
    return until;
  }

  function hardSeekCatchup(targetMs, opts = {}) {
    // Automatic roll/refill hard-seeks must not stack on top of Restart/seek settle.
    if (opts.roll && (isSeekSettling() || remountJumpTimer)) {
      playerLog('ui.hardSeek.skip', 'settle/remount', { targetMs, roll: !!opts.roll });
      return;
    }
    if (opts.roll && lastAutoRemountAt && Date.now() - lastAutoRemountAt < MSE_ROLL_COOLDOWN_MS) {
      playerLog('ui.hardSeek.skip', 'cooldown', { targetMs });
      return;
    }
    const now = Date.now();
    const earliest = catchupEarliestMs();
    const resumeHint = Number(opts.resumeAt) || targetMs;
    // Live's streamBase is "now" — don't feed it into the planner (would force goLive / thrash).
    const baseForPlan = mode === 'live' ? 0 : (streamBase || 0);
    // VLC: open timeshift at the seek minute (proxy). HTML/MSE: open ~2m behind for soft window.
    const planned = planHardSeekWindow(resumeHint, earliest, baseForPlan, now, { nativeVlc: hasNativeVlc() });
    let hard = planned.start;
    let resumeAt = planned.resume;
    // Native VLC: always land on the minute boundary the user asked for.
    if (hasNativeVlc()) {
      hard = alignCatchupMinute(resumeHint);
      if (hard < earliest) hard = alignCatchupMinute(earliest);
      resumeAt = hard;
    }
    playerLog('ui.hardSeek', opts.roll ? 'roll' : 'user', {
      targetMs,
      hard,
      resumeAt,
      streamBase,
      earliest,
      nativeVlc: hasNativeVlc(),
    });
    // Only the true live tip is off-limits for timeshift — past the MSE window must open catch-up.
    if (hard >= now - LIVE_EDGE_MS || resumeAt >= now - LIVE_EDGE_MS) {
      goLive();
      return;
    }
    const until = hardSeekUntilMs(hard);
    if (!opts.roll) message.textContent = `Seeking to ${fmtTime(resumeAt)}…`;
    setPlayhead(resumeAt);
    beginSeekSettle(hasNativeVlc() ? 3000 : 10000);
    clearTimeout(remountTimer);
    remountTimer = null;
    clearInterval(remountJumpTimer);
    remountJumpTimer = null;
    // User hard-seek must not inherit auto-remount cooldown from a prior refill.
    if (!opts.roll) lastAutoRemountAt = 0;
    else lastAutoRemountAt = now;
    playCatchupWindow(hard, until, resumeAt, ++loadReq, { forceNew: true, roll: !!opts.roll });
  }

  /**
   * Rebase catch-up around the playhead: window starts ~2 minutes behind, resume
   * stays on the playhead so the ±2 minute quick-seek window is restored.
   */
  function reopenCatchupAroundPlayhead(posMs, { auto = true } = {}) {
    if (isSeekSettling() || remountJumpTimer) return false;
    const now = Date.now();
    // Auto reopen only — user seeks escalate to hardSeekCatchup instead of stalling.
    if (auto && lastAutoRemountAt && now - lastAutoRemountAt < MSE_ROLL_COOLDOWN_MS) return false;
    const pos = Math.max(Number(posMs) || 0, streamBase || 0);
    const earliest = catchupEarliestMs();
    const planned = planHardSeekWindow(pos, earliest, streamBase || 0, now, { nativeVlc: hasNativeVlc() });
    let start = planned.start;
    const resumeAt = planned.resume;
    if (auto && !hasNativeVlc() && start <= (streamBase || 0) + 500) {
      const want = streamBase ? (pos - streamBase) / 1000 : 0;
      // Never soft-remount a URL that already failed demux.
      if (want <= 180 && !(poisonedCatchupUrl && catchupPlayUrl === poisonedCatchupUrl)) {
        return remountSameCatchup(pos, { auto: true });
      }
    }
    if (start >= now - LIVE_EDGE_MS || resumeAt >= now - LIVE_EDGE_MS) {
      goLive();
      return true;
    }
    setPlayhead(resumeAt);
    beginSeekSettle(hasNativeVlc() ? 3000 : 12000);
    if (auto) lastAutoRemountAt = now;
    playCatchupWindow(start, hardSeekUntilMs(start), resumeAt, ++loadReq, { forceNew: true, roll: true });
    return true;
  }

  /** Seek inside the already-open catch-up buffer (second-accurate). */
  function seekLocal(targetMs) {
    if (mode !== 'catchup') return false;
    const decision = decideSeekAction(msePolicyState(), targetMs);
    if (decision === 'hard_seek') return false;
    if (decision === 'soft_refill') return remountSameCatchup(targetMs);
    if (!canSeekLocal(targetMs)) return false;
    const rel = Math.max(0, (targetMs - streamBase) / 1000);
    setPlayhead(targetMs);
    beginSeekSettle(5000);
    clearTimeout(remountTimer);
    remountTimer = null;
    const kind = engine.seek(rel);
    bufGrewAt = Date.now();
    engine.tryPlay();
    // mpegts often accepts currentTime then snaps back when the target is not in MSE.
    remountTimer = setTimeout(() => {
      remountTimer = null;
      if (destroyed || mode !== 'catchup') return;
      if (Math.abs((video.currentTime || 0) - rel) <= 4) {
        engine.tryPlay();
        return;
      }
      // Jump already in progress — don't stack another remount.
      if (remountJumpTimer) {
        engine.tryPlay();
        return;
      }
      const at = playheadMs || targetMs;
      // Failed local jump — one soft same-cache remount only. No hard-seek fallback here
      // (hard-seek reopen was the Restart/seek show-load loop).
      if (canSeekCached(at)) remountSameCatchup(at);
      else engine.tryPlay();
    }, 1200);
    return kind !== 'live';
  }

  /**
   * Continue catch-up when MSE runs dry. Prefer soft same-URL refill; hard-seek
   * only when the policy says disk/window cannot cover the playhead.
   * When the policy says `none` (settling, tip still growing, healthy cushion),
   * do nothing — the old fallthrough remounted from show-start and looped.
   */
  function refillCatchupMse() {
    if (!catchupPrefetch || destroyed || mode !== 'catchup') return false;
    if (isSeekSettling() || remountJumpTimer) return false;
    const action = decideRollAction(msePolicyState());
    if (action === 'none') return false;
    return applyRollDecision(action);
  }

  /**
   * After mpegts demux/format failure: open a fresh timeshift around the playhead.
   * Same-URL remount would re-feed the bad bytes and spam sync_byte again.
   */
  function recoverCatchupBadMedia(posMs) {
    if (destroyed || mode !== 'catchup') return false;
    const now = Date.now();
    if (badMediaRecoveries >= MAX_BAD_MEDIA_RECOVERIES) {
      playerLog('ui.recoverBadMedia', 'max recoveries', { badMediaRecoveries, posMs });
      clearInterval(remountJumpTimer);
      remountJumpTimer = null;
      try { engine.stop(); } catch { /* ignore */ }
      return false;
    }
    // Cooldown only blocks stacked recovers — first abort after poison always proceeds.
    if (badMediaRecoveries > 0 && now - (gapSkipAt || 0) < 2000) {
      playerLog('ui.recoverBadMedia.skip', 'cooldown', { badMediaRecoveries, posMs });
      return false;
    }
    gapSkipAt = now;
    badMediaRecoveries += 1;
    playerLog('ui.recoverBadMedia', 'forceNew', { badMediaRecoveries, posMs, streamBase });
    clearInterval(remountJumpTimer);
    remountJumpTimer = null;
    clearTimeout(remountTimer);
    remountTimer = null;
    const pos = Math.max(streamBase || 0, Number(posMs) || 0);
    if (nearLiveCatchup(pos)) {
      goLive();
      return true;
    }
    const earliest = catchupEarliestMs();
    let start = rebaseWindowStart(pos, earliest);
    if (start <= (streamBase || 0) + 500) {
      start = Math.min(Math.floor(pos / MIN) * MIN, Math.max(earliest, start + MIN));
    }
    if (start >= now - LIVE_EDGE_MS) {
      goLive();
      return true;
    }
    const resumeAt = rebaseResumeAt(pos, start);
    setPlayhead(resumeAt);
    beginSeekSettle(12000);
    message.textContent = 'Reloading catch-up…';
    playCatchupWindow(start, hardSeekUntilMs(start), resumeAt, ++loadReq, { forceNew: true, roll: true });
    return true;
  }

  /** Apply a tick-time MSE policy decision. */
  function applyRollDecision(action) {
    const now = Date.now();
    if (action === 'none') return false;
    if (now - (gapSkipAt || 0) < MSE_ROLL_COOLDOWN_MS) {
      playerLog('ui.roll.skip', 'cooldown', { action });
      return false;
    }
    const pos = Math.max(mediaPosition(), position(), playheadMs || 0, streamBase);
    playerLog('ui.roll', action, { pos, streamBase, mseEnd: streamBase + bufferedEndSec() * 1000 });
    if (action === 'go_live') {
      goLive();
      return true;
    }
    if (action === 'soft_refill') {
      gapSkipAt = now;
      // Deep into the cache: rebase around the playhead (keeps resume + ±2m window).
      const want = streamBase ? (pos - streamBase) / 1000 : 0;
      if (want > 180) return reopenCatchupAroundPlayhead(pos, { auto: true });
      return remountSameCatchup(pos, { auto: true });
    }
    if (action === 'hard_seek') {
      gapSkipAt = now;
      hardSeekCatchup(pos, { resumeAt: pos, roll: true });
      return true;
    }
    return false;
  }

  /**
   * Sliding MSE window tick: keep ~2 minutes ahead via soft refill when the tip
   * stalls and disk still has data — avoid hard-seek/buffer storms.
   */
  function rollCatchupMseWindow() {
    if (!catchupPrefetch || destroyed || mode !== 'catchup' || !streamBase) return false;
    return applyRollDecision(decideRollAction(msePolicyState()));
  }

  /**
   * Remount the same cached URL and jump to resumeAt. Stays paused/frozen until
   * the seek lands — never lets playback run from t=0 (that looks like a rewind).
   * @param {{ auto?: boolean }} opts `auto: true` for refill/roll (cooldown applies).
   *   User seeks omit this so leaving MSE / second timeshift soft-refill still works.
   */
  function remountSameCatchup(resumeAt, opts = {}) {
    if (!catchupPlayUrl || !catchupPrefetch) return false;
    // Poisoned tip: same-URL remount re-feeds sync_byte spam — force a new timeshift.
    // Do not call reopenCatchupAroundPlayhead here: it can fall back into remountSameCatchup.
    if (poisonedCatchupUrl && catchupPlayUrl === poisonedCatchupUrl) {
      const at = clampCatchupTarget(resumeAt);
      playerLog('ui.remount.poisoned', 'escalate recover', { at, auto: !!opts.auto });
      setPlayhead(at);
      if (nearLiveCatchup(at)) {
        goLive();
        return true;
      }
      return !!recoverCatchupBadMedia(at);
    }
    if (remountJumpTimer) {
      setPlayhead(clampCatchupTarget(resumeAt));
      return true;
    }
    const auto = !!opts.auto;
    const now = Date.now();
    // Cooldown only for automatic refill storms — never block user soft/hard seeks.
    if (auto && lastAutoRemountAt && now - lastAutoRemountAt < MSE_ROLL_COOLDOWN_MS) {
      setPlayhead(clampCatchupTarget(resumeAt));
      return false;
    }
    const at = clampCatchupTarget(resumeAt);
    const want = Math.max(0, (at - streamBase) / 1000);
    // Deep into a long cache: remounting from byte 0 buffers forever — rebase ±2m around playhead.
    if (want > 180) {
      return reopenCatchupAroundPlayhead(at, { auto });
    }
    if (auto) lastAutoRemountAt = now;
    clearTimeout(remountTimer);
    remountTimer = null;
    clearInterval(remountJumpTimer);
    remountJumpTimer = null;
    setPlayhead(at);
    beginSeekSettle(12000);
    message.textContent = `Loading…`;
    try { engine.freezeFrame(); } catch { /* optional */ }
    const durationSec = Math.max(60, (windowEnd - streamBase) / 1000);
    const holdPlay = want > 0.25;
    playerLog('ui.remount', auto ? 'auto' : 'user', {
      at,
      want,
      holdPlay,
      streamBase,
      url: String(catchupPlayUrl).slice(0, 160),
    });
    // Same cached URL — mpegts reloads from disk; no new provider timeshift minute.
    // Stay paused until the resume seek lands so the user never sees show-start.
    engine.play([catchupPlayUrl], 'ts', {
      live: false,
      duration: durationSec,
      prefetch: true,
      bufferAhead: MSE_BUFFER_AHEAD_SEC,
      start: want,
      paused: holdPlay,
    });
    clearInterval(remountJumpTimer);
    const resume = () => {
      if (engine._badMediaAbort) return;
      engine.pausedByUser = false;
      if (message.textContent === 'Loading…' || message.textContent.startsWith('Seeking')
        || message.textContent.startsWith('Reloading')) {
        message.textContent = '';
      }
      engine.tryPlay();
    };
    if (!holdPlay) {
      resume();
      bufGrewAt = Date.now();
      return true;
    }
    let tries = 0;
    const jump = () => {
      if (destroyed || engine._badMediaAbort) return;
      try {
        if (!video.paused && Math.abs((video.currentTime || 0) - want) > 2) {
          video.pause();
        }
        const buf = bufferedEndSec();
        // Only early-resume when the tip actually covers the resume point — otherwise
        // clearing pause lets start-timeout same-URL reconnect the poisoned cache.
        if (buf > 1.5 && tries > 25 && buf >= want - 2) {
          video.currentTime = Math.min(want, Math.max(0, buf - 0.5));
          resume();
          clearInterval(remountJumpTimer);
          remountJumpTimer = null;
          return;
        }
        if (buf < want - 0.5) return;
        video.currentTime = want;
        if (Math.abs((video.currentTime || 0) - want) < 1.25) {
          clearInterval(remountJumpTimer);
          remountJumpTimer = null;
          resume();
        }
      } catch { /* ignore */ }
    };
    video.addEventListener('loadedmetadata', jump, { once: true });
    video.addEventListener('canplay', jump, { once: true });
    remountJumpTimer = setInterval(() => {
      if (++tries > 180 || destroyed) {
        clearInterval(remountJumpTimer);
        remountJumpTimer = null;
        if (engine._badMediaAbort) return;
        try {
          const buf = bufferedEndSec();
          if (buf > 1) video.currentTime = Math.min(want, Math.max(0, buf - 0.5));
        } catch { /* ignore */ }
        resume();
        return;
      }
      jump();
    }, 200);
    bufGrewAt = Date.now();
    return true;
  }

  /**
   * Seek on the current catch-up download (local MSE or soft same-URL remount).
   * Returns false only when the target needs a new timeshift URL.
   */
  function seekCatchupPrefetch(targetMs) {
    if (message.textContent === 'Still downloading…') message.textContent = '';
    // Finished file + seek past the MSE tip → new timeshift (not soft remount past EOF).
    if (cacheInfo.done && targetMs > mseBufferedEndMs() + 3000) return false;
    const decision = decideSeekAction(msePolicyState(), targetMs);
    if (decision === 'hard_seek') return false;
    if (decision === 'soft_refill') return remountSameCatchup(targetMs);
    return seekLocal(targetMs);
  }

  /** Earliest wall time catch-up can reopen to for this channel. */
  function catchupEarliestMs() {
    const days = (channel && channel.catchupDays) || 7;
    return Date.now() - days * 24 * 3600 * 1000 + 5 * MIN;
  }

  /** True when a wall time is close enough to live that tip timeshift often stalls. */
  function nearLiveCatchup(ms = Date.now()) {
    return ms >= Date.now() - CATCHUP_LIVE_LOOKBACK_MS;
  }

  /** Wall-clock start of the retained live MSE window (0 if unknown). */
  function liveMseStartMs() {
    if (mode !== 'live' || !streamBase) return 0;
    try {
      if (video.buffered && video.buffered.length) {
        return streamBase + video.buffered.start(0) * 1000;
      }
    } catch { /* ignore */ }
    return 0;
  }

  /**
   * Live instant-replay: seek inside the retained MSE behind-buffer.
   * Returns false when the target is before the buffer so the caller can open catch-up.
   */
  function seekLiveLocal(targetMs, { clamp = false } = {}) {
    if (mode !== 'live') return false;
    syncLiveTimeline();
    if (!streamBase) return false;
    let start = 0;
    let end = 0;
    try {
      if (video.buffered && video.buffered.length) {
        start = video.buffered.start(0);
        end = video.buffered.end(video.buffered.length - 1);
      }
    } catch {
      return false;
    }
    if (!(end > start + 0.35)) return false;
    let rel = (targetMs - streamBase) / 1000;
    // Past the retained DVR window → catch-up (unless briefly clamping while DVR fills).
    if (rel < start - 0.15) {
      if (!clamp) return false;
      rel = start;
    }
    // Snap to the live tip of MSE when seeking at/past the buffer end.
    if (rel >= end - 0.3) {
      setPlayhead(Math.min(Date.now(), streamBase + end * 1000));
      beginSeekSettle(3000);
      const kind = engine.seek(Math.max(0, end - 0.35));
      engine.tryPlay();
      return kind === 'local';
    }
    if (rel < start) rel = start;
    // Prefer any point inside the TimeRanges span — hasBuffered can flake on edges.
    if (rel > end - 0.2) rel = Math.max(start, end - 0.35);
    if (!engine.hasBuffered(rel) && !engine.hasBuffered(rel + 0.25) && !(rel >= start && rel <= end - 0.15)) {
      if (!clamp) return false;
      rel = start;
    }
    setPlayhead(streamBase + rel * 1000);
    beginSeekSettle(4000);
    try { video.currentTime = Math.max(0, rel); } catch { /* ignore */ }
    const kind = engine.seek(Math.max(0, rel));
    engine.tryPlay();
    return kind === 'local' || (video.currentTime >= start && Math.abs((video.currentTime || 0) - rel) < 5);
  }

  function seekTo(target, { forceCatchup = false } = {}) {
    if (!canSeek()) return;
    const now = Date.now();
    const from = position();
    playerLog('ui.seekTo', '', {
      mode,
      from,
      target,
      deltaSec: Math.round((target - from) / 1000),
      streamBase,
      forceCatchup: !!forceCatchup,
      mseEnd: mode === 'catchup' ? streamBase + bufferedEndSec() * 1000 : null,
    });
    // Live rewind must not be treated as "go live" just because it's within LIVE_EDGE_MS.
    if (target >= now - LIVE_EDGE_MS && (mode !== 'live' || target >= position() - 1000)) {
      playerLog('ui.seekTo.action', 'goLive');
      goLive();
      return;
    }
    // Native VLC live: no HTML DVR — every rewind past the tip opens catch-up at a minute.
    if (mode === 'live' && hasNativeVlc()) {
      const at = alignCatchupMinute(target);
      playerLog('ui.seekTo.action', 'liveVlcHardSeek', { at, target });
      hardSeekCatchup(at, { resumeAt: at });
      showControls();
      tick();
      updateInfo();
      return;
    }
    // Arrow / ±1m from live: open catch-up at that minute (do not stay on the live tip).
    if (mode === 'live' && forceCatchup) {
      const at = alignCatchupMinute(target);
      playerLog('ui.seekTo.action', 'liveForceHardSeek', { at, target });
      hardSeekCatchup(at, { resumeAt: at });
      showControls();
      tick();
      updateInfo();
      return;
    }
    // Live (HTML/MSE): stay on MSE when the target is inside it; past the MSE start → catch-up.
    if (mode === 'live') {
      syncLiveTimeline();
      if (seekLiveLocal(target)) {
        playerLog('ui.seekTo.action', 'liveLocal');
        showControls();
        tick();
        updateInfo();
        return;
      }
      const mseStart = liveMseStartMs();
      // Explicitly past what MSE holds — open catch-up (live feed is stopped first).
      if (mseStart && target < mseStart - 250) {
        const at = alignCatchupMinute(target);
        playerLog('ui.seekTo.action', 'livePastMseHardSeek', { mseStart, at });
        hardSeekCatchup(at, { resumeAt: at });
        showControls();
        tick();
        return;
      }
      // DVR still filling — try MSE; if it can't hold the target, open catch-up.
      if (target >= now - LIVE_DVR_MS) {
        if (seekLiveLocal(target, { clamp: true })) {
          playerLog('ui.seekTo.action', 'liveDvrClamp');
          showControls();
          tick();
          updateInfo();
          return;
        }
      }
      {
        const at = alignCatchupMinute(target);
        playerLog('ui.seekTo.action', 'liveHardSeek', { at });
        hardSeekCatchup(at, { resumeAt: at });
      }
      showControls();
      tick();
      return;
    }
    // Catch-up + native VLC: minute-align, Time= on the open stream, else new URL.
    if (mode === 'catchup' && hasNativeVlc()) {
      seekCatchupVlc(target);
      showControls();
      tick();
      updateInfo();
      return;
    }
    // Prefetch: local / soft-refill when MSE or disk covers the target; hard-seek only past disk.
    if (mode === 'catchup' && catchupPrefetch) {
      const decision = decideSeekAction(msePolicyState(), target);
      playerLog('ui.seekTo.policy', decision, { target });
      if (decision === 'local_seek' || decision === 'soft_refill') {
        if (seekCatchupPrefetch(target) || (decision === 'soft_refill' && remountSameCatchup(target))) {
          playerLog('ui.seekTo.action', decision);
          showControls();
          tick();
          return;
        }
      }
      playerLog('ui.seekTo.action', 'hardSeek');
      hardSeekCatchup(alignCatchupMinute(target), { resumeAt: alignCatchupMinute(target) });
      showControls();
      tick();
      return;
    }
    if (seekLocal(target)) {
      playerLog('ui.seekTo.action', 'local');
      showControls();
      tick();
      return;
    }
    playerLog('ui.seekTo.action', 'hardSeek');
    hardSeekCatchup(mode === 'catchup' ? alignCatchupMinute(target) : target,
      mode === 'catchup' ? { resumeAt: alignCatchupMinute(target) } : {});
  }

  function queueSeek(delta) {
    if (!canSeek()) return;
    // Live + catch-up: only whole-minute steps.
    if (mode === 'live' || mode === 'catchup') {
      const mag = Math.abs(delta);
      if (mag > 0 && mag < MIN) delta = delta < 0 ? -MIN : MIN;
    }
    // First click starts a 1s collection window. Further clicks only add to the
    // total — the stream is not touched until the timer fires once.
    if (!seekTimer) {
      if (mode === 'live') syncLiveTimeline();
      seekAnchorMs = mediaPosition();
      if (playheadMs > 0 && Date.now() < playheadStickyUntil
          && seekAnchorMs < playheadMs - 1500) {
        seekAnchorMs = playheadMs;
      }
      // Catch-up only: don't pull the anchor forward to streamBase (blocks −1m).
      if (mode === 'catchup' && streamBase > 0 && seekAnchorMs < streamBase) {
        seekAnchorMs = streamBase;
      }
      seekTimer = setTimeout(() => {
        const total = pendingSeek;
        const from = seekAnchorMs;
        clearSeekBurst();
        if (!total) return;
        let to = from + total;
        // Live + catch-up: latch onto whole minutes.
        if (mode === 'catchup' || mode === 'live') {
          to = alignCatchupMinute(to);
        }
        playerLog('ui.queueSeek.commit', '', { from, total, to, mode });
        // Keyboard / ± buttons from live must open timeshift, not only nudge the live tip.
        seekTo(to, { forceCatchup: mode === 'live' });
      }, SEEK_COMMIT_MS);
    }
    playerLog('ui.queueSeek', '', { delta, pending: pendingSeek + delta, mode });
    pendingSeek += delta;
    const maxDelta = Date.now() - seekAnchorMs;
    if (pendingSeek > maxDelta) pendingSeek = maxDelta;
    // Live: allow rewind past MSE into catch-up; clamp only to the archive window.
    if (mode === 'live') {
      const minMs = catchupEarliestMs();
      if (seekAnchorMs + pendingSeek < minMs) pendingSeek = minMs - seekAnchorMs;
    }
    // Preview the minute-latched target on the bar while bursting.
    if (mode === 'catchup' || mode === 'live') {
      const preview = alignCatchupMinute(seekAnchorMs + pendingSeek);
      pendingSeek = preview - seekAnchorMs;
    }
    showControls();
    tick();
    updateSeekTipForBurst();
  }

  function restartProgramme() {
    if (!programme) return;
    const at = programme.start;
    clearSeekBurst();
    // Kill any in-flight remount jump / delayed seek escalate — those were snapping
    // the playhead back mid-show after Restart and triggering another full reload.
    clearTimeout(remountTimer);
    remountTimer = null;
    clearInterval(remountJumpTimer);
    remountJumpTimer = null;
    setPlayhead(at);
    beginSeekSettle(8000);
    // Window opened mid-show: reopen from programme start so the bar clock matches content.
    if (mode === 'catchup' && streamBase > 0 && at < streamBase - 2000) {
      const pad = preloadPadMs();
      const until = (programme.end || at + 3600000) + pad;
      lastAutoRemountAt = 0;
      playCatchupWindow(at, until, at, ++loadReq, { forceNew: true });
      showControls();
      tick();
      return;
    }
    // Same cached file — local seek only if show-start is still in MSE; otherwise one
    // soft remount. Avoid "local seek success" that leaves the playhead mid-show when
    // autoCleanup already trimmed the start (then settle blocked the remount escalate).
    if (mode === 'catchup' && catchupPrefetch) {
      lastAutoRemountAt = 0; // user Restart may remount once immediately
      const range = bufferedRangeMs();
      const startInMse = !!(range && at >= range.start - 250 && at <= range.end + 8000);
      if (startInMse) {
        if (!seekLocal(at) && !remountSameCatchup(at)) seekTo(at);
      } else if (!remountSameCatchup(at)) {
        seekTo(at);
      }
      showControls();
      tick();
      return;
    }
    seekTo(at);
  }

  function catchupUntil(fromMs) {
    const pad = preloadPadMs();
    let until = windowEnd || (fromMs + 3600000 + pad);
    if (programme && !programme.synthetic) until = Math.max(until, programme.end + pad);
    return until;
  }

  /** Reopen timeshift at this minute — only when there is no disk cache to preserve. */
  function rebootCatchupAt(anchorMs, { asGapRetry = true, label } = {}) {
    if (catchupPrefetch) return skipCatchupGapLocal(anchorMs);
    const now = Date.now();
    const start = Math.floor(Math.max(streamBase, anchorMs) / MIN) * MIN;
    if (asGapRetry) {
      gapRetried = true;
      gapRetryFrom = anchorMs;
    }
    gapSkipAt = now;
    lastBufEndMs = 0;
    bufGrewAt = 0;
    clearSeekBurst();
    message.textContent = label || `Retrying catch-up… ${fmtTime(start)}`;
    playCatchupWindow(start, catchupUntil(windowEnd || start), Math.min(Math.max(anchorMs, start), now));
    return true;
  }

  function continueCatchupDownload() {
    if (mode !== 'catchup' || destroyed || catchupPrefetch) return false;
    const now = Date.now();
    if (now - gapSkipAt < GAP_SKIP_COOLDOWN_MS) return false;
    return rebootCatchupAt(position(), { asGapRetry: false, label: 'Loading more catch-up…' });
  }

  /** Skip a hole inside the current cached stream (same file — download keeps going). */
  function skipCatchupGapLocal(fromMs) {
    if (mode !== 'catchup' || destroyed) return false;
    const now = Date.now();
    if (now - gapSkipAt < GAP_SKIP_COOLDOWN_MS) return false;
    if (gapSkips >= GAP_MAX_SKIPS) {
      message.textContent = 'Catch-up hit a long gap.';
      return false;
    }
    const anchor = Math.max(position(), Number(fromMs) || 0, streamBase);
    const next = Math.ceil((anchor + 1000) / MIN) * MIN;
    const limit = Math.min(cachedUntilMs() - 500, bufferGoalMs() - 1000, now - LIVE_EDGE_MS);
    if (!(next < limit)) {
      if (catchupPrefetch) {
        const edge = Math.min(cachedUntilMs() - 500, now - LIVE_EDGE_MS);
        return seekLocal(edge) || remountSameCatchup(edge, { auto: true });
      }
      goLive();
      return true;
    }
    gapSkipAt = now;
    gapSkips += 1;
    clearSeekBurst();
    message.textContent = `Skipping gap… ${fmtTime(next)}`;
    seekCatchupPrefetch(next);
    showControls();
    tick();
    return true;
  }

  /** Jump to the next minute after a hole (non-cached catch-up only). */
  function skipCatchupGap(fromMs) {
    if (catchupPrefetch) return skipCatchupGapLocal(fromMs);
    if (mode !== 'catchup' || destroyed) return false;
    const now = Date.now();
    if (gapSkips >= GAP_MAX_SKIPS) {
      message.textContent = 'Catch-up hit a long gap.';
      return false;
    }
    const anchor = Math.max(position(), Number(fromMs) || 0, streamBase);
    const next = Math.ceil((anchor + 1000) / MIN) * MIN;
    const limit = Math.min(
      bufferGoalMs() - 1000,
      (windowEnd || now) - 1000,
      now - LIVE_EDGE_MS,
    );
    if (!(next < limit)) {
      goLive();
      return true;
    }
    gapSkipAt = now;
    gapSkips += 1;
    gapRetried = false;
    gapRetryFrom = 0;
    lastBufEndMs = 0;
    bufGrewAt = 0;
    clearSeekBurst();
    message.textContent = `Skipping gap… ${fmtTime(next)}`;
    playCatchupWindow(next, catchupUntil(next), next);
    return true;
  }

  function recoverCatchupGap(fromMs) {
    if (mode !== 'catchup' || destroyed) return false;
    if (catchupPrefetch) return skipCatchupGapLocal(fromMs);
    const now = Date.now();
    if (now - gapSkipAt < GAP_SKIP_COOLDOWN_MS) return false;
    const anchor = Math.max(position(), Number(fromMs) || 0, streamBase);
    const sameHole = gapRetried && Math.abs(anchor - gapRetryFrom) < GAP_SAME_HOLE_MS;
    if (sameHole) return skipCatchupGap(anchor);
    return rebootCatchupAt(anchor);
  }

  function checkCatchupStall() {
    if (mode !== 'catchup' || destroyed || engine.paused || scrub || !streamBase) return;
    // Don't remount / gap-skip while the user is seeking — that causes timestamp thrash.
    if (isSeekSettling() || remountJumpTimer || engine._badMediaAbort) return;
    // Native VLC: no HTML MSE tip. Stall/gap remounts were snapping 1–3m seeks back
    // to live and thrashing 4m+ seeks into an endless reopen loop.
    if (engine.useVlc || hasNativeVlc()) return;

    // Disk download continues in the background. Track MSE growth (not only disk bytes) —
    // otherwise a growing download hides a stuck SourceBuffer until hard underrun.
    if (catchupPrefetch) {
      const pos = position();
      const mseEnd = streamBase + bufferedEndSec() * 1000;
      const remain = mseEnd - pos;
      const now = Date.now();
      const cached = cachedUntilMs();
      if (mseEnd > lastBufEndMs + 250) {
        lastBufEndMs = mseEnd;
        bufGrewAt = now;
        gapRetried = false;
        gapRetryFrom = 0;
        if (gapSkips) gapSkips = 0;
      }
      // Near-live catch-up that never fills MSE — abandon timeshift instead of seek-looping.
      if (nearLiveCatchup(pos) && remain < 1000 && !(bufferedEndSec() > 1)) {
        if (!bufGrewAt) bufGrewAt = now;
        if (now - bufGrewAt >= GAP_BUFFER_STALL_MS) {
          goLive();
          return;
        }
      }
      // Sliding window policy: soft-refill when <2 min ahead and tip stalled with disk;
      // never hard-seek while the same cache still covers the playhead.
      if (remain < MSE_ROLL_KEEP_MS) {
        if (rollCatchupMseWindow()) return;
      }
      if (remain > GAP_APPROACH_MS) return;
      if (!bufGrewAt) bufGrewAt = now;
      if (now - bufGrewAt < GAP_BUFFER_STALL_MS) return;
      // Frozen near live — go live rather than remounting a broken tip timeshift.
      if (nearLiveCatchup(Math.max(pos, mseEnd))) {
        goLive();
        return;
      }
      // Frozen at MSE edge — soft refill first; hard-seek only if policy allows.
      if (cached > mseEnd + 2000 || remain < MSE_ROLL_KEEP_MS) {
        engine.tryPlay();
        if (now - (gapSkipAt || 0) > MSE_REFILL_COOLDOWN_MS) {
          if (!rollCatchupMseWindow()) refillCatchupMse();
        }
        return;
      }
      skipCatchupGapLocal(Math.max(mseEnd, pos));
      return;
    }

    const now = Date.now();
    const pos = position();
    const bufEnd = streamBase + bufferedEndSec() * 1000;
    const goal = bufferGoalMs();

    if (bufEnd > lastBufEndMs + 250) {
      lastBufEndMs = bufEnd;
      bufGrewAt = now;
      gapRetried = false;
      gapRetryFrom = 0;
      if (gapSkips) gapSkips = 0;
      return;
    }
    if (!bufGrewAt) {
      lastBufEndMs = bufEnd;
      bufGrewAt = now;
      return;
    }

    if (bufEnd >= goal - 1500) return;
    if (now - bufGrewAt < GAP_BUFFER_STALL_MS) return;

    const remain = bufEnd - pos;
    if (remain <= GAP_APPROACH_MS) {
      recoverCatchupGap(bufEnd > streamBase ? bufEnd : pos);
      return;
    }
    if (remain <= CATCHUP_REFILL_AHEAD_MS) {
      continueCatchupDownload();
      return;
    }
    if (now - bufGrewAt >= 8000) continueCatchupDownload();
  }

  /**
   * Live-only: if the playhead is stuck at the buffer tip for LIVE_FREEZE_MS while at the
   * live edge, recover. Skips catch-up/VOD, pause, scrub, DVR rewind, and in-flight tunes.
   * Prefer tip-seek / same-URL reconnect; full playLive only after repeated failures.
   */
  function checkLiveFreeze() {
    if (mode !== 'live' || destroyed || scrub || liveTuneInFlight) return;
    if (engine.pausedByUser || engine.reconnectTimer) {
      liveStallSince = 0;
      return;
    }
    if (isSeekSettling() || pendingSeek || Date.now() < seekingUntil) {
      liveStallSince = 0;
      liveMediaTime = video.currentTime || 0;
      return;
    }
    if (!engine.hasPlayed || !engine.impl) return;
    // Rewound in the live DVR window — do not yank the user back to the tip.
    if (!nearLive()) {
      liveStallSince = 0;
      liveMediaTime = video.currentTime || 0;
      return;
    }
    // Warm-up: joinTip / first buffer fill often look "stuck" — do not arm yet.
    if (!liveStableAt) liveStableAt = Date.now();
    if (Date.now() - liveStableAt < LIVE_FREEZE_ARM_MS) {
      liveStallSince = 0;
      liveMediaTime = video.currentTime || 0;
      return;
    }

    const t = video.currentTime || 0;
    const end = bufferedEndSec();
    const ahead = end - t;
    const now = Date.now();
    const moved = liveMediaTime >= 0 && (t - liveMediaTime) > 0.08;
    if (moved) {
      liveMediaTime = t;
      liveStallSince = 0;
      return;
    }
    // Only a tip underrun counts as a freeze. Buffer ahead + flat clock is a glitch — nudge play.
    if (ahead >= 0.75) {
      liveMediaTime = t;
      if (!liveStallSince) liveStallSince = now;
      if (now - liveStallSince >= 2000) {
        liveStallSince = now;
        engine.tryPlay();
      }
      return;
    }

    if (liveMediaTime < 0) liveMediaTime = t;
    if (!liveStallSince) liveStallSince = now;
    const frozenFor = now - liveStallSince;
    if (frozenFor < LIVE_FREEZE_MS) return;
    if (now - lastLiveFreezeRecoverAt < LIVE_FREEZE_COOLDOWN_MS) return;

    lastLiveFreezeRecoverAt = now;
    liveStallSince = 0;
    liveMediaTime = -1;
    liveStableAt = 0;
    liveFreezeRecoveries += 1;
    playerLog('ui.liveFreeze', 'recover', {
      frozenFor,
      ahead,
      recoveries: liveFreezeRecoveries,
      pos: position(),
    });

    // 1) Jump to whatever tip still exists. 2) Same-URL reconnect. 3) Fresh live tune.
    if (end > 0.4 && seekLiveLocal(Date.now())) {
      engine.tryPlay();
      return;
    }
    if (liveFreezeRecoveries <= 2) {
      engine.reconnect('live freeze');
      return;
    }
    liveFreezeRecoveries = 0;
    playLive();
  }

  function goLive() {
    playerLog('ui.goLive', '', { mode, streamBase, pos: position() });
    clearSeekBurst();
    liveStallSince = 0;
    liveMediaTime = -1;
    // Already on live with MSE: jump to the live tip of the buffer (no remount).
    if (mode === 'live') {
      syncLiveTimeline();
      const end = bufferedEndSec();
      if (end > 0.4 && seekLiveLocal(Date.now())) {
        playerLog('ui.goLive', 'tip jump');
        showControls();
        tick();
        updateInfo();
        return;
      }
    }
    // Leave catch-up — open true live (not the end of the catch-up download).
    if (mode === 'catchup') {
      clearTimeout(remountTimer);
      remountTimer = null;
      clearInterval(remountJumpTimer);
      remountJumpTimer = null;
      clearInterval(cachePollTimer);
      cachePollTimer = null;
    }
    playLive();
    showControls();
    tick();
  }

  function togglePlay() {
    playerLog('ui.togglePlay', engine.paused ? 'resume' : 'pause', { mode, pos: position() });
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
    if (device === 'phone') {
      native('setLandscape', full);
      if (full && screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
      else if (!full && screen.orientation && screen.orientation.unlock) {
        try { screen.orientation.unlock(); } catch { /* not supported */ }
      }
    }
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
    hideTimer = setTimeout(function hideLater() {
      if (scrub || volumeOpen) hideTimer = setTimeout(hideLater, HIDE_AFTER_MS);
      else if (!engine.paused) hidePlayerChrome();
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

  // ---------- seek bar: click or drag (mouse and finger) ----------
  function fracAt(clientX) {
    const rect = seekbar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  function showScrub(clientX) {
    const from = barStartMs();
    const to = barEndMs();
    const span = to - from;
    const liveFrac = span > 0 ? Math.max(0, Math.min(1, (Date.now() - from) / span)) : 1;
    scrub.frac = Math.min(fracAt(clientX), liveFrac);
    fill.style.width = `${scrub.frac * 100}%`;
    knob.style.left = `${scrub.frac * 100}%`;
    const at = from + scrub.frac * span;
    posLabel.textContent = `→ ${fmtTime(at)}`;
    seekTip.showHover(scrub.frac, fmtTime(at));
  }

  function endScrub(e, commit) {
    if (!scrub || e.pointerId !== scrub.id) return;
    const from = barStartMs();
    const to = barEndMs();
    const target = programme ? from + scrub.frac * (to - from) : null;
    scrub = null;
    seekbar.classList.remove('scrubbing');
    if (commit && target !== null) seekTo(target, { forceCatchup: mode === 'live' });
    seekTip.hide();
    tick();
    showControls();
  }

  function hoverSeekTip(clientX) {
    if (scrub || pendingSeek) return;
    const from = barStartMs();
    const to = barEndMs();
    const span = Math.max(1, to - from);
    let frac = fracAt(clientX);
    if (canSeek()) {
      const liveFrac = Math.max(0, Math.min(1, (Date.now() - from) / span));
      frac = Math.min(frac, liveFrac);
    }
    seekTip.showHover(frac, fmtTime(from + frac * span));
  }

  seekbar.addEventListener('pointerdown', (e) => {
    if (!programme || !canSeek() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    e.stopPropagation();
    clearSeekBurst();
    scrub = { id: e.pointerId, frac: 0 };
    try {
      seekbar.setPointerCapture(e.pointerId);
    } catch { /* pointer already gone */ }
    seekbar.classList.add('scrubbing');
    showControls();
    showScrub(e.clientX);
  });
  seekbar.addEventListener('pointermove', (e) => {
    if (scrub && e.pointerId === scrub.id) showScrub(e.clientX);
    else if (e.pointerType === 'mouse') hoverSeekTip(e.clientX);
  });
  seekbar.addEventListener('pointerenter', (e) => {
    if (e.pointerType === 'mouse' && !scrub && !pendingSeek) hoverSeekTip(e.clientX);
  });
  seekbar.addEventListener('pointerleave', () => {
    if (!scrub && seekTip.mode === 'hover') seekTip.hide();
  });
  seekbar.addEventListener('pointerup', (e) => endScrub(e, true));
  seekbar.addEventListener('pointercancel', (e) => endScrub(e, false));

  // ---------- taps and clicks on the picture ----------
  // Touch: one tap shows/hides the controls; double-tap the left/right third to jump back/forward
  // (keep tapping the same side to jump further); double-tap the middle for full screen.
  // Mouse: moving shows the controls, a click toggles them, a double-click toggles full screen.
  const onControl = (el) => !!el.closest('button, input, .seekbar, .volume, .vol-btn, .cc-panel, .cc-btn');
  let lastTap = null;
  let tapTimer = null;
  let streak = null; // { dir, until }
  let flashTimer = null;

  function flashSeek(dir, amountMs = SEEK_STEP_LONG_MS) {
    const sec = Math.round(Math.abs(amountMs) / 1000);
    const label = sec >= 60 ? `${Math.round(sec / 60)}m` : `${sec}s`;
    seekFlash.replaceChildren(h('span', { text: dir < 0 ? `« −${label}` : `+${label} »` }));
    seekFlash.classList.toggle('left', dir < 0);
    seekFlash.classList.toggle('right', dir > 0);
    seekFlash.classList.add('show');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => seekFlash.classList.remove('show'), SEEK_STREAK_MS);
  }

  function doubleTap(zone) {
    if (zone && canSeek()) {
      const step = SEEK_STEP_LONG_MS;
      queueSeek(zone * step);
      flashSeek(zone, step);
      streak = { dir: zone, until: performance.now() + SEEK_STREAK_MS };
    } else if (hasNative('setFullscreen') || document.fullscreenEnabled) {
      toggleFullscreen();
    } else {
      toggleControls();
    }
  }

  // ---------- press and hold (phones): right half = volume, left half = brightness ----------
  // Hold still for 2 s to open the bar, then drag up/down without lifting the finger.
  let hold = null; // { id, x, y, downAt, kind, timer, active, startY, startLevel }
  let holdConsumed = false;
  let adjustHideTimer = null;
  let webBrightness = 1;
  let brightnessChanged = false;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  function getLevel(kind) {
    if (kind === 'volume') {
      if (engine && engine.userMuted) return 0;
      const v = engine ? engine.getVolume() : video.volume;
      return clamp01(Number.isFinite(v) ? v : 1);
    }
    const b = hasNative('getBrightness') ? Number(native('getBrightness')) : webBrightness;
    return clamp01(Number.isFinite(b) ? b : 0.5);
  }

  function setLevel(kind, level) {
    if (kind === 'volume') {
      if (level <= 0.001) {
        if (!(engine && engine.userMuted) && video.volume > 0) {
          volumeBeforeMute = Math.round(video.volume * 100) || volumeBeforeMute;
        }
        applyUserMute(true);
      } else {
        volumeBeforeMute = Math.max(1, Math.round(level * 100));
        prefs.set('volume', volumeBeforeMute);
        if (engine) {
          engine.setVolume(level);
          applyUserMute(false);
          engine.unlockSound();
        } else {
          video.volume = level;
          applyUserMute(false);
        }
      }
      syncVolumeUi();
    } else if (hasNative('setBrightness')) {
      native('setBrightness', level);
      brightnessChanged = true;
    } else {
      // Browsers cannot change the screen itself, so the picture is dimmed instead.
      webBrightness = level;
      video.style.filter = level < 1 ? `brightness(${(0.1 + 0.9 * level).toFixed(3)})` : '';
    }
    showLevel(kind, level);
  }

  function showLevel(kind, level) {
    const pct = Math.round(level * 100);
    adjustIcon.innerHTML = kind === 'brightness'
      ? ICON.sun
      : (pct === 0 ? ICON.mute : pct < 34 ? ICON.volLow : pct < 67 ? ICON.volMed : ICON.volHigh);
    adjustFill.style.height = `${pct}%`;
    adjustValue.textContent = `${pct}%`;
    adjustPanel.classList.toggle('left', kind === 'brightness');
    adjustPanel.classList.toggle('right', kind === 'volume');
    adjustPanel.classList.add('show');
    clearTimeout(adjustHideTimer);
  }

  function cancelHold() {
    if (!hold) return;
    clearTimeout(hold.timer);
    if (hold.active) adjustHideTimer = setTimeout(() => adjustPanel.classList.remove('show'), ADJUST_HIDE_MS);
    hold = null;
  }

  playerEl.addEventListener('pointerdown', (e) => {
    if (!phone || e.pointerType === 'mouse' || onControl(e.target)) return;
    if (hold && hold.id !== e.pointerId) {
      cancelHold(); // a second finger: not a hold
      return;
    }
    const kind = e.clientX >= playerEl.clientWidth / 2 ? 'volume' : 'brightness';
    hold = { id: e.pointerId, x: e.clientX, y: e.clientY, lastY: e.clientY, downAt: performance.now(), kind, active: false };
    hold.timer = setTimeout(() => {
      if (!hold) return;
      hold.active = true;
      hold.startY = hold.lastY;
      hold.startLevel = getLevel(hold.kind);
      clearTimeout(tapTimer);
      lastTap = null;
      try {
        playerEl.setPointerCapture(hold.id);
      } catch { /* finger already lifted */ }
      if (navigator.vibrate) navigator.vibrate(15);
      showLevel(hold.kind, hold.startLevel);
    }, HOLD_MS);
  });
  playerEl.addEventListener('pointermove', (e) => {
    if (!hold || e.pointerId !== hold.id) return;
    hold.lastY = e.clientY;
    if (!hold.active) {
      if (Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > HOLD_SLOP_PX) cancelHold();
      return;
    }
    e.preventDefault();
    const range = (playerEl.clientHeight || window.innerHeight) * ADJUST_RANGE;
    setLevel(hold.kind, clamp01(hold.startLevel + (hold.startY - e.clientY) / range));
  });
  const endHold = (e) => {
    if (!hold || e.pointerId !== hold.id) return;
    if (hold.active || performance.now() - hold.downAt > 600) holdConsumed = true;
    cancelHold();
  };
  playerEl.addEventListener('pointerup', endHold);
  playerEl.addEventListener('pointercancel', endHold);
  playerEl.addEventListener('contextmenu', (e) => {
    if (phone) e.preventDefault();
  });

  playerEl.addEventListener('pointerup', (e) => {
    if (holdConsumed) {
      holdConsumed = false;
      return;
    }
    if (e.pointerType === 'mouse' || scrub || onControl(e.target)) return;
    const now = performance.now();
    const x = e.clientX / (playerEl.clientWidth || 1);
    const zone = x < 1 / 3 ? -1 : x > 2 / 3 ? 1 : 0;
    if (streak && now < streak.until && zone === streak.dir) {
      clearTimeout(tapTimer);
      lastTap = null;
      doubleTap(zone);
      return;
    }
    streak = null;
    if (lastTap && now - lastTap.t < DOUBLE_TAP_MS && Math.abs(e.clientX - lastTap.x) < TAP_SLOP_PX * 2) {
      clearTimeout(tapTimer);
      lastTap = null;
      doubleTap(zone);
      return;
    }
    lastTap = { t: now, x: e.clientX };
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => {
      lastTap = null;
      toggleControls();
    }, DOUBLE_TAP_MS);
  });

  let pointerKind = 'mouse';
  playerEl.addEventListener('pointerdown', (e) => { pointerKind = e.pointerType; }, true);
  playerEl.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') showControls();
  });
  let clickTimer = null;
  playerEl.addEventListener('click', (e) => {
    if (pointerKind !== 'mouse' || e.detail === 0 || onControl(e.target) || e.target.closest('.player-top')) return;
    clearTimeout(clickTimer);
    if (e.detail === 1) clickTimer = setTimeout(toggleControls, DOUBLE_TAP_MS);
  });
  playerEl.addEventListener('dblclick', (e) => {
    if (pointerKind !== 'mouse' || onControl(e.target)) return;
    clearTimeout(clickTimer);
    if (fullBtn) toggleFullscreen();
  });

  // ---------- start ----------
  tickTimer = setInterval(tick, 1000);
  gapWatchTimer = setInterval(() => {
    checkCatchupStall();
    checkLiveFreeze();
  }, 500);
  rememberChannel(channelId);
  try {
    const s = await get('/settings');
    if (s && s.catchupPreloadHours != null) prefs.set('catchupPreloadHours', Number(s.catchupPreloadHours) || 0);
  } catch { /* keep prefs default */ }
  const start = Number(params.start);
  if (Number.isFinite(start) && start > 0) {
    try {
      const info = await get(`/play/live?ch=${encodeURIComponent(channelId)}`);
      channel = info.channel;
    } catch (err) {
      message.textContent = err.message;
    }
    await playCatchup(start, Number(params.end) || null);
  } else {
    await playLive();
  }
  showControls(true);

  return {
    manageFocus: true,
    onKey(action) {
      if (action === 'back') {
        if (isFullscreen()) {
          toggleFullscreen();
          return true;
        }
        return false;
      }
      const visible = controlsVisible();
      // Media remote / Space only — picture clicks never toggle play/pause.
      if (action === 'playpause') {
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
      if (action === 'ff' || action === 'rew') {
        if (!canSeek()) return true;
        queueSeek(action === 'ff' ? SEEK_STEP_LONG_MS : -SEEK_STEP_LONG_MS);
        return true;
      }
      // Left/right always seek when the channel has catch-up; otherwise ignore.
      if (action === 'left' || action === 'right') {
        if (!canSeek()) return true;
        queueSeek(action === 'right' ? SEEK_STEP_LONG_MS : -SEEK_STEP_LONG_MS);
        return true;
      }
      if (!visible) {
        // Enter shows chrome — play/pause is only the play button (or Space).
        showControls(true);
        return true;
      }
      showControls();
      // Enter on the focused play button activates it; elsewhere ignore.
      if (action === 'enter' && document.activeElement === playBtn) {
        togglePlay();
        return true;
      }
      return false;
    },
    onBack() {
      return false;
    },
    unmount() {
      reportWatch(true);
      destroyed = true;
      clearInterval(tickTimer);
      clearInterval(gapWatchTimer);
      clearInterval(cachePollTimer);
      clearInterval(remountJumpTimer);
      clearTimeout(remountTimer);
      clearTimeout(hideTimer);
      clearTimeout(seekTimer);
      clearTimeout(tapTimer);
      clearTimeout(clickTimer);
      clearTimeout(flashTimer);
      clearTimeout(adjustHideTimer);
      clearTimeout(subRefreshTimer);
      playerSettings.destroy();
      cancelHold();
      if (brightnessChanged) native('setBrightness', -1);
      engine.stop();
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
      window.__onNativeFullscreen = null;
      if (hasNative('setFullscreen') && isFullscreen()) native('setFullscreen', false);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      native('setLandscape', false);
      native('setImmersive', false);
    },
  };
}
