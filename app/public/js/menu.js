/**
 * Popup context menus (with submenus) and a small text prompt dialog. Both work with mouse, touch
 * and remote/keyboard; while open they take all key input via the nav.js modal stack.
 */
import { h } from './util.js';
import { pushModal, focusEl, moveFocus, isTextInput } from './nav.js';

/**
 * items: [{ label, onSelect, submenu: items, checked: bool, disabled: bool, hint }] or { separator: true }
 * at: { x, y } in viewport pixels, or { anchor: element }.
 */
export function openMenu(items, at = {}) {
  const returnFocus = document.activeElement;
  const backdrop = h('div.cm-backdrop');
  const panels = [];
  let closed = false;

  const close = ({ restoreFocus = true } = {}) => {
    if (closed) return;
    closed = true;
    popModal();
    backdrop.remove();
    if (restoreFocus && returnFocus && document.contains(returnFocus)) {
      if (at.keyboard) focusEl(returnFocus);
      else returnFocus.focus({ preventScroll: true });
    }
  };

  const closeFrom = (level) => {
    while (panels.length > level) panels.pop().el.remove();
  };

  const place = (el, x, y, { flipX = null } = {}) => {
    el.style.left = '0px';
    el.style.top = '0px';
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    if (left + r.width > vw - 8) left = flipX !== null ? flipX - r.width : vw - r.width - 8;
    let top = Math.min(y, vh - r.height - 8);
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${Math.max(8, top)}px`;
  };

  const openPanel = (list, level, pos, { keyboard = false } = {}) => {
    closeFrom(level);
    const el = h('div.cm-menu', { role: 'menu' });
    const panel = { el, items: [] };
    for (const item of list) {
      if (!item) continue;
      if (item.separator) {
        el.append(h('div.cm-sep'));
        continue;
      }
      if (item.header) {
        el.append(h('div.cm-head', { text: item.label }));
        continue;
      }
      const btn = h('button.cm-item', {
        role: 'menuitem',
        tabindex: '-1',
        disabled: !!item.disabled,
      },
      h('span.cm-check', { text: item.checked ? '✓' : '' }),
      h('span.cm-label', { text: item.label }),
      item.hint ? h('span.cm-hint', { text: item.hint }) : null,
      item.submenu ? h('span.cm-arrow', { text: '›' }) : null);
      if (item.checked) btn.classList.add('checked');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        activate(item, btn, level, false);
      });
      btn.addEventListener('pointerenter', (e) => {
        if (e.pointerType !== 'mouse') return;
        btn.focus({ preventScroll: true });
        if (item.submenu) openSub(item, btn, level, false);
        else closeFrom(level + 1);
      });
      panel.items.push({ item, btn });
      el.append(btn);
    }
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    backdrop.append(el);
    panels.push(panel);
    place(el, pos.x, pos.y, pos);
    const first = panel.items.find((p) => !p.item.disabled);
    if (first && keyboard) focusEl(first.btn);
    else if (first) first.btn.focus({ preventScroll: true });
    return panel;
  };

  const openSub = (item, btn, level, keyboard) => {
    if (panels[level + 1] && panels[level + 1].owner === btn) {
      if (keyboard) focusEl(panels[level + 1].items.find((p) => !p.item.disabled)?.btn);
      return;
    }
    const r = btn.getBoundingClientRect();
    const panel = openPanel(item.submenu, level + 1, { x: r.right - 4, y: r.top - 6, flipX: r.left + 4 }, { keyboard });
    panel.owner = btn;
    if (!keyboard) btn.focus({ preventScroll: true });
  };

  const activate = (item, btn, level, keyboard) => {
    if (item.disabled) return;
    if (item.submenu) {
      openSub(item, btn, level, keyboard);
      return;
    }
    close();
    if (item.onSelect) item.onSelect();
  };

  const currentLevel = () => {
    const idx = panels.findIndex((p) => p.el.contains(document.activeElement));
    return idx >= 0 ? idx : panels.length - 1;
  };

  const popModal = pushModal({
    close: () => close({ restoreFocus: false }),
    onBack() {
      if (panels.length > 1) {
        const owner = panels[panels.length - 1].owner;
        closeFrom(panels.length - 1);
        focusEl(owner);
      } else {
        close();
      }
    },
    onKey(action, e) {
      const level = currentLevel();
      const panel = panels[level];
      if (!panel) return true;
      const enabled = panel.items.filter((p) => !p.item.disabled);
      const idx = enabled.findIndex((p) => p.btn === document.activeElement);
      const entry = enabled[idx];
      if (action === 'up' || action === 'down') {
        if (!enabled.length) return true;
        const next = action === 'down' ? (idx + 1) % enabled.length : (idx - 1 + enabled.length) % enabled.length;
        closeFrom(level + 1);
        focusEl(enabled[idx < 0 ? 0 : next].btn);
      } else if (action === 'enter') {
        if (e.repeat) return true;
        if (entry) activate(entry.item, entry.btn, level, true);
      } else if (action === 'right') {
        if (entry && entry.item.submenu) openSub(entry.item, entry.btn, level, true);
      } else if (action === 'left') {
        if (level > 0) {
          const owner = panel.owner;
          closeFrom(level);
          focusEl(owner);
        }
      } else if (action === 'menu') {
        close();
      }
      return true;
    },
  });

  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (e.target === backdrop) close();
  });
  document.body.append(backdrop);

  let pos;
  if (at.anchor) {
    const r = at.anchor.getBoundingClientRect();
    pos = { x: r.left + Math.min(24, r.width / 2), y: r.bottom + 4 };
  } else {
    pos = { x: at.x ?? window.innerWidth / 2, y: at.y ?? window.innerHeight / 3 };
  }
  openPanel(items, 0, pos, { keyboard: !!at.keyboard });
  return { close };
}

/**
 * Pick one or more custom groups. groups: [{ id, name, count?, disabled?, checked? }].
 * Resolves with selected ids (multi) or one id / null (single).
 */
export function groupPickerDialog({ title, groups, multi = false, okLabel = 'Save', hint = '' } = {}) {
  return new Promise((resolve) => {
    const returnFocus = document.activeElement;
    const list = h('div.group-picker-list');
    const inputs = [];
    for (const g of groups) {
      const input = h('input.focusable', { type: multi ? 'checkbox' : 'radio', name: 'grp-pick', checked: !!g.checked, disabled: !!g.disabled });
      inputs.push({ g, input });
      list.append(h('label.check', { title: g.disabled ? g.disabledHint || '' : '' }, input, h('span', { text: `${g.name}${g.count != null ? ` (${g.count})` : ''}` })));
    }
    const ok = h(`button.btn.primary.focusable`, { type: 'submit', text: okLabel });
    const cancel = h('button.btn.focusable', { type: 'button', text: 'Cancel' });
    const form = h('form.dialog', { role: 'dialog' },
      h('h2', { text: title }),
      hint ? h('div.dialog-hint', { text: hint }) : null,
      list,
      h('div.dialog-actions', {}, cancel, ok));
    const backdrop = h('div.cm-backdrop.dim', {}, form);

    const finish = (result) => {
      popModal();
      backdrop.remove();
      if (returnFocus && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
      resolve(result);
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const picked = inputs.filter(({ input, g }) => input.checked && !g.disabled).map(({ g }) => g.id);
      if (!multi && !picked.length) return;
      finish(multi ? picked : (picked[0] || null));
    });
    cancel.addEventListener('click', () => finish(null));
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) finish(null);
    });

    const popModal = pushModal({
      close: () => finish(null),
      onBack: () => finish(null),
      onKey(action) {
        if (action === 'up' || action === 'down') {
          moveFocus(action, form);
          return true;
        }
        return false;
      },
    });

    document.body.append(backdrop);
    const first = inputs.find(({ g }) => !g.disabled);
    if (first) focusEl(first.input);
    else focusEl(cancel);
  });
}

/** Asks the user to confirm an action. Resolves true or false. */
export async function confirmDialog({ title, message = '', okLabel = 'OK', danger = false } = {}) {
  return (await promptDialog({ title, hint: message, okLabel, danger, input: false })) !== null;
}

/** Asks for a line of text. Resolves with the entered string, or null when cancelled. */
export function promptDialog({ title, value = '', placeholder = '', hint = '', okLabel = 'Save', danger = false, input: withInput = true } = {}) {
  return new Promise((resolve) => {
    const returnFocus = document.activeElement;
    const input = withInput ? h('input.input', { type: 'text', value, placeholder, maxlength: '120' }) : null;
    const ok = h(`button.btn.${danger ? 'danger' : 'primary'}.focusable`, { type: 'submit', text: okLabel });
    const cancel = h('button.btn.focusable', { type: 'button', text: 'Cancel' });
    const form = h('form.dialog', { role: 'dialog' },
      h('h2', { text: title }),
      input,
      hint ? h('div.dialog-hint', { text: hint }) : null,
      h('div.dialog-actions', {}, cancel, ok));
    const backdrop = h('div.cm-backdrop.dim', {}, form);

    const finish = (result) => {
      popModal();
      backdrop.remove();
      if (returnFocus && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
      resolve(result);
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      finish(input ? input.value : '');
    });
    cancel.addEventListener('click', () => finish(null));
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) finish(null);
    });

    const popModal = pushModal({
      close: () => finish(null),
      onBack: () => finish(null),
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
    if (input) {
      input.focus();
      input.select();
    } else {
      focusEl(cancel);
    }
  });
}
