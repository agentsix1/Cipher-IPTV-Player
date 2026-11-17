/**
 * HTML5 video engine for IPTV streams. MPEG-TS goes through mpegts.js, HLS through hls.js,
 * with native <video> playback as the last resort. Candidates are tried in order until one plays.
 */

import { playerLog } from './player-debug.js';
import * as vlc from './vlc-bridge.js';

const START_TIMEOUT_MS = 25000;
/** Remux (MKV→fMP4) needs longer before first MSE bytes — don't abort into Seeking… loops. */
const VOD_REMUX_START_TIMEOUT_MS = 90000;
/** Backstop coalesce for hard VOD seeks (UI usually waits longer before calling seek). */
const VOD_SEEK_DEBOUNCE_MS = 350;
const MAX_RECONNECTS = 6;
const STABLE_PLAYBACK_MS = 30000;
/** Soft-seek window for remuxed VOD — jumps inside this stay on currentTime (no ffmpeg reopen). */
const MSE_AHEAD_SEC = 120;
const MSE_BEHIND_SEC = 20;
/** Live DVR window — enough for −1m, but not so large that SourceBuffer quota stalls appends. */
const MSE_LIVE_BEHIND_MAX_SEC = 120;
const MSE_LIVE_BEHIND_MIN_SEC = 60;
/** Catch-up quick-seek window: keep ~2 min behind + allow ~2.5 min ahead. */
const MSE_CATCHUP_AHEAD_SEC = 150;
const MSE_CATCHUP_BEHIND_MAX_SEC = 150;
const MSE_CATCHUP_BEHIND_MIN_SEC = 120;
// A transparent poster stops Android from drawing its default grey/white "play" poster over the black video.
const BLANK_POSTER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function withStartParam(url, seconds) {
  const ss = Math.max(0, Number(seconds) || 0);
  try {
    const u = new URL(url, window.location.origin);
    if (ss > 0.4) u.searchParams.set('ss', String(Math.floor(ss)));
    else u.searchParams.delete('ss');
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

export class StreamPlayer {
  /**
   * @param {HTMLVideoElement} video
   * @param {{ onState?: Function, still?: HTMLCanvasElement }} opts `still` shows the last picture while
   *   the stream is switched (seek, restart, reconnect) until the new one draws its first frame.
   */
  constructor(video, { onState, still } = {}) {
    this.video = video;
    this.still = still || null;
    video.poster = BLANK_POSTER;
    this.onState = onState || (() => {});
    this.impl = null;
    /** When true, decode is native libVLC (HTML video hidden). */
    this.useVlc = false;
    this._vlcUnsub = null;
    this.candidates = [];
    this.index = 0;
    this.token = 0;
    this.startTimer = null;
    this.live = true;
    this.startAt = 0;
    this.hasPlayed = false;
    this.reconnects = 0;
    this.reconnectTimer = null;
    this.stableTimer = null;
    this.drainTimer = null;
    this.soundBlocked = false;
    /** True when the user muted via the volume UI — never cleared by load/seek/play. */
    this.userMuted = false;
    this.seekOffset = 0;
    this.knownDuration = 0;
    this.pausedByUser = false;
    this.hold = 0;
    /** Keep UI on hold until native VLC Time= (or open-at) lands. */
    this._holdUiUntil = 0;
    this.pendingSeek = null;
    this.seekDebounce = null;
    this.stallTimer = null;
    this.convertAhead = false;
    this.transcode = false;
    this.prefetch = false;
    this.ignoreErrorsUntil = 0;
    this.bufferAhead = 0;
    this._unlock = () => this.unlockSound();
    video.addEventListener('loadedmetadata', () => {
      try {
        const tracks = video.audioTracks;
        if (tracks && tracks.length) {
          for (let i = 0; i < tracks.length; i++) tracks[i].enabled = i === 0;
        }
      } catch { /* audioTracks not exposed */ }
      // Re-apply mute after the element reloads — do not force unmute.
      this.applyMuteState();
    });

    video.addEventListener('playing', () => {
      clearTimeout(this.startTimer);
      this.hasPlayed = true;
      clearTimeout(this.stableTimer);
      this.stableTimer = setTimeout(() => { this.reconnects = 0; }, STABLE_PLAYBACK_MS);
      playerLog('engine.playing', '', {
        live: !!this.live,
        currentTime: this.video.currentTime || 0,
        readyState: this.video.readyState,
        seekOffset: this.seekOffset || 0,
        pendingSeek: this.pendingSeek,
      });
      // Burst updated the target while this remux was opening — one follow-up reopen.
      if (
        !this.live
        && this.transcode
        && this.pendingSeek != null
        && Math.abs(this.pendingSeek - this.position()) > 1.25
      ) {
        const t = this.pendingSeek;
        playerLog('engine.playing.followSeek', '', { to: t, pos: this.position() });
        this.reconnectAt(t);
        return;
      }
      this.revealVideo();
      this.onState('playing');
    });
    // Nudge play when the first bytes land — some IPTV feeds open MSE long before 'playing'.
    video.addEventListener('loadeddata', () => { this.tryPlay(); });
    video.addEventListener('canplay', () => { this.tryPlay(); });
    video.addEventListener('waiting', () => {
      clearTimeout(this.stableTimer);
      this.onState('buffering');
    });
    video.addEventListener('pause', () => {
      if (!this.pausedByUser && this.pendingSeek != null) return;
      this.onState('paused');
    });
    video.addEventListener('ended', () => {
      if (this.live && this.impl) this.reconnect('playback ended');
    });
    video.addEventListener('error', () => {
      if (this.pausedByUser) return;
      // VOD remux: empty MSE before the first fMP4 fragment often fires a spurious error.
      // Reconnecting aborts ffmpeg and leaves the UI stuck on Seeking… — wait for start timeout.
      if (!this.live && this.transcode && !this.hasPlayed) {
        playerLog('engine.videoError.ignore', 'vod remux warming', {
          code: this.video.error && this.video.error.code,
          impl: this.impl && this.impl.type,
        });
        return;
      }
      if (this.impl && (this.impl.type === 'native' || this.impl.type === 'mse')) this.streamFailed('native playback error');
    });
  }

  /**
   * @param {string[]} urls ordered candidate URLs
   * @param {'ts'|'hls'} kind stream type of the first URL
   * @param {{ live?: boolean }} opts live enables latency chasing (off for catch-up)
   */
  play(urls, kind, {
    live = true, start = 0, duration = 0, convertAhead, transcode, prefetch,
    bufferAhead = 0, paused = false, videoCodec = '', audioCodec = '',
    /** Guide/channels preview must stay in the HTML &lt;video&gt; box — native VLC is a full-window underlay. */
    forceHtml = false,
  } = {}) {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.videoCodec = String(videoCodec || '').toLowerCase();
    this.audioCodec = String(audioCodec || '').toLowerCase();
    const allowVlc = !forceHtml && vlc.hasNativeVlc();
    playerLog('engine.play', live ? 'live' : 'catchup', {
      kind,
      live: !!live,
      start: Number(start) || 0,
      duration: Number(duration) || 0,
      prefetch: !!prefetch,
      paused: !!paused,
      forceHtml: !!forceHtml,
      vlc: allowVlc,
      videoCodec: this.videoCodec,
      audioCodec: this.audioCodec,
      urls: (urls || []).length,
      url0: urls && urls[0] ? String(urls[0]).slice(0, 160) : '',
    });
    this.live = live;
    // Cipher: never remux in the browser engine; native VLC handles codecs.
    this.transcode = false;
    // Disk prefetch can run alongside remux (ffmpeg reads the growing cache file).
    // Catch-up disk cache uses mpegts (`ts`); VOD remux uses `file`.
    this.prefetch = !live && !!prefetch && (kind === 'file' || kind === 'ts');
    this.convertAhead = this.transcode && convertAhead !== false;
    this.knownDuration = Number(duration) || this.knownDuration || 0;
    // Catch-up: keep downloading until this many seconds are buffered ahead of the playhead
    // (capped in startTs). Target is settings window end, gated by what has actually aired (live).
    this.bufferAhead = Math.max(0, Number(bufferAhead) || 0);
    this.seekOffset = this.transcode ? (Number(start) || 0) : 0;
    this.startAt = Number(start) || 0;
    // `paused: true` holds autoplay (e.g. remount until seek lands) — do not flash t=0.
    this.pausedByUser = !!paused;
    this.hold = this.startAt;
    // Large resume offsets often need >8s before VLC Time= catches up.
    this._holdUiUntil = this.startAt > 0.4
      ? Date.now() + Math.min(20000, Math.max(8000, Math.floor(this.startAt / 60) * 1000 + 8000))
      : 0;
    this.pendingSeek = null;
    clearTimeout(this.seekDebounce);
    this.candidates = [];
    if (kind === 'file') {
      for (const url of urls) {
        // Remuxed streams are fragmented MP4 — <video src> is unreliable; always try MSE first.
        if ((this.transcode || this.convertAhead) && window.MediaSource) this.candidates.push({ url, kind: 'mse' });
        this.candidates.push({ url, kind: 'native' });
      }
    } else if (kind === 'hls') {
      for (const url of urls) this.candidates.push({ url, kind: 'hls' });
      this.candidates.push({ url: urls[0], kind: 'native' });
    } else {
      for (const url of urls) this.candidates.push({ url, kind: 'ts' });
      this.candidates.push({ url: urls[0], kind: 'native' });
    }
    this.index = 0;
    this.hasPlayed = false;
    this.reconnects = 0;
    if (allowVlc && urls && urls[0]) {
      this.startVlc(urls[0], { live, start: this.startAt, paused });
      return;
    }
    // Leaving a previous native session (e.g. full player → guide preview).
    if (this.useVlc) {
      try { vlc.vlcStop(); } catch { /* ignore */ }
      if (this._vlcUnsub) {
        try { this._vlcUnsub(); } catch { /* ignore */ }
        this._vlcUnsub = null;
      }
    }
    this.useVlc = false;
    vlc.setHtmlVideoHidden(this.video, false);
    this.start();
  }

  startVlc(url, { live = true, start = 0, paused = false } = {}) {
    this.destroyImpl();
    this.useVlc = true;
    this.token++;
    const token = this.token;
    vlc.setHtmlVideoHidden(this.video, true);
    if (this._vlcUnsub) {
      try { this._vlcUnsub(); } catch { /* ignore */ }
      this._vlcUnsub = null;
    }
    this._vlcUnsub = vlc.onVlcState((ev) => {
      if (token !== this.token || !this.useVlc) return;
      const state = String(ev.state || '');
      if (state === 'playing') {
        this.hasPlayed = true;
        // Native Time= seek has landed (or stream has no start offset).
        const t = Math.max(0, Number(ev.time) || vlc.vlcGetTime() || 0);
        if (this.hold > 0.4 && t >= this.hold - 2) this._holdUiUntil = 0;
        this.onState('playing');
      } else if (state === 'paused') this.onState('paused');
      else if (state === 'buffering' || state === 'opening') this.onState(this.hasPlayed ? 'reconnecting' : 'loading');
      else if (state === 'ended') this.onState('ended');
      else if (state === 'error') this.onState('error');
      else if (state === 'stopped') this.onState('stopped');
      if (ev.length > 1) this.knownDuration = Number(ev.length) || this.knownDuration;
      if (ev.time > 0.4 && this.hold > 0.4 && ev.time >= this.hold - 2) this._holdUiUntil = 0;
    });
    const startSec = Number(start) || 0;
    this.hold = startSec;
    this.startAt = startSec;
    this._holdUiUntil = startSec > 0.4
      ? Date.now() + Math.min(20000, Math.max(8000, Math.floor(startSec / 60) * 1000 + 8000))
      : 0;
    playerLog('engine.start', 'vlc', {
      live: !!live,
      start: startSec,
      url: String(url || '').slice(0, 160),
    });
    this.onState('loading');
    vlc.vlcOpen(url, { start: startSec, live: !!live });
    // Re-apply volume/mute after open — libVLC resets to default on each media.
    this.applyMuteState();
    if (paused) vlc.vlcPause();
    else vlc.vlcPlay();
  }

  start({ reconnecting = false } = {}) {
    if (this.useVlc) {
      const url = this.candidates[this.index] && this.candidates[this.index].url;
      if (url) {
        this.startVlc(url, { live: this.live, start: this.seekOffset || this.startAt || 0, paused: this.pausedByUser });
        return;
      }
    }
    this.destroyImpl();
    this._badMediaAbort = false;
    const token = ++this.token;
    const candidate = this.candidates[this.index];
    if (!candidate) {
      playerLog('engine.error', 'no candidate');
      this.onState('error');
      return;
    }
    playerLog('engine.start', reconnecting ? 'reconnecting' : 'loading', {
      token,
      index: this.index,
      kind: candidate.kind,
      live: !!this.live,
      prefetch: !!this.prefetch,
      startAt: this.startAt,
      pausedByUser: !!this.pausedByUser,
      url: String(candidate.url || '').slice(0, 160),
    });
    this.onState(reconnecting ? 'reconnecting' : 'loading');
    clearTimeout(this.startTimer);
    const startWait = START_TIMEOUT_MS;
    this.startTimer = setTimeout(() => this.checkStartTimeout(token), startWait);

    try {
      if (candidate.kind === 'ts') {
        if (window.mpegts && window.mpegts.getFeatureList().mseLivePlayback) this.startTs(candidate.url, token);
        else this.fail('unsupported');
      } else if (candidate.kind === 'hls' && window.Hls && window.Hls.isSupported()) this.startHls(candidate.url, token);
      else if (candidate.kind === 'mse') this.startMse(candidate.url, token);
      else if (candidate.kind === 'native') this.startNative(candidate.url);
      else this.fail('unsupported');
    } catch (err) {
      console.warn('player start failed', err);
      this.fail(err.message);
    }
  }

  /** Fail only when nothing arrived. If MSE is buffering, keep waiting and nudge play(). */
  checkStartTimeout(token) {
    // holdPlay / bad-media recover keep pausedByUser — never same-URL reconnect while waiting.
    if (token !== this.token || this.hasPlayed || this.pausedByUser || this._badMediaAbort) {
      playerLog('engine.startTimeout.skip', '', {
        tokenMatch: token === this.token,
        hasPlayed: !!this.hasPlayed,
        pausedByUser: !!this.pausedByUser,
        badMedia: !!this._badMediaAbort,
      });
      return;
    }
    const v = this.video;
    let buffered = 0;
    try {
      if (v.buffered && v.buffered.length) buffered = v.buffered.end(v.buffered.length - 1) - v.buffered.start(0);
    } catch { /* ignore */ }
    playerLog('engine.startTimeout', 'checking', {
      buffered: Math.round(buffered * 100) / 100,
      readyState: v.readyState,
      live: !!this.live,
    });
    if (buffered > 0.2 || v.readyState >= 2) {
      this.tryPlay();
      this.startTimer = setTimeout(() => {
        if (token === this.token && !this.hasPlayed && !this.pausedByUser && !this._badMediaAbort) {
          this.streamFailed('start timeout');
        }
      }, 12000);
      return;
    }
    this.streamFailed('start timeout');
  }

  startTs(url, token) {
    // Catch-up: do not use lazyLoad — pause/resume corrupts Xtream timeshift (TS sync_byte errors).
    // Live: never chase latency via seek or playbackRate — both desync A/V on IPTV MPEG-TS.
    const catchup = !this.live;
    try { this.video.playbackRate = 1; } catch { /* ignore */ }
    const player = window.mpegts.createPlayer(
      { type: 'mpegts', isLive: this.live, hasAudio: true, hasVideo: true, url },
      catchup ? {
        enableWorker: false,
        enableStashBuffer: true,
        stashInitialSize: 1024 * 1024,
        lazyLoad: false,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: MSE_CATCHUP_BEHIND_MAX_SEC,
        autoCleanupMinBackwardDuration: MSE_CATCHUP_BEHIND_MIN_SEC,
        accurateSeek: true,
        liveBufferLatencyChasing: false,
        liveSync: false,
        fixAudioTimestampGap: true,
      } : {
        enableWorker: false,
        enableStashBuffer: true,
        stashInitialSize: 512 * 1024,
        lazyLoad: false,
        // Retain ~1–2 minutes behind the live tip for smooth instant replay seeks.
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: MSE_LIVE_BEHIND_MAX_SEC,
        autoCleanupMinBackwardDuration: MSE_LIVE_BEHIND_MIN_SEC,
        // No latency chase (seek or playbackRate) — both desync IPTV A/V more than they help.
        liveBufferLatencyChasing: false,
        liveSync: false,
        // Live audio is normalized to AAC-LC server-side; keep gap fill for network jitter.
        fixAudioTimestampGap: true,
      },
    );
    player.on(window.mpegts.Events.ERROR, (type, detail) => {
      if (token !== this.token) return;
      const kind = `${type || ''} ${detail || ''}`;
      playerLog('engine.mpegts.error', kind, { live: !!this.live, hasPlayed: !!this.hasPlayed });
      // Non-TS bytes (HTML/zeros after tip) make TSDemuxer spam sync_byte forever.
      // Kill the loader immediately — do not wait for settle / pause swallow.
      if (!this.live && /format|demux|mediaerror|mse|codec|unsupported|sync/i.test(kind)) {
        this.abortBadCatchupMedia(token);
        return;
      }
      this.streamFailed(`mpegts ${type} ${detail}`);
    });
    // Live: providers often close the socket — drain, then reconnect.
    // Catch-up: a short archive / missing minute ends the download — signal a gap skip.
    // Prefetch: HTTP slice often ends while the disk file is still growing — refill early.
    player.on(window.mpegts.Events.LOADING_COMPLETE, () => {
      if (token !== this.token) return;
      if (this.live) this.reconnectWhenDrained(token);
      else this.catchupWhenDrained(token);
    });
    // mpegts logs sync_byte errors and keeps pumping — it does not always fire ERROR.
    if (!this.live) this.watchTsSyncSpam(token);
    player.attachMediaElement(this.video);
    player.load();
    this.impl = { type: 'ts', player };
    // Catch-up remount with a resume offset: stay paused until the UI seeks — never play from 0.
    if (!this.live && this.startAt > 0.4 && this.pausedByUser) {
      try { this.video.pause(); } catch { /* ignore */ }
      return;
    }
    this.tryPlay();
  }

  /** Catch-up uses a soft reboot to refill MSE; keep cleanup knobs tight. */
  setBufferAhead(seconds) {
    this.bufferAhead = Math.max(0, Number(seconds) || 0);
    if (this.live || !this.impl || this.impl.type !== 'ts' || !this.impl.player) return;
    try {
      const cfg = this.impl.player._config;
      if (cfg) {
        cfg.lazyLoad = false;
        cfg.autoCleanupSourceBuffer = true;
        cfg.autoCleanupMaxBackwardDuration = MSE_CATCHUP_BEHIND_MAX_SEC;
        cfg.autoCleanupMinBackwardDuration = MSE_CATCHUP_BEHIND_MIN_SEC;
      }
    } catch { /* private config unavailable */ }
  }

  startHls(url, token) {
    const hls = new window.Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 30 });
    hls.on(window.Hls.Events.ERROR, (_evt, data) => {
      if (data.fatal && token === this.token) this.streamFailed(`hls ${data.details}`);
    });
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => this.tryPlay());
    hls.loadSource(url);
    hls.attachMedia(this.video);
    this.impl = { type: 'hls', player: hls };
  }

  startNative(url) {
    const src = (!this.live && this.transcode) ? withStartParam(url, this.seekOffset) : url;
    this.video.src = src;
    this.impl = { type: 'native' };
    if (!this.live && !this.transcode && this.startAt > 0.4) {
      const want = this.startAt;
      const token = this.token;
      this.video.addEventListener('loadedmetadata', () => {
        if (token !== this.token) return;
        try { this.video.currentTime = want; } catch { /* ignore */ }
      }, { once: true });
    }
    this.tryPlay();
  }

  mseMimes() {
    const avc = [
      'video/mp4; codecs="avc1.640028,mp4a.40.2"',
      'video/mp4; codecs="avc1.64001F,mp4a.40.2"',
      'video/mp4; codecs="avc1.42E01E,mp4a.40.2"',
    ];
    // hev1 = length-prefixed NAL (ffmpeg remux default); hvc1 = length-prefixed too with different brand.
    // Main 10 (profile 2) must be listed — bare hev1 often isn't enough for 4K HDR remuxes.
    const hevc = [
      'video/mp4; codecs="hev1.2.4.L153.B0,mp4a.40.2"',
      'video/mp4; codecs="hvc1.2.4.L153.B0,mp4a.40.2"',
      'video/mp4; codecs="hev1.2.4.L120.B0,mp4a.40.2"',
      'video/mp4; codecs="hvc1.2.4.L120.B0,mp4a.40.2"',
      'video/mp4; codecs="hev1.1.6.L150.B0,mp4a.40.2"',
      'video/mp4; codecs="hvc1.1.6.L150.B0,mp4a.40.2"',
      'video/mp4; codecs="hev1.1.6.L123.B0,mp4a.40.2"',
      'video/mp4; codecs="hvc1.1.6.L123.B0,mp4a.40.2"',
      'video/mp4; codecs="hev1.1.6.L93.B0,mp4a.40.2"',
      'video/mp4; codecs="hvc1.1.6.L93.B0,mp4a.40.2"',
      'video/mp4; codecs="hev1,mp4a.40.2"',
      'video/mp4; codecs="hvc1,mp4a.40.2"',
    ];
    const preferHevc = /hevc|h265|hev1|hvc1/i.test(this.videoCodec || '');
    // Wrong order is fatal: AVC SourceBuffer + HEVC fragments → MEDIA_ERR_SRC_NOT_SUPPORTED.
    const list = preferHevc ? [...hevc, ...avc] : [...avc, ...hevc];
    if (!window.MediaSource) return [];
    const supported = list.filter((m) => MediaSource.isTypeSupported(m));
    playerLog('engine.mseMimes', preferHevc ? 'prefer-hevc' : 'prefer-avc', {
      videoCodec: this.videoCodec || '',
      first: (supported[0] || list[0] || '').slice(0, 80),
      supported: supported.length,
    });
    return supported.length ? supported : list;
  }

  startMse(url, token) {
    if (!this.mseMimes().length) {
      this.fail('mse unsupported');
      return;
    }
    const src = withStartParam(url, this.seekOffset);
    const abort = new AbortController();
    const ms = new MediaSource();
    const objectUrl = URL.createObjectURL(ms);
    this.video.src = objectUrl;
    this.impl = { type: 'mse', abort, ms, objectUrl };
    ms.addEventListener('sourceopen', () => {
      if (token !== this.token) return;
      const remain = Math.max(0, (this.knownDuration || 0) - (this.seekOffset || 0));
      if (remain > 1 && Number.isFinite(remain)) {
        try { ms.duration = remain; } catch { /* ignore */ }
      }
      this.pumpMse(src, token, abort, ms).catch((err) => {
        if (token !== this.token || !err || err.name === 'AbortError') return;
        if (err.name === 'QuotaExceededError' || /full|quota/i.test(String(err.message || ''))) return;
        this.fail(err.message || 'mse pump');
      });
    }, { once: true });
    this.tryPlay();
  }

  async pumpMse(url, token, abort, ms) {
    let sb;
    let usedMime = '';
    const mimes = this.mseMimes();
    for (const mime of mimes) {
      try {
        sb = ms.addSourceBuffer(mime);
        usedMime = mime;
        break;
      } catch { /* try next codec string */ }
    }
    if (!sb) throw new Error('sourcebuffer');
    playerLog('engine.mseSourceBuffer', usedMime.slice(0, 90), {
      videoCodec: this.videoCodec || '',
      preferHevc: /^(hevc|h265|hev1|hvc1)$/i.test(this.videoCodec || ''),
    });
    try { sb.mode = 'segments'; } catch { /* ignore */ }
    const res = await fetch(url, { signal: abort.signal, cache: 'no-store' });
    if (!res.ok || !res.body) throw new Error(`mse http ${res.status}`);
    const reader = res.body.getReader();
    let pending = new Uint8Array(0);
    const concat = (a, b) => {
      const out = new Uint8Array(a.length + b.length);
      out.set(a, 0);
      out.set(b, a.length);
      return out;
    };
    const takeBoxes = () => {
      let i = 0;
      while (i + 8 <= pending.length) {
        const size = (pending[i] * 0x1000000 + (pending[i + 1] << 16) + (pending[i + 2] << 8) + pending[i + 3]) >>> 0;
        if (size === 1) {
          if (i + 16 > pending.length) break;
          const hi = ((pending[i + 8] << 24) | (pending[i + 9] << 16) | (pending[i + 10] << 8) | pending[i + 11]) >>> 0;
          const lo = ((pending[i + 12] << 24) | (pending[i + 13] << 16) | (pending[i + 14] << 8) | pending[i + 15]) >>> 0;
          const big = hi * 0x100000000 + lo;
          if (i + big > pending.length) break;
          i += big;
          continue;
        }
        if (size < 8 || size > 32 * 1024 * 1024) break;
        if (i + size > pending.length) break;
        i += size;
      }
      if (!i) return null;
      const piece = pending.subarray(0, i);
      pending = pending.subarray(i);
      return piece.slice();
    };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const wait = () => new Promise((resolve, reject) => {
      if (!sb.updating) {
        resolve();
        return;
      }
      const ok = () => {
        sb.removeEventListener('updateend', ok);
        sb.removeEventListener('error', bad);
        resolve();
      };
      const bad = () => {
        sb.removeEventListener('updateend', ok);
        sb.removeEventListener('error', bad);
        reject(new Error('sourcebuffer update'));
      };
      sb.addEventListener('updateend', ok);
      sb.addEventListener('error', bad);
    });
    const ahead = () => {
      try {
        if (!sb.buffered.length) return 0;
        return Math.max(0, sb.buffered.end(sb.buffered.length - 1) - (this.video.currentTime || 0));
      } catch {
        return 0;
      }
    };
    const evictBehind = async () => {
      await wait();
      if (!sb.buffered.length) return false;
      const t = this.video.currentTime || 0;
      const from = sb.buffered.start(0);
      const to = Math.min(t - 1, t - MSE_BEHIND_SEC);
      if (!(to > from + 0.5)) return false;
      try {
        sb.remove(from, to);
        await wait();
        return true;
      } catch {
        return false;
      }
    };
    const quotaErr = (err) => err && (err.name === 'QuotaExceededError' || /full|quota/i.test(String(err.message || '')));
    const append = async (buf) => {
      while (token === this.token && ahead() > MSE_AHEAD_SEC) {
        await evictBehind();
        if (ahead() > MSE_AHEAD_SEC) await sleep(250);
      }
      while (token === this.token) {
        await wait();
        try {
          sb.appendBuffer(buf);
          await wait();
          return;
        } catch (err) {
          if (!quotaErr(err) && !/sourcebuffer/i.test(String(err.message || ''))) throw err;
          const t = this.video.currentTime || 0;
          const a = ahead();
          const freed = await evictBehind();
          if (!freed) {
            while (token === this.token) {
              await sleep(300);
              if ((this.video.currentTime || 0) > t + 0.4 || ahead() < a - 1) break;
            }
          }
        }
      }
    };
    while (token === this.token) {
      const { done, value } = await reader.read();
      if (done) break;
      if (token !== this.token) break;
      pending = concat(pending, value);
      const boxes = takeBoxes();
      if (boxes) await append(boxes);
    }
    if (pending.length && token === this.token) await append(pending);
    if (token === this.token && ms.readyState === 'open') {
      try { ms.endOfStream(); } catch { /* ignore */ }
    }
  }

  async tryPlay() {
    if (this.pausedByUser) return;
    // Do not clear muted here — that would undo a user mute on every seek/remount.
    // Prefer muted autoplay first so live IPTV is not stuck waiting on a gesture.
    if (!this.userMuted && !this.video.muted) {
      // leave unmuted if already allowed; NotAllowedError path below mutes
    } else {
      this.applyMuteState();
    }
    try {
      await this.video.play();
    } catch (err) {
      if (this.pausedByUser) return;
      if (err && err.name === 'NotAllowedError' && !this.video.muted) {
        this.soundBlocked = true;
        this.video.muted = true;
        this.onState('muted');
        try {
          await this.video.play();
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** Keep <video muted> + native VLC volume in sync with user mute / autoplay block. */
  applyMuteState() {
    this.video.muted = !!(this.userMuted || this.soundBlocked);
    // Native libVLC ignores HTML video.volume — push the audible level every time.
    if (this.useVlc || vlc.hasNativeVlc()) {
      const out = (this.userMuted || this.soundBlocked)
        ? 0
        : Math.max(0, Math.min(1, Number(this.video.volume) || 0));
      vlc.vlcSetVolume(out);
    }
  }

  /** Set playback volume 0..1 (also drives native VLC when active). */
  setVolume(level01) {
    const v = Math.max(0, Math.min(1, Number(level01) || 0));
    if (v > 0) this.video.volume = v;
    else this.video.volume = 0;
    this.applyMuteState();
  }

  getVolume() {
    if (this.userMuted) return 0;
    if (this.useVlc) {
      try {
        const n = vlc.vlcGetVolume();
        if (Number.isFinite(n) && n >= 0) return n;
      } catch { /* ignore */ }
    }
    return Math.max(0, Math.min(1, Number(this.video.volume) || 0));
  }

  /** Embedded / sidecar subtitle tracks (VLC SPU or HTML textTracks). */
  listSubtitleTracks() {
    if (this.useVlc) return vlc.vlcGetSubtitleTracks();
    const v = this.video;
    if (!v || !v.textTracks) return [];
    const out = [];
    for (let i = 0; i < v.textTracks.length; i++) {
      const t = v.textTracks[i];
      if (!t || (t.kind && t.kind !== 'subtitles' && t.kind !== 'captions')) continue;
      out.push({
        id: i,
        name: t.label || t.language || `Track ${i + 1}`,
        language: t.language || '',
      });
    }
    return out;
  }

  getSubtitleTrackId() {
    if (this.useVlc) return vlc.vlcGetSubtitleTrack();
    const v = this.video;
    if (!v || !v.textTracks) return -1;
    for (let i = 0; i < v.textTracks.length; i++) {
      const t = v.textTracks[i];
      if (t && t.mode === 'showing') return i;
    }
    return -1;
  }

  /** @param {number|null} id track id, or -1 / null for none */
  setSubtitleTrack(id) {
    const want = id == null || id === '' ? -1 : Number(id);
    if (this.useVlc) {
      vlc.vlcSetSubtitleTrack(Number.isFinite(want) ? want : -1);
      return;
    }
    const v = this.video;
    if (!v || !v.textTracks) return;
    for (let i = 0; i < v.textTracks.length; i++) {
      const t = v.textTracks[i];
      if (!t) continue;
      t.mode = i === want ? 'showing' : 'disabled';
    }
  }

  setUserMuted(muted) {
    this.userMuted = !!muted;
    this.applyMuteState();
  }

  /**
   * Clear browser autoplay mute after a user gesture.
   * Does not override an intentional user mute from the volume bar.
   */
  unlockSound() {
    if (!this.soundBlocked) return;
    this.soundBlocked = false;
    if (!this.userMuted && !(this.video.volume > 0)) this.video.volume = 1;
    this.applyMuteState();
    this.tryPlay();
    if (!this.userMuted) this.onState('unmuted');
  }

  /** A live stream that already played is retried on the same engine; otherwise the next candidate is tried. */
  /** Suppress transient mpegts errors caused by seek/pause/remount (keeps disk cache intact). */
  ignoreMediaErrors(ms = 2500) {
    this.ignoreErrorsUntil = Date.now() + Math.max(0, Number(ms) || 0);
  }

  /**
   * mpegts TSDemuxer logs sync_byte mismatches and keeps pumping — often without ERROR.
   * Leading garbage before the first 0x47 is common on working timeshift opens — suppress
   * the browser flood and only abort if demux never produces playable media.
   */
  watchTsSyncSpam(token) {
    this.clearTsSyncWatch();
    let hits = 0;
    let firstAt = 0;
    let aborted = false;
    const orig = console.error;
    this._tsSyncOrigError = orig;
    this._tsSyncToken = token;
    console.error = (...args) => {
      try {
        if (this._tsSyncToken === token && /sync_byte\s*=/.test(String(args[0] ?? args[1] ?? ''))) {
          hits += 1;
          if (!firstAt) {
            firstAt = Date.now();
            playerLog('engine.sync_byte', 'first mismatch (suppressing browser spam)', { token });
          } else if (hits === 25 || hits === 80 || hits % 200 === 0) {
            playerLog('engine.sync_byte', `hits=${hits}`, {
              token,
              ms: Date.now() - firstAt,
              hasPlayed: !!this.hasPlayed,
              readyState: this.video.readyState,
            });
          }
          // Do not forward to the browser console — floods freeze the tab.
          // Abort only when spam persists with no playable buffer (not on open/seek noise).
          if (!aborted && hits >= 100 && Date.now() - firstAt >= 6000 && !this.hasPlayed) {
            let buffered = 0;
            try {
              const v = this.video;
              if (v.buffered && v.buffered.length) {
                buffered = v.buffered.end(v.buffered.length - 1) - v.buffered.start(0);
              }
            } catch { /* ignore */ }
            if (buffered < 0.35 && this.video.readyState < 2) {
              aborted = true;
              playerLog('engine.sync_byte.abort', 'sustained mismatch, no media', {
                hits,
                buffered,
                ms: Date.now() - firstAt,
              });
              this.abortBadCatchupMedia(token);
            }
          }
          return;
        }
      } catch { /* ignore */ }
      return orig.apply(console, args);
    };
  }

  clearTsSyncWatch() {
    if (this._tsSyncOrigError) {
      console.error = this._tsSyncOrigError;
      this._tsSyncOrigError = null;
    }
    this._tsSyncToken = 0;
  }

  /**
   * Bad MPEG-TS (zeros / non-TS tip). Invalidate token + timers so a stale start
   * timeout cannot same-URL reconnect while the UI recovers with a new timeshift.
   */
  abortBadCatchupMedia(token) {
    if (token !== this.token) return;
    playerLog('engine.abortBadMedia', 'teardown for UI recover', {
      token,
      hasPlayed: !!this.hasPlayed,
      live: !!this.live,
    });
    this.clearTsSyncWatch();
    this.token++;
    clearTimeout(this.startTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.stableTimer);
    clearTimeout(this.seekDebounce);
    clearTimeout(this.stallTimer);
    clearInterval(this.drainTimer);
    this.reconnectTimer = null;
    this._badMediaAbort = true;
    // Stay paused so start-timeout / tryPlay cannot same-URL reconnect while UI recovers.
    this.pausedByUser = true;
    this.ignoreErrorsUntil = Date.now() + 4000;
    try { this.destroyImpl(); } catch { /* ignore */ }
    this.onState('catchup-bad-media');
  }

  streamFailed(reason) {
    if (this._badMediaAbort) {
      playerLog('engine.streamFailed.skip', reason, { why: 'badMedia' });
      return;
    }
    if (this.pausedByUser || Date.now() < this.ignoreErrorsUntil) {
      playerLog('engine.streamFailed.skip', reason, {
        why: this.pausedByUser ? 'paused' : 'ignoreErrors',
      });
      return;
    }
    playerLog('engine.streamFailed', reason, {
      live: !!this.live,
      hasPlayed: !!this.hasPlayed,
      prefetch: !!this.prefetch,
      reconnects: this.reconnects,
    });
    if (this.live && this.hasPlayed) this.reconnect(reason);
    else if (!this.live && this.hasPlayed) {
      // Pause/seek often aborts the media request — don't treat that as an archive gap.
      this.onState('catchup-gap');
    } else if (!this.live && this.transcode && !this.hasPlayed) {
      // Remux still starting — do not same-URL reconnect (kills ffmpeg mid-warm).
      playerLog('engine.streamFailed.hold', reason, { why: 'vod-remux-warm' });
    } else if (!this.live && this.prefetch && this.reconnects < 3) {
      // Cache file race / brief proxy blip on first open — retry same URL.
      // Never after sync_byte abort: that URL is poisoned (UI opens a new timeshift).
      this.reconnect(reason);
    } else this.fail(reason);
  }

  reconnectWhenDrained(token) {
    clearInterval(this.drainTimer);
    this.drainTimer = setInterval(() => {
      if (token !== this.token) {
        clearInterval(this.drainTimer);
        return;
      }
      const v = this.video;
      const end = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
      if (end - v.currentTime < 1.5) {
        clearInterval(this.drainTimer);
        this.reconnect('stream ended');
      }
    }, 500);
  }

  /**
   * Catch-up HTTP finished (or the cache slice ended). Prefetch files often keep growing —
   * refill before the playhead hits the wall instead of buffering for a long underrun.
   * Non-prefetch: once MSE drains, ask the UI to skip the archive gap.
   */
  catchupWhenDrained(token) {
    clearInterval(this.drainTimer);
    this.drainTimer = setInterval(() => {
      if (token !== this.token) {
        clearInterval(this.drainTimer);
        return;
      }
      if (this.pausedByUser) return;
      const v = this.video;
      let end = 0;
      try {
        if (v.buffered && v.buffered.length) end = v.buffered.end(v.buffered.length - 1);
      } catch { /* ignore */ }
      const ahead = end - (v.currentTime || 0);
      if (this.prefetch) {
        // Ask UI to continue from the playhead once we're nearly dry — not from file start.
        if (ahead < 4) {
          clearInterval(this.drainTimer);
          this.onState('catchup-refill');
        }
        return;
      }
      if (ahead < 1.2) {
        clearInterval(this.drainTimer);
        this.onState('catchup-gap');
      }
    }, 400);
  }

  reconnect(reason) {
    // Same poisoned timeshift URL after sync_byte abort — never loop reconnect.
    if (this._badMediaAbort || this.pausedByUser) {
      playerLog('engine.reconnect.skip', reason, {
        badMedia: !!this._badMediaAbort,
        pausedByUser: !!this.pausedByUser,
      });
      return;
    }
    if (this.reconnectTimer) return;
    if (this.reconnects >= MAX_RECONNECTS) {
      this.fail(`${reason} (gave up after ${MAX_RECONNECTS} reconnects)`);
      return;
    }
    this.reconnects++;
    playerLog('engine.reconnect', reason, { n: this.reconnects, live: !!this.live });
    const token = ++this.token;
    clearTimeout(this.startTimer);
    this.onState('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (token === this.token) this.start({ reconnecting: true });
    }, Math.min(500 * this.reconnects, 4000));
  }

  fail(reason) {
    playerLog('engine.fail', reason, {
      index: this.index,
      candidates: this.candidates.length,
      live: !!this.live,
    });
    this.index++;
    this.hasPlayed = false;
    if (this.index < this.candidates.length) this.start();
    else {
      clearTimeout(this.startTimer);
      this.destroyImpl();
      this.onState('error');
    }
  }

  get paused() {
    if (this.useVlc) return this.pausedByUser || !vlc.vlcIsPlaying();
    return this.pausedByUser || this.video.paused;
  }

  position() {
    if (this.pendingSeek != null) return this.pendingSeek;
    if (this.useVlc) {
      const t = Math.max(0, vlc.vlcGetTime());
      // Resume / open-at-offset: keep UI on the intended time until native Time= lands
      // (VLC often reports t=0 for several seconds after open.seek on large offsets).
      const hold = Number(this.hold) || 0;
      if (hold > 0.4 && t < hold - 1.5) {
        const softUntil = this._holdUiUntil || 0;
        const hardUntil = softUntil ? softUntil + 25000 : 0;
        // Within the soft window, or still stuck near 0 while seeking — show hold.
        if ((softUntil && Date.now() < softUntil)
            || (t < 1 && hardUntil && Date.now() < hardUntil)) {
          return hold;
        }
      }
      return t;
    }
    return Math.max(0, (this.seekOffset || 0) + (this.video.currentTime || 0));
  }

  duration() {
    if (this.useVlc) {
      const len = vlc.vlcGetLength();
      if (len > 1) this.knownDuration = Math.max(this.knownDuration || 0, len);
      return this.knownDuration || 0;
    }
    // Remuxed/fragmented MP4 reports only buffered length; keep the real duration from the API.
    const trustVideo = !this.transcode && !(this.impl && this.impl.type === 'mse');
    const fromVideo = this.video.duration;
    if (trustVideo && Number.isFinite(fromVideo) && fromVideo > 1) {
      this.knownDuration = Math.max(this.knownDuration || 0, fromVideo);
    }
    return this.knownDuration || 0;
  }

  hasBuffered(rel) {
    const v = this.video;
    if (!v || rel < 0 || !v.buffered || !v.buffered.length) return false;
    try {
      for (let i = 0; i < v.buffered.length; i++) {
        if (rel >= v.buffered.start(i) && rel <= v.buffered.end(i) - 0.15) return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  seek(seconds) {
    const dur = this.duration();
    const target = Math.max(0, dur ? Math.min(dur - 0.25, seconds) : Math.max(0, seconds));
    playerLog('engine.seek', '', {
      target,
      live: !!this.live,
      pos: this.position(),
      hasPlayed: !!this.hasPlayed,
      pending: this.pendingSeek,
      vlc: !!this.useVlc,
      transcode: !!this.transcode,
    });
    if (this.useVlc) {
      this.pausedByUser = false;
      this.hold = target;
      this._holdUiUntil = Date.now() + 4000;
      this.pendingSeek = null;
      vlc.vlcSeek(target);
      vlc.vlcPlay();
      return 'local';
    }
    // Live: allow seeks inside the retained MSE behind-buffer (instant replay).
    if (this.live) {
      if (this.hasBuffered(target)) {
        this.pausedByUser = false;
        clearTimeout(this.seekDebounce);
        this.pendingSeek = null;
        try { this.video.currentTime = target; } catch { /* ignore */ }
        this.tryPlay();
        return 'local';
      }
      return 'live';
    }
    this.pausedByUser = false;
    this.hold = target;

    // Already coalescing a hard seek — only update the target (one stream reopen).
    if (this.seekDebounce || this.pendingSeek != null) {
      this.scheduleHardSeek(target);
      return 'network';
    }

    // Native progressive: soft seek when the time is already buffered.
    if (!this.transcode) {
      if (this.hasBuffered(target) && this.video.readyState >= 2) {
        clearTimeout(this.seekDebounce);
        this.pendingSeek = null;
        try { this.video.currentTime = target; } catch { /* ignore */ }
        this.tryPlay();
        return 'local';
      }
      // Past buffered lead (or still warming) — one debounced currentTime jump
      // so Range requests are not spammed while the user is bursting FF.
      this.scheduleHardSeek(target, { native: true });
      return 'network';
    }

    // Remux / MSE: soft seek inside the converted window.
    const rel = target - (this.seekOffset || 0);
    if (
      this.convertAhead
      && rel >= 0
      && this.hasBuffered(rel)
      && (this.video.readyState >= 2 || (this.impl && this.impl.type === 'mse'))
    ) {
      clearTimeout(this.seekDebounce);
      this.pendingSeek = null;
      try { this.video.currentTime = rel; } catch { /* ignore */ }
      this.tryPlay();
      return 'local';
    }
    // Past remux window — reopen stream at ss=target (coalesced).
    this.scheduleHardSeek(target);
    return 'network';
  }

  /**
   * Coalesce hard VOD seeks: freeze UI on the latest target, cancel any in-flight
   * same-URL reconnect, and reopen (or native-jump) once after a short idle.
   */
  scheduleHardSeek(target, { native = false } = {}) {
    this.pendingSeek = target;
    this.hold = target;
    this.freezeFrame();
    clearTimeout(this.seekDebounce);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.onState('reconnecting');
    this.seekDebounce = setTimeout(() => {
      this.seekDebounce = null;
      const t = this.pendingSeek != null ? this.pendingSeek : target;
      if (native && !this.transcode) {
        this.pendingSeek = null;
        this.seekOffset = 0;
        try { this.video.currentTime = t; } catch { /* ignore */ }
        this.tryPlay();
        return;
      }
      // Same target already opening — keep it; playing handler applies a newer pendingSeek.
      if (
        Math.abs((this.seekOffset || 0) - t) < 0.75
        && !this.hasPlayed
        && this.impl
      ) {
        playerLog('engine.seek.retarget', 'same-ss', { target: t });
        return;
      }
      this.reconnectAt(t);
    }, VOD_SEEK_DEBOUNCE_MS);
  }

  reconnectAt(seconds) {
    const ss = Math.max(0, Number(seconds) || 0);
    // If a newer hard-seek target arrived while we were opening, prefer that.
    const latest = this.pendingSeek != null ? this.pendingSeek : ss;
    this.pendingSeek = null;
    this.seekOffset = Math.max(0, Number(latest) || 0);
    this.startAt = this.seekOffset;
    this.hold = this.seekOffset;
    this.hasPlayed = false;
    this.reconnects = 0;
    this.index = 0;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    clearTimeout(this.seekDebounce);
    this.seekDebounce = null;
    playerLog('engine.reconnectAt', '', { ss: this.seekOffset, transcode: !!this.transcode });
    this.start({ reconnecting: true });
  }

  pause() {
    this.pausedByUser = true;
    this.hold = this.position();
    playerLog('engine.pause', '', { hold: this.hold, live: !!this.live, vlc: !!this.useVlc });
    if (this.useVlc) {
      vlc.vlcPause();
      this.onState('paused');
      return;
    }
    this.ignoreMediaErrors(5000);
    clearTimeout(this.stallTimer);
    this.video.pause();
  }

  resume() {
    playerLog('engine.resume', '', { live: !!this.live, hold: this.hold || this.position(), vlc: !!this.useVlc });
    if (this.useVlc) {
      this.pausedByUser = false;
      vlc.vlcPlay();
      this.onState('playing');
      return;
    }
    if (this.live) {
      this.pausedByUser = false;
      this.unlockSound(); // no-op unless autoplay-blocked; respects userMuted
      this.tryPlay();
      return;
    }
    const t = this.hold || this.position();
    this.pausedByUser = false;
    this.ignoreMediaErrors(2500);
    if (!this.transcode || (this.impl && this.impl.type === 'mse')) {
      this.tryPlay();
      return;
    }
    const rel = t - (this.seekOffset || 0);
    if (this.convertAhead && rel >= 0 && this.hasBuffered(rel) && this.video.readyState >= 2 && !this.video.error) {
      this.tryPlay();
      clearTimeout(this.stallTimer);
      const token = this.token;
      this.stallTimer = setTimeout(() => {
        if (token !== this.token || this.pausedByUser) return;
        if (this.video.paused || this.video.readyState < 2) this.reconnectAt(t);
      }, 400);
      return;
    }
    this.seek(t);
  }

  /** Copies the current picture onto the still canvas, which covers the video until revealVideo(). */
  freezeFrame() {
    const v = this.video;
    const c = this.still;
    if (!c || v.readyState < 2 || !v.videoWidth) return;
    try {
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      c.classList.add('show');
    } catch {
      /* frame not drawable */
    }
  }

  revealVideo() {
    const c = this.still;
    if (!c || !c.classList.contains('show')) return;
    const hide = () => c.classList.remove('show');
    if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(hide);
    else setTimeout(hide, 150);
  }

  destroyImpl() {
    clearInterval(this.drainTimer);
    this.clearTsSyncWatch();
    const impl = this.impl;
    this.impl = null;
    if (!impl) return;
    this.freezeFrame();
    // mpegts aborts its fetch on unload; that rejects asynchronously (AbortError /
    // null.length after SourceBuffer teardown). Swallow so recover is not poisoned.
    this.ignoreMediaErrors(1500);
    const swallowAbort = (e) => {
      const r = e.reason;
      const msg = r && (r.message || r._message || String(r));
      if (
        r
        && (r.name === 'AbortError'
          || /aborted/i.test(String(msg || ''))
          || /null \(reading ['"]length['"]\)/i.test(String(msg || '')))
      ) {
        e.preventDefault();
      }
    };
    window.addEventListener('unhandledrejection', swallowAbort);
    try {
      if (impl.type === 'ts') {
        try { impl.player.pause(); } catch { /* ignore */ }
        try {
          const unloaded = impl.player.unload();
          if (unloaded && typeof unloaded.catch === 'function') unloaded.catch(() => {});
        } catch { /* ignore */ }
        try { impl.player.detachMediaElement(); } catch { /* ignore */ }
        try { impl.player.destroy(); } catch { /* ignore */ }
      } else if (impl.type === 'hls') {
        impl.player.destroy();
      } else if (impl.type === 'mse') {
        try { impl.abort.abort(); } catch { /* ignore */ }
        try { URL.revokeObjectURL(impl.objectUrl); } catch { /* ignore */ }
      }
    } catch (err) {
      console.warn('player cleanup failed', err);
    }
    this.video.removeAttribute('src');
    try { this.video.playbackRate = 1; } catch { /* ignore */ }
    try {
      this.video.load();
    } catch {
      /* ignore */
    }
    setTimeout(() => window.removeEventListener('unhandledrejection', swallowAbort), 500);
  }

  stop() {
    playerLog('engine.stop', '', { live: !!this.live, hasPlayed: !!this.hasPlayed, vlc: !!this.useVlc });
    this.token++;
    clearTimeout(this.startTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.stableTimer);
    clearTimeout(this.seekDebounce);
    clearTimeout(this.stallTimer);
    clearInterval(this.drainTimer);
    this.reconnectTimer = null;
    this.pendingSeek = null;
    this.hasPlayed = false;
    if (this.useVlc) {
      try { vlc.vlcStop(); } catch { /* ignore */ }
      if (this._vlcUnsub) {
        try { this._vlcUnsub(); } catch { /* ignore */ }
        this._vlcUnsub = null;
      }
      this.useVlc = false;
      vlc.setHtmlVideoHidden(this.video, false);
    }
    this.destroyImpl();
    this.onState('stopped');
  }
}
