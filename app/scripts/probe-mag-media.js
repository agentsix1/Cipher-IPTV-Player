'use strict';

/**
 * Sample real MAG media: 10 random movies, 10 random TV shows, 20 random live channels.
 * Skips 24/7, PPV, and header/organizer rows. Writes mag_probe_media_test.json.
 *
 * VOD: one fail is noise; more than 3 fails in the 20 titles → limited/faulty catalog.
 * Live: dead feeds are common; 10 failed samples usually means junk streams, not a dead account.
 *
 * Usage (from app/):
 *   npm run probe:mag-media
 *   node scripts/probe-mag-media.js [path-to-accounts.json]
 */

const fs = require('fs');
const path = require('path');
const mag = require('../src/mag');

const ROOT = path.resolve(__dirname, '..', '..');
const INPUT = process.argv[2] || path.join(ROOT, 'mag_tested_working.json');
const SUMMARY_IN = path.join(ROOT, 'mag_probe_summary.json');
const OUT = path.join(ROOT, 'mag_probe_media_test.json');

const ACCOUNT_CONCURRENCY = 2;
const MOVIE_SAMPLES = 10;
const SERIES_SAMPLES = 10;
const LIVE_SAMPLES = 20;
const VOD_LIMITED_FAILS = 4;
const LIVE_DEAD_FEED_FAILS = 10;
const PEEK_MS = 8000;
const LINK_MS = 25000;

const SKIP_LIVE = [
  /\b24\s*[/\-]?\s*7\b/i,
  /\bppv\b/i,
  /pay[\s-]*per[\s-]*view/i,
  /\bxxx\b/i,
  /\badult\b/i,
  /\bporn\b/i,
  /\bradio\b/i,
  /\binfomercial\b/i,
  /\bnon[\s-]*stop\b/i,
  /\balways[\s-]*on\b/i,
  /\bheader\b/i,
  /\binformation\b/i,
  /\bannounce/i,
  /\bwelcome\b/i,
  /\bserver\s*(?:info|status|message)/i,
  /\btest\s*(?:channel|stream)\b/i,
  /\borgani[sz]e/i,
  /\bplaylist\s*info\b/i,
  /^[\s\-_=*#.>|<[\]!/\\]{2,}$/,
  /^[\-_=*#]{2,}.+[\-_=*#]{2,}$/,
  /[▬━═─]{3,}/,
];

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickN(list, n) {
  return shuffle(list).slice(0, n);
}

function hostOf(portal) {
  try { return new URL(portal).host; } catch { return portal; }
}

function isJunkText(text) {
  const value = String(text || '').trim();
  if (value.length < 2) return true;
  if (!/[a-z0-9]/i.test(value)) return true;
  return SKIP_LIVE.some((re) => re.test(value));
}

function isJunkCategory(name) {
  return isJunkText(name);
}

function isHeaderOrJunkChannel(ch) {
  const name = String(ch.name || '').trim();
  const group = String(ch.groupName || '').trim();
  if (isJunkText(name) || isJunkText(group)) return true;
  if (isJunkText(`${name} ${group}`)) return true;
  return false;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function streamHeaders(creds) {
  let origin = '';
  try { origin = new URL(creds.portal).origin; } catch { /* ignore */ }
  const headers = {
    Cookie: `mac=${creds.mac}; stb_lang=en; timezone=${creds.timezone || 'Europe/London'}`,
    'X-User-Agent': 'Model: MAG250; Link: WiFi',
  };
  if (origin) {
    headers.Referer = `${origin}/c/`;
    headers.Origin = origin;
  }
  return headers;
}

async function peekUrl(url, creds) {
  if (!mag.isPlayableMagUrl(url)) return { ok: false, status: 0, error: 'not a playable URL' };
  const tries = [
    streamHeaders(creds),
    { 'X-User-Agent': 'Model: MAG250; Link: WiFi' },
    {},
  ];
  let last = { ok: false, status: 0, error: 'peek failed' };
  for (const headers of tries) {
    try {
      const peek = await mag.peekMedia(url, headers, { timeoutMs: PEEK_MS });
      last = { ok: !!peek.ok, status: peek.status || 0 };
      if (peek.ok) return last;
      if (peek.status && ![456, 460, 462].includes(peek.status)) return last;
    } catch (err) {
      last = { ok: false, status: 0, error: err.message };
    }
  }
  return last;
}

function failSample(item, error, extra = {}) {
  return { ok: false, id: item.id, name: item.name, error, ...extra };
}

async function collectVodPool(creds, kind, categories, want) {
  const cats = shuffle((categories || []).filter((c) => c && c.id && !isJunkCategory(c.name)));
  const pool = [];
  const seen = new Set();
  for (const cat of cats.slice(0, 12)) {
    try {
      const first = await mag.loadCategoryPage(creds, kind, cat.id, 1, { timeoutMs: 30000 });
      const per = Math.max(1, first.items.length || 14);
      const pages = Math.max(1, Math.ceil((Number(first.total) || first.items.length || 1) / per));
      const pageNo = pages > 1 ? 1 + Math.floor(Math.random() * Math.min(pages, 8)) : 1;
      const page = pageNo === 1
        ? first
        : await mag.loadCategoryPage(creds, kind, cat.id, pageNo, { timeoutMs: 30000 });
      for (const item of page.items || []) {
        if (!item.id || seen.has(item.id) || isJunkText(item.name)) continue;
        seen.add(item.id);
        pool.push({ ...item, categoryName: cat.name });
      }
    } catch {
      /* skip dead category */
    }
    if (pool.length >= want * 4) break;
  }
  return pickN(pool, want);
}

async function testMovie(creds, item) {
  const started = Date.now();
  try {
    const cmd = String(item.cmd || '').trim();
    const url = await mag.createVodLink(creds, { cmd, file_id: item.id, series: '' }, { timeoutMs: LINK_MS });
    if (!url) return failSample(item, 'create_link returned no URL', { ms: Date.now() - started });
    const peek = await peekUrl(url, creds);
    return {
      ok: !!peek.ok,
      id: item.id,
      name: item.name,
      category: item.categoryName || '',
      host: (() => { try { return new URL(url).host; } catch { return ''; } })(),
      status: peek.status || 0,
      error: peek.ok ? '' : (peek.error || (peek.status ? `HTTP ${peek.status}` : 'CDN peek failed')),
      ms: Date.now() - started,
    };
  } catch (err) {
    return failSample(item, err.message, { ms: Date.now() - started });
  }
}

async function testSeries(creds, item) {
  const started = Date.now();
  try {
    const pack = await mag.loadSeriesEpisodes(creds, item.id, { timeoutMs: 45000, maxPages: 3 });
    const episodes = (pack.episodes || []).filter((e) => e.cmd || e.episode);
    if (!episodes.length) return failSample(item, 'no episodes', { ms: Date.now() - started });
    const ep = pickN(episodes, 1)[0];
    const url = await mag.createVodLink(creds, { cmd: ep.cmd, series: String(ep.episode || '') }, { timeoutMs: LINK_MS });
    if (!url) {
      return failSample(item, 'episode create_link returned no URL', {
        season: ep.season,
        episode: ep.episode,
        ms: Date.now() - started,
      });
    }
    const peek = await peekUrl(url, creds);
    return {
      ok: !!peek.ok,
      id: item.id,
      name: item.name,
      category: item.categoryName || '',
      season: ep.season,
      episode: ep.episode,
      host: (() => { try { return new URL(url).host; } catch { return ''; } })(),
      status: peek.status || 0,
      error: peek.ok ? '' : (peek.error || (peek.status ? `HTTP ${peek.status}` : 'CDN peek failed')),
      ms: Date.now() - started,
    };
  } catch (err) {
    return failSample(item, err.message, { ms: Date.now() - started });
  }
}

async function testLive(creds, ch) {
  const started = Date.now();
  const base = { id: ch.id, name: ch.name, group: ch.groupName || '' };
  try {
    const url = await mag.liveUrl(creds, ch, { timeoutMs: LINK_MS });
    const peek = await peekUrl(url, creds);
    return {
      ...base,
      ok: !!peek.ok,
      host: (() => { try { return new URL(url).host; } catch { return ''; } })(),
      status: peek.status || 0,
      error: peek.ok ? '' : (peek.error || (peek.status ? `HTTP ${peek.status}` : 'CDN peek failed')),
      ms: Date.now() - started,
    };
  } catch (err) {
    return { ...base, ok: false, error: err.message, ms: Date.now() - started };
  }
}

function tally(samples) {
  const ok = samples.filter((s) => s.ok).length;
  const fail = samples.length - ok;
  const errors = {};
  for (const s of samples) {
    if (s.ok) continue;
    const key = s.status ? `HTTP ${s.status}` : (s.error || 'unknown');
    errors[key] = (errors[key] || 0) + 1;
  }
  return { tested: samples.length, ok, fail, errors };
}

function vodVerdict(movies, series) {
  const tested = movies.tested + series.tested;
  const fail = movies.fail + series.fail;
  const ok = movies.ok + series.ok;
  if (!tested) return 'empty';
  if (fail >= VOD_LIMITED_FAILS) return 'limited';
  if (ok > 0) return 'working';
  return 'limited';
}

function liveVerdict(live) {
  if (!live.tested) return 'none';
  if (live.ok === 0) return 'broken';
  if (live.fail >= LIVE_DEAD_FEED_FAILS) return 'dead-feeds';
  return 'working';
}

function compactSample(s) {
  const row = { name: s.name, ok: !!s.ok };
  if (s.group) row.group = s.group;
  if (s.season) row.season = s.season;
  if (s.episode) row.episode = s.episode;
  if (!s.ok) row.error = s.error || (s.status ? `HTTP ${s.status}` : 'fail');
  return row;
}

async function probeOne(entry, index, total) {
  const portal = mag.normalizePortal(entry.url || entry.portal);
  const mac = mag.normalizeMac(entry.mac);
  const started = Date.now();
  const result = {
    index,
    portal,
    mac,
    ok: false,
    auth: false,
    movies: { tested: 0, ok: 0, fail: 0, samples: [] },
    series: { tested: 0, ok: 0, fail: 0, samples: [] },
    live: { tested: 0, ok: 0, fail: 0, skipped: 0, samples: [] },
    vodVerdict: 'empty',
    liveVerdict: 'none',
    errors: [],
    ms: 0,
  };

  process.stdout.write(`[${index + 1}/${total}] ${hostOf(portal)} ${mac} ... `);
  if (!portal || !mac) {
    result.errors.push('invalid portal or mac');
    result.ms = Date.now() - started;
    console.log('FAIL invalid');
    return result;
  }

  const creds = { portal, mac };
  try {
    const session = await mag.connect(creds, { timeoutMs: 25000, deadlineMs: 25000 });
    creds.token = session.token;
    creds.timezone = session.timezone;
    creds.endpoint = session.endpoint;
    result.auth = true;
  } catch (err) {
    result.errors.push(`auth: ${err.message}`);
    result.ms = Date.now() - started;
    console.log(`AUTH FAIL (${err.message})`);
    return result;
  }

  try {
    const cats = await mag.loadVodCategories(creds, { timeoutMs: 30000 });
    const moviePool = await collectVodPool(creds, 'movies', cats.movieCats, MOVIE_SAMPLES);
    const seriesPool = await collectVodPool(creds, 'series', cats.seriesCats, SERIES_SAMPLES);
    const movieSamples = [];
    for (const item of moviePool) movieSamples.push(await testMovie(creds, item));
    const seriesSamples = [];
    for (const item of seriesPool) seriesSamples.push(await testSeries(creds, item));
    result.movies = { ...tally(movieSamples), samples: movieSamples.map(compactSample) };
    result.series = { ...tally(seriesSamples), samples: seriesSamples.map(compactSample) };
  } catch (err) {
    result.errors.push(`vod: ${err.message}`);
  }

  try {
    const live = await mag.loadLive(creds, { timeoutMs: 120000 });
    const usable = (live.channels || []).filter((ch) => !isHeaderOrJunkChannel(ch));
    result.live.skipped = Math.max(0, (live.channels || []).length - usable.length);
    const picked = pickN(usable, LIVE_SAMPLES);
    const liveSamples = [];
    for (const ch of picked) liveSamples.push(await testLive(creds, ch));
    const stats = tally(liveSamples);
    result.live = { ...stats, skipped: result.live.skipped, samples: liveSamples.map(compactSample) };
  } catch (err) {
    result.errors.push(`live: ${err.message}`);
    result.live.error = err.message;
  }

  result.vodVerdict = vodVerdict(result.movies, result.series);
  result.liveVerdict = liveVerdict(result.live);
  result.ok = result.auth && (result.vodVerdict === 'working' || result.liveVerdict === 'working' || result.liveVerdict === 'dead-feeds');
  result.ms = Date.now() - started;
  console.log(
    `${result.ok ? 'OK' : 'FAIL'} vod=${result.vodVerdict} `
    + `movies ${result.movies.ok}/${result.movies.tested} `
    + `shows ${result.series.ok}/${result.series.tested} `
    + `live=${result.liveVerdict} ${result.live.ok}/${result.live.tested} `
    + `${result.ms}ms`,
  );
  return result;
}

function loadAccounts() {
  const raw = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  const all = Array.isArray(raw) ? raw : [];
  if (!fs.existsSync(SUMMARY_IN)) return { list: all, source: path.basename(INPUT) };
  try {
    const prev = JSON.parse(fs.readFileSync(SUMMARY_IN, 'utf8'));
    const working = (prev.working || []).map((w) => ({ url: w.portal, mac: w.mac, portal: w.portal }));
    if (!working.length) return { list: all, source: path.basename(INPUT) };
    return {
      list: working,
      source: `${path.basename(INPUT)} (working from mag_probe_summary.json)`,
    };
  } catch {
    return { list: all, source: path.basename(INPUT) };
  }
}

function accountRow(r) {
  return {
    portal: r.portal,
    mac: r.mac,
    vod: r.vodVerdict,
    movies: `${r.movies.ok}/${r.movies.tested}`,
    series: `${r.series.ok}/${r.series.tested}`,
    live: r.liveVerdict,
    liveOk: `${r.live.ok}/${r.live.tested}`,
    skippedLive: r.live.skipped || 0,
    movieErrors: r.movies.errors || {},
    seriesErrors: r.series.errors || {},
    liveErrors: r.live.errors || {},
    ms: r.ms,
  };
}

async function main() {
  const { list, source } = loadAccounts();
  if (!list.length) throw new Error('No MAG accounts to probe');
  console.log(`Media-probing ${list.length} MAG accounts (concurrency=${ACCOUNT_CONCURRENCY})`);
  console.log(`Source: ${source}`);
  console.log(`Samples: ${MOVIE_SAMPLES} movies, ${SERIES_SAMPLES} shows, ${LIVE_SAMPLES} live\n`);

  const results = await mapLimit(list, ACCOUNT_CONCURRENCY, (entry, i) => probeOne(entry, i, list.length));

  const vodWorking = results.filter((r) => r.vodVerdict === 'working');
  const vodLimited = results.filter((r) => r.vodVerdict === 'limited');
  const vodEmpty = results.filter((r) => r.vodVerdict === 'empty');
  const liveWorking = results.filter((r) => r.liveVerdict === 'working');
  const liveDeadFeeds = results.filter((r) => r.liveVerdict === 'dead-feeds');
  const liveBroken = results.filter((r) => r.liveVerdict === 'broken');
  const authFailed = results.filter((r) => !r.auth);

  const report = {
    probedAt: new Date().toISOString(),
    source,
    rules: {
      movies: MOVIE_SAMPLES,
      series: SERIES_SAMPLES,
      live: LIVE_SAMPLES,
      vodLimitedIfFails: VOD_LIMITED_FAILS,
      liveDeadFeedsIfFails: LIVE_DEAD_FEED_FAILS,
      skipLive: '24/7, PPV, adult, radio, header/organizer rows',
    },
    totals: {
      accounts: results.length,
      authFailed: authFailed.length,
      vodWorking: vodWorking.length,
      vodLimited: vodLimited.length,
      vodEmpty: vodEmpty.length,
      liveWorking: liveWorking.length,
      liveDeadFeeds: liveDeadFeeds.length,
      liveBroken: liveBroken.length,
    },
    vodWorking: vodWorking.map(accountRow),
    vodLimited: vodLimited.map(accountRow),
    liveWorking: liveWorking.map(accountRow),
    liveDeadFeeds: liveDeadFeeds.map(accountRow),
    liveBroken: liveBroken.map(accountRow),
    authFailed: authFailed.map((r) => ({ portal: r.portal, mac: r.mac, errors: r.errors, ms: r.ms })),
    accounts: results,
  };

  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log('\n=== MEDIA TEST ===');
  console.log(`VOD working (≤3 fails): ${vodWorking.length}/${results.length}`);
  console.log(`VOD limited (>3 fails): ${vodLimited.length}`);
  console.log(`VOD empty: ${vodEmpty.length}`);
  console.log(`Live working (<10 fails): ${liveWorking.length}`);
  console.log(`Live mostly dead feeds (≥10 fails, some work): ${liveDeadFeeds.length}`);
  console.log(`Live broken (0 working): ${liveBroken.length}`);
  console.log(`Wrote ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
