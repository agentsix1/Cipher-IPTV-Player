import { get, post, del } from '../api.js';
import { h, toast } from '../util.js';
import { navigate, setNavHints, device } from '../app.js';
import { focusEl } from '../nav.js';
import { playerLog } from '../player-debug.js';
import { proxiedLogo, defaultLogoUrl } from '../chlogo.js';
import { cipherMark, svgIcon, ICONS, applyHubHighlight } from '../theme.js';
import {
  recentCard, forYouCard, paintStrip, openItem, progressLabel, episodeBits,
  itemKey, sameItem, liveProgressNow, liveEnded, hasLiveEpg,
} from './home-cards.js';

function continueArt(item) {
  const name = item.title || '';
  const live = item.kind === 'live' || item.kind === 'catchup';
  const showArt = live && (item.backdrop || (item.poster && item.poster !== item.logo));
  const src = item.backdrop || item.poster || item.logo || '';
  const img = h('img', {
    alt: '',
    referrerpolicy: 'no-referrer',
    onerror: (e) => {
      if (live && !showArt) {
        const fallback = defaultLogoUrl(item.subtitle || name);
        if (e.target.src !== fallback) e.target.src = fallback;
      } else e.target.style.opacity = '0';
    },
  });
  if (live && !showArt) img.classList.add('is-logo');
  if (src) {
    img.src = (live && !showArt) ? proxiedLogo(src, item.subtitle || name) : src;
  } else if (live) {
    img.src = defaultLogoUrl(item.subtitle || name);
  }
  return h('div.hub-continue-art', {}, img);
}

function pill(icon, label, cls, attrs) {
  return h(`button.focusable.${cls}`, { type: 'button', ...attrs }, svgIcon(icon, { filled: cls.includes('hub-resume') }), h('span', { text: label }));
}

function canShowContinue(item) {
  const title = String((item && item.title) || '').trim();
  if (!item || !title) return false;
  if (/^(untitled\b.*|n\/?a|unknown|movie|video|null|undefined)$/i.test(title)) return false;
  return true;
}

function continueSection(item, { onBookmark, autofocus = false }) {
  const resume = pill(ICONS.play, 'Resume', 'hub-resume', {
    ...(autofocus ? { 'data-autofocus': true } : {}),
    onclick: () => openItem(item),
  });
  const bookmark = pill(ICONS.bookmark, item.bookmarked ? 'Bookmarked' : 'Bookmark', 'hub-bookmark', {
    onclick: () => onBookmark(item, bookmark),
  });
  bookmark.classList.toggle('on', !!item.bookmarked);
  const plot = item.plot ? h('p.hub-plot', { text: item.plot }) : null;
  const epgLive = item.kind === 'live' && hasLiveEpg(item);
  const liveNow = item.kind === 'live' ? (epgLive ? liveProgressNow(item) : null) : item.progress;
  const meta = progressLabel(item);
  const metaRow = (meta || epgLive)
    ? h('div.hub-progress-meta', {},
      meta ? h('span.hub-progress-meta-text', { text: meta }) : null,
      epgLive ? h('span.hub-live-badge', { text: 'LIVE' }) : null,
    )
    : null;
  const bar = liveNow
    ? h('div.hub-progress', {}, h('span', { style: `width:${Math.round(liveNow.fraction * 100)}%` }))
    : null;
  const sub = episodeBits(item) || item.subtitle || '';
  return h('section.hub-continue', {},
    continueArt(item),
    h('div.hub-continue-copy', {},
      h('div.hub-kicker', { text: 'Continue Watching' }),
      h('h2.hub-continue-title', { text: item.title || 'Continue watching' }),
      sub ? h('div.hub-sub', { text: sub }) : null,
      plot,
      metaRow,
      bar,
      h('div.hub-actions', {}, resume, bookmark),
    ),
  );
}

function rowSection(title, seeAllRoute, strip, extraClass = '') {
  return h(`section.hub-row${extraClass ? `.${extraClass}` : ''}`, {},
    h('div.hub-row-head', {},
      h('h2.hub-row-title', { text: title }),
      h('button.hub-see-all.focusable', {
        type: 'button',
        'data-nav-skip': '1',
        onclick: () => navigate(seeAllRoute),
      }, 'See All ', h('span.chev', { text: '>' })),
    ),
    strip,
  );
}

function setBookmarkLabel(btn, on) {
  const label = btn.querySelector('span');
  if (label) label.textContent = on ? 'Bookmarked' : 'Bookmark';
  btn.classList.toggle('on', on);
}

function rowCards(row) {
  return row ? [...row.querySelectorAll('.hub-card')] : [];
}

function rememberedRecent(recentCards, selected) {
  if (selected) {
    const key = itemKey(selected);
    const match = recentCards.find((el) => el.dataset.hubKey === key);
    if (match) return match;
  }
  return recentCards[0] || null;
}

function moveHubFocus(page, action, selected) {
  const active = document.activeElement;
  if (!active || !page.contains(active)) return false;

  const recentRow = page.querySelector('.hub-row.recent');
  const forYouRow = page.querySelector('.hub-row.foryou');
  const recentCards = rowCards(recentRow);
  const forYouCards = rowCards(forYouRow);
  const recentSee = recentRow && recentRow.querySelector('.hub-see-all');
  const forYouSee = forYouRow && forYouRow.querySelector('.hub-see-all');
  const resume = page.querySelector('.hub-resume');
  const bookmark = page.querySelector('.hub-bookmark');
  const lastRecent = rememberedRecent(recentCards, selected);
  const go = (el) => {
    if (!el) return false;
    focusEl(el);
    return true;
  };

  if (active === recentSee) {
    if (action === 'left') return go(recentCards[recentCards.length - 1]) || true;
    if (action === 'down') return go(forYouCards[0]) || true;
    if (action === 'up') return go(resume || bookmark) || false;
    return true;
  }
  if (active === forYouSee) {
    if (action === 'left') return go(forYouCards[forYouCards.length - 1]) || true;
    if (action === 'up') return go(lastRecent) || true;
    return true;
  }

  const recentAt = recentCards.indexOf(active);
  if (recentAt >= 0) {
    if (action === 'right') {
      if (recentAt < recentCards.length - 1) return go(recentCards[recentAt + 1]);
      return go(recentSee) || true;
    }
    if (action === 'left') return recentAt > 0 ? go(recentCards[recentAt - 1]) : true;
    if (action === 'down') return go(forYouCards[0]) || true;
    if (action === 'up') return go(resume || bookmark) || false;
    return true;
  }

  const forYouAt = forYouCards.indexOf(active);
  if (forYouAt >= 0) {
    if (action === 'right') {
      if (forYouAt < forYouCards.length - 1) return go(forYouCards[forYouAt + 1]);
      return go(forYouSee) || true;
    }
    if (action === 'left') return forYouAt > 0 ? go(forYouCards[forYouAt - 1]) : true;
    if (action === 'up') return go(lastRecent) || true;
    return true;
  }

  if (active === resume || active === bookmark) {
    if (action === 'right' && active === resume) return go(bookmark) || true;
    if (action === 'left' && active === bookmark) return go(resume) || true;
    if (action === 'down') return go(lastRecent) || true;
    if (action === 'up') return false;
    return true;
  }

  return false;
}

async function toggleBookmark(item, btn) {
  const body = {
    kind: item.kind,
    itemId: item.bookmarkId || item.itemId,
    sourcePlaylistId: item.sourcePlaylistId || '',
    episodeId: item.episodeId || '',
    season: item.season || 0,
    episode: item.episode || 0,
    title: item.title || '',
    subtitle: item.subtitle || '',
    poster: item.poster || item.logo || '',
    start: item.start || 0,
    end: item.end || 0,
  };
  try {
    if (item.bookmarked) await del('/bookmarks', body);
    else await post('/bookmarks', body);
    item.bookmarked = !item.bookmarked;
    setBookmarkLabel(btn, item.bookmarked);
  } catch (err) {
    toast(err.message || 'Bookmark failed', { error: true });
  }
}

export async function mount(root) {
  let playlists = [];
  try {
    playlists = await get('/playlists');
  } catch {
    playlists = [];
  }
  if (!playlists.length) {
    playerLog('home.empty', 'no playlists → settings?add=1');
    navigate('settings?add=1', { replace: true });
    return {};
  }

  let settings = {};
  let summary = { hasVod: false, loading: true, movies: 0, series: 0, supported: true };
  let home = { continue: null, recent: [], forYou: [] };
  try {
    const [s, v, hdata] = await Promise.all([
      get('/settings').catch(() => ({})),
      get('/vod/summary').catch(() => summary),
      get('/home').catch(() => home),
    ]);
    settings = s || {};
    summary = v || summary;
    home = hdata || home;
  } catch {
    /* empty hub */
  }

  applyHubHighlight(settings.hubHighlight);
  setNavHints({ vod: summary, alwaysShowChannels: !!settings.alwaysShowChannels });

  const continueHost = h('div.hub-continue-host');
  const recentStrip = h('div.hub-strip.hub-strip-recent');
  const forYouStrip = h('div.hub-strip.hub-strip-wide');
  let selected = null;
  let recents = [];
  let pointerArmedKey = '';

  const syncSelectedClass = () => {
    const key = itemKey(selected);
    for (const el of recentStrip.querySelectorAll('.hub-card-recent')) {
      el.classList.toggle('is-selected', el.dataset.hubKey === key);
    }
  };

  const paintContinue = (item, { autofocus = false } = {}) => {
    selected = item;
    continueHost.replaceChildren();
    if (canShowContinue(item)) {
      continueHost.append(continueSection(item, { onBookmark: toggleBookmark, autofocus }));
    }
    syncSelectedClass();
  };

  const bindRecent = () => {
    paintStrip(recentStrip, recents, (item) => recentCard(item, {
      selected: sameItem(selected, item),
      onSelect: (next, { openIfSame } = {}) => {
        const key = itemKey(next);
        if (openIfSame && pointerArmedKey === key && sameItem(selected, next)) {
          openItem(next);
          return;
        }
        if (openIfSame) pointerArmedKey = key;
        if (sameItem(selected, next) && selected.title === next.title) {
          syncSelectedClass();
          return;
        }
        paintContinue(next);
      },
      onOpen: (next) => openItem(next),
    }));
  };

  const paintHome = (data, { keepSelection = false } = {}) => {
    home = data || home;
    recents = (home.recent || []).slice(0, 5);
    if (keepSelection && selected) {
      selected = recents.find((item) => sameItem(item, selected)) || recents[0] || home.continue || null;
    } else {
      selected = recents[0] || home.continue || null;
    }
    paintContinue(selected, { autofocus: !keepSelection });
    bindRecent();
    paintStrip(forYouStrip, (home.forYou || []).slice(0, 4), (item) => forYouCard(item, {
      onSelect: (next, { openIfSame } = {}) => {
        const key = itemKey(next);
        if (openIfSame && pointerArmedKey === key) {
          openItem(next);
          return;
        }
        if (openIfSame) pointerArmedKey = key;
      },
      onOpen: (next) => openItem(next),
    }));
  };
  paintHome(home);

  const page = h(`div.hub-page${device === 'phone' ? '.is-phone' : '.is-fit'}`, {},
    device === 'phone' ? h('div.hub-brand', {}, cipherMark()) : null,
    continueHost,
    rowSection('Recently Watched', 'recent', recentStrip, 'recent'),
    rowSection('For You', 'foryou', forYouStrip, 'foryou'),
  );
  root.append(page);
  const lockHubScroll = () => {
    page.scrollTop = 0;
    page.scrollLeft = 0;
    const app = document.getElementById('app');
    if (app) {
      app.scrollTop = 0;
      app.scrollLeft = 0;
    }
    const view = root.closest('.view') || root;
    view.scrollTop = 0;
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  };
  page.addEventListener('focusin', lockHubScroll);
  page.addEventListener('scroll', lockHubScroll);

  const applyLiveProgress = () => {
    for (const item of recents) {
      if (item.kind !== 'live') continue;
      const p = liveProgressNow(item);
      if (!p) continue;
      item.progress = p;
      const card = recentStrip.querySelector(`[data-hub-key="${CSS.escape(itemKey(item))}"]`);
      if (card) {
        const fill = card.querySelector('.hub-card-progress > span');
        if (fill) fill.style.width = `${Math.round(p.fraction * 100)}%`;
      }
      if (sameItem(selected, item)) {
        selected.progress = p;
        const fill = continueHost.querySelector('.hub-progress > span');
        if (fill) fill.style.width = `${Math.round(p.fraction * 100)}%`;
        const meta = continueHost.querySelector('.hub-progress-meta-text');
        if (meta) meta.textContent = progressLabel(item);
      }
    }
  };

  let poll = null;
  let liveTimer = null;
  let unmounted = false;
  let liveTicks = 0;
  liveTimer = setInterval(async () => {
    if (unmounted) return;
    applyLiveProgress();
    liveTicks += 1;
    const showChanged = recents.some(liveEnded);
    const periodic = liveTicks % 8 === 0 && recents.some((item) => item.kind === 'live');
    if (!showChanged && !periodic) return;
    try {
      const data = await get('/home');
      if (unmounted) return;
      paintHome(data, { keepSelection: true });
    } catch { /* keep current cards */ }
  }, 12000);

  if (summary.loading) {
    const again = async () => {
      if (unmounted) return;
      try {
        summary = await get('/vod/summary');
      } catch {
        return;
      }
      if (unmounted) return;
      setNavHints({ vod: summary });
      if (!summary.loading) {
        try {
          paintHome(await get('/home'), { keepSelection: true });
        } catch { /* keep first paint */ }
        return;
      }
      poll = setTimeout(again, 2500);
    };
    poll = setTimeout(again, 2500);
  }

  return {
    onKey(action) {
      if (!['up', 'down', 'left', 'right'].includes(action)) return false;
      return moveHubFocus(page, action, selected);
    },
    onBack() {
      // Stay on Home — ignore Back / Backspace.
      return true;
    },
    unmount() {
      unmounted = true;
      clearTimeout(poll);
      clearInterval(liveTimer);
    },
  };
}
