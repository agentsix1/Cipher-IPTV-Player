/**
 * Catch-up MSE decision policy (pure). Shared by the player and eval scripts.
 *
 * Goals:
 * - Keep a smooth stream (do not remount/hard-seek while MSE is healthy).
 * - Maintain a ~2 minute behind + ~2 minute ahead quick-seek window in MSE.
 * - Soft-refill only on true underrun with disk still ahead.
 * - Hard-seek only when the target is past what disk/window already covers.
 */

export const MIN = 60_000;
export const LIVE_EDGE_MS = 15_000;
/** Desired quick-seek cushion ahead of / behind the playhead. */
export const MSE_ROLL_KEEP_MS = 2 * MIN;
/**
 * Remount only when the tip is this close and not growing.
 * Remounting earlier destroys the 2-minute behind window and causes buffering.
 */
export const MSE_UNDERRUN_MS = 12_000;
export const MSE_LOCAL_SLACK_MS = 8_000;

/**
 * @typedef {'none'|'local_seek'|'soft_refill'|'hard_seek'|'go_live'} MseAction
 *
 * @typedef {{
 *   mode: 'catchup'|'live'|string,
 *   streamBase: number,
 *   pos: number,
 *   mseStart?: number,
 *   mseEnd: number,
 *   cachedUntil: number,
 *   windowEnd?: number,
 *   now?: number,
 *   tipGrowing?: boolean,
 *   nearLive?: boolean,
 *   prefetch?: boolean,
 *   settleActive?: boolean,
 * }} MseState
 */

/** Wall-clock ms still ahead of the playhead inside MSE. */
export function mseAheadMs(state) {
  return Math.max(0, (state.mseEnd || 0) - (state.pos || 0));
}

/** Wall-clock ms of MSE retained behind the playhead. */
export function mseBehindMs(state) {
  const start = state.mseStart != null ? state.mseStart : (state.streamBase || 0);
  return Math.max(0, (state.pos || 0) - start);
}

/** True when target is inside the current MSE buffered range (quick-seek window). */
export function inMseBuffer(state, targetMs) {
  const start = state.mseStart != null ? state.mseStart : (state.streamBase || 0);
  const end = Math.max(start, (state.mseEnd || start) - 250);
  return targetMs >= start - 250 && targetMs <= end + MSE_LOCAL_SLACK_MS;
}

/** Ideal ±2 minute quick-seek window clamped to what MSE currently holds. */
export function quickSeekWindow(state) {
  const pos = Math.max(state.pos || 0, state.streamBase || 0);
  const mseStart = state.mseStart != null ? state.mseStart : (state.streamBase || 0);
  const mseEnd = Math.max(mseStart, state.mseEnd || mseStart);
  return {
    start: Math.max(mseStart, pos - MSE_ROLL_KEEP_MS),
    end: Math.min(mseEnd, pos + MSE_ROLL_KEEP_MS),
    mseStart,
    mseEnd,
    keepMs: MSE_ROLL_KEEP_MS,
  };
}

/**
 * New timeshift origin when rebasing around the playhead: ~2 minutes behind,
 * minute-aligned, not before `earliest`.
 */
export function rebaseWindowStart(posMs, earliestMs = 0) {
  const pos = Math.max(0, Number(posMs) || 0);
  let start = Math.floor((pos - MSE_ROLL_KEEP_MS) / MIN) * MIN;
  if (start < earliestMs) start = Math.floor(earliestMs / MIN) * MIN;
  if (start < 0) start = 0;
  return start;
}

/** Resume point for a rebased window — never before the window start. */
export function rebaseResumeAt(posMs, windowStartMs) {
  return Math.max(Number(windowStartMs) || 0, Number(posMs) || 0);
}

/**
 * Plan a hard timeshift reopen.
 * - HTML/MSE: window origin ~2 minutes behind resume so ±2m soft seek works after landing.
 * - Native VLC (`nativeVlc`): open at the resume minute — no lead buffer to download.
 *
 * @returns {{ start: number, resume: number }}
 */
export function planHardSeekWindow(targetMs, earliestMs = 0, currentBaseMs = 0, nowMs = Date.now(), opts = {}) {
  const nativeVlc = !!(opts && opts.nativeVlc);
  const liveEdge = nowMs - LIVE_EDGE_MS;
  let resume = Math.min(liveEdge, Math.max(0, Number(targetMs) || 0));
  const earliest = Math.max(0, Number(earliestMs) || 0);
  if (resume < earliest) resume = earliest;
  let start = nativeVlc
    ? Math.floor(resume / MIN) * MIN
    : rebaseWindowStart(resume, earliest);
  if (start < earliest) start = Math.floor(earliest / MIN) * MIN;
  if (start < 0) start = 0;
  const cur = Number(currentBaseMs) || 0;
  if (cur > 0 && Math.abs(start - cur) < 1000) {
    const alt = Math.floor(resume / MIN) * MIN;
    if (Math.abs(alt - cur) >= 1000 && alt >= earliest) start = alt;
    else {
      // Must change origin minute — prefer stepping toward the seek direction.
      const forward = resume >= cur;
      start = forward ? cur + MIN : Math.max(earliest, cur - MIN);
      start = Math.floor(start / MIN) * MIN;
    }
  }
  if (start > resume) start = Math.floor(resume / MIN) * MIN;
  if (start < earliest) start = Math.floor(earliest / MIN) * MIN;
  if (start < 0) start = 0;
  resume = rebaseResumeAt(resume, start);
  return { start, resume };
}

/** True when prefetch disk already covers the target. */
export function onDisk(state, targetMs) {
  if (!state.prefetch) return false;
  const base = state.streamBase || 0;
  if (targetMs < base) return false;
  return targetMs <= (state.cachedUntil || base) - 500;
}

/**
 * Playback tick: protect the ±2 minute MSE window.
 * - Healthy / still appending → none (smooth playback).
 * - Soft-refill only on underrun with disk ahead (loader stuck).
 * - Hard-seek only when disk cannot cover and the archive window continues.
 */
export function decideRollAction(state) {
  if (state.mode !== 'catchup' || !state.prefetch || !state.streamBase) return 'none';
  if (state.settleActive) return 'none';

  const ahead = mseAheadMs(state);
  // 2+ minutes buffered ahead — leave the stream alone.
  if (ahead >= MSE_ROLL_KEEP_MS) return 'none';

  const now = state.now || Date.now();
  if (state.nearLive && ahead < 8000) return 'go_live';

  const diskAhead = (state.cachedUntil || 0) > (state.mseEnd || 0) + 2000;
  const tipGrowing = !!state.tipGrowing;

  // Still building or holding a usable cushion — remounting would wipe RW history.
  if (tipGrowing || ahead >= MSE_UNDERRUN_MS) return 'none';

  // True underrun risk and disk still has media → soft same-URL refill once.
  if (diskAhead) return 'soft_refill';

  // No more disk in this window, but air/window continues — hard-seek as last resort.
  const available = Math.min(
    now - LIVE_EDGE_MS,
    state.windowEnd || now,
    Math.max(state.cachedUntil || 0, state.windowEnd || 0),
  );
  if (
    ahead < MSE_UNDERRUN_MS
    && available > (state.mseEnd || 0) + 5000
    && available >= (state.pos || 0) + MSE_ROLL_KEEP_MS - 15000
  ) {
    return 'hard_seek';
  }

  if (ahead <= 5000 && state.nearLive) return 'go_live';
  return 'none';
}

/**
 * User seek: local inside MSE quick-seek window, soft refill on disk past MSE,
 * hard-seek only past disk.
 */
export function decideSeekAction(state, targetMs) {
  if (state.mode !== 'catchup' || !state.streamBase) return 'hard_seek';

  if (inMseBuffer(state, targetMs)) return 'local_seek';
  if (onDisk(state, targetMs)) return 'soft_refill';
  return 'hard_seek';
}

/**
 * Classify whether an action is allowed under the smooth-stream + window rule.
 */
export function assertActionAllowed(kind, state, targetMs, action) {
  const roll = kind === 'tick' ? decideRollAction(state) : decideSeekAction(state, targetMs);
  if (action !== roll) {
    return { ok: false, expected: roll, got: action, reason: 'action mismatch' };
  }
  if (action === 'hard_seek') {
    const ahead = mseAheadMs(state);
    if (kind === 'tick' && (state.cachedUntil || 0) > (state.mseEnd || 0) + 2000 && ahead < MSE_UNDERRUN_MS) {
      return { ok: false, expected: 'soft_refill', got: action, reason: 'hard-seek while disk ahead on underrun' };
    }
    if (kind === 'seek' && (inMseBuffer(state, targetMs) || onDisk(state, targetMs))) {
      return {
        ok: false,
        expected: inMseBuffer(state, targetMs) ? 'local_seek' : 'soft_refill',
        got: action,
        reason: 'hard-seek while local/disk covers target',
      };
    }
  }
  if (kind === 'tick' && action === 'soft_refill' && (state.tipGrowing || mseAheadMs(state) >= MSE_UNDERRUN_MS)) {
    return { ok: false, expected: 'none', got: action, reason: 'soft-refill while window still healthy' };
  }
  return { ok: true, expected: roll, got: action };
}
