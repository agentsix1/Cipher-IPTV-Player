import { h } from './util.js';

/** Formats a signed seek amount for the tip (+15s, −1:00). */
export function fmtSeekDelta(ms) {
  const n = Math.round(Number(ms) || 0);
  if (!n) return '';
  const sign = n < 0 ? '−' : '+';
  const abs = Math.abs(n);
  const sec = Math.round(abs / 1000);
  if (sec < 60) return `${sign}${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${sign}${m}:${String(s).padStart(2, '0')}` : `${sign}${m}:00`;
}

/**
 * YouTube-style tip locked to the seek bar: hover timestamp, and ±delta while
 * arrow / ± buttons are bursting.
 */
export function createSeekTip(seekbar) {
  const deltaEl = h('div.seek-tip-delta');
  const timeEl = h('div.seek-tip-time');
  const tip = h('div.seek-tip', { hidden: true }, deltaEl, timeEl);
  seekbar.append(tip);
  seekbar.classList.add('has-seek-tip');

  let hideTimer = null;
  let mode = '';

  function place(frac) {
    const f = Math.max(0, Math.min(1, Number(frac) || 0));
    tip.style.left = `${f * 100}%`;
    // Keep the bubble on-screen at the ends of the bar.
    const shift = f < 0.06 ? '0%' : f > 0.94 ? '-100%' : '-50%';
    tip.style.transform = `translateX(${shift})`;
  }

  function clearHide() {
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  function showHover(frac, timeText) {
    if (mode === 'delta') return;
    clearHide();
    mode = 'hover';
    tip.hidden = false;
    tip.classList.remove('is-delta');
    deltaEl.textContent = '';
    timeEl.textContent = timeText || '';
    place(frac);
  }

  function showDelta(frac, timeText, deltaMs) {
    clearHide();
    mode = 'delta';
    tip.hidden = false;
    tip.classList.add('is-delta');
    deltaEl.textContent = fmtSeekDelta(deltaMs);
    timeEl.textContent = timeText || '';
    place(frac);
  }

  function hide({ delay = 0 } = {}) {
    clearHide();
    if (delay > 0) {
      hideTimer = setTimeout(() => {
        tip.hidden = true;
        tip.classList.remove('is-delta');
        mode = '';
        hideTimer = null;
      }, delay);
      return;
    }
    tip.hidden = true;
    tip.classList.remove('is-delta');
    mode = '';
  }

  return { showHover, showDelta, hide, get mode() { return mode; } };
}
