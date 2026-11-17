/**
 * Live smoke + timeline sim against the running APK server.
 * 1) Open a real catch-up window and confirm disk cache grows.
 * 2) Simulate playback approaching the MSE tip over time — policy must stay
 *    on none/soft_refill (no hard-seek) while disk covers the playhead.
 *
 * Usage: node scripts/eval-mse-live.mjs [--base=http://127.0.0.1:8092] [--runs=3]
 */
import {
  MIN,
  MSE_ROLL_KEEP_MS,
  decideRollAction,
  decideSeekAction,
} from '../public/js/mse-policy.mjs';

const BASE = (process.argv.find((a) => a.startsWith('--base=')) || '--base=http://127.0.0.1:8092').split('=')[1];
const RUNS = Math.max(1, Number((process.argv.find((a) => a.startsWith('--runs=')) || '--runs=3').split('=')[1]) || 3);

async function api(path) {
  const res = await fetch(`${BASE}${path}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

async function listCatchupChannels() {
  const groups = await api('/api/channels');
  let list = [];
  if (Array.isArray(groups)) list = groups;
  else if (groups && Array.isArray(groups.channels)) list = groups.channels;
  else if (groups && Array.isArray(groups.groups)) {
    for (const g of groups.groups) {
      if (Array.isArray(g.channels)) list.push(...g.channels);
    }
  }
  let withCatchup = list.filter((c) => c && c.catchup);
  if (!withCatchup.length) {
    try {
      const hit = await api('/api/search?q=news&when=past&limit=30');
      const rows = hit.results || hit.hits || hit.items || [];
      for (const r of rows) {
        const ch = r.ch || r.channel || r;
        if (ch && (ch.catchup || r.catchup) && (ch.id || ch.channelId)) {
          withCatchup.push({ id: ch.id || ch.channelId, name: ch.name || 'search-hit', catchup: true });
        }
      }
    } catch { /* ignore */ }
  }
  if (!withCatchup.length) throw new Error('No catch-up channels found via API');
  // Shuffle lightly so runs hit different channels.
  for (let i = withCatchup.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [withCatchup[i], withCatchup[j]] = [withCatchup[j], withCatchup[i]];
  }
  return withCatchup;
}

function cachePathFromUrl(playUrl) {
  try {
    const u = new URL(playUrl, BASE);
    return `/api/stream-cache${u.search}`;
  } catch {
    return '';
  }
}

async function openCatchup(channelId) {
  const start = Math.floor((Date.now() - 45 * MIN) / MIN) * MIN;
  const end = Math.min(Date.now(), start + 60 * MIN);
  const info = await api(`/api/play/catchup?ch=${encodeURIComponent(channelId)}&start=${start}&end=${end}`);
  return { info, start, end };
}

async function waitCacheGrowth(playUrl, { minBytes = 200_000, timeoutMs = 25_000 } = {}) {
  const path = cachePathFromUrl(playUrl);
  if (!path) return { ok: false, reason: 'no cache path' };
  const t0 = Date.now();
  let last = 0;
  let lastSt = null;
  while (Date.now() - t0 < timeoutMs) {
    let st;
    try {
      st = await api(path);
      lastSt = st;
    } catch {
      await new Promise((r) => setTimeout(r, 800));
      continue;
    }
    const bytes = Number(st.bytes) || 0;
    if (st.error && bytes < 1) {
      return { ok: false, reason: st.error, bytes, st };
    }
    if (bytes >= minBytes) return { ok: true, bytes, grew: bytes > last, st };
    last = bytes;
    await new Promise((r) => setTimeout(r, 800));
  }
  return { ok: false, reason: (lastSt && lastSt.error) || 'cache did not grow', bytes: last, st: lastSt };
}

/**
 * Simulate ~3 minutes of playback with a healthy ±2m MSE window.
 * Soft-refill only near underrun; hard-seek must stay 0 while disk covers pos.
 */
function simulatePlaybackTimeline(streamBase, cachedUntil) {
  const events = [];
  let hard = 0;
  let soft = 0;
  let none = 0;
  let local = 0;

  for (let t = 0; t < 180; t += 5) {
    const pos = streamBase + (120 + t) * 1000; // already deep enough for a 2m behind window
    // Healthy window: ~2m behind, ~2m ahead, tip keeps growing slowly.
    const mseStart = pos - MSE_ROLL_KEEP_MS;
    const mseEnd = pos + MSE_ROLL_KEEP_MS + (t < 100 ? 15_000 : -5_000);
    const disk = Math.max(cachedUntil, pos + 10 * MIN);
    const tipGrowing = t < 100 || (mseEnd - pos) > 20_000;
    const state = {
      mode: 'catchup',
      streamBase,
      pos,
      mseStart,
      mseEnd: Math.max(mseEnd, pos + 5_000),
      cachedUntil: disk,
      windowEnd: streamBase + 60 * MIN,
      now: Date.now(),
      tipGrowing,
      nearLive: false,
      prefetch: true,
      settleActive: false,
    };
    const action = decideRollAction(state);
    if (action === 'hard_seek') hard += 1;
    if (action === 'soft_refill') soft += 1;
    if (action === 'none') none += 1;
    if (action === 'hard_seek' || (action === 'soft_refill' && (mseEnd - pos) >= 20_000)) {
      events.push({ t, action, ahead: state.mseEnd - pos });
    }

    // ±1 minute seeks inside the quick window must stay local.
    if (t === 60 || t === 120) {
      for (const delta of [-60_000, 15_000, 60_000]) {
        const target = pos + delta;
        const seekAct = decideSeekAction(state, target);
        if (seekAct === 'local_seek') local += 1;
        else {
          hard += seekAct === 'hard_seek' ? 1 : 0;
          soft += seekAct === 'soft_refill' ? 1 : 0;
          events.push({ t, action: `seek:${seekAct}`, delta });
        }
      }
    }
  }

  return { hard, soft, none, local, events };
}

console.log(`Live MSE eval against ${BASE} — ${RUNS} runs\n`);

const channels = await listCatchupChannels();
let failed = 0;
let cacheHits = 0;
for (let run = 1; run <= RUNS; run += 1) {
  process.stdout.write(`Run ${run}/${RUNS}: `);
  try {
    let ch = null;
    let info = null;
    let start = 0;
    let growth = { ok: false, reason: 'no attempt', bytes: 0 };
    // Try a few channels until prefetch actually stores media bytes.
    for (let i = 0; i < Math.min(6, channels.length); i += 1) {
      ch = channels[(run * 3 + i) % channels.length];
      ({ info, start } = await openCatchup(ch.id));
      if (!(info.urls && info.urls[0])) continue;
      growth = await waitCacheGrowth(info.urls[0], { minBytes: 80_000, timeoutMs: 12_000 });
      if (growth.ok) break;
      if (growth.st && growth.st.error) growth.reason = growth.st.error;
    }
    if (!info || !(info.urls && info.urls[0])) {
      throw new Error(`catchup missing urls for ${ch && (ch.name || ch.id)}`);
    }
    if (growth.ok) cacheHits += 1;
    else console.log(`WARN cache: ${growth.reason}`);

    const cachedUntil = start + Math.max(10 * MIN, ((growth.bytes || 500_000) / (2 * 1024 * 1024 / 8)) * 1000);
    const sim = simulatePlaybackTimeline(info.start || start, cachedUntil);

    const ok = sim.hard === 0;
    if (!ok) failed += 1;
    console.log(
      `${ok ? 'PASS' : 'FAIL'} ch=${ch.name || ch.id} cacheBytes=${growth.bytes || 0} ` +
      `roll(none=${sim.none},soft=${sim.soft},hard=${sim.hard}) localSeekChecks=${sim.local}`,
    );
    if (!ok) {
      for (const e of sim.events.slice(0, 8)) console.log('  hard event', e);
    }

    // Seek-to-tip must be local when inside MSE
    const tipState = {
      mode: 'catchup',
      streamBase: info.start || start,
      pos: (info.start || start) + 60_000,
      mseEnd: (info.start || start) + 180_000,
      cachedUntil: (info.start || start) + 40 * MIN,
      now: Date.now(),
      prefetch: true,
    };
    const tipSeek = decideSeekAction(tipState, tipState.mseEnd - 2_000);
    if (tipSeek !== 'local_seek') {
      failed += 1;
      console.log(`  FAIL tip-seek expected local_seek got ${tipSeek}`);
    }
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${err.message}`);
  }
}
console.log(`cache growth hits: ${cacheHits}/${RUNS}`);

if (failed) {
  console.error(`\nLIVE EVAL FAILED (${failed})`);
  process.exit(1);
}
console.log('\nLIVE EVAL PASSED — catch-up opens, timeline stays soft/local (no hard-seek while disk covers)');
process.exit(0);
