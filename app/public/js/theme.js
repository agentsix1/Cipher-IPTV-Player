import { h } from './util.js';

export const DEFAULT_HUB_HIGHLIGHT = '#c084fc';

export function parseHex(value) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(value || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return {
    hex: `#${m[1].toLowerCase()}`,
    r: (n >> 16) & 255,
    g: (n >> 8) & 255,
    b: n & 255,
  };
}

export function rgbToHex(r, g, b) {
  const byte = (n) => Math.max(0, Math.min(255, Number(n) || 0)).toString(16).padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

export function applyHubHighlight(hex) {
  const c = parseHex(hex) || parseHex(DEFAULT_HUB_HIGHLIGHT);
  const root = document.documentElement;
  root.style.setProperty('--hub-accent', c.hex);
  root.style.setProperty('--hub-accent-rgb', `${c.r}, ${c.g}, ${c.b}`);
  root.style.setProperty('--hub-accent-soft', `rgba(${c.r}, ${c.g}, ${c.b}, 0.18)`);
  root.style.setProperty('--hub-focus', c.hex);
  return c;
}

export function svgIcon(d, { filled = false, size = 22 } = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  if (filled) {
    path.setAttribute('fill', 'currentColor');
  } else {
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
  }
  svg.append(path);
  return svg;
}

export const ICONS = {
  home: 'M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z',
  guide: 'M4 7h16v11H4zM8 7v11M4 11h16M8 4h8',
  channels: 'M4 7h16M4 12h16M4 17h16',
  movies: 'M4 6h16v12H4zM8 6l2 3M12 6l2 3M16 6l2 3M8 18l2-3M12 18l2-3M16 18l2-3',
  shows: 'M4 8h16v10H4zM9 4l3 4 3-4M10 12l5 3-5 3z',
  search: 'M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM15.5 15.5 21 21',
  settings: 'M12 8.4a3.6 3.6 0 1 1 0 7.2 3.6 3.6 0 0 1 0-7.2zM12 3v2.2M12 18.8V21M4.6 6.1l1.6 1.6M17.8 16.3l1.6 1.6M3 12h2.2M18.8 12H21M4.6 17.9l1.6-1.6M17.8 7.7l1.6-1.6',
  play: 'M8 6.2v11.6a1 1 0 0 0 1.54.84l9.1-5.8a1 1 0 0 0 0-1.68l-9.1-5.8A1 1 0 0 0 8 6.2z',
  bookmark: 'M7 4.5h10a1 1 0 0 1 1 1V20l-6-3.4L6 20V5.5a1 1 0 0 1 1-1z',
  plus: 'M12 5v14M5 12h14',
  info: 'M12 11.2v5.3M12 7.8h.01M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z',
  wifi: 'M5 12.5a10 10 0 0 1 14 0M8.2 15.4a5.6 5.6 0 0 1 7.6 0M12 18.6h.01',
  person: 'M12 12a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8zM5.6 19.2a6.4 6.4 0 0 1 12.8 0',
};

export function cipherMark({ word = true } = {}) {
  return h('span.cipher-brand', { 'aria-label': 'Cipher' },
    h('span.cipher-mark', { 'aria-hidden': 'true' }),
    word ? h('span.cipher-word', { text: 'Cipher' }) : null,
  );
}

export function fmtNavClock(ms = Date.now()) {
  const d = new Date(ms);
  const day = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${day} • ${time}`;
}

export function timeAgo(ms) {
  const at = Number(ms) || 0;
  if (!at) return '';
  const mins = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
