import { get } from '../api.js';
import { h } from '../util.js';
import { topbar, seeAllOnKey } from './common.js';
import { paintGrid } from './home-cards.js';
import { applyHubHighlight } from '../theme.js';

export async function mount(root) {
  try {
    const s = await get('/settings');
    applyHubHighlight(s && s.hubHighlight);
  } catch { /* keep default */ }
  const grid = h('div.hub-grid.hub-grid-wide', {}, h('div.hub-empty', { text: 'Loading…' }));
  root.append(topbar('For You', { back: false }), h('div.scroll.hub-seeall', {}, grid));
  try {
    const data = await get('/home/foryou?limit=60');
    paintGrid(grid, (data && data.items) || [], { large: true, empty: 'Watch something to fill this list' });
  } catch (err) {
    paintGrid(grid, [], { large: true, empty: err.message || 'Could not load For You' });
  }
  return {
    onKey(action) {
      return seeAllOnKey(root, action);
    },
  };
}
