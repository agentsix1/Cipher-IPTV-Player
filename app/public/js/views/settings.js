import { get, post, put, del } from '../api.js';
import { h, toast, store, prefs } from '../util.js';
import { session, refreshSession, navigate, setNavHints } from '../app.js';
import { focusFirst } from '../nav.js';
import { topbar, statusBlock, watchStatus } from './common.js';
import { confirmDialog } from '../menu.js';
import { openEpgBrowser } from './epgbrowser.js';
import { setScrollingText } from '../marquee.js';
import { playerLog, setDebugOverlay, isDebugOverlayOn } from '../player-debug.js';
import { applyHubHighlight, parseHex, rgbToHex, DEFAULT_HUB_HIGHLIGHT } from '../theme.js';

const field = (label, input, hint) => h('div.field', {}, h('label', { text: label }), input, hint ? h('small', { text: hint, style: 'color:var(--muted)' }) : null);
const textInput = (value = '', attrs = {}) => h('input.focusable', { type: 'text', value, autocapitalize: 'off', spellcheck: 'false', ...attrs });
const checkbox = (label, checked) => {
  const input = h('input.focusable', { type: 'checkbox', checked: !!checked });
  return { input, el: h('label.check', {}, input, h('span', { text: label })) };
};

function colorPicker(initial) {
  let current = parseHex(initial) || parseHex(DEFAULT_HUB_HIGHLIGHT);
  const well = h('input.focusable', { type: 'color', value: current.hex, 'aria-label': 'Highlight color' });
  const hex = h('input.focusable.rgb-hex', { type: 'text', value: current.hex, spellcheck: 'false', 'aria-label': 'Hex color' });
  const num = (name, value) => h('input.focusable', {
    type: 'number', min: '0', max: '255', value: String(value), 'aria-label': name,
  });
  const r = num('Red', current.r);
  const g = num('Green', current.g);
  const b = num('Blue', current.b);
  const paint = (next, source) => {
    current = next;
    if (source !== well) well.value = next.hex;
    if (source !== hex) hex.value = next.hex;
    if (source !== r) r.value = String(next.r);
    if (source !== g) g.value = String(next.g);
    if (source !== b) b.value = String(next.b);
    applyHubHighlight(next.hex);
  };
  well.addEventListener('input', () => {
    const next = parseHex(well.value);
    if (next) paint(next, well);
  });
  hex.addEventListener('change', () => {
    const next = parseHex(hex.value);
    if (next) paint(next, hex);
  });
  const fromRgb = (source) => paint(parseHex(rgbToHex(r.value, g.value, b.value)), source);
  r.addEventListener('input', () => fromRgb(r));
  g.addEventListener('input', () => fromRgb(g));
  b.addEventListener('input', () => fromRgb(b));
  return {
    el: h('div.rgb-picker', {},
      well,
      h('label.rgb-ch', {}, h('span', { text: 'R' }), r),
      h('label.rgb-ch', {}, h('span', { text: 'G' }), g),
      h('label.rgb-ch', {}, h('span', { text: 'B' }), b),
      hex,
    ),
    inputs: [well, r, g, b, hex],
    value: () => current.hex,
  };
}

const SHIFT_OPTIONS = [];
for (let v = -12; v <= 12; v += 0.5) SHIFT_OPTIONS.push(v);

const MAX_EPG_SOURCES = 10; // the user's own sources; the epgshare01 set is managed as one block
const EPGSHARE_BASE = 'https://epgshare01.online/epgshare01/';
const isEpgShare = (s) => String(s.url || '').startsWith(EPGSHARE_BASE);

let presetsPromise = null;
function loadPresets() {
  if (!presetsPromise) {
    presetsPromise = get('/epg/presets').then((r) => r.epgshare).catch((err) => {
      presetsPromise = null;
      throw err;
    });
  }
  return presetsPromise;
}

/**
 * The epgshare01.online guides of a playlist as one block: count, show/hide the list, all on/off,
 * add/remove. Returns { el, value(), has(), add(), remove() }.
 */
function epgShareBlock(initial, onChange) {
  let entries = initial.map((s) => ({ ...s }));
  let open = false;
  // Freshly added guides are all on; choosing from the list starts from none so the user picks.
  let fresh = false;
  const toggleList = () => {
    open = !open;
    if (open && fresh) entries.forEach((s) => { s.enabled = false; });
    fresh = false;
    render();
  };
  const el = h('div.epgshare');

  function render() {
    el.innerHTML = '';
    el.hidden = !entries.length;
    if (!entries.length) return;
    const on = entries.filter((s) => s.enabled).length;
    const btn = (text, fn, cls = '') => h(`button.btn.small.focusable${cls}`, { type: 'button', text, onclick: fn });
    el.append(h('div.epgshare-head', {},
      h('div.epgshare-title', {},
        h('strong', { text: 'epgshare01.online guides' }),
        h('span.hint', { text: ` ${on} of ${entries.length} on` })),
      h('div.form-actions', {},
        btn(open ? 'Hide list' : 'Choose…', toggleList),
        btn('All on', () => { fresh = false; entries.forEach((s) => { s.enabled = true; }); render(); }),
        btn('All off', () => { fresh = false; entries.forEach((s) => { s.enabled = false; }); render(); }),
        btn('Remove', () => api.remove(), '.danger'))));
    if (!open) return;
    const grid = h('div.epgshare-grid');
    const refreshOpts = [[0, 'Default interval'], [1, 'Every 1 h'], [3, 'Every 3 h'], [6, 'Every 6 h'], [12, 'Every 12 h'], [24, 'Every 24 h'], [48, 'Every 48 h']];
    for (const s of entries) {
      if (s.autoUpdate === undefined) s.autoUpdate = true;
      if (s.refreshHours === undefined) s.refreshHours = 0;
      const input = h('input.focusable', { type: 'checkbox', checked: s.enabled });
      input.addEventListener('change', () => {
        s.enabled = input.checked;
        el.querySelector('.epgshare-title .hint').textContent = ` ${entries.filter((x) => x.enabled).length} of ${entries.length} on`;
      });
      const autoUp = h('input.focusable', { type: 'checkbox', checked: s.autoUpdate !== false });
      autoUp.addEventListener('change', () => { s.autoUpdate = autoUp.checked; });
      const refreshSel = h('select.focusable', {}, refreshOpts.map(([v, t]) => h('option', {
        value: String(v),
        text: t,
        selected: Number(s.refreshHours) === v,
      })));
      refreshSel.addEventListener('change', () => { s.refreshHours = Number(refreshSel.value); });
      grid.append(h('div.epgshare-row', { title: s.url },
        h('label.check.epgshare-name', {}, input, h('span', { text: s.name.replace(/^epgshare01 · /, '') })),
        h('label.check.small', {}, autoUp, h('span', { text: 'Auto-update' })),
        refreshSel));
    }
    el.append(h('p.hint', { text: 'Auto-update re-downloads each enabled guide on its schedule (Settings → default TV guide interval). Turn off guides you only want manually.' }), grid);
  }

  const api = {
    el,
    value: () => entries.map((s) => ({ ...s })),
    has: () => entries.length > 0,
    async add() {
      if (entries.length) return;
      try {
        entries = (await loadPresets()).map((s) => ({ ...s }));
      } catch (err) {
        toast(`Could not load the epgshare01 list: ${err.message}`, { error: true });
        return;
      }
      fresh = true;
      render();
      onChange(true);
    },
    remove() {
      entries = [];
      open = false;
      fresh = false;
      render();
      onChange(false);
    },
  };
  render();
  return api;
}

/** Editable list of extra XMLTV guides for a playlist. Returns { el, value(), shared }. */
function epgSourcesEditor(initial = [], { onSharedChange = () => {} } = {}) {
  const shared = epgShareBlock(initial.filter(isEpgShare), onSharedChange);
  initial = initial.filter((s) => !isEpgShare(s));
  const rows = h('div.epg-src-rows');
  const addBtn = h('button.btn.small.focusable', { type: 'button', text: '+ Add guide source' });
  const sync = () => {
    const n = rows.children.length;
    addBtn.disabled = n >= MAX_EPG_SOURCES;
    if (!n) rows.append(h('div.hint.epg-src-empty', { text: 'No extra guides. Add one to fill in channels your main guide is missing.' }));
    else rows.querySelectorAll('.epg-src-empty').forEach((el) => el.remove());
  };
  const addRow = (src = {}) => {
    rows.querySelectorAll('.epg-src-empty').forEach((el) => el.remove());
    const name = textInput(src.name || '', { placeholder: 'Name (e.g. UK guide)', maxlength: '60' });
    const url = textInput(src.url || '', { placeholder: 'XMLTV URL (.xml or .xml.gz)', type: 'url' });
    const enabled = checkbox('On', src.enabled !== false);
    const remove = h('button.btn.small.danger.focusable', { type: 'button', text: 'Remove', title: 'Remove this guide source' });
    const row = h('div.epg-src-row', { 'data-id': src.id || '' }, name, url, enabled.el, remove);
    row._value = () => ({ id: row.dataset.id || undefined, name: name.value, url: url.value, enabled: enabled.input.checked });
    remove.addEventListener('click', () => {
      const next = row.nextElementSibling || row.previousElementSibling;
      row.remove();
      sync();
      (next && next.querySelector('input')) ? next.querySelector('input').focus() : addBtn.focus();
    });
    rows.append(row);
    sync();
    return row;
  };
  addBtn.addEventListener('click', () => addRow().querySelector('input').focus());
  for (const src of initial) addRow(src);
  sync();
  return {
    el: h('div.field', {},
      h('label', { text: 'Extra guide sources' }),
      h('small', { text: 'More XMLTV guides to search and assign to channels (Channel menu → Choose guide). Channels without a match in the main guide are also matched here by their guide id.', style: 'color:var(--muted)' }),
      rows,
      h('div.form-actions', {}, addBtn)),
    value: () => [...rows.querySelectorAll('.epg-src-row')].map((r) => r._value()).filter((s) => s.url.trim()).concat(shared.value()),
    shared,
  };
}

function shiftSelect(value) {
  const select = h('select.focusable');
  for (const v of SHIFT_OPTIONS) {
    const label = v === 0 ? '0 (none)' : `${v > 0 ? '+' : ''}${v} h`;
    select.append(h('option', { value: String(v), text: label, selected: Number(value) === v }));
  }
  return select;
}

export async function mount(root, params) {
  root.append(topbar('Settings'));
  const content = h('div.settings');
  root.append(h('div.scroll', {}, content));

  const playlistsCard = h('div.card');
  const generalCard = h('div.card');
  const backupCard = h('div.card');
  const accountCard = h('div.card');
  const usersCard = h('div.card');
  const aboutCard = h('div.card');
  content.append(playlistsCard, generalCard, backupCard);
  if (session.mode === 'web') content.append(accountCard);
  if (session.mode === 'web' && session.user && session.user.isAdmin) content.append(usersCard);
  content.append(aboutCard);

  const status = statusBlock();
  const stopStatus = watchStatus((s) => status.update(s));

  // ---------------- playlists ----------------
  async function renderPlaylists(editing = null) {
    let list = [];
    try {
      list = await get('/playlists');
    } catch (err) {
      toast(err.message, { error: true });
    }
    playlistsCard.innerHTML = '';
    playlistsCard.append(h('h2', { text: 'Playlists' }), status.el);

    if (editing) {
      playlistsCard.append(playlistForm(editing === 'new' ? null : editing, list.length === 0));
      return;
    }

    if (!list.length) playlistsCard.append(h('p.hint', { text: 'Add an M3U URL, Xtream Codes login, or MAG portal to get started.' }));
    for (const pl of list) {
      const metas = {
        xtream: `Xtream · ${pl.serverUrl} · ${pl.username}`,
        mag: `MAG · ${pl.serverUrl} · ${pl.macAddress}`,
      };
      const meta = metas[pl.type] || `M3U · ${pl.m3uUrl}`;
      const shifts = [];
      if (pl.epgShiftHours) shifts.push(`EPG shift ${pl.epgShiftHours > 0 ? '+' : ''}${pl.epgShiftHours}h`);
      if (pl.catchupShiftHours) shifts.push(`Catch-up shift ${pl.catchupShiftHours > 0 ? '+' : ''}${pl.catchupShiftHours}h`);
      const extra = (pl.epgSources || []).filter((s) => s.enabled).length;
      if (extra) shifts.push(`${extra} extra guide${extra === 1 ? '' : 's'}`);
      const health = pl.catalog || {};
      if (health.state === 'offline') shifts.push('Offline');
      else if (health.state === 'loading') shifts.push('Loading…');
      else if (health.channels) shifts.push(`${health.channels.toLocaleString()} channels`);
      playlistsCard.append(h('div.pl-item', {},
        h('div.info', {},
          h('div.n', { text: `${pl.name}${pl.isActive ? '  ✓ Active' : ''}${health.state === 'offline' ? '  · Offline' : ''}` }),
          h('div.m', { text: meta }),
          shifts.length ? h('div.m', { text: shifts.join(' · ') }) : null),
        h('div.acts', {},
          pl.isActive ? null : h('button.btn.small.focusable', { onclick: () => act(() => post(`/playlists/${pl.id}/activate`), 'Playlist activated') }, 'Use'),
          h('button.btn.small.focusable', { onclick: () => renderPlaylists(pl) }, 'Edit'),
          pl.isActive ? h('button.btn.small.focusable', { title: 'Browse and search the TV guide sources', onclick: () => openEpgBrowser() }, 'Guides') : null,
          h('button.btn.small.focusable', { onclick: () => act(() => post(`/playlists/${pl.id}/refresh`), 'Refreshing channels, TV guide, movies and TV shows…') }, 'Refresh'),
          h('button.btn.small.danger.focusable', {
            onclick: () => {
              if (confirm(`Delete playlist "${pl.name}"?`)) act(() => del(`/playlists/${pl.id}`), 'Playlist deleted');
            },
          }, 'Delete'))));
    }
    playlistsCard.append(h('div.form-actions', { style: 'margin-top:0.8rem' },
      h('button.btn.primary.focusable', { onclick: () => renderPlaylists('new') }, '+ Add playlist')));
  }

  async function act(fn, okMessage) {
    try {
      await fn();
      toast(okMessage);
      await renderPlaylists();
      stopStatusRef.stop();
      stopStatusRef.stop = watchStatus((s) => status.update(s));
    } catch (err) {
      toast(err.message, { error: true });
    }
  }
  const stopStatusRef = { stop: stopStatus };

  function playlistForm(pl, isFirst) {
    const type = h('select.focusable', {},
      h('option', { value: 'xtream', text: 'Xtream Codes (server + login)', selected: !pl || pl.type === 'xtream' }),
      h('option', { value: 'm3u', text: 'M3U playlist URL', selected: pl && pl.type === 'm3u' }),
      h('option', { value: 'mag', text: 'MAG portal (portal URL + MAC address)', selected: pl && pl.type === 'mag' }));
    const name = textInput(pl ? pl.name : '', { placeholder: 'My IPTV' });
    const server = textInput(pl && pl.type !== 'mag' ? pl.serverUrl : '', { placeholder: 'http://example.com:8080', type: 'url' });
    const portal = textInput(pl && pl.type === 'mag' ? pl.serverUrl : '', { placeholder: 'http://example.com/c/', type: 'url' });
    const mac = textInput(pl ? pl.macAddress : '', { placeholder: '00:1A:79:12:34:56', autocomplete: 'off' });
    const username = textInput(pl && pl.type === 'xtream' ? pl.username : '', { autocomplete: 'off' });
    const password = h('input.focusable', { type: 'password', value: pl ? pl.password : '', autocomplete: 'new-password' });
    const m3u = textInput(pl ? pl.m3uUrl : '', { placeholder: 'https://example.com/playlist.m3u', type: 'url' });
    const epgUrl = textInput(pl ? pl.epgUrl : '', { placeholder: 'Optional XMLTV URL (.xml or .xml.gz)', type: 'url' });
    const providerEpg = checkbox('Use the provider\'s built-in EPG when available', pl ? pl.useProviderEpg : true);
    // New playlists get the epgshare01 guides unless the user unticks the box; existing ones show
    // whether they have them.
    const extraGuides = epgSourcesEditor(pl ? pl.epgSources : [], {
      onSharedChange: (has) => { epgShare.input.checked = has; },
    });
    const epgShare = checkbox('Add the free epgshare01.online guides (about 100 guides for many countries and services)', pl ? extraGuides.shared.has() : true);
    epgShare.input.addEventListener('change', () => (epgShare.input.checked ? extraGuides.shared.add() : extraGuides.shared.remove()));
    if (!pl) extraGuides.shared.add();
    const epgShift = shiftSelect(pl ? pl.epgShiftHours : 0);
    const catchupShift = shiftSelect(pl ? pl.catchupShiftHours : 0);
    const format = h('select.focusable', {},
      h('option', { value: 'ts', text: 'MPEG-TS (.ts) – recommended', selected: !pl || pl.streamFormat !== 'm3u8' }),
      h('option', { value: 'm3u8', text: 'HLS (.m3u8)', selected: pl && pl.streamFormat === 'm3u8' }));
    const userAgent = textInput(pl ? pl.userAgent : '', { placeholder: 'Leave empty for the default' });
    const plRefresh = h('select.focusable', {},
      h('option', { value: '-1', text: 'Default (Settings → Auto-refresh playlist)', selected: !pl || pl.refreshHours === undefined || pl.refreshHours === -1 }),
      h('option', { value: '0', text: 'Off', selected: pl && pl.refreshHours === 0 }),
      ...[1, 3, 6, 12, 24, 48].map((v) => h('option', { value: String(v), text: `Every ${v} hour${v > 1 ? 's' : ''}`, selected: pl && pl.refreshHours === v })));
    const error = h('div.error-text');

    const xtreamFields = h('div.form', {}, field('Server URL', server), h('div.row2', {}, field('Username', username), field('Password', password)), field('Stream format', format));
    const m3uFields = h('div.form', {}, field('M3U URL', m3u));
    const magFields = h('div.form', {},
      field('Portal URL', portal, 'The portal address from your provider, e.g. http://example.com/c/ or http://example.com:8080/'),
      field('MAC address', mac));
    const syncType = () => {
      const kind = type.value;
      xtreamFields.style.display = kind === 'xtream' ? '' : 'none';
      m3uFields.style.display = kind === 'm3u' ? '' : 'none';
      magFields.style.display = kind === 'mag' ? '' : 'none';
      providerEpg.el.style.display = kind === 'm3u' ? 'none' : '';
      if (!pl) {
        if (kind === 'mag') extraGuides.shared.remove();
        else extraGuides.shared.add();
      }
    };
    type.addEventListener('change', syncType);
    syncType();

    const save = h('button.btn.primary.focusable', { type: 'submit' }, pl ? 'Save' : 'Add playlist');
    const form = h('form.form', {
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = '';
        save.disabled = true;
        const body = {
          name: name.value,
          type: type.value,
          serverUrl: type.value === 'mag' ? portal.value : server.value,
          username: username.value,
          macAddress: mac.value,
          password: password.value,
          m3uUrl: m3u.value,
          epgUrl: epgUrl.value,
          epgSources: extraGuides.value(),
          useProviderEpg: providerEpg.input.checked,
          epgShiftHours: Number(epgShift.value),
          catchupShiftHours: Number(catchupShift.value),
          streamFormat: format.value,
          userAgent: userAgent.value,
          refreshHours: Number(plRefresh.value),
        };
        try {
          playerLog('playlist.save', pl ? 'update' : (isFirst ? 'create-first' : 'create'), {
            type: body.type,
            name: body.name,
            isFirst: !!isFirst,
          });
          if (pl) await put(`/playlists/${pl.id}`, body);
          else await post('/playlists', body);
          playerLog('playlist.save.ok', pl ? 'updated' : 'created', { isFirst: !!isFirst });
          toast(pl ? 'Playlist saved' : 'Playlist added. Loading channels and guide…');
          if (!pl && isFirst) {
            playerLog('playlist.first→home', 'navigate home after first playlist');
            navigate('home', { replace: true });
            return;
          }
          await renderPlaylists();
          stopStatusRef.stop();
          stopStatusRef.stop = watchStatus((s) => status.update(s));
        } catch (err) {
          playerLog('playlist.save.error', err && err.message, { isFirst: !!isFirst }, { level: 'error' });
          error.textContent = err.message;
        } finally {
          save.disabled = false;
        }
      },
    },
    h('h2', { text: pl ? `Edit ${pl.name}` : 'Add playlist' }),
    field('Playlist name', name),
    field('Type', type),
    xtreamFields,
    m3uFields,
    magFields,
    field('EPG URL', epgUrl, 'Leave empty to use the playlist\'s own guide.'),
    providerEpg.el,
    h('div.field', {}, epgShare.el,
      h('small', { text: 'Fills in guide data your provider is missing, matched by each channel\'s guide id. Use Choose… to pick single guides. More guides make each guide update take longer.', style: 'color:var(--muted)' }),
      extraGuides.shared.el),
    extraGuides.el,
    h('div.row2', {},
      field('EPG time shift', epgShift, 'Moves guide times if programmes show at the wrong hour.'),
      field('Catch-up time shift', catchupShift, 'Adjusts the start time sent for catch-up if replays begin at the wrong point.')),
    field('User agent', userAgent),
    field('Auto-refresh playlist', plRefresh, 'Re-downloads channels, TV guide, movies and TV shows on a schedule. Default uses Settings → Auto-refresh playlist.'),
    error,
    h('div.form-actions', {}, save, isFirst ? null : h('button.btn.focusable', { type: 'button', onclick: () => renderPlaylists() }, 'Cancel')));
    requestAnimationFrame(() => focusFirst(form));
    return form;
  }

  // ---------------- general ----------------
  async function renderGeneral() {
    let s;
    try {
      s = await get('/settings');
    } catch {
      return;
    }
    prefs.set('vodConvertAhead', s.vodConvertAhead !== false);
    prefs.set('catchupPreloadHours', Number(s.catchupPreloadHours) || 0);
    const autoPreview = checkbox('Auto-play preview when opening the guide', s.autoPlayPreview);
    const debugOverlay = checkbox('Show debug overlay (Ctrl+Shift+D)', s.debugOverlay || isDebugOverlayOn());
    const convertAhead = checkbox('Convert on-demand ahead (smoother seeking)', s.vodConvertAhead !== false);
    convertAhead.el.title = 'Only for on-demand files the browser cannot play. Keeps converting ahead so skips inside the light buffer are instant.';
    const channelNumbers = checkbox('Show channel numbers', s.showChannelNumbers);
    const combine = checkbox('Combine playlists', !!s.combinePlaylists);
    const alwaysChannels = checkbox('Always show Channels', !!s.alwaysShowChannels);
    alwaysChannels.el.title = 'Keeps the Channels button on the home screen when movies or TV shows are available';
    const scrollingText = checkbox('Allow Scrolling Text', s.scrollingText !== false);
    scrollingText.el.title = 'Channel and group names that do not fit scroll to show the rest';
    const epgHours = h('select.focusable', {}, [1, 3, 6, 12, 24, 48].map((v) => h('option', { value: String(v), text: `Every ${v} hour${v > 1 ? 's' : ''}`, selected: s.epgUpdateHours === v })));
    const plHours = h('select.focusable', {}, [0, 1, 3, 6, 12, 24, 48].map((v) => h('option', { value: String(v), text: v === 0 ? 'Off' : `Every ${v} hour${v > 1 ? 's' : ''}`, selected: (s.playlistRefreshHours || 0) === v })));
    const hoursVisible = h('select.focusable', {}, [0, 1, 1.5, 2, 3, 4, 6].map((v) => h('option', { value: String(v), text: v === 0 ? 'Automatic' : `${v} hours`, selected: s.guideHoursVisible === v })));
    const past = h('select.focusable', {}, [12, 24, 48, 60, 72, 96, 168].map((v) => h('option', { value: String(v), text: `${v / 24 >= 1 ? `${+(v / 24).toFixed(1)} days` : `${v} hours`}`, selected: s.guidePastHours === v })));
    const future = h('select.focusable', {}, [24, 48, 72, 84, 120, 168].map((v) => h('option', { value: String(v), text: `${+(v / 24).toFixed(1)} days`, selected: s.guideFutureHours === v })));
    const catchupPad = h('select.focusable', {}, [0, 1, 2, 3, 6, 12].map((v) => h('option', {
      value: String(v),
      text: v === 0 ? 'Stop at programme end' : `${v} hour${v > 1 ? 's' : ''} past the end`,
      selected: (Number(s.catchupPreloadHours) || 0) === v,
    })));
    const highlight = colorPicker(s.hubHighlight || DEFAULT_HUB_HIGHLIGHT);

    const save = async () => {
      try {
        await put('/settings', {
          autoPlayPreview: autoPreview.input.checked,
          debugOverlay: debugOverlay.input.checked,
          vodConvertAhead: convertAhead.input.checked,
          showChannelNumbers: channelNumbers.input.checked,
          alwaysShowChannels: alwaysChannels.input.checked,
          combinePlaylists: combine.input.checked,
          scrollingText: scrollingText.input.checked,
          epgUpdateHours: Number(epgHours.value),
          playlistRefreshHours: Number(plHours.value),
          guideHoursVisible: Number(hoursVisible.value),
          guidePastHours: Number(past.value),
          guideFutureHours: Number(future.value),
          catchupPreloadHours: Number(catchupPad.value),
          hubHighlight: highlight.value(),
        });
        applyHubHighlight(highlight.value());
        prefs.set('vodConvertAhead', convertAhead.input.checked);
        prefs.set('catchupPreloadHours', Number(catchupPad.value));
        setDebugOverlay(debugOverlay.input.checked);
        setNavHints({ alwaysShowChannels: alwaysChannels.input.checked });
        toast('Settings saved');
      } catch (err) {
        toast(err.message, { error: true });
      }
    };
    combine.input.addEventListener('change', () => {
      store.set('guide.state', {});
      store.set('channels.state', {});
      store.set('search.state', {});
    });
    for (const el of [autoPreview.input, debugOverlay.input, convertAhead.input, channelNumbers.input, alwaysChannels.input, combine.input, scrollingText.input, epgHours, plHours, hoursVisible, past, future, catchupPad, ...highlight.inputs]) el.addEventListener('change', save);
    scrollingText.input.addEventListener('change', () => setScrollingText(scrollingText.input.checked));

    generalCard.innerHTML = '';
    generalCard.append(h('h2', { text: 'General' }), h('div.form', {},
      field('Home highlight color', highlight.el, 'Changes the highlight on Home and See All pages. Other screens keep the current theme for now.'),
      autoPreview.el,
      h('div', {}, debugOverlay.el, h('small', { text: 'Live event stream for testing. Also press Ctrl+Shift+D. Full logs: %LocalAppData%\\Cipher\\data\\player-debug.log and host.log (portable: <exe>\\data\\)', style: 'color:var(--muted);display:block;margin:0.2rem 0 0 1.8rem' })),
      h('div', {}, convertAhead.el, h('small', { text: 'Applies only to downloaded on-demand files that need ffmpeg (unsupported codecs). Live TV and already-playable videos use the normal player. The light bar is converted video you can skip into.', style: 'color:var(--muted);display:block;margin:0.2rem 0 0 1.8rem' })),
      channelNumbers.el,
      h('div', {}, combine.el, h('small', { text: 'Merges the TV guide, channels and groups of all your playlists. Groups with the same name become one group. Pick "All playlists" or a single playlist on the home screen.', style: 'color:var(--muted);display:block;margin:0.2rem 0 0 1.8rem' })),
      h('div', {}, alwaysChannels.el, h('small', { text: 'When movies or TV shows are available, Channels is hidden unless this is on. With no video on demand, Channels stays on the home screen.', style: 'color:var(--muted);display:block;margin:0.2rem 0 0 1.8rem' })),
      h('div', {}, scrollingText.el, h('small', { text: 'Channel and group names that are too long for their box scroll to show the rest, then wait 5 seconds and scroll again.', style: 'color:var(--muted);display:block;margin:0.2rem 0 0 1.8rem' })),
      field('Catch-up preload past programme end', catchupPad, 'On catch-up channels, the current show is loaded as catch-up so you can skip by 15s/30s/1m. Extra time after the show lets you keep fast-forwarding.'),
      h('div.row2', {}, field('Auto-refresh TV guide', epgHours, 'Default interval for enabled guide sources. Per-source timers are set on each playlist.'), field('Auto-refresh playlist', plHours, 'Re-downloads channels, TV guide, movies and TV shows (MAG/Xtream) on this schedule.')),
      field('Guide hours on screen', hoursVisible),
      h('div.row2', {}, field('Guide history (catch-up range)', past), field('Guide future range', future))));
  }

  // ---------------- backup & share ----------------
  let shareTimer = null;

  function importSummary(res) {
    const parts = [];
    if (res.added) parts.push(`${res.added} playlist${res.added === 1 ? '' : 's'} added`);
    if (res.updated) parts.push(`${res.updated} updated`);
    if (res.settings) parts.push('settings applied');
    return parts.length ? `Imported: ${parts.join(', ')}` : 'Nothing to import';
  }

  async function afterImport(res) {
    toast(importSummary(res), { ms: 5000 });
    await renderPlaylists();
    await renderGeneral();
    stopStatusRef.stop();
    stopStatusRef.stop = watchStatus((s) => status.update(s));
  }

  const confirmImport = () => confirmDialog({
    title: 'Import config',
    message: 'This adds or updates playlists, favorites, groups and settings on this device. Nothing is deleted.',
    okLabel: 'Import',
  });

  function renderBackup() {
    clearInterval(shareTimer);
    const shareBox = h('div.share-box');
    const shareIncludeImages = checkbox('Include custom channel icons', false);
    const showIdle = () => {
      clearInterval(shareTimer);
      shareBox.innerHTML = '';
      shareBox.append(
        shareIncludeImages.el,
        h('p.hint', { text: 'Including icons embeds uploaded images in the shared config and can make it much larger (often several MB).' }),
        h('button.btn.primary.focusable', { onclick: startShare }, 'Create share code'));
    };
    async function startShare() {
      let res;
      try {
        res = await post('/share', { includeImages: shareIncludeImages.input.checked });
      } catch (err) {
        toast(err.message, { error: true });
        return;
      }
      const countdown = h('span.m');
      const tick = () => {
        const left = Math.max(0, res.expiresAt - Date.now());
        countdown.textContent = `Expires in ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
        if (!left) showIdle();
      };
      shareBox.innerHTML = '';
      shareBox.append(
        h('div.share-code', { text: `${res.code.slice(0, 3)} ${res.code.slice(3)}` }),
        h('div.share-addr', {}, h('span.m', { text: 'Address: ' }),
          res.addresses.length
            ? h('b', { text: res.addresses.join('  or  ') })
            : h('span', { text: `this device's IP address, port ${res.port} (see your network settings)` })),
        countdown,
        h('div.form-actions', {}, h('button.btn.small.focusable', {
          onclick: async () => {
            await del('/share').catch(() => {});
            showIdle();
          },
        }, 'Stop sharing')));
      tick();
      shareTimer = setInterval(tick, 1000);
    }
    showIdle();

    const address = textInput('', { placeholder: '10.0.0.61:8788 or :8093 for web', inputmode: 'url' });
    const code = textInput('', { placeholder: '123456', inputmode: 'numeric', maxlength: '7', autocomplete: 'off' });
    const remoteError = h('div.error-text');
    const remoteBtn = h('button.btn.primary.focusable', { type: 'submit' }, 'Import');
    const remoteForm = h('form.form', {
      onsubmit: async (e) => {
        e.preventDefault();
        remoteError.textContent = '';
        if (!(await confirmImport())) return;
        remoteBtn.disabled = true;
        remoteBtn.textContent = 'Importing…';
        try {
          const res = await post('/config/import-remote', { address: address.value, code: code.value });
          code.value = '';
          await afterImport(res);
        } catch (err) {
          remoteError.textContent = err.message;
        } finally {
          remoteBtn.disabled = false;
          remoteBtn.textContent = 'Import';
        }
      },
    },
    h('div.row2', {}, field('Other device address', address), field('Share code', code)),
    remoteError,
    h('div.form-actions', {}, remoteBtn));

    backupCard.innerHTML = '';
    backupCard.append(
      h('h2', { text: 'Backup & share' }),
      h('p.hint', { text: 'Copy your setup (playlists, favorites, group and channel order, renamed/hidden/custom groups and channels, guide choices and settings) to another device on the same network. Shared configs include your playlist logins, so only share with your own devices.' }),
      h('h3', { text: 'Share this device\'s setup' }),
      h('p.hint', { text: session.mode === 'apk'
        ? 'Create a code here (opens port 8788 on your Wi‑Fi while the code is active). On the other device: Settings → Backup & share → Import, then enter the address and code. The phone app has no login screen; that is normal and does not block sharing or IPTV.'
        : 'Create a code, then on the other device open Settings → Backup & share → Import. Use this PC\'s IP and port shown below (e.g. :8093). You must be logged in on both sides for web mode.' }),
      shareBox,
      h('h3', { text: 'Import from another device' }),
      remoteForm,
      layoutSection());

    if (session.mode === 'web') {
      const fileInput = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        fileInput.value = '';
        if (!file) return;
        let data;
        try {
          data = JSON.parse(await file.text());
        } catch {
          toast('That file is not a valid config', { error: true });
          return;
        }
        if (!(await confirmImport())) return;
        try {
          await afterImport(await post('/config/import', { config: data }));
        } catch (err) {
          toast(err.message, { error: true });
        }
      });
      const fileIncludeImages = checkbox('Include custom channel icons', false);
      const download = async () => {
        try {
          const q = fileIncludeImages.input.checked ? '?includeImages=1' : '';
          const data = await get(`/config/export${q}`);
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          const a = h('a', { href: URL.createObjectURL(blob), download: `cipher-config-${new Date().toISOString().slice(0, 10)}.json` });
          document.body.append(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        } catch (err) {
          toast(err.message, { error: true });
        }
      };
      backupCard.append(
        h('h3', { text: 'Config file' }),
        fileIncludeImages.el,
        h('p.hint', { text: 'Including icons embeds uploaded images and can make the JSON file much larger.' }),
        h('div.form-actions', {},
          h('button.btn.focusable', { onclick: download }, 'Download config file'),
          h('button.btn.focusable', { onclick: () => fileInput.click() }, 'Import config file')),
        fileInput);
    }
  }

  /** Saves text as a file: through the Android app's save dialog, or as a browser download. */
  function saveTextFile(filename, text) {
    if (window.XsNative && window.XsNative.saveTextFile) {
      return new Promise((resolve) => {
        window.__xsFileSaved = (ok, detail) => {
          window.__xsFileSaved = null;
          resolve({ ok, detail });
        };
        window.XsNative.saveTextFile(filename, text);
      });
    }
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return Promise.resolve({ ok: true, detail: '' });
  }

  function layoutSummary(res) {
    const parts = [];
    const add = (n, one, many = `${one}s`) => { if (n) parts.push(`${n} ${n === 1 ? one : many}`); };
    add(res.customGroups, 'custom group');
    add(res.renamedGroups + res.renamedChannels, 'rename');
    add(res.hiddenGroups + res.hiddenChannels, 'hidden item');
    add(res.epgAssignments, 'guide choice');
    add(res.favorites, 'favorite');
    return parts.length ? `Layout imported: ${parts.join(', ')}` : 'Layout imported';
  }

  /**
   * Layout file: the active playlist's groups/channels layout as a base64 text file. It carries no
   * playlist details or guide data, so it only restores how the lists are arranged.
   */
  function layoutSection() {
    const fileInput = h('input', { type: 'file', style: 'display:none' });
    const activeName = async () => {
      const list = await get('/playlists').catch(() => []);
      const active = list.find((p) => p.isActive);
      return active ? active.name : '';
    };
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      let text;
      try {
        text = await file.text();
      } catch {
        toast('That file could not be read', { error: true });
        return;
      }
      const name = await activeName();
      const ok = await confirmDialog({
        title: 'Import layout',
        message: `This replaces the layout of ${name ? `"${name}"` : 'your active playlist'}: group and channel order, names, hidden and custom groups, favorites and guide choices. Playlists and settings are not changed.`,
        okLabel: 'Import',
      });
      if (!ok) return;
      try {
        toast(layoutSummary(await post('/layout/import', { data: text })), { ms: 5000 });
      } catch (err) {
        toast(err.message, { error: true });
      }
    });
    const saveBtn = h('button.btn.focusable', {
      onclick: async () => {
        try {
          const { filename, data } = await get('/layout/export');
          const res = await saveTextFile(filename, data);
          if (res.ok) toast(res.detail ? `Layout saved to ${res.detail}` : 'Layout file saved');
          else if (res.detail) toast(res.detail, { error: true });
        } catch (err) {
          toast(err.message, { error: true });
        }
      },
    }, 'Save layout file');
    return h('div', {},
      h('h3', { text: 'Layout file' }),
      h('p.hint', { text: 'Save the active playlist\'s layout (group and channel order, names, hidden and custom groups, favorites and guide choices) as a file, then import it on any device that uses the same provider. The file does not contain playlist logins or guide data.' }),
      h('div.form-actions', {},
        saveBtn,
        h('button.btn.focusable', { onclick: () => fileInput.click() }, 'Import layout file')),
      fileInput);
  }

  // ---------------- account ----------------
  function renderAccount() {
    const current = h('input.focusable', { type: 'password', autocomplete: 'current-password' });
    const next = h('input.focusable', { type: 'password', autocomplete: 'new-password' });
    const error = h('div.error-text');
    accountCard.innerHTML = '';
    accountCard.append(h('h2', { text: `Account · ${session.user ? session.user.username : ''}` }),
      h('form.form', {
        onsubmit: async (e) => {
          e.preventDefault();
          error.textContent = '';
          try {
            await post('/auth/password', { currentPassword: current.value, newPassword: next.value });
            current.value = '';
            next.value = '';
            toast('Password changed');
          } catch (err) {
            error.textContent = err.message;
          }
        },
      },
      h('div.row2', {}, field('Current password', current), field('New password', next)),
      error,
      h('div.form-actions', {},
        h('button.btn.focusable', { type: 'submit' }, 'Change password'),
        h('button.btn.danger.focusable', {
          type: 'button',
          onclick: async () => {
            await post('/auth/logout');
            await refreshSession();
            navigate('login', { replace: true });
            window.dispatchEvent(new HashChangeEvent('hashchange'));
          },
        }, 'Sign out'))));
  }

  // ---------------- users ----------------
  async function renderUsers() {
    let users = [];
    try {
      users = await get('/users');
    } catch {
      return;
    }
    const username = textInput('', { autocomplete: 'off' });
    const password = h('input.focusable', { type: 'password', autocomplete: 'new-password' });
    const admin = checkbox('Administrator (can manage users)', false);
    const error = h('div.error-text');
    usersCard.innerHTML = '';
    usersCard.append(h('h2', { text: 'Users' }), h('p.hint', { text: 'Each user has their own playlists, favorites, and settings.' }));
    for (const u of users) {
      usersCard.append(h('div.pl-item', {},
        h('div.info', {}, h('div.n', { text: u.username }), h('div.m', { text: u.isAdmin ? 'Administrator' : 'User' })),
        u.id === session.user.id ? null : h('div.acts', {}, h('button.btn.small.danger.focusable', {
          onclick: async () => {
            if (!confirm(`Delete user "${u.username}" and all their playlists?`)) return;
            try {
              await del(`/users/${u.id}`);
              toast('User deleted');
              renderUsers();
            } catch (err) {
              toast(err.message, { error: true });
            }
          },
        }, 'Delete'))));
    }
    usersCard.append(h('form.form', {
      style: 'margin-top:0.8rem',
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = '';
        try {
          await post('/users', { username: username.value, password: password.value, isAdmin: admin.input.checked });
          toast('User created');
          renderUsers();
        } catch (err) {
          error.textContent = err.message;
        }
      },
    }, h('div.row2', {}, field('New username', username), field('Password', password)), admin.el, error,
    h('div.form-actions', {}, h('button.btn.focusable', { type: 'submit' }, '+ Add user'))));
  }

  function renderAbout() {
    aboutCard.innerHTML = '';
    aboutCard.append(h('h2', { text: 'About' }), h('p.hint', {
      text: `Cipher ${session.version} · ${session.desktop ? 'Desktop app (local server)' : session.mode === 'apk' ? 'Android app (local server)' : 'Web server'}`,
    }));
  }

  await renderPlaylists(params.add ? 'new' : null);
  await renderGeneral();
  renderBackup();
  if (session.mode === 'web') renderAccount();
  if (session.mode === 'web' && session.user && session.user.isAdmin) await renderUsers();
  renderAbout();
  if (!params.add) focusFirst(root);

  return {
    manageFocus: true,
    onBack() {
      navigate('home');
      return true;
    },
    unmount() {
      clearInterval(shareTimer);
      stopStatusRef.stop();
    },
  };
}
