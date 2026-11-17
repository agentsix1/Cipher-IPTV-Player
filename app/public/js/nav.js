/**
 * Remote / keyboard input: maps key events to actions and provides spatial (D-pad) focus movement.
 */

const KEYS = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'enter',
  NumpadEnter: 'enter',
  Escape: 'back',
  GoBack: 'back',
  BrowserBack: 'back',
  MediaPlayPause: 'playpause',
  MediaPlay: 'playpause',
  MediaPause: 'playpause',
  MediaFastForward: 'ff',
  MediaRewind: 'rew',
  MediaTrackNext: 'ff',
  MediaTrackPrevious: 'rew',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  ChannelUp: 'pageup',
  ChannelDown: 'pagedown',
  ContextMenu: 'menu',
};

const KEYCODES = { 37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'enter', 23: 'enter', 27: 'back', 179: 'playpause', 33: 'pageup', 34: 'pagedown', 93: 'menu' };

/**
 * Modal layers (context menus, dialogs). While one is open it receives every key action and Back
 * before the current view does.
 */
const modals = [];

export function pushModal(modal) {
  modals.push(modal);
  return () => {
    const i = modals.indexOf(modal);
    if (i >= 0) modals.splice(i, 1);
  };
}

export function topModal() {
  return modals[modals.length - 1] || null;
}

export function closeModals() {
  while (modals.length) {
    const modal = modals[modals.length - 1];
    if (modal.close) modal.close();
    if (modals[modals.length - 1] === modal) modals.pop();
  }
}

export function isTextInput(el) {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  return !['checkbox', 'radio', 'button', 'submit', 'range'].includes(el.type);
}

export function keyAction(e) {
  let action = KEYS[e.key] || KEYCODES[e.keyCode] || null;
  if (e.key === 'Backspace' && !isTextInput(document.activeElement)) action = 'back';
  if ((e.key === ' ' || e.code === 'Space') && !isTextInput(document.activeElement)) action = 'playpause';
  if ((e.key === 'm' || e.key === 'M') && !isTextInput(document.activeElement)) action = 'mute';
  return action;
}

function visible(el) {
  if (el.disabled || el.getAttribute('aria-hidden') === 'true') return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

function navSkip(el) {
  return !!(el.closest && el.closest('[data-nav-skip]'));
}

export function focusables(root = document) {
  return [...root.querySelectorAll('.focusable, input, select, button')].filter((el) => visible(el) && !navSkip(el));
}

export function focusEl(el) {
  if (!el) return;
  el.classList.add('kb-focus');
  el.focus({ preventScroll: true });
  if (!el.closest('.hub-page.is-fit')) {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

export function focusFirst(root = document) {
  const first = root.querySelector('[data-autofocus]') || focusables(root)[0];
  focusEl(first);
  return first;
}

/** Moves focus to the nearest focusable element in the given direction. Returns true if focus moved. */
export function moveFocus(dir, root = document) {
  const items = focusables(root);
  const current = document.activeElement;
  if (!current || !items.includes(current)) {
    if (items[0]) {
      focusEl(items[0]);
      return true;
    }
    return false;
  }
  const from = current.getBoundingClientRect();
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  let best = null;
  let bestScore = Infinity;

  for (const el of items) {
    if (el === current) continue;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    let primary;
    let secondary;
    if (dir === 'up') {
      if (r.bottom > from.top + 1) continue;
      primary = from.top - r.bottom;
      secondary = Math.abs(x - cx);
    } else if (dir === 'down') {
      if (r.top < from.bottom - 1) continue;
      primary = r.top - from.bottom;
      secondary = Math.abs(x - cx);
    } else if (dir === 'left') {
      if (r.right > from.left + 1) continue;
      primary = from.left - r.right;
      secondary = Math.abs(y - cy);
    } else {
      if (r.left < from.right - 1) continue;
      primary = r.left - from.right;
      secondary = Math.abs(y - cy);
    }
    const score = primary + secondary * 2;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }

  if (best) {
    focusEl(best);
    return true;
  }
  return false;
}

// Drop the keyboard focus ring when the user switches to mouse/touch.
document.addEventListener('pointerdown', () => {
  document.querySelectorAll('.kb-focus').forEach((el) => el.classList.remove('kb-focus'));
}, true);
