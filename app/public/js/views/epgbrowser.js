import { get, put } from '../api.js';
import { h, toast, debounce, fmtRange, dayLabel } from '../util.js';
import { focusEl, pushModal, moveFocus, isTextInput } from '../nav.js';

/**
 * TV guide browser: pick a guide source (or all of them), search or scroll its channels and preview
 * their schedule. Opened for a channel it also assigns the chosen guide channel to it (or switches
 * back to automatic matching / turns the guide off). Resolves true when an assignment changed.
 * opts: { channel, source, onChanged(change) }
 */

const enc = encodeURIComponent;
const PAGE = 60;

export function openEpgBrowser({ channel = null, source = '', onChanged = () => {} } = {}) {
  return new Promise((resolve) => {
    const returnFocus = document.activeElement;
    const state = { source, sources: [], current: null, offset: 0, total: 0, selected: null, done: false };
    let req = 0;
    let previewReq = 0;

    const input = h('input.input.epg-search', {
      type: 'search',
      value: channel ? channel.originalName || channel.name : '',
      placeholder: channel ? 'Search guide channels' : 'Search this guide (or leave empty to browse)',
      maxlength: '120',
      enterkeyhint: 'search',
    });
    const chips = h('div.chips.epg-sources');
    const currentEl = h('div.epg-current');
    const status = h('div.dialog-hint.epg-status');
    const results = h('div.epg-results');
    const preview = h('div.epg-preview', {}, h('div.empty', { text: 'Select a guide channel to preview its schedule.' }));
    const autoBtn = channel && h('button.btn.small.focusable', { type: 'button', text: 'Automatic', title: 'Match this channel to the guide automatically' });
    const noneBtn = channel && h('button.btn.small.focusable', { type: 'button', text: 'No guide', title: 'Show "No Information" for this channel' });
    const closeBtn = h('button.btn.focusable', { type: 'button', text: 'Close' });
    const form = h('form.dialog.epg-dialog.epg-browser', { role: 'dialog' },
      h('h2', { text: channel ? `Guide for ${channel.name}` : 'TV guide sources' }),
      channel ? currentEl : null,
      chips,
      input,
      status,
      h('div.epg-browser-body', {}, results, preview),
      h('div.dialog-actions', {}, autoBtn, noneBtn, closeBtn));
    const backdrop = h('div.cm-backdrop.dim', {}, form);

    const finish = (changed) => {
      if (state.done) return;
      state.done = true;
      search.cancel();
      previewSoon.cancel();
      popModal();
      backdrop.remove();
      if (returnFocus && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
      resolve(changed);
    };

    const sourceName = (id) => (state.sources.find((s) => s.id === id) || {}).name || id;

    function describeCurrent() {
      const c = state.current;
      if (!c) return '';
      const from = (src) => (src && state.sources.length > 1 ? ` · ${src}` : '');
      if (c.mode === 'custom') return `Using: ${c.name}${from(c.source)}`;
      if (c.mode === 'none') return 'Guide is turned off for this channel';
      if (!c.autoId) return 'Automatic: no guide match found for this channel';
      return `Automatic: ${c.autoName}${c.autoHasData ? '' : ' · no schedule found'}`;
    }

    async function assign(key, label) {
      let res;
      try {
        res = await put(`/channels/${enc(channel.id)}`, { epgId: key });
      } catch (err) {
        toast(err.message, { error: true });
        return;
      }
      if (key === null) toast(`"${channel.name}" now uses the automatic guide match`);
      else if (key === '') toast(`Guide turned off for "${channel.name}"`);
      else if (res.reloading) toast(`Guide set to ${label}. Loading its schedule, this can take a minute…`, { ms: 6000 });
      else toast(`Guide set to ${label}`);
      finish(true);
      onChanged({ kind: 'epg', id: channel.id, reloading: !!res.reloading });
    }

    function renderChips() {
      chips.innerHTML = '';
      const total = state.sources.reduce((n, s) => n + (s.channels || 0), 0);
      const chip = (id, label, count, error) => {
        const b = h('button.chip.focusable', { type: 'button', 'data-source': id, title: error ? `Last load failed: ${error}` : null },
          h('span', { text: label }),
          count ? h('span.chip-count', { text: count.toLocaleString() }) : null,
          error ? h('span.chip-err', { text: '!' }) : null);
        b.classList.toggle('active', state.source === id);
        b.addEventListener('click', () => {
          if (state.source === id) return;
          state.source = id;
          renderChips();
          if (!channel) input.value = '';
          run();
        });
        return b;
      };
      chips.append(chip('', 'All sources', total, ''));
      for (const s of state.sources) chips.append(chip(s.id, s.name, s.channels, s.error));
    }

    function resultItem(entry) {
      const c = state.current;
      const using = c && c.mode === 'custom' && c.id.toLowerCase() === entry.key.toLowerCase();
      const detail = entry.hasData
        ? (entry.now ? `Now: ${entry.now}` : 'Schedule loaded')
        : channel ? 'Schedule loads after you pick it' : 'Not loaded (only guides used by your channels are kept)';
      const meta = [entry.id !== entry.name ? entry.id : '', !state.source && state.sources.length > 1 ? entry.sourceName : '', detail].filter(Boolean).join(' · ');
      const item = h('button.list-item.epg-result.focusable', { type: 'button', 'data-key': entry.key },
        entry.icon
          ? h('img.logo', { src: entry.icon, loading: 'lazy', alt: '', onerror: (e) => { e.target.style.visibility = 'hidden'; } })
          : h('span.ch-logo'),
        h('span.epg-text', {}, h('span.n', { text: entry.name }), h('span.m', { text: meta })),
        using ? h('span.tag.custom', { text: 'In use' }) : null);
      if (!entry.hasData) item.classList.add('no-data');
      item.addEventListener('focus', () => previewSoon(entry));
      item.addEventListener('pointerenter', () => previewSoon(entry));
      item.addEventListener('click', () => {
        if (channel) assign(entry.key, entry.name);
        else showPreview(entry);
      });
      return item;
    }

    const previewSoon = debounce((entry) => showPreview(entry), 250);

    async function showPreview(entry) {
      if (state.done || (state.selected && state.selected.key === entry.key)) return;
      state.selected = entry;
      for (const el of results.querySelectorAll('.epg-result')) el.classList.toggle('selected', el.dataset.key === entry.key);
      const id = ++previewReq;
      const head = h('div.epg-preview-head', {},
        entry.icon ? h('img.logo', { src: entry.icon, alt: '', onerror: (e) => { e.target.style.visibility = 'hidden'; } }) : null,
        h('div', {}, h('div.n', { text: entry.name }), h('div.m', { text: [entry.id, sourceName(entry.source)].join(' · ') })));
      const list = h('div.epg-preview-list', {}, h('div.empty', { text: 'Loading schedule…' }));
      const use = channel && h('button.btn.small.primary.focusable', { type: 'button', text: 'Use for this channel', onclick: () => assign(entry.key, entry.name) });
      preview.innerHTML = '';
      preview.append(head, use || '', list);
      let data;
      try {
        data = await get(`/epg/schedule?key=${enc(entry.key)}`);
      } catch (err) {
        if (id === previewReq) list.innerHTML = '';
        if (id === previewReq) list.append(h('div.empty', { text: err.message }));
        return;
      }
      if (id !== previewReq || state.done) return;
      list.innerHTML = '';
      if (!data.loaded) {
        list.append(h('div.empty', {
          text: channel
            ? 'This guide channel is not loaded yet. Choose it and its schedule is downloaded with the next guide refresh (started right away).'
            : 'Schedule not loaded. Only guide channels used by your playlist are kept; assign it to a channel to load it.',
        }));
        return;
      }
      if (!data.programmes.length) {
        list.append(h('div.empty', { text: 'No upcoming programmes in this guide.' }));
        return;
      }
      const now = Date.now();
      let day = '';
      for (const p of data.programmes) {
        const label = dayLabel(p.start);
        if (label !== day) {
          day = label;
          list.append(h('div.epg-preview-day', { text: label }));
        }
        const row = h('div.epg-preview-row', {},
          h('span.t', { text: fmtRange(p.start, p.end) }),
          h('span.n', { text: p.title, title: p.desc || null }));
        if (p.start <= now && p.end > now) row.classList.add('live');
        else if (p.end <= now) row.classList.add('past');
        list.append(row);
      }
    }

    async function run({ more = false } = {}) {
      const id = ++req;
      const offset = more ? state.offset + PAGE : 0;
      status.textContent = more ? 'Loading more…' : 'Searching…';
      const q = input.value.trim();
      let data;
      try {
        const params = `q=${enc(q)}&source=${enc(state.source)}&offset=${offset}&limit=${PAGE}${channel ? `&ch=${enc(channel.id)}` : ''}`;
        data = await get(`/epg/search?${params}`);
      } catch (err) {
        if (id === req) status.textContent = err.message;
        return;
      }
      if (id !== req || state.done) return;
      state.offset = offset;
      state.total = data.total;
      if (channel) {
        state.current = data.current;
        currentEl.textContent = describeCurrent();
        autoBtn.disabled = !state.current || state.current.mode === 'auto';
        noneBtn.disabled = !!state.current && state.current.mode === 'none';
      }
      const notes = [];
      const where = state.source ? sourceName(state.source) : `${state.sources.length > 1 ? 'all guides' : 'the guide'}`;
      if (q) notes.push(data.total ? `${data.total.toLocaleString()} match${data.total === 1 ? '' : 'es'} in ${where}` : `No matching channels in ${where}`);
      else notes.push(`${data.available.toLocaleString()} channels in ${where}, A–Z`);
      if (!data.hasList) notes.push('Only already-matched guide channels are listed until the guide is refreshed.');
      if (data.loading) notes.push('The guide is loading right now.');
      status.textContent = notes.join(' · ');
      const moreBtn = results.querySelector('.epg-more');
      if (moreBtn) moreBtn.remove();
      if (!more) {
        results.innerHTML = '';
        results.scrollTop = 0;
      }
      const firstNew = data.results.length ? resultItem(data.results[0]) : null;
      if (firstNew) results.append(firstNew);
      for (const entry of data.results.slice(1)) results.append(resultItem(entry));
      if (!data.results.length && !more) results.append(h('div.empty', { text: q ? 'Nothing found. Try fewer words or another source.' : 'This source has no channels yet.' }));
      if (offset + data.results.length < data.total) {
        const left = data.total - offset - data.results.length;
        const btn = h('button.btn.small.epg-more.focusable', { type: 'button', text: `Show more (${left.toLocaleString()} left)` });
        btn.addEventListener('click', () => {
          const focusNext = document.activeElement === btn;
          run({ more: true }).then(() => {
            if (focusNext && firstNew) {
              const items = results.querySelectorAll('.epg-result');
              const next = items[offset + PAGE];
              if (next) focusEl(next);
            }
          });
        });
        results.append(btn);
      }
    }
    const search = debounce(() => run(), 250);

    async function loadSources() {
      try {
        const data = await get('/epg/sources');
        state.sources = data.sources;
      } catch {
        state.sources = [];
      }
      if (state.done) return;
      if (state.source && !state.sources.some((s) => s.id === state.source)) state.source = '';
      renderChips();
    }

    input.addEventListener('input', search);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      search.cancel();
      run().then(() => {
        const first = results.querySelector('.epg-result');
        if (first) focusEl(first);
      });
    });
    if (channel) {
      autoBtn.addEventListener('click', () => assign(null));
      noneBtn.addEventListener('click', () => assign(''));
    }
    closeBtn.addEventListener('click', () => finish(false));
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) finish(false);
    });

    const popModal = pushModal({
      close: () => finish(false),
      onBack: () => finish(false),
      onKey(action) {
        const active = document.activeElement;
        if (action === 'up' || action === 'down') {
          moveFocus(action, form);
          return true;
        }
        if ((action === 'left' || action === 'right') && !isTextInput(active)) {
          moveFocus(action, form);
          return true;
        }
        return false;
      },
    });

    document.body.append(backdrop);
    input.focus();
    input.select();
    loadSources().then(() => run());
  });
}
