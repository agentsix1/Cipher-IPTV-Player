'use strict';

/**
 * Probe MAG portals from mag_tested_working.json using the app's mag.js client.
 * Handshake + live catalog + movie/series categories + one VOD create_link per account.
 * Writes mag_probe_results.json (full) and mag_probe_summary.json (compact).
 *
 * Usage (from app/):
 *   npm run probe:mag
 *   node scripts/probe-mag-accounts.js [path-to-json]
 */

const fs = require('fs');
const path = require('path');
const mag = require('../src/mag');

const ROOT = path.resolve(__dirname, '..', '..');
const INPUT = process.argv[2] || path.join(ROOT, 'mag_tested_working.json');
const RESULTS_OUT = path.join(ROOT, 'mag_probe_results.json');
const SUMMARY_OUT = path.join(ROOT, 'mag_probe_summary.json');
const CONCURRENCY = 4;
const SAMPLE_PAGES = 1;

function summaryItem(item) {
  return {
    id: item.id,
    name: item.name,
    hasPoster: !!item.poster,
    hasCmd: !!item.cmd,
    year: item.year || '',
  };
}

async function probeOne(entry, index, total) {
  const portal = mag.normalizePortal(entry.url);
  const mac = mag.normalizeMac(entry.mac);
  const label = `${portal} | ${mac}`;
  const started = Date.now();
  const result = {
    index,
    url: entry.url,
    portal,
    mac,
    ok: false,
    auth: null,
    live: null,
    movies: null,
    series: null,
    linkSample: null,
    errors: [],
    ms: 0,
  };

  if (!portal || !mac) {
    result.errors.push('invalid portal or mac');
    result.ms = Date.now() - started;
    console.log(`[${index + 1}/${total}] FAIL invalid ${entry.url} ${entry.mac}`);
    return result;
  }

  const creds = { portal, mac };
  process.stdout.write(`[${index + 1}/${total}] probing ${label} ... `);

  try {
    const session = await mag.connect(creds, { timeoutMs: 25000 });
    result.auth = {
      endpoint: session.endpoint,
      timezone: session.timezone,
      hasToken: !!session.token,
    };
  } catch (err) {
    result.errors.push(`auth: ${err.message}`);
    result.ms = Date.now() - started;
    console.log(`AUTH FAIL (${err.message})`);
    return result;
  }

  try {
    const live = await mag.loadLive(creds, { timeoutMs: 120000 });
    const sample = (live.channels || []).slice(0, 3).map((c) => ({
      id: c.id,
      name: c.name,
      group: c.groupName,
      hasUrl: !!c.url,
      needsLink: mag.cmdUrl(c.linkCmd || '') ? !/^https?:\/\//i.test(mag.cmdUrl(c.linkCmd)) || /play_token=|\/play\//i.test(c.url || '') : true,
      catchup: !!c.catchup,
      epgId: c.epgId || '',
    }));
    const missingName = (live.channels || []).filter((c) => !c.name).length;
    const missingCmd = (live.channels || []).filter((c) => !c.linkCmd && !c.url).length;
    result.live = {
      groups: (live.groups || []).length,
      channels: (live.channels || []).length,
      missingName,
      missingCmd,
      sample,
    };
  } catch (err) {
    result.errors.push(`live: ${err.message}`);
    result.live = { error: err.message };
  }

  try {
    const cats = await mag.loadVodCategories(creds, { timeoutMs: 30000 });
    const movieCats = cats.movieCats || [];
    const seriesCats = cats.seriesCats || [];
    result.movies = { categories: movieCats.length, categorySample: movieCats.slice(0, 5), pages: [] };
    result.series = { categories: seriesCats.length, categorySample: seriesCats.slice(0, 5), pages: [] };

    for (const cat of movieCats.slice(0, SAMPLE_PAGES ? 2 : 0)) {
      try {
        const page = await mag.loadCategoryPage(creds, 'movies', cat.id, 1, { timeoutMs: 45000 });
        result.movies.pages.push({
          categoryId: cat.id,
          categoryName: cat.name,
          total: page.total,
          pageItems: page.items.length,
          sample: page.items.slice(0, 3).map(summaryItem),
          missingName: page.items.filter((i) => !i.name).length,
        });
      } catch (err) {
        result.movies.pages.push({ categoryId: cat.id, categoryName: cat.name, error: err.message });
        result.errors.push(`movies:${cat.id}: ${err.message}`);
      }
    }

    for (const cat of seriesCats.slice(0, SAMPLE_PAGES ? 2 : 0)) {
      try {
        const page = await mag.loadCategoryPage(creds, 'series', cat.id, 1, { timeoutMs: 45000 });
        result.series.pages.push({
          categoryId: cat.id,
          categoryName: cat.name,
          total: page.total,
          pageItems: page.items.length,
          sample: page.items.slice(0, 3).map(summaryItem),
          missingName: page.items.filter((i) => !i.name).length,
        });

        const first = page.items.find((i) => i.id);
        if (first && !result.series.episodesSample) {
          try {
            const eps = await mag.loadSeriesEpisodes(creds, first.id, { timeoutMs: 45000, maxPages: 3 });
            result.series.episodesSample = {
              seriesId: first.id,
              seriesName: first.name,
              seasonsOrRows: (eps.seasons && eps.seasons.length) || 0,
              episodes: (eps.episodes || []).length,
              sample: (eps.episodes || []).slice(0, 3).map((e) => ({
                id: e.id,
                season: e.season,
                episode: e.episode,
                hasCmd: !!e.cmd,
              })),
            };
          } catch (err) {
            result.series.episodesSample = { seriesId: first.id, error: err.message };
            result.errors.push(`series-episodes: ${err.message}`);
          }
        }
      } catch (err) {
        result.series.pages.push({ categoryId: cat.id, categoryName: cat.name, error: err.message });
        result.errors.push(`series:${cat.id}: ${err.message}`);
      }
    }

    // Mint one VOD create_link when a movie cmd is available (validates on-demand path).
    const movieRow = (result.movies.pages || [])
      .flatMap((p) => (p.sample || []).map((s) => ({ ...s, categoryId: p.categoryId })))
      .find((i) => i.hasCmd);
    if (movieRow) {
      try {
        // Reload page item with cmd from portal row via category page items (summary dropped cmd text).
        const page = await mag.loadCategoryPage(creds, 'movies', movieRow.categoryId, 1, { timeoutMs: 45000 });
        const full = page.items.find((i) => i.id === movieRow.id) || page.items.find((i) => i.cmd);
        if (full && full.cmd) {
          const url = await mag.createVodLink(creds, { cmd: full.cmd, file_id: full.id, series: '' }, { timeoutMs: 30000 });
          result.linkSample = {
            movieId: full.id,
            movieName: full.name,
            ok: !!url && /^https?:\/\//i.test(url),
            host: (() => { try { return new URL(url).host; } catch { return ''; } })(),
          };
        }
      } catch (err) {
        result.linkSample = { error: err.message };
        result.errors.push(`movie-link: ${err.message}`);
      }
    }
  } catch (err) {
    result.errors.push(`vod: ${err.message}`);
  }

  const liveOk = result.live && result.live.channels > 0;
  const authOk = !!(result.auth && result.auth.hasToken);
  const vodOk = (result.movies && result.movies.categories > 0) || (result.series && result.series.categories > 0);
  result.ok = authOk && (liveOk || vodOk);
  result.ms = Date.now() - started;

  const parts = [
    authOk ? 'auth' : 'no-auth',
    liveOk ? `live=${result.live.channels}` : 'live=0',
    result.movies ? `moviesCat=${result.movies.categories}` : 'movies=?',
    result.series ? `seriesCat=${result.series.categories}` : 'series=?',
    result.linkSample && result.linkSample.ok ? 'link=ok' : (result.linkSample ? 'link=fail' : 'link=n/a'),
    `${result.ms}ms`,
  ];
  console.log(`${result.ok ? 'OK' : 'PARTIAL/FAIL'} ${parts.join(' ')}`);
  return result;
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

function failReasonGroup(message) {
  const msg = String(message || '');
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|timed out|timeout/i.test(msg)) return 'DNS/connect';
  const http = msg.match(/HTTP (\d+)/i);
  if (http) return `HTTP ${http[1]}`;
  return 'other';
}

function hostLabel(portal) {
  try { return new URL(portal).host; } catch { return portal; }
}

function groupAuthFailures(failed) {
  const groups = {};
  const counts = new Map();
  for (const r of failed) {
    const key = failReasonGroup((r.errors && r.errors[0]) || '');
    const host = hostLabel(r.portal);
    if (!groups[key]) groups[key] = [];
    counts.set(`${key}|${host}`, (counts.get(`${key}|${host}`) || 0) + 1);
    if (!groups[key].includes(host) && !groups[key].some((h) => h.startsWith(`${host} (`))) {
      groups[key].push(host);
    }
  }
  for (const [combo, n] of counts) {
    const [key, host] = combo.split('|');
    if (n > 1) {
      const i = groups[key].indexOf(host);
      if (i >= 0) groups[key][i] = `${host} (x${n})`;
    }
  }
  return groups;
}

function vodLinkSummary(r) {
  if (r.linkSample && r.linkSample.ok) return true;
  if (r.linkSample && r.linkSample.error) return r.linkSample.error;
  if (r.errors.some((e) => /movie-link|create_link/i.test(e))) {
    return r.errors.find((e) => /movie-link|create_link/i.test(e));
  }
  return false;
}

function liveSummary(r) {
  if (r.live && Number(r.live.channels) > 0) return r.live.channels;
  if (r.live && r.live.error) {
    if (/429/.test(r.live.error)) return 'flaky/429';
    return r.live.error;
  }
  return r.live && r.live.channels === 0 ? 0 : null;
}

async function main() {
  const list = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  if (!Array.isArray(list) || !list.length) throw new Error('No accounts in input');
  console.log(`Probing ${list.length} MAG accounts (concurrency=${CONCURRENCY})`);
  console.log(`Input: ${INPUT}\n`);

  const results = await mapLimit(list, CONCURRENCY, (entry, i) => probeOne(entry, i, list.length));

  const working = results.filter((r) => r.ok);
  const authOnly = results.filter((r) => r.auth && r.auth.hasToken && !r.ok);
  const failed = results.filter((r) => !r.auth || !r.auth.hasToken);

  const report = {
    probedAt: new Date().toISOString(),
    input: INPUT,
    totals: {
      accounts: results.length,
      working: working.length,
      authButNoCatalog: authOnly.length,
      authFailed: failed.length,
    },
    working: working.map((r) => ({
      portal: r.portal,
      mac: r.mac,
      liveChannels: r.live && r.live.channels,
      movieCategories: r.movies && r.movies.categories,
      seriesCategories: r.series && r.series.categories,
      linkOk: !!(r.linkSample && r.linkSample.ok),
      ms: r.ms,
    })),
    authButNoCatalog: authOnly.map((r) => ({
      portal: r.portal,
      mac: r.mac,
      errors: r.errors,
      live: r.live,
      movies: r.movies && { categories: r.movies.categories },
      series: r.series && { categories: r.series.categories },
    })),
    authFailed: failed.map((r) => ({
      portal: r.portal,
      mac: r.mac,
      errors: r.errors,
      ms: r.ms,
    })),
    results,
  };

  const summary = {
    probedAt: report.probedAt,
    source: path.basename(INPUT),
    totals: {
      accounts: results.length,
      working: working.length,
      authButCatalogFlaky: authOnly.length,
      authFailed: failed.length,
    },
    working: working.map((r) => {
      const row = {
        portal: r.portal,
        mac: r.mac,
        live: liveSummary(r),
        movieCats: r.movies ? r.movies.categories : 0,
        seriesCats: r.series ? r.series.categories : 0,
        vodLink: vodLinkSummary(r),
      };
      const notes = [];
      if (r.live && r.live.error) notes.push(`live: ${r.live.error}`);
      if (r.series && r.series.episodesSample && r.series.episodesSample.error) {
        notes.push(`episodes: ${r.series.episodesSample.error}`);
      }
      if (notes.length) row.note = notes.join('; ');
      return row;
    }),
    authFailedReasons: groupAuthFailures(failed),
  };

  fs.writeFileSync(RESULTS_OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(SUMMARY_OUT, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log('\n=== SUMMARY ===');
  console.log(`Working: ${working.length}/${results.length}`);
  console.log(`Auth but empty/broken catalog: ${authOnly.length}`);
  console.log(`Auth failed: ${failed.length}`);
  console.log(`Wrote ${RESULTS_OUT}`);
  console.log(`Wrote ${SUMMARY_OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
