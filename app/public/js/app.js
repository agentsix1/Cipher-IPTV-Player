import { get } from './api.js';
import { keyAction, moveFocus, isTextInput, focusFirst, focusEl, topModal, closeModals } from './nav.js';
import { store } from './util.js';
import { cipherMark, svgIcon, ICONS, fmtNavClock, applyHubHighlight } from './theme.js';
import * as home from './views/home.js';
import * as login from './views/login.js';
import * as channels from './views/channels.js';
import * as guide from './views/guide.js';
import * as player from './views/player.js';
import * as settings from './views/settings.js';
import * as search from './views/search.js';
import * as vod from './views/vod.js';
import * as vodplay from './views/vodplay.js';
import * as recents from './views/recents.js';
import * as foryou from './views/foryou.js';
import { setScrollingText } from './marquee.js';
import { installDebugSystem, playerLog, setDebugOverlay } from './player-debug.js';

const ROUTES = {
  home, login, setup: login, channels, guide, player, settings, search, vod, vodplay,
  recent: recents, foryou,
  movies: { mount: (root, params) => vod.mount(root, { ...params, kind: 'movies' }) },
  shows: { mount: (root, params) => vod.mount(root, { ...params, kind: 'series' }) },
};

export const session = { mode: 'web', user: null, needsSetup: false, version: '' };

let current = null;
let currentName = null;
let renderToken = 0;
const history = [];
let backPending = false;

function detectDevice() {
  const params = new URLSearchParams(location.search);
  const fromHost = params.get('device');
  if (fromHost) store.set('device', fromHost);
  // A server started with --ui=phone|tv (e.g. the phone test server) fixes the layout.
  const forced = document.documentElement.dataset.ui;
  let device = fromHost || forced || store.get('device');
  if (!device) {
    const ua = navigator.userAgent;
    const small = Math.min(screen.width, screen.height) < 600;
    if (/Android TV|AFT|BRAVIA|SMART-TV|SmartTV|GoogleTV/i.test(ua)) device = 'tv';
    else if (small && navigator.maxTouchPoints > 0) device = 'phone';
    else device = 'desktop';
  }
  document.documentElement.classList.add(`device-${device}`);
  return device;
}

export const device = detectDevice();
applyHubHighlight();

// ---------- phone tab bar ----------
const TAB_ICONS = {
  home: ICONS.home,
  guide: ICONS.guide,
  channels: ICONS.channels,
  search: ICONS.search,
  settings: ICONS.settings,
  movies: ICONS.movies,
  shows: ICONS.shows,
};
let tabbar = null;
let tabSignature = '';

function phoneTabs() {
  const vodInfo = session.vod;
  const showVod = !!(vodInfo && (vodInfo.supported || vodInfo.hasVod || vodInfo.loading));
  const tabs = [
    { route: 'home', label: 'Home' },
    { route: 'guide', label: 'Guide' },
  ];
  if (!vodInfo || !vodInfo.hasVod || session.alwaysShowChannels) tabs.push({ route: 'channels', label: 'Channels' });
  if (showVod) {
    tabs.push({ route: 'movies', label: 'Movies' });
    tabs.push({ route: 'shows', label: 'Shows' });
  }
  tabs.push({ route: 'search', label: 'Search' }, { route: 'settings', label: 'Settings' });
  return tabs;
}

function tabRouteFor(name) {
  if (name === 'vod' || name === 'vodplay') {
    const q = new URLSearchParams((location.hash.split('?')[1]) || '');
    return q.get('kind') === 'series' ? 'shows' : 'movies';
  }
  if (name === 'recent' || name === 'foryou') return 'home';
  return name;
}

export function setNavHints(partial) {
  if (partial.vod !== undefined) session.vod = partial.vod;
  if (partial.alwaysShowChannels !== undefined) session.alwaysShowChannels = !!partial.alwaysShowChannels;
  if (currentName) {
    syncTabbar(currentName);
    syncAppnav(currentName);
  }
}

function navItems() {
  return phoneTabs().map((t) => (t.route === 'guide' ? { ...t, label: 'TV Guide' } : t));
}

function isMainRoute(name) {
  const tabs = phoneTabs();
  return tabs.some((t) => t.route === name)
    || name === 'vod' || name === 'vodplay' || name === 'movies' || name === 'shows'
    || name === 'recent' || name === 'foryou';
}

let appnav = null;
let appnavSig = '';
let appnavClock = null;
let appnavClockTimer = null;
let keepAppnavFocus = '';

function syncAppnav(name) {
  const items = navItems();
  const active = tabRouteFor(name);
  const show = device !== 'phone' && isMainRoute(name) && name !== 'vodplay' && name !== 'player';
  document.documentElement.classList.toggle('has-appnav', show);
  document.documentElement.classList.toggle('hub-theme', ['home', 'recent', 'foryou', 'guide', 'movies', 'shows'].includes(name));
  if (!show) {
    if (appnav) appnav.hidden = true;
    return;
  }
  const sig = items.map((t) => t.route).join(',');
  if (!appnav || appnavSig !== sig) {
    if (appnav) appnav.remove();
    appnavSig = sig;
    appnav = document.createElement('nav');
    appnav.id = 'appnav';
    const brand = document.createElement('button');
    brand.type = 'button';
    brand.className = 'appnav-brand';
    brand.tabIndex = -1;
    brand.setAttribute('data-nav-skip', '1');
    brand.append(cipherMark());
    brand.addEventListener('click', () => navigate('home'));
    appnav.append(brand);
    const links = document.createElement('div');
    links.className = 'appnav-links';
    for (const t of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'appnav-link focusable';
      btn.dataset.route = t.route;
      btn.append(svgIcon(ICONS[t.route] || ICONS.home), document.createTextNode(t.label));
      btn.addEventListener('click', () => {
        if (currentName === t.route) {
          if (current && current.onTabReselect) current.onTabReselect();
          return;
        }
        navigate(t.route);
      });
      links.append(btn);
    }
    appnav.append(links);
    const meta = document.createElement('div');
    meta.className = 'appnav-meta';
    meta.setAttribute('data-nav-skip', '1');
    meta.setAttribute('aria-hidden', 'true');
    const avatar = document.createElement('span');
    avatar.className = 'appnav-avatar';
    const initial = session.user && session.user.username ? session.user.username.slice(0, 1).toUpperCase() : '';
    if (initial) avatar.textContent = initial;
    else avatar.append(svgIcon(ICONS.person, { size: 18 }));
    appnavClock = document.createElement('div');
    appnavClock.className = 'appnav-clock';
    const wifi = document.createElement('span');
    wifi.className = 'appnav-wifi';
    wifi.append(svgIcon(ICONS.wifi, { size: 18 }));
    wifi.hidden = typeof navigator !== 'undefined' && navigator.onLine === false;
    meta.append(avatar, appnavClock, wifi);
    appnav.append(meta);
    document.body.append(appnav);
    if (!appnavClockTimer) {
      appnavClockTimer = setInterval(() => {
        if (appnavClock) appnavClock.textContent = fmtNavClock();
      }, 15000);
    }
  }
  appnav.hidden = false;
  if (appnavClock) appnavClock.textContent = fmtNavClock();
  for (const btn of appnav.querySelectorAll('.appnav-link')) {
    btn.classList.toggle('active', btn.dataset.route === active);
  }
}

function appnavLinkFor(name) {
  if (!appnav) return null;
  return appnav.querySelector(`.appnav-link[data-route="${tabRouteFor(name)}"]`);
}

function activateAppnavFromKeys() {
  const el = document.activeElement;
  if (!el || !el.classList.contains('appnav-link')) return;
  const route = el.dataset.route;
  if (!route) return;
  // Already on this tab (e.g. Up from Movies content onto Movies) — only highlight, don't navigate.
  if (route === currentName || tabRouteFor(currentName) === route) return;
  keepAppnavFocus = route;
  // Movies / Shows from another tab open the clean default catalog (never ?restore=1).
  if (route === 'movies' || route === 'shows') {
    navigate(route, { replace: true });
    return;
  }
  navigate(route);
}

function restoreAppnavFocus(name) {
  const link = appnavLinkFor(name);
  if (link) focusEl(link);
}

function syncTabbar(name) {
  const tabs = phoneTabs();
  const active = tabRouteFor(name);
  const show = device === 'phone' && isMainRoute(name);
  document.documentElement.classList.toggle('has-tabs', show);
  if (!show) return;
  const sig = tabs.map((t) => t.route).join(',');
  if (!tabbar || tabSignature !== sig) {
    if (tabbar) tabbar.remove();
    tabSignature = sig;
    tabbar = document.createElement('nav');
    tabbar.id = 'tabbar';
    for (const t of tabs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab';
      btn.dataset.route = t.route;
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${TAB_ICONS[t.route]}"/></svg><span>${t.label}</span>`;
      btn.addEventListener('click', () => {
        if (currentName === t.route) {
          if (current && current.onTabReselect) current.onTabReselect();
          return;
        }
        navigate(t.route);
      });
      tabbar.append(btn);
    }
    document.body.append(tabbar);
  }
  for (const btn of tabbar.children) btn.classList.toggle('active', btn.dataset.route === active);
}

let settingsApplied = false;
function applyUserSettings() {
  if (settingsApplied) return;
  settingsApplied = true;
  const pull = () => Promise.all([
    get('/settings').catch(() => null),
    get('/vod/summary').catch(() => null),
  ]).then(([s, vodInfo]) => {
    if (s) {
      setScrollingText(s.scrollingText !== false);
      session.alwaysShowChannels = !!s.alwaysShowChannels;
      applyHubHighlight(s.hubHighlight);
      if (s.debugOverlay) setDebugOverlay(true);
    }
    if (vodInfo) session.vod = vodInfo;
    if (currentName) {
      syncTabbar(currentName);
      syncAppnav(currentName);
    }
    if (vodInfo && vodInfo.loading) setTimeout(pull, 2500);
  }).catch(() => { settingsApplied = false; });
  pull();
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [name, query = ''] = raw.split('?');
  return { name: name || 'home', params: Object.fromEntries(new URLSearchParams(query)) };
}

export function navigate(path, { replace = false } = {}) {
  const hash = path.startsWith('#') ? path : `#/${path.replace(/^\//, '')}`;
  if (replace) location.replace(hash);
  else location.hash = hash;
}

/**
 * Fallback back when a view does not handle it.
 * Home / login / setup: ignore (do not leave the app).
 * Player routes: prefer browser history so playback returns to the prior screen.
 * Everything else: Home.
 */
export function goBack() {
  if (currentName === 'home' || currentName === 'login' || currentName === 'setup') return true;
  if (backPending) return true;
  backPending = true;
  setTimeout(() => { backPending = false; }, 1500);
  if (currentName === 'vodplay' || currentName === 'player') {
    if (history.length > 1) {
      history.pop();
      window.history.back();
    } else {
      navigate('home', { replace: true });
    }
    return true;
  }
  navigate('home', { replace: true });
  return true;
}

/**
 * Back action for on-screen buttons, remotes and the Android host: the current view gets the first chance.
 * `button: true` marks a click on the on-screen Back button.
 */
export function back({ button = false } = {}) {
  const modal = topModal();
  if (modal) {
    modal.onBack();
    return true;
  }
  if (current && current.onBack && current.onBack({ button })) return true;
  return goBack();
}

async function render() {
  const token = ++renderToken;
  backPending = false;
  let { name, params } = parseHash();

  if (session.mode === 'web' && !session.user) {
    name = session.needsSetup ? 'setup' : 'login';
  } else if (name === 'login' || name === 'setup') {
    name = 'home';
  }
  const view = ROUTES[name] || home;
  closeModals();
  const routeName = ROUTES[name] ? name : 'home';
  syncTabbar(routeName);
  syncAppnav(routeName);
  if (name !== 'login' && name !== 'setup') applyUserSettings();

  document.documentElement.classList.remove('vlc-native');
  if (current && current.unmount) {
    try {
      current.unmount();
    } catch (err) {
      playerLog('ui.unmount.error', err && err.message, {
        view: currentName,
        stack: err && err.stack ? String(err.stack).slice(0, 800) : null,
      }, { level: 'error' });
    }
  }
  current = null;

  const root = document.getElementById('app');
  const container = document.createElement('div');
  container.className = 'view';
  // Keep the previous screen (or the boot splash) visible until this view has painted.

  if (history[history.length - 1] !== location.hash) history.push(location.hash);
  if (history.length > 50) history.shift();

  currentName = name;
  playerLog('ui.route', name, { params, hash: location.hash });
  let instance;
  try {
    instance = await view.mount(container, { ...params, mode: name }) || {};
  } catch (err) {
    playerLog('ui.mount.error', err && err.message, {
      view: name,
      stack: err && err.stack ? String(err.stack).slice(0, 800) : null,
    }, { level: 'error' });
    container.innerHTML = `<div class="empty">Screen failed to load: ${err && err.message ? err.message : err}</div>`;
    instance = {};
  }
  if (token !== renderToken) {
    if (instance.unmount) instance.unmount();
    return;
  }
  root.replaceChildren(container);
  hideBootSplash();
  current = instance;
  const holdNav = keepAppnavFocus && tabRouteFor(routeName) === keepAppnavFocus;
  if (holdNav) {
    keepAppnavFocus = '';
    const restore = () => {
      if (token !== renderToken) return;
      restoreAppnavFocus(routeName);
    };
    requestAnimationFrame(() => {
      restore();
      requestAnimationFrame(restore);
    });
  } else if (!instance.manageFocus) {
    requestAnimationFrame(() => focusFirst(container));
  }
}

/** Re-mounts the current screen (e.g. after switching which playlist is shown). */
export function rerender() {
  settingsApplied = false;
  render();
}

export async function refreshSession() {
  Object.assign(session, await get('/session'));
}

function bootSplash() {
  return document.getElementById('boot-splash');
}

function setBootMessage(text) {
  const el = bootSplash();
  const msg = el && el.querySelector('.boot-msg');
  if (msg && text) msg.textContent = text;
}

function hideBootSplash() {
  const el = bootSplash();
  if (el) el.classList.add('is-hidden');
}

document.addEventListener('keydown', (e) => {
  const action = keyAction(e);
  if (!action) return;
  const modal = topModal();
  if (modal) {
    if (action === 'back') {
      if (isTextInput(document.activeElement) && e.key === 'Backspace') return;
      e.preventDefault();
      modal.onBack();
    } else if (modal.onKey(action, e)) {
      e.preventDefault();
    }
    return;
  }
  const active = document.activeElement;
  const inAppnav = !!(appnav && !appnav.hidden && appnav.contains(active));
  if (inAppnav && action === 'down') {
    const app = document.getElementById('app');
    const vodList = app && app.querySelector('.vod-cipher .vod-list');
    // Entering Movies / Shows from the nav always starts at the top (default), not a saved card.
    if (vodList) {
      vodList.scrollTop = 0;
      const first = vodList.querySelector('.vod-row .vod-card, .vod-cat-block .vod-card, .vod-card');
      if (first) {
        for (const el of vodList.querySelectorAll('.vod-card.on')) el.classList.remove('on');
        first.classList.add('on');
        e.preventDefault();
        focusEl(first);
        return;
      }
    }
    const into = app && (
      app.querySelector('.topbar-back')
      || app.querySelector('.hub-resume')
      || app.querySelector('.hub-card')
    );
    if (into) {
      e.preventDefault();
      focusEl(into);
      return;
    }
  }
  if (!inAppnav && current && current.onKey && current.onKey(action, e)) {
    e.preventDefault();
    return;
  }
  if (['up', 'down', 'left', 'right'].includes(action)) {
    if (isTextInput(active) && (action === 'left' || action === 'right')) return;
    if (active && active.tagName === 'SELECT' && (action === 'up' || action === 'down')) return;
    if (active && active.type === 'range' && (action === 'left' || action === 'right')) return;
    const focusRoot = document.documentElement.classList.contains('has-appnav')
      ? document.body
      : document.getElementById('app');
    if (moveFocus(action, focusRoot)) {
      e.preventDefault();
      // Only change screens when moving left/right across nav links — not when Up focuses the current tab.
      if (action === 'left' || action === 'right') activateAppnavFromKeys();
    }
    return;
  }
  if (action === 'back') {
    if (isTextInput(active) && e.key === 'Backspace') return;
    e.preventDefault();
    back();
  }
});

/** Called by the Android host when the hardware back button is pressed. Returns true if handled. */
window.__appBack = () => back();

window.addEventListener('hashchange', render);

// iOS Safari ignores user-scalable=no in the viewport tag; cancel its pinch gestures instead.
for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, (e) => e.preventDefault());

(async function boot() {
  installDebugSystem();
  setBootMessage('Connecting…');
  try {
    await refreshSession();
    playerLog('ui.session', session.mode || 'ok', {
      mode: session.mode,
      needsSetup: !!session.needsSetup,
      user: session.user && (session.user.id || session.user.name) || null,
      device,
    });
  } catch (err) {
    playerLog('ui.session.error', err && err.message, null, { level: 'error' });
    hideBootSplash();
    document.getElementById('app').innerHTML = `<div class="empty">Cannot reach the server: ${err.message}</div>`;
    return;
  }
  setBootMessage('Loading playlists…');
  render();
})();
