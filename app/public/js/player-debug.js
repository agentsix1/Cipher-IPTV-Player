/**
 * Client debug pipeline: batches events to POST /api/player-debug (file + server console),
 * keeps a ring buffer for the on-screen overlay, and captures uncaught errors.
 *
 * Toggle overlay: Ctrl+Shift+D, or Settings → Show debug overlay.
 * Logs land in the data dir as player-debug.log (desktop: %LocalAppData%\Cipher\data\ or <exe>\data\).
 */

const SESSION_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const FLUSH_MS = 350;
const FLUSH_AT = 16;
const RING_MAX = 200;
const OVERLAY_STORE_KEY = 'debug.overlay';

let queue = [];
let timer = null;
let seq = 0;
const ring = [];
let overlayEl = null;
let overlayBody = null;
let overlayOn = false;
let installed = false;

function scheduleFlush() {
  if (timer != null) return;
  timer = setTimeout(flush, FLUSH_MS);
}

export function playerDebugSession() {
  return SESSION_ID;
}

export function getRecentDebugEvents(limit = 80) {
  const n = Math.max(1, Math.min(RING_MAX, Number(limit) || 80));
  return ring.slice(-n);
}

/**
 * @param {string} tag short action id (e.g. seek, play, guide.preview)
 * @param {string} [msg]
 * @param {object} [data]
 * @param {{ level?: 'info'|'warn'|'error' }} [opts]
 */
export function playerLog(tag, msg = '', data = null, opts = {}) {
  seq += 1;
  const level = opts.level === 'warn' || opts.level === 'error' ? opts.level : 'info';
  const event = {
    t: Date.now(),
    n: seq,
    tag: String(tag || 'event'),
    msg: msg == null ? '' : String(msg),
    data: data == null ? null : data,
    level,
  };
  queue.push(event);
  ring.push(event);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  paintOverlay();
  mirrorToHost(event);
  if (queue.length >= FLUSH_AT) flush();
  else scheduleFlush();
}

export function flushPlayerLog() {
  flush();
}

function flush() {
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
  if (!queue.length) return;
  const events = queue;
  queue = [];
  const body = JSON.stringify({ sessionId: SESSION_ID, events });
  try {
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      const ok = navigator.sendBeacon('/api/player-debug', new Blob([body], { type: 'application/json' }));
      if (ok) return;
    }
  } catch { /* fall through */ }
  try {
    fetch('/api/player-debug', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch { /* ignore */ }
}

function mirrorToHost(event) {
  try {
    const n = window.XsNative;
    if (!n || typeof n.hostLog !== 'function') return;
    const line = `${event.tag}${event.msg ? `: ${event.msg}` : ''}`;
    n.hostLog(String(event.level || 'info'), line);
  } catch { /* host may be busy */ }
}

function readOverlayPref() {
  try {
    return localStorage.getItem(OVERLAY_STORE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeOverlayPref(on) {
  try {
    localStorage.setItem(OVERLAY_STORE_KEY, on ? '1' : '0');
  } catch { /* ignore */ }
}

export function isDebugOverlayOn() {
  return overlayOn;
}

export function setDebugOverlay(on) {
  overlayOn = !!on;
  writeOverlayPref(overlayOn);
  ensureOverlayDom();
  if (overlayEl) overlayEl.hidden = !overlayOn;
  if (overlayOn) paintOverlay();
  playerLog('debug.overlay', overlayOn ? 'on' : 'off');
}

export function toggleDebugOverlay() {
  setDebugOverlay(!overlayOn);
  return overlayOn;
}

function ensureOverlayDom() {
  if (overlayEl || typeof document === 'undefined') return;
  overlayEl = document.createElement('div');
  overlayEl.id = 'debug-overlay';
  overlayEl.hidden = !overlayOn;
  overlayEl.innerHTML = `
    <div class="debug-overlay-head">
      <strong>Debug</strong>
      <span class="debug-overlay-sid"></span>
      <button type="button" class="debug-overlay-copy" title="Copy recent lines">Copy</button>
      <button type="button" class="debug-overlay-close" title="Hide (Ctrl+Shift+D)">×</button>
    </div>
    <pre class="debug-overlay-body"></pre>
    <div class="debug-overlay-foot">Ctrl+Shift+D · logs → player-debug.log</div>
  `;
  overlayBody = overlayEl.querySelector('.debug-overlay-body');
  const sid = overlayEl.querySelector('.debug-overlay-sid');
  if (sid) sid.textContent = SESSION_ID;
  overlayEl.querySelector('.debug-overlay-close')?.addEventListener('click', () => setDebugOverlay(false));
  overlayEl.querySelector('.debug-overlay-copy')?.addEventListener('click', () => {
    const text = getRecentDebugEvents(120).map(formatLine).join('\n');
    try {
      navigator.clipboard?.writeText(text);
      playerLog('debug.copy', `${text.split('\n').length} lines`);
    } catch {
      playerLog('debug.copy', 'clipboard failed', null, { level: 'warn' });
    }
  });
  document.body.append(overlayEl);
}

function formatLine(ev) {
  const ts = new Date(ev.t).toISOString().slice(11, 23);
  const lvl = (ev.level || 'info').toUpperCase().padEnd(5);
  const msg = ev.msg ? ` ${ev.msg}` : '';
  let data = '';
  if (ev.data != null) {
    try {
      data = ` ${JSON.stringify(ev.data)}`;
      if (data.length > 180) data = `${data.slice(0, 180)}…`;
    } catch {
      data = ' {_unserializable}';
    }
  }
  return `${ts} ${lvl} ${ev.tag}${msg}${data}`;
}

function paintOverlay() {
  if (!overlayOn || !overlayBody) return;
  const lines = getRecentDebugEvents(60).map(formatLine);
  overlayBody.textContent = lines.join('\n');
  overlayBody.scrollTop = overlayBody.scrollHeight;
}

function safeErrorData(err, extra = null) {
  const out = {
    name: err && err.name,
    message: err && (err.message || String(err)),
    stack: err && err.stack ? String(err.stack).slice(0, 1200) : null,
  };
  if (extra && typeof extra === 'object') Object.assign(out, extra);
  return out;
}

/** Install global handlers once (safe to call multiple times). */
export function installDebugSystem() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  overlayOn = readOverlayPref();
  ensureOverlayDom();
  if (overlayEl) overlayEl.hidden = !overlayOn;

  window.addEventListener('error', (e) => {
    playerLog('ui.error', e.message || 'uncaught', safeErrorData(e.error, {
      source: e.filename,
      line: e.lineno,
      col: e.colno,
    }), { level: 'error' });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    playerLog('ui.unhandledrejection', reason && reason.message ? reason.message : String(reason),
      safeErrorData(reason && typeof reason === 'object' ? reason : { message: String(reason) }),
      { level: 'error' });
  });

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
      e.preventDefault();
      toggleDebugOverlay();
    }
  });

  playerLog('debug.boot', 'client session', {
    session: SESSION_ID,
    href: location.href,
    ua: navigator.userAgent.slice(0, 160),
    hasXsNative: !!(window.XsNative && (typeof window.XsNative.hasVlc === 'function' || typeof window.XsNative.vlcOpen === 'function')),
    overlay: overlayOn,
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}
