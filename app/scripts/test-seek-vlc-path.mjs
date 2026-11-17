/**
 * Regression: VLC catch-up seeks must hard-seek (new timeshift URL), not Time=.
 * Reproduces the windowEnd "tip" bug from player-debug.log (2026-10-21).
 */
const MIN = 60_000;
const LIVE_EDGE_MS = 15_000;

function alignCatchupMinute(ms) {
  return Math.floor(Number(ms) / MIN) * MIN;
}

/** Old broken tip check (must NOT be used). */
function oldWouldVlcTime({ clamped, streamBase, windowEnd, durationSec, mediaPosMs }) {
  const tip = Math.max(
    windowEnd || 0,
    streamBase + (durationSec || 0) * 1000,
    mediaPosMs + 3 * MIN,
  );
  return streamBase > 0 && clamped >= streamBase && clamped <= tip + MIN;
}

/** New decision for seekCatchupVlc (mirrors player.js). */
function newDecision({ clamped, from, now = Date.now() }) {
  if (clamped >= now - LIVE_EDGE_MS) return 'goLive';
  if (Math.abs(from - clamped) < 2500) return 'vlcAlreadyThere';
  return 'vlcHardSeek';
}

const streamBase = 1_792_555_320_000;
const windowEnd = 1_792_600_200_000; // hours ahead — old tip used this
const cases = [
  {
    name: '+1m from ~16s into open window (log 07:38:40)',
    from: streamBase + 16_485,
    target: streamBase + 240_000,
  },
  {
    name: '+4m burst commit (log 07:38:44)',
    from: streamBase + 22_158,
    target: streamBase + 480_000,
  },
  {
    name: 'scrub back to stream start while mid-window',
    from: streamBase + 300_000,
    target: streamBase,
  },
  {
    name: 'no-op when already on target minute',
    from: streamBase + 800,
    target: streamBase,
  },
];

let failed = 0;
for (const c of cases) {
  const clamped = alignCatchupMinute(c.target);
  const old = oldWouldVlcTime({
    clamped,
    streamBase,
    windowEnd,
    durationSec: 44_880,
    mediaPosMs: c.from,
  });
  const next = newDecision({ clamped, from: c.from, now: streamBase + 3_600_000 });
  const expectHard = Math.abs(c.from - clamped) >= 2500;
  const ok = expectHard ? next === 'vlcHardSeek' : next === 'vlcAlreadyThere';
  if (!ok || (expectHard && !old)) {
    // expectHard && !old would mean old path was already correct; still require new ok
  }
  if (!ok) {
    failed += 1;
    console.error('FAIL', c.name, { clamped, from: c.from, oldWouldVlcTime: old, new: next });
  } else {
    console.log('ok', c.name, { oldWouldVlcTime: old, new: next });
  }
  if (expectHard && !old) {
    console.warn('  note: old path would not have used vlcTime for this case');
  }
  if (expectHard && old) {
    console.log('  (old bug would have taken dead vlcTime path)');
  }
}

if (failed) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}
console.log('\nAll seek path cases passed');
