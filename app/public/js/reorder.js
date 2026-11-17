/**
 * In-place reordering for rendered lists (groups, channels). Rows carry a `data-<attr>` id; moves shift
 * the row elements themselves instead of re-rendering, so the scroll position never jumps.
 */
import { focusEl } from './nav.js';

/** Runs a DOM change while keeping the first visible row (other than `moved`) at the same screen spot. */
export function keepView(container, selector, change, moved) {
  const top = container.getBoundingClientRect().top;
  const anchor = [...container.querySelectorAll(selector)]
    .find((el) => el !== moved && el.getBoundingClientRect().bottom > top);
  const before = anchor ? anchor.getBoundingClientRect().top : 0;
  change();
  if (anchor) container.scrollTop += anchor.getBoundingClientRect().top - before;
}

/**
 * Reorder session over the rows inside `container`.
 * ids: current order. hint(): text for the `.reorder-bar .list-head-text` element.
 * Returns { ids, moving, active, itemEl, sync, moveTo, move, toggle, beginDrag, takeClick, end }.
 */
export function createReorder(container, { attr, ids, moving = null, hint = null }) {
  const selector = `[data-${attr}]`;
  let suppressClick = false;

  const r = {
    ids: [...ids],
    moving,
    active: true,

    itemEl: (id) => container.querySelector(`[data-${attr}="${CSS.escape(id)}"]`),

    /** Updates the "moving" highlight and hint without rebuilding the list. */
    sync() {
      container.querySelectorAll(selector).forEach((el) => {
        el.classList.toggle('moving', r.active && el.dataset[attr] === r.moving);
      });
      const text = container.querySelector('.reorder-bar .list-head-text');
      if (text && hint && r.active) text.textContent = hint();
    },

    /**
     * Moves a row by moving its element in place. follow: keep the row in view (remote/keyboard);
     * otherwise the view stays put. pick: leave the row selected for further moves.
     * anchor: pin the visible rows while the row leaves or enters above them.
     */
    moveTo(id, to, { follow = true, pick = true, anchor = true } = {}) {
      const from = r.ids.indexOf(id);
      const el = r.itemEl(id);
      if (from < 0 || to < 0 || to >= r.ids.length || !el) return;
      r.moving = pick ? id : null;
      if (from !== to) {
        r.ids.splice(from, 1);
        r.ids.splice(to, 0, id);
        const place = () => {
          const ref = r.itemEl(r.ids[to + 1] || '');
          if (ref) ref.before(el);
          else r.itemEl(r.ids[to - 1]).after(el);
        };
        if (follow || !anchor) place();
        else keepView(container, selector, place, el);
      }
      r.sync();
      if (follow) focusEl(el);
      else el.focus({ preventScroll: true });
    },

    move(id, delta, opts) {
      r.moveTo(id, r.ids.indexOf(id) + delta, opts);
    },

    toggle(id) {
      r.moving = r.moving === id ? null : id;
      r.sync();
    },

    /** True once after a drag ended, so the click that follows the drop is ignored. */
    takeClick() {
      if (!suppressClick) return false;
      suppressClick = false;
      return true;
    },

    end() {
      r.active = false;
    },

    /**
     * Pointer drag: mouse drags the whole row, touch uses the ⠿ handle (.ro-handle). The row floats
     * with the pointer and the others slide out of the way; the DOM is only reordered on drop, so the
     * layout the drop target is computed from never shifts mid-drag.
     */
    beginDrag(e, item, id) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest('.ro-btn')) return;
      const onHandle = !!e.target.closest('.ro-handle');
      if (e.pointerType !== 'mouse' && !onHandle) return;
      const list = item.parentElement;
      const startY = e.clientY;
      const startScroll = container.scrollTop;
      let lastY = startY;
      let dragging = false;
      let scrollTimer = null;
      let items = [];
      let from = 0;
      let target = 0;
      let step = 0;

      const layout = () => {
        const dy = lastY - startY + container.scrollTop - startScroll;
        item.style.transform = `translateY(${dy}px)`;
        const center = item.offsetTop + item.offsetHeight / 2 + dy;
        target = 0;
        items.forEach((el, k) => {
          if (k !== from && el.offsetTop + el.offsetHeight / 2 < center) target += 1;
        });
        items.forEach((el, k) => {
          if (k === from) return;
          const other = k < from ? k : k - 1;
          let shift = 0;
          if (k > from && other < target) shift = -step;
          else if (k < from && other >= target) shift = step;
          el.style.transform = shift ? `translateY(${shift}px)` : '';
        });
      };
      const autoScroll = () => {
        const rect = container.getBoundingClientRect();
        const edge = Math.min(60, rect.height / 5);
        const before = container.scrollTop;
        if (lastY < rect.top + edge) container.scrollTop -= 14;
        else if (lastY > rect.bottom - edge) container.scrollTop += 14;
        if (container.scrollTop !== before) layout();
      };
      const onMove = (ev) => {
        lastY = ev.clientY;
        if (!dragging) {
          if (!onHandle && Math.abs(lastY - startY) < 6) return;
          dragging = true;
          try {
            item.setPointerCapture(e.pointerId);
          } catch {
            // pointer already released
          }
          items = [...list.querySelectorAll(selector)];
          from = items.indexOf(item);
          const next = items[from + 1] || items[from - 1];
          step = next ? Math.abs(next.offsetTop - item.offsetTop) : item.offsetHeight;
          list.classList.add('drag-active');
          item.classList.add('dragging', 'moving');
          scrollTimer = setInterval(autoScroll, 30);
        }
        ev.preventDefault();
        layout();
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        clearInterval(scrollTimer);
        if (!dragging) return;
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 300);
        list.classList.remove('drag-active');
        item.classList.remove('dragging');
        items.forEach((el) => { el.style.transform = ''; });
        if (!r.active) return;
        r.moving = null;
        r.moveTo(id, target, { follow: false, pick: false, anchor: false });
      };
      if (onHandle) e.preventDefault();
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
  };
  return r;
}

/** Shared ⤒ ▲ ▼ ⤓ buttons shown on each row in reorder mode. */
export function reorderButtons(h, r, id) {
  const btn = (text, title, fn) => h('span.ro-btn', {
    text,
    title,
    onclick: (e) => {
      e.stopPropagation();
      fn();
    },
  });
  return [
    btn('⤒', 'Move to top', () => r.moveTo(id, 0, { follow: false, pick: false })),
    btn('▲', 'Move up', () => r.move(id, -1, { follow: false })),
    btn('▼', 'Move down', () => r.move(id, 1, { follow: false })),
    btn('⤓', 'Move to bottom', () => r.moveTo(id, r.ids.length - 1, { follow: false, pick: false })),
  ];
}
