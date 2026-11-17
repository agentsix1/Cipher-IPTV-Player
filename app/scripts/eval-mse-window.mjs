/**
 * Eval: catch-up MSE policy — local/soft preferred, hard-seek only past disk.
 * Runs several randomized passes and a fixed scenario suite.
 *
 * Usage: node scripts/eval-mse-window.mjs [--runs=5]
 */
import {
  MIN,
  MSE_ROLL_KEEP_MS,
  MSE_UNDERRUN_MS,
  LIVE_EDGE_MS,
  decideRollAction,
  decideSeekAction,
  assertActionAllowed,
  inMseBuffer,
  onDisk,
  quickSeekWindow,
  rebaseWindowStart,
  rebaseResumeAt,
  planHardSeekWindow,
} from '../public/js/mse-policy.mjs';

const RUNS = Math.max(1, Number((process.argv.find((a) => a.startsWith('--runs=')) || '--runs=5').split('=')[1]) || 5);
const MIN_MS = MIN;

function baseState(over = {}) {
  const now = over.now || Date.now();
  const streamBase = over.streamBase ?? (now - 30 * MIN_MS);
  const pos = over.pos ?? (streamBase + 60_000);
  return {
    mode: 'catchup',
    streamBase,
    pos,
    mseStart: over.mseStart ?? Math.max(streamBase, pos - MSE_ROLL_KEEP_MS),
    mseEnd: over.mseEnd ?? (streamBase + 180_000),
    cachedUntil: streamBase + 20 * MIN_MS,
    windowEnd: streamBase + 60 * MIN_MS,
    now,
    tipGrowing: false,
    nearLive: false,
    prefetch: true,
    settleActive: false,
    ...over,
  };
}

/** Fixed cases: expected action must match. */
function fixedCases() {
  const now = 1_700_000_000_000;
  const base = now - 30 * MIN_MS;
  return [
    {
      name: 'healthy ahead ≥2m → none',
      kind: 'tick',
      state: baseState({ now, streamBase: base, pos: base + 60_000, mseEnd: base + 60_000 + MSE_ROLL_KEEP_MS + 5_000, tipGrowing: true }),
      expect: 'none',
    },
    {
      name: 'tip growing, 100s ahead → none (no interrupt)',
      kind: 'tick',
      state: baseState({
        now, streamBase: base, pos: base + 60_000,
        mseEnd: base + 60_000 + 100_000, tipGrowing: true, cachedUntil: base + 40 * MIN_MS,
      }),
      expect: 'none',
    },
    {
      name: 'tip stalled, 90s ahead → none (keep window, no remount)',
      kind: 'tick',
      state: baseState({
        now, streamBase: base, pos: base + 60_000, mseStart: base + 60_000 - MSE_ROLL_KEEP_MS,
        mseEnd: base + 60_000 + 90_000, tipGrowing: false, cachedUntil: base + 40 * MIN_MS,
      }),
      expect: 'none',
    },
    {
      name: 'tip stalled under 2m but above underrun → none',
      kind: 'tick',
      state: baseState({
        now, streamBase: base, pos: base + 120_000, mseStart: base + 120_000 - MSE_ROLL_KEEP_MS,
        mseEnd: base + 120_000 + 50_000, tipGrowing: false, cachedUntil: base + 40 * MIN_MS,
      }),
      expect: 'none',
    },
    {
      name: 'true underrun + disk ahead → soft_refill',
      kind: 'tick',
      state: baseState({
        now, streamBase: base, pos: base + 120_000, mseStart: base + 120_000 - MSE_ROLL_KEEP_MS,
        mseEnd: base + 120_000 + Math.floor(MSE_UNDERRUN_MS / 2), tipGrowing: false, cachedUntil: base + 40 * MIN_MS,
      }),
      expect: 'soft_refill',
    },
    {
      name: 'quick window spans ~2m behind/ahead inside MSE',
      kind: 'window',
      state: baseState({
        now, streamBase: base, pos: base + 180_000,
        mseStart: base + 180_000 - MSE_ROLL_KEEP_MS,
        mseEnd: base + 180_000 + MSE_ROLL_KEEP_MS,
      }),
      expect: 'window',
    },
    {
      name: 'settle active → none',
      kind: 'tick',
      state: baseState({
        now, streamBase: base, pos: base + 120_000,
        mseEnd: base + 130_000, tipGrowing: false, settleActive: true, cachedUntil: base + 40 * MIN_MS,
      }),
      expect: 'none',
    },
    {
      name: 'seek mid-MSE → local_seek',
      kind: 'seek',
      target: base + 90_000,
      state: baseState({
        now, streamBase: base, pos: base + 60_000,
        mseStart: base + 30_000, mseEnd: base + 180_000,
      }),
      expect: 'local_seek',
    },
    {
      name: 'seek to MSE tip → local_seek (no hard-seek)',
      kind: 'seek',
      target: base + 175_000,
      state: baseState({
        now, streamBase: base, pos: base + 60_000,
        mseStart: base + 30_000, mseEnd: base + 180_000, cachedUntil: base + 40 * MIN_MS,
      }),
      expect: 'local_seek',
    },
    {
      name: 'seek past MSE onto disk → soft_refill',
      kind: 'seek',
      target: base + 250_000,
      state: baseState({
        now, streamBase: base, pos: base + 60_000,
        mseStart: base + 30_000, mseEnd: base + 180_000, cachedUntil: base + 40 * MIN_MS,
      }),
      expect: 'soft_refill',
    },
    {
      name: 'seek past disk → hard_seek',
      kind: 'seek',
      target: base + 50 * MIN_MS,
      state: baseState({
        now, streamBase: base, pos: base + 60_000,
        mseStart: base + 30_000, mseEnd: base + 180_000, cachedUntil: base + 10 * MIN_MS,
      }),
      expect: 'hard_seek',
    },
    {
      name: 'rewind inside MSE → local_seek',
      kind: 'seek',
      target: base + 70_000,
      state: baseState({
        now, streamBase: base, pos: base + 180_000,
        mseStart: base + 60_000, mseEnd: base + 300_000,
      }),
      expect: 'local_seek',
    },
    {
      name: 'rebase window starts ~2m behind playhead',
      kind: 'rebase',
      pos: base + 10 * MIN_MS + 45_000,
      earliest: base,
      // Absolute minute floor of (pos - 2m), not relative to streamBase.
      expectStart: Math.floor(((base + 10 * MIN_MS + 45_000) - MSE_ROLL_KEEP_MS) / MIN_MS) * MIN_MS,
    },
    {
      name: 'rebase resume stays on playhead',
      kind: 'rebase-resume',
      pos: base + 10 * MIN_MS + 45_000,
      start: Math.floor(((base + 10 * MIN_MS + 45_000) - MSE_ROLL_KEEP_MS) / MIN_MS) * MIN_MS,
      expectResume: base + 10 * MIN_MS + 45_000,
    },
    {
      name: 'hard-seek window opens ~2m behind target (soft MSE ready)',
      kind: 'hard-plan',
      target: base + 20 * MIN_MS + 30_000,
      earliest: base,
      currentBase: base + 5 * MIN_MS,
      now,
      expectStart: Math.floor(((base + 20 * MIN_MS + 30_000) - MSE_ROLL_KEEP_MS) / MIN_MS) * MIN_MS,
      expectResume: base + 20 * MIN_MS + 30_000,
    },
    {
      name: 'second hard-seek must change origin when plan equals current base',
      kind: 'hard-plan-step',
      target: base + 10 * MIN_MS + 10_000,
      earliest: base,
      // Current base already at the natural rebase start → must step away.
      currentBase: Math.floor(((base + 10 * MIN_MS + 10_000) - MSE_ROLL_KEEP_MS) / MIN_MS) * MIN_MS,
      now,
    },
    {
      name: 'seek past MSE after timeshift still soft when on disk',
      kind: 'seek',
      target: base + 12 * MIN_MS,
      state: baseState({
        now, streamBase: base, pos: base + 8 * MIN_MS,
        mseStart: base + 8 * MIN_MS - MSE_ROLL_KEEP_MS,
        mseEnd: base + 8 * MIN_MS + 40_000,
        cachedUntil: base + 40 * MIN_MS,
      }),
      expect: 'soft_refill',
    },
    {
      name: 'seek past disk after timeshift → hard_seek',
      kind: 'seek',
      target: base + 45 * MIN_MS,
      state: baseState({
        now, streamBase: base + 10 * MIN_MS, pos: base + 12 * MIN_MS,
        mseStart: base + 12 * MIN_MS - MSE_ROLL_KEEP_MS,
        mseEnd: base + 12 * MIN_MS + 50_000,
        cachedUntil: base + 20 * MIN_MS,
      }),
      expect: 'hard_seek',
    },
    // Browser repro: spam +1m past MSE tip (progress bar / button) while disk still covers.
    {
      name: '+1m spam past MSE tip onto disk → soft_refill',
      kind: 'seek',
      target: base + 180_000 + 60_000,
      state: baseState({
        now, streamBase: base, pos: base + 180_000 - 5_000,
        mseStart: base + 30_000, mseEnd: base + 180_000,
        cachedUntil: base + 40 * MIN_MS,
      }),
      expect: 'soft_refill',
    },
    {
      name: 'progress-bar scrub past MSE onto disk → soft_refill',
      kind: 'seek',
      target: base + 10 * MIN_MS,
      state: baseState({
        now, streamBase: base, pos: base + 2 * MIN_MS,
        mseStart: base + 60_000, mseEnd: base + 3 * MIN_MS,
        cachedUntil: base + 30 * MIN_MS,
      }),
      expect: 'soft_refill',
    },
    {
      name: 'progress-bar scrub past disk → hard_seek (not soft remount)',
      kind: 'seek',
      target: base + 35 * MIN_MS,
      state: baseState({
        now, streamBase: base, pos: base + 2 * MIN_MS,
        mseStart: base + 60_000, mseEnd: base + 3 * MIN_MS,
        cachedUntil: base + 8 * MIN_MS,
      }),
      expect: 'hard_seek',
    },
    {
      name: 'three rapid +1m steps past tip stay soft while on disk',
      kind: 'seek-chain',
      steps: [
        { from: base + 170_000, to: base + 230_000 },
        { from: base + 230_000, to: base + 290_000 },
        { from: base + 290_000, to: base + 350_000 },
      ],
      state: baseState({
        now, streamBase: base, pos: base + 170_000,
        mseStart: base + 30_000, mseEnd: base + 180_000,
        cachedUntil: base + 40 * MIN_MS,
      }),
      expectEach: 'soft_refill',
    },
  ];
}

function randInt(n) {
  return Math.floor(Math.random() * n);
}

/** Randomized fuzz: policy must never hard-seek when local/disk covers the target. */
function fuzzCase(seedTag) {
  const now = 1_700_000_000_000 + randInt(1_000_000);
  const streamBase = now - (10 + randInt(50)) * MIN_MS;
  const posOff = randInt(8 * MIN_MS);
  const mseExtra = 30_000 + randInt(4 * MIN_MS);
  const diskExtra = mseExtra + randInt(30 * MIN_MS);
  const pos = streamBase + posOff;
  const mseEnd = pos + 20_000 + randInt(3 * MIN_MS);
  const cachedUntil = streamBase + diskExtra;
  const state = baseState({
    now,
    streamBase,
    pos,
    mseEnd: Math.max(mseEnd, pos + 5_000),
    cachedUntil: Math.max(cachedUntil, mseEnd + 1_000),
    tipGrowing: Math.random() < 0.4,
    settleActive: Math.random() < 0.1,
    nearLive: Math.random() < 0.05,
  });

  const kind = Math.random() < 0.45 ? 'tick' : 'seek';
  let target = pos;
  if (kind === 'seek') {
    const mode = randInt(4);
    if (mode === 0) target = pos - randInt(Math.min(pos - streamBase, 60_000)); // rewind
    else if (mode === 1) target = streamBase + randInt(Math.max(1, state.mseEnd - streamBase)); // in MSE
    else if (mode === 2) target = state.mseEnd + 5_000 + randInt(Math.max(1, state.cachedUntil - state.mseEnd)); // on disk
    else target = state.cachedUntil + MIN_MS + randInt(10 * MIN_MS); // past disk
  }

  const action = kind === 'tick' ? decideRollAction(state) : decideSeekAction(state, target);
  const check = assertActionAllowed(kind, state, target, action);

  // Extra invariants
  const invariants = [];
  if (kind === 'tick' && action === 'hard_seek' && (state.cachedUntil > state.mseEnd + 2000)) {
    invariants.push('tick hard-seek while disk ahead of MSE');
  }
  if (kind === 'seek' && action === 'hard_seek' && (inMseBuffer(state, target) || onDisk(state, target))) {
    invariants.push('seek hard-seek while MSE/disk covers target');
  }
  if (kind === 'tick' && action === 'soft_refill' && (state.tipGrowing || (state.mseEnd - state.pos) >= MSE_UNDERRUN_MS)) {
    invariants.push('soft_refill while tip/window still healthy');
  }
  if (kind === 'tick' && action !== 'none' && state.settleActive) {
    invariants.push('acted while settleActive');
  }

  return {
    name: `fuzz ${seedTag} ${kind}`,
    kind,
    target,
    state,
    action,
    check,
    invariants,
  };
}

function runOnce(runIndex) {
  const failures = [];
  let passed = 0;
  let hardSeeks = 0;
  let softRefills = 0;
  let localSeeks = 0;
  let nones = 0;

  for (const c of fixedCases()) {
    if (c.kind === 'window') {
      const w = quickSeekWindow(c.state);
      const behind = c.state.pos - w.start;
      const ahead = w.end - c.state.pos;
      if (behind < MSE_ROLL_KEEP_MS - 1000 || ahead < MSE_ROLL_KEEP_MS - 1000) {
        failures.push(`[fixed] ${c.name}: window behind=${behind} ahead=${ahead}`);
      } else {
        passed += 1;
      }
      continue;
    }
    if (c.kind === 'rebase') {
      const start = rebaseWindowStart(c.pos, c.earliest);
      if (start !== c.expectStart) {
        failures.push(`[fixed] ${c.name}: expected start ${c.expectStart}, got ${start}`);
      } else {
        passed += 1;
      }
      continue;
    }
    if (c.kind === 'rebase-resume') {
      const resume = rebaseResumeAt(c.pos, c.start);
      if (resume !== c.expectResume) {
        failures.push(`[fixed] ${c.name}: expected resume ${c.expectResume}, got ${resume}`);
      } else {
        passed += 1;
      }
      continue;
    }
    if (c.kind === 'hard-plan') {
      const planned = planHardSeekWindow(c.target, c.earliest, c.currentBase, c.now);
      if (planned.start !== c.expectStart || planned.resume !== c.expectResume) {
        failures.push(`[fixed] ${c.name}: expected start=${c.expectStart} resume=${c.expectResume}, got start=${planned.start} resume=${planned.resume}`);
      } else if (!(c.expectResume - planned.start >= MSE_ROLL_KEEP_MS - MIN_MS)) {
        failures.push(`[fixed] ${c.name}: resume not ~2m ahead of window start`);
      } else {
        passed += 1;
      }
      continue;
    }
    if (c.kind === 'hard-plan-step') {
      const planned = planHardSeekWindow(c.target, c.earliest, c.currentBase, c.now);
      if (Math.abs(planned.start - c.currentBase) < 1000) {
        failures.push(`[fixed] ${c.name}: start still equals currentBase ${c.currentBase}`);
      } else if (planned.resume < planned.start) {
        failures.push(`[fixed] ${c.name}: resume before start`);
      } else {
        passed += 1;
      }
      continue;
    }
    if (c.kind === 'seek-chain') {
      let ok = true;
      let pos = c.state.pos;
      for (let i = 0; i < c.steps.length; i += 1) {
        const step = c.steps[i];
        const state = { ...c.state, pos, mseEnd: Math.min(c.state.mseEnd, pos + 10_000) };
        const action = decideSeekAction(state, step.to);
        if (action === 'hard_seek') hardSeeks += 1;
        if (action === 'soft_refill') softRefills += 1;
        if (action === 'local_seek') localSeeks += 1;
        if (action === 'none') nones += 1;
        if (action !== c.expectEach) {
          failures.push(`[fixed] ${c.name} step ${i + 1}: expected ${c.expectEach}, got ${action}`);
          ok = false;
        }
        pos = step.to;
      }
      if (ok) passed += 1;
      continue;
    }
    const action = c.kind === 'tick' ? decideRollAction(c.state) : decideSeekAction(c.state, c.target);
    if (action === 'hard_seek') hardSeeks += 1;
    if (action === 'soft_refill') softRefills += 1;
    if (action === 'local_seek') localSeeks += 1;
    if (action === 'none') nones += 1;
    if (action !== c.expect) {
      failures.push(`[fixed] ${c.name}: expected ${c.expect}, got ${action}`);
    } else {
      passed += 1;
    }
    const allowed = assertActionAllowed(c.kind, c.state, c.target ?? c.state.pos, action);
    if (!allowed.ok) failures.push(`[fixed-allow] ${c.name}: ${allowed.reason}`);
  }

  for (let i = 0; i < 80; i += 1) {
    const f = fuzzCase(`${runIndex}.${i}`);
    if (f.action === 'hard_seek') hardSeeks += 1;
    if (f.action === 'soft_refill') softRefills += 1;
    if (f.action === 'local_seek') localSeeks += 1;
    if (f.action === 'none') nones += 1;
    if (!f.check.ok) failures.push(`[fuzz] ${f.name}: ${f.check.reason} (expected ${f.check.expected}, got ${f.check.got})`);
    for (const inv of f.invariants) failures.push(`[fuzz-inv] ${f.name}: ${inv}`);
    if (f.check.ok && !f.invariants.length) passed += 1;
  }

  return { passed, failures, hardSeeks, softRefills, localSeeks, nones };
}

console.log(`MSE policy eval — ${RUNS} runs\n`);

let totalFail = 0;
const summaries = [];
for (let r = 1; r <= RUNS; r += 1) {
  const result = runOnce(r);
  summaries.push(result);
  const ok = result.failures.length === 0;
  if (!ok) totalFail += result.failures.length;
  console.log(
    `Run ${r}/${RUNS}: ${ok ? 'PASS' : 'FAIL'} — passed=${result.passed} hard=${result.hardSeeks} soft=${result.softRefills} local=${result.localSeeks} none=${result.nones}`,
  );
  if (!ok) {
    for (const line of result.failures.slice(0, 12)) console.log(`  ${line}`);
    if (result.failures.length > 12) console.log(`  … ${result.failures.length - 12} more`);
  }
}

// Aggregate: hard-seeks should be rare vs soft/local on fuzz+fixed.
const agg = summaries.reduce((a, s) => {
  a.hard += s.hardSeeks;
  a.soft += s.softRefills;
  a.local += s.localSeeks;
  a.none += s.nones;
  a.fail += s.failures.length;
  return a;
}, { hard: 0, soft: 0, local: 0, none: 0, fail: 0 });

console.log('\n--- Aggregate ---');
console.log(`hard_seek=${agg.hard} soft_refill=${agg.soft} local_seek=${agg.local} none=${agg.none} failures=${agg.fail}`);

if (agg.fail > 0) {
  console.error('\nEVAL FAILED');
  process.exit(1);
}

// Sanity: hard seeks must not dominate soft+local (policy anti-buffer goal).
const actionable = agg.hard + agg.soft + agg.local;
if (actionable > 0 && agg.hard / actionable > 0.55) {
  console.error(`\nEVAL FAILED: hard_seek ratio too high (${agg.hard}/${actionable}) — would cause excess buffering`);
  process.exit(1);
}

console.log('\nEVAL PASSED — no unnecessary hard-seeks; soft/local preferred for MSE/disk coverage');
process.exit(0);
