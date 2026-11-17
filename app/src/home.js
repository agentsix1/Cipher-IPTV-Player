'use strict';

const catalog = require('./catalog');
const playlists = require('./playlists');
const combined = require('./combined');
const groupPrefs = require('./groups');
const vod = require('./vod');
const history = require('./history');
const bookmarks = require('./bookmarks');
const meta = require('./meta');
const log = require('./log');

function epgOverride(prefs, channelId) {
  return Object.prototype.hasOwnProperty.call(prefs.epgMap, channelId) ? prefs.epgMap[channelId] : undefined;
}

function channelShiftMs(playlist, prefs, channel) {
  const base = channel._shiftMs !== undefined ? channel._shiftMs : Math.round((Number(playlist.epg_shift_hours) || 0) * 3600000);
  return base + Math.round((Number(prefs.epgShift[channel.id]) || 0) * 3600000);
}

function listPrefs(userId, playlist, state) {
  const prefs = groupPrefs.get(userId, playlist.id);
  return state && state.combined ? combined.inheritPrefs(prefs, state, (id) => groupPrefs.get(userId, id)) : prefs;
}

function programmeAt(list, shift, t) {
  if (!list || !list.length) return null;
  for (const p of list) {
    const start = p[0] + shift;
    const end = p[1] + shift;
    if (end <= t) continue;
    if (start > t) break;
    if (start <= t && t < end) {
      return { title: p[2], start, end, plot: p[3] || '' };
    }
  }
  return null;
}

function findChannel(state, itemId) {
  if (!state || !state.byId) return null;
  const raw = String(itemId || '');
  if (state.byId.has(raw)) return state.byId.get(raw);
  const bare = history.stripPrefix(raw);
  if (bare && state.byId.has(bare)) return state.byId.get(bare);
  if (state.combined) {
    for (const ch of state.channels) {
      if (ch._src === raw || ch._src === bare || ch.id === bare) return ch;
    }
  }
  return null;
}

function findVodItem(playlistId, kind, id) {
  const doc = vod.getMemory(playlistId) || vod.memoryOrDisk(playlistId);
  if (!doc) return null;
  const needle = String(id || '').replace(/^[mse]:/i, '');
  if (!needle) return null;
  const bucket = kind === 'series' ? doc.series : doc.movies;
  const extra = doc.searchExtra && doc.searchExtra[kind];
  return ((bucket && bucket.items) || []).find((i) => String(i.id) === needle)
    || (extra || []).find((i) => String(i.id) === needle)
    || null;
}

function vodSourceOf(userId, viewing, fallbackVod, sourcePlaylistId) {
  const asked = String(sourcePlaylistId || '');
  if (asked && asked !== combined.COMBINED_ID) {
    const row = playlists.getRow(userId, asked);
    if (row) return { playlist: row, state: catalog.getState(row.id) };
  }
  if (fallbackVod && fallbackVod.playlist) return fallbackVod;
  return { playlist: viewing.playlist, state: viewing.state };
}

function progressOf(position, duration, { allowEarly = false, fallbackDuration = 0 } = {}) {
  const pos = Math.max(0, Number(position) || 0);
  let dur = Math.max(0, Number(duration) || 0);
  if (!(dur > 1)) dur = Math.max(0, Number(fallbackDuration) || 0);
  if (!(dur > 1) && pos > 5) dur = Math.max(pos / 0.7, pos + 60);
  if (!(dur > 1) || (!allowEarly && pos < 8)) return null;
  if (pos > dur) dur = pos / 0.7;
  const fraction = Math.max(0, Math.min(1, pos / dur));
  if (fraction >= 0.97) return null;
  const watchedMin = Math.max(1, Math.round(pos / 60));
  const leftMin = Math.max(1, Math.round((dur - pos) / 60));
  return { position: pos, duration: dur, fraction, watchedMin, leftMin };
}

function progressEntry(map, ...keys) {
  if (!map) return null;
  for (const key of keys) {
    const id = String(key || '').trim();
    if (!id) continue;
    if (map.has(id)) return map.get(id);
  }
  return null;
}

function vodProgressFor(userId, playlistId, card) {
  if (!userId || !playlistId || !card) return null;
  const map = vod.progressMap(userId, playlistId);
  if (card.kind === 'series') {
    const sid = String(card.itemId || '').replace(/^s:/i, '');
    const eid = String(card.episodeId || '').replace(/^e:/i, '');
    const cont = progressEntry(map, `s:${sid}`, sid);
    const ep = progressEntry(map, eid ? `e:${eid}` : '', eid, cont && cont.extra);
    return ep || cont || null;
  }
  if (card.kind === 'movie') {
    const mid = String(card.itemId || '').replace(/^m:/i, '');
    return progressEntry(map, `m:${mid}`, mid);
  }
  return null;
}

function usableCard(card) {
  const title = String((card && card.title) || '').trim();
  if (!card || !title) return false;
  if (/^(untitled\b.*|n\/?a|unknown|movie|video|null|undefined)$/i.test(title)) return false;
  return true;
}

function qs(params) {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    out.set(key, String(value));
  }
  const text = out.toString();
  return text ? `?${text}` : '';
}

function hrefOf(card) {
  if (card.kind === 'live') return `player${qs({ ch: card.itemId })}`;
  if (card.kind === 'catchup') return `player${qs({ ch: card.channelId || card.itemId, start: card.start, end: card.end })}`;
  if (card.kind === 'movie') return `vodplay${qs({ id: `m:${card.itemId}`, kind: 'movies', playlist: card.sourcePlaylistId, title: card.title })}`;
  if (card.episodeId) {
    return `vodplay${qs({
      id: `e:${card.episodeId}`,
      series: card.itemId,
      kind: 'series',
      playlist: card.sourcePlaylistId,
      title: card.title,
    })}`;
  }
  return `shows${qs({ show: card.itemId, playlist: card.sourcePlaylistId })}`;
}

function episodeLine(season, episode, episodeTitle) {
  const bits = [];
  if (season) bits.push(`S${season}`);
  if (episode) bits.push(`E${episode}`);
  if (episodeTitle) bits.push(episodeTitle);
  return bits.join(' • ');
}

function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (err) {
        log.warn('Home card decorate failed', err);
        out[idx] = null;
      }
    }
  }
  const count = Math.max(1, Math.min(n, items.length || 1));
  return Promise.all(Array.from({ length: items.length ? count : 0 }, worker)).then(() => out.filter(Boolean));
}

function baseCard(row) {
  const extra = history.parseExtra(row);
  const catchup = row.kind === 'catchup' ? history.parseCatchupId(row.item_id) : null;
  return {
    kind: row.kind,
    itemId: catchup ? catchup.channelId : row.item_id,
    channelId: catchup ? catchup.channelId : (row.kind === 'live' ? row.item_id : ''),
    sourcePlaylistId: row.source_playlist_id || '',
    episodeId: row.episode_id || extra.episodeId || '',
    season: Number(row.season) || 0,
    episode: Number(row.episode) || 0,
    title: row.title || '',
    subtitle: row.subtitle || '',
    plot: extra.plot || '',
    genre: extra.genre || '',
    year: extra.year || '',
    rating: extra.rating || '',
    poster: row.poster || '',
    backdrop: extra.backdrop || '',
    logo: extra.logo || '',
    live: row.kind === 'live',
    bookmarkId: row.item_id,
    start: catchup ? catchup.start || Number(row.start_ms) || 0 : Number(row.start_ms) || 0,
    end: Number(row.end_ms) || 0,
    progress: row.kind === 'live' || row.kind === 'catchup' ? null : progressOf(row.position, row.duration, {
      allowEarly: true,
      fallbackDuration: row.kind === 'movie' ? 90 * 60 : 45 * 60,
    }),
    updatedAt: Number(row.updated_at) || 0,
    bookmarked: false,
  };
}

function looksLikeNamedShow(title, channelName) {
  const name = String(title || '').trim();
  if (name.length < 3) return false;
  const channel = String(channelName || '').trim();
  if (channel && name.toLowerCase() === channel.toLowerCase()) return false;
  if (/^(live|news|sports|weather|tbd|n\/?a|to be announced|paid programming|no info|unknown|sign off)$/i.test(name)) return false;
  return true;
}

async function decorateLive(card, row, ctx) {
  const { playlist, state, prefs } = ctx;
  const lookupId = row.kind === 'catchup' ? history.parseCatchupId(row.item_id).channelId : row.item_id;
  const ch = findChannel(state, lookupId);
  if (!ch) {
    card.title = card.title || 'Channel';
    card.subtitle = row.kind === 'catchup' ? 'Catch-up' : 'Live TV';
    card.href = hrefOf(card);
    return card;
  }
  card.itemId = ch.id;
  card.channelId = ch.id;
  card.sourcePlaylistId = ch._pl || card.sourcePlaylistId || playlist.id;
  const name = prefs.chNames[ch.id] || ch.name;
  const logo = prefs.chLogos[ch.id] || ch.logo || '';
  card.logo = logo;
  card.poster = card.poster || logo;
  const shift = channelShiftMs(playlist, prefs, ch);
  const progs = catalog.programmesFor(state, ch, epgOverride(prefs, ch.id));
  const at = row.kind === 'catchup'
    ? (Number(row.start_ms) || history.parseCatchupId(row.item_id).start || Date.now())
    : Date.now();
  const prog = programmeAt(progs, shift, at);
  if (prog) {
    card.title = prog.title || name;
    card.subtitle = row.kind === 'catchup' ? `${name} · Catch-up` : name;
    card.plot = card.plot || prog.plot || '';
    card.start = prog.start;
    card.end = prog.end;
    if (row.kind === 'live') {
      const span = Math.max(1, (prog.end - prog.start) / 1000);
      const pos = Math.max(0, (Date.now() - prog.start) / 1000);
      card.progress = progressOf(pos, span, { allowEarly: true });
    }
    if (looksLikeNamedShow(prog.title, name)) {
      try {
        const extra = await meta.tvmazeShow(prog.title);
        if (extra && (extra.backdrop || extra.poster)) {
          card.poster = extra.poster || extra.backdrop;
          card.backdrop = extra.backdrop || extra.poster;
          card.plot = card.plot || extra.plot || '';
          card.genre = card.genre || extra.genre || '';
        }
      } catch (err) {
        log.warn('Home live show art failed', err);
      }
    }
  } else {
    card.title = card.title || name;
    card.subtitle = row.kind === 'catchup' ? `${name} · Catch-up` : 'Live TV';
    card.start = 0;
    card.end = 0;
    card.progress = null;
  }
  card.live = row.kind === 'live';
  card.href = hrefOf(card);
  return card;
}

async function decorateVod(card, row, ctx, { deep }) {
  const src = vodSourceOf(ctx.userId, ctx.viewing, ctx.vod, row.source_playlist_id);
  card.sourcePlaylistId = src.playlist.id;
  const kind = row.kind === 'series' ? 'series' : 'movies';
  const item = findVodItem(src.playlist.id, kind, row.item_id);
  if (item) {
    card.title = card.title || item.name;
    card.poster = card.poster || item.poster || '';
    card.plot = card.plot || item.plot || '';
    card.genre = card.genre || item.genre || '';
    card.year = card.year || item.year || '';
  }
  if (deep) {
    try {
      const progress = vod.progressMap(ctx.userId, src.playlist.id);
      const detail = row.kind === 'series'
        ? await vod.seriesDetail(src.playlist, src.state, row.item_id, progress)
        : await vod.movieDetail(src.playlist, src.state, row.item_id, progress);
      if (detail) {
        card.title = detail.name || card.title;
        card.poster = detail.poster || card.poster;
        card.backdrop = detail.backdrop || card.backdrop || card.poster;
        card.plot = detail.plot || card.plot;
        card.genre = detail.genre || card.genre;
        card.year = detail.year || card.year;
        if (row.kind === 'series' && detail.resume) {
          card.episodeId = card.episodeId || detail.resume.episodeId;
          if (!card.progress) card.progress = progressOf(detail.resume.position, detail.resume.duration);
        } else if (detail.progress && !card.progress) {
          card.progress = progressOf(detail.progress.position, detail.progress.duration);
        }
        if (row.kind === 'series' && Array.isArray(detail.episodes) && card.episodeId) {
          const ep = detail.episodes.find((e) => String(e.id) === String(card.episodeId));
          if (ep) {
            card.season = card.season || ep.season;
            card.episode = card.episode || ep.episode;
            card.episodeTitle = ep.title || '';
            card.plot = card.plot || ep.plot || '';
            if (ep.poster) card.poster = card.poster || ep.poster;
          }
        }
      }
    } catch (err) {
      log.warn('Home VOD detail failed', err);
    }
  }
  if (row.kind === 'series') {
    card.episodeTitle = card.episodeTitle || '';
    card.subtitle = episodeLine(card.season, card.episode, card.episodeTitle) || card.subtitle || 'TV Show';
    if (card.title && (deep || !card.poster || !card.backdrop)) {
      try {
        const extra = await meta.tvmazeEpisode(card.title, card.season, card.episode);
        if (extra) {
          card.plot = card.plot || extra.episodePlot || extra.plot || '';
          card.poster = card.poster || extra.episodePoster || extra.poster || '';
          card.backdrop = extra.backdrop || card.backdrop || extra.poster || card.poster;
          card.genre = card.genre || extra.genre || '';
          card.year = card.year || extra.year || '';
          card.rating = card.rating || extra.rating || '';
          if (extra.episodeTitle) {
            card.episodeTitle = extra.episodeTitle;
            card.subtitle = episodeLine(card.season, card.episode, extra.episodeTitle);
          }
        }
      } catch (err) {
        log.warn('Home TVMaze fill failed', err);
      }
    }
  } else if (card.title && (deep || !card.poster || !card.backdrop)) {
    try {
      const extra = await meta.itunesMovie(card.title);
      if (extra) {
        card.poster = card.poster || extra.poster || '';
        card.backdrop = extra.backdrop || card.backdrop || extra.poster || card.poster;
        card.genre = card.genre || extra.genre || '';
        card.year = card.year || extra.year || '';
        card.rating = card.rating || extra.rating || '';
      }
    } catch (err) {
      log.warn('Home iTunes fill failed', err);
    }
  }
  if (!card.backdrop) card.backdrop = card.poster;
  card.subtitle = card.subtitle || (row.kind === 'series' ? 'TV Show' : 'Movie');
  const saved = vodProgressFor(ctx.userId, src.playlist.id, card)
    || vodProgressFor(ctx.userId, card.sourcePlaylistId, card)
    || vodProgressFor(ctx.userId, ctx.viewing.playlist.id, card);
  if (saved) {
    if (saved.extra && !card.episodeId && /^e:/i.test(saved.extra)) {
      card.episodeId = saved.extra.replace(/^e:/i, '');
    }
    card.progress = progressOf(saved.position, saved.duration, {
      allowEarly: true,
      fallbackDuration: row.kind === 'movie' ? 90 * 60 : 45 * 60,
    }) || card.progress;
  }
  card.href = hrefOf(card);
  return card;
}

async function decorate(row, ctx, { deep = false } = {}) {
  const card = baseCard(row);
  if (row.kind === 'live' || row.kind === 'catchup') return decorateLive(card, row, ctx);
  return decorateVod(card, row, ctx, { deep });
}

function markBookmarks(cards, bookmarkSet) {
  for (const card of cards) {
    const ids = [
      card.bookmarkId,
      card.itemId,
      card.kind === 'catchup' ? `${card.channelId}@${card.start}` : '',
    ].filter(Boolean);
    card.bookmarked = ids.some((id) => (
      bookmarkSet.has(`${card.kind}:${id}`) || bookmarkSet.has(history.identityKey(card.kind, id))
    ));
  }
  return cards;
}

function bookmarkSetOf(userId, playlistIds) {
  const set = new Set();
  for (const row of bookmarks.list(userId, playlistIds)) {
    set.add(`${row.kind}:${row.item_id}`);
    set.add(history.identityKey(row.kind, row.item_id));
  }
  return set;
}

async function build(userId, viewing, vodCtx, { recentLimit = 12, forYouLimit = 12, recentOnly = false, forYouOnly = false } = {}) {
  history.seedFromProgress(userId);
  const playlistIds = history.scopeIds(userId, viewing.playlist);
  const prefs = listPrefs(userId, viewing.playlist, viewing.state);
  const ctx = {
    userId,
    viewing,
    playlist: viewing.playlist,
    state: viewing.state,
    prefs,
    vod: vodCtx,
  };
  const marks = bookmarkSetOf(userId, playlistIds);

  if (recentOnly) {
    const rows = history.recent(userId, playlistIds, recentLimit);
    const cards = await mapLimit(rows, 4, (row) => decorate(row, ctx, { deep: false }));
    return { items: markBookmarks(cards.filter(usableCard), marks) };
  }
  if (forYouOnly) {
    const rows = history.forYou(userId, playlistIds, forYouLimit);
    const cards = await mapLimit(rows, 4, (row) => decorate(row, ctx, { deep: false }));
    return { items: markBookmarks(cards.filter(usableCard), marks) };
  }

  const recentRows = history.recent(userId, playlistIds, Math.max(recentLimit * 2, 12));
  const forYouRows = history.forYou(userId, playlistIds, Math.max(forYouLimit * 2, 8));
  const recent = (await mapLimit(recentRows, 4, (row) => decorate(row, ctx, { deep: true }))).filter((card) => usableCard(card));
  const forYouCards = (await mapLimit(forYouRows, 4, (row) => decorate(row, ctx, { deep: false }))).filter((card) => usableCard(card));
  const continueCard = recent[0] || null;
  markBookmarks(continueCard ? [continueCard] : [], marks);
  markBookmarks(recent, marks);
  markBookmarks(forYouCards, marks);
  return {
    continue: continueCard,
    recent: recent.slice(0, recentLimit),
    forYou: forYouCards.slice(0, forYouLimit),
    bookmarks: [...marks],
  };
}

function watchFromVodProgress(userId, viewingPlaylistId, sourcePlaylistId, body) {
  const itemId = String((body && body.itemId) || '');
  if (!itemId) return;
  const payload = {
    position: body.position,
    duration: body.duration,
    sourcePlaylistId,
    title: body.title,
    subtitle: body.subtitle,
    poster: body.poster,
    season: body.season,
    episode: body.episode,
    episodeId: body.episodeId,
    seriesId: body.seriesId,
    silent: !String(body.title || '').trim(),
  };
  if (!payload.title) {
    const kind = itemId.startsWith('m:') ? 'movies' : 'series';
    const id = itemId.replace(/^[mse]:/i, '');
    const item = findVodItem(sourcePlaylistId || viewingPlaylistId, kind, id)
      || findVodItem(viewingPlaylistId, kind, id);
    if (item) {
      payload.title = item.name || '';
      payload.poster = payload.poster || item.poster || '';
      payload.silent = !payload.title;
    }
  }
  const write = (playlistId) => {
    if (itemId.startsWith('m:')) {
      history.record(userId, playlistId, { ...payload, kind: 'movie', itemId });
      return;
    }
    if (body.seriesId || itemId.startsWith('s:') || itemId.startsWith('e:')) {
      history.record(userId, playlistId, {
        ...payload,
        kind: 'series',
        itemId: body.seriesId || itemId,
        seriesId: body.seriesId,
        episodeId: body.episodeId || (itemId.startsWith('e:') ? itemId.slice(2) : ''),
      });
    }
  };
  write(viewingPlaylistId);
  if (sourcePlaylistId && sourcePlaylistId !== viewingPlaylistId) write(sourcePlaylistId);
}

module.exports = { build, watchFromVodProgress, hrefOf };
