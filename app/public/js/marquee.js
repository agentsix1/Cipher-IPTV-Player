/**
 * "Allow Scrolling Text": channel, group and show names that do not fit their box scroll right-to-left
 * to reveal the rest, snap back, wait, then scroll again.
 *
 * Only names that are on screen and overflowing are animated. Every animation is pinned to one
 * shared start time, so lists that re-render (the TV Guide redraws rows constantly) pick up at the
 * same point instead of restarting.
 */

const SELECTOR = [
  '.list-item .name',
  '.epg-ch .nm',
  '.s-channel .s-text .n',
  '.s-group .s-text .n',
  '.s-show .s-text .n',
  '.s-show .s-text .m',
  '.epg-result .epg-text .n',
].join(', ');

const SPEED_PX_S = 45;
const WAIT_MS = 5000;
const END_HOLD_MS = 1200;
const MIN_SCROLL_MS = 1200;
const EPOCH = performance.now() - (WAIT_MS - 1500); // first scroll starts ~1.5 s after load

let enabled = false;
let mutations = null;
let visibility = null;
let scanQueued = false;
const running = new Map(); // element -> Animation

function inner(el) {
  const first = el.firstElementChild;
  if (first && first.classList.contains('mq-inner') && el.childNodes.length === 1) return first;
  const span = document.createElement('span');
  span.className = 'mq-inner';
  while (el.firstChild) span.append(el.firstChild);
  el.append(span);
  return span;
}

function unwrap(el) {
  const first = el.firstElementChild;
  if (!first || !first.classList.contains('mq-inner')) return;
  while (first.firstChild) el.insertBefore(first.firstChild, first);
  first.remove();
}

function start(el) {
  if (!enabled || !el.isConnected) return;
  if (running.has(el)) return;
  if (!el.firstElementChild?.classList.contains('mq-inner') && el.scrollWidth <= el.clientWidth + 1) return;
  const span = inner(el);
  const distance = Math.ceil(span.getBoundingClientRect().width - el.clientWidth);
  if (distance <= 1) {
    unwrap(el);
    return;
  }
  const scroll = Math.max(MIN_SCROLL_MS, (distance / SPEED_PX_S) * 1000);
  const total = WAIT_MS + scroll + END_HOLD_MS;
  const end = `translateX(${-distance}px)`;
  const anim = span.animate([
    { transform: 'translateX(0)', offset: 0 },
    { transform: 'translateX(0)', offset: WAIT_MS / total },
    { transform: end, offset: (WAIT_MS + scroll) / total },
    { transform: end, offset: 1 },
  ], { duration: total, iterations: Infinity, easing: 'linear' });
  anim.startTime = EPOCH;
  el.classList.add('mq-on');
  running.set(el, anim);
}

function stop(el, { restore = false } = {}) {
  const anim = running.get(el);
  if (anim) anim.cancel();
  running.delete(el);
  el.classList.remove('mq-on');
  if (restore) unwrap(el);
}

function scan() {
  scanQueued = false;
  if (!enabled) return;
  for (const [el] of running) if (!el.isConnected) running.delete(el);
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (el.dataset.mq === '1') continue;
    el.dataset.mq = '1';
    if (el.scrollWidth <= el.clientWidth + 1) {
      unwrap(el);
      continue;
    }
    visibility.observe(el);
  }
}

// Batched: lists re-render constantly while scrolling (the TV Guide on every frame), and scanning on
// each change would compete with the scroll for the main thread.
const SCAN_DELAY_MS = 250;
function queueScan() {
  if (scanQueued || !enabled) return;
  scanQueued = true;
  setTimeout(scan, SCAN_DELAY_MS);
}

let resizeTimer = null;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const el of [...running.keys()]) stop(el, { restore: true });
    queueScan();
  }, 250);
}

export function setScrollingText(on) {
  on = !!on;
  if (on === enabled) return;
  enabled = on;
  document.documentElement.classList.toggle('mq-enabled', on);
  if (on) {
    visibility = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.target.isConnected) {
          visibility.unobserve(e.target);
          stop(e.target);
        } else if (e.isIntersecting) start(e.target);
        else stop(e.target);
      }
    });
    mutations = new MutationObserver(queueScan);
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', onResize);
    queueScan();
  } else {
    if (mutations) mutations.disconnect();
    if (visibility) visibility.disconnect();
    mutations = null;
    visibility = null;
    window.removeEventListener('resize', onResize);
    for (const el of [...running.keys()]) stop(el, { restore: true });
    for (const el of document.querySelectorAll('[data-mq]')) {
      unwrap(el);
      delete el.dataset.mq;
    }
  }
}
