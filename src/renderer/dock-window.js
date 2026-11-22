/**
 * Dock window renderer.
 *
 * Hosts every enabled widget in a single transparent always-on-top window
 * that follows the main Overkot window. Widgets render as <iframe> cells
 * arranged into vertical columns, columns laid out left-to-right.
 *
 * Layout rules (locked with the user):
 *   - Each iframe widget reports its natural content size via postMessage
 *     (see widget-host.js → reportEmbedSize). The dock tracks those sizes.
 *   - Column width = max widget width inside that column. Every cell in
 *     the column is stretched to that width.
 *   - Cell height = the widget's reported natural height (not a fixed
 *     value), so a tall widget like the boss list gets the room it needs
 *     and a short widget stays short.
 *   - When the sum of cell heights in a column exceeds the available
 *     vertical room (work-area bottom minus dock top), the overflowing
 *     widgets spill into the next column. A fresh column is appended at
 *     the end if needed.
 *   - Every layout change is animated with the FLIP technique
 *     (First-Last-Invert-Play): we measure cell rects before the DOM
 *     mutation, mutate, measure again, apply the inverse transform, then
 *     transition to identity in the next frame.
 *   - Widgets can be dragged inside the dock to reorder. While dragging,
 *     a ghost element follows the cursor and the prospective drop
 *     position is shown as live FLIP reflow of the remaining cells.
 *     Release commits the new layout and persists it via saveConfig.
 */

const DOCK_PAD = 8;
const COLUMN_GAP = 8;
const CELL_GAP = 8;
const FALLBACK_W = 240;
const FALLBACK_H = 80;
const WIDGET_DEFAULT_SIZES = { 'world-watch': { w: 350, h: 300 } };
const FLIP_MS = 200;
const DROP_MARGIN = 32; // pixels into the column-gap that count as a drop

let state = {
  config: {},
  visibility: {},
  columns: [],          // [{ widgets: ['boss', ...] }, ...] — ordering only
  sizes: {},            // widget id -> { w, h }
  maxHeight: 600,       // refreshed from main on demand
};

// Outstanding render request — coalesces multiple triggers (size reports,
// config changes) into a single layout pass per frame.
let _renderQueued = false;
let desiredDockSize = { width: 0, height: 0 };
function syncDockOverflow() {
  // Clear both scrollbars together when the content fits the full viewport.
  // Otherwise each bar can make the other axis appear to overflow after a
  // resize, leaving unnecessary bars on an exactly fitted window on Windows.
  const fits = desiredDockSize.width <= window.innerWidth && desiredDockSize.height <= window.innerHeight;
  document.documentElement.style.overflow = fits ? 'hidden' : 'auto';
}
window.addEventListener('resize', syncDockOverflow);

function queueRender() {
  if (_renderQueued) return;
  _renderQueued = true;
  requestAnimationFrame(() => {
    _renderQueued = false;
    render();
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const s = await window.api.getState();
  state.config = s.config || {};
  state.visibility = state.config.widgetVisibility || {};
  state.columns = normalizeColumns(state.config.gridLayout?.columns, state.visibility);
  await refreshMaxHeight();
  render();

  window.api.onConfigChanged((newConfig) => {
    state.config = newConfig || {};
    state.visibility = state.config.widgetVisibility || {};
    state.columns = normalizeColumns(state.config.gridLayout?.columns, state.visibility);
    refreshMaxHeight().then(queueRender);
  });

  // Widget size updates from each iframe cell.
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || msg.type !== 'overkot-widget-size') return;
    const id = msg.widget;
    const w = Math.max(80, msg.w | 0);
    const h = Math.max(40, msg.h | 0);
    const prev = state.sizes[id];
    if (prev && prev.w === w && prev.h === h) return;
    state.sizes[id] = { w, h };
    queueRender();
  });

  bindDockDrag();

  // Main may move/resize at any time, which changes how much vertical
  // room the dock has before widgets spill into a new column. Listen for
  // pushed updates so we re-spill instead of overflowing the screen.
  if (window.api.onDockMaxHeight) {
    window.api.onDockMaxHeight((h) => {
      if (typeof h === 'number' && h > 0 && h !== state.maxHeight) {
        state.maxHeight = h;
        queueRender();
      }
    });
  }
});

async function refreshMaxHeight() {
  try {
    const h = await window.api.getDockMaxHeight();
    if (typeof h === 'number' && h > 0) state.maxHeight = h;
  } catch (_) { /* keep previous */ }
}

// ─── Layout helpers ─────────────────────────────────────────
function normalizeColumns(savedColumns, visibility) {
  const visibleIds = (window.ALL_WIDGET_IDS || []).filter(id => visibility[id] === true);
  const visibleSet = new Set(visibleIds);

  if (!Array.isArray(savedColumns) || savedColumns.length === 0) {
    return visibleIds.length ? [{ widgets: visibleIds.slice() }] : [];
  }

  const seen = new Set();
  const cleaned = [];
  for (const col of savedColumns) {
    const widgets = (col?.widgets || [])
      .filter(id => visibleSet.has(id) && !seen.has(id));
    widgets.forEach(id => seen.add(id));
    if (widgets.length) cleaned.push({ widgets });
  }
  const orphans = visibleIds.filter(id => !seen.has(id));
  if (orphans.length) {
    if (cleaned.length === 0) cleaned.push({ widgets: orphans });
    else cleaned[cleaned.length - 1].widgets.push(...orphans);
  }
  return cleaned;
}

// Apply vertical-overflow spillover: walk each column top-to-bottom; if
// adding the next widget would exceed maxHeight, push the rest into the
// next column (creating one if needed). Returns a fresh columns array;
// does not mutate state.columns. We deliberately do not collapse short
// columns back together — preserving the user's intended grouping.
function applyOverflow(columns, sizes, maxHeight) {
  const out = [];
  const queue = columns.map(c => ({ widgets: c.widgets.slice() }));
  while (queue.length) {
    const col = queue.shift();
    const fitted = [];
    let total = 0;
    let i = 0;
    for (; i < col.widgets.length; i++) {
      const id = col.widgets[i];
      const h = (sizes[id]?.h ?? WIDGET_DEFAULT_SIZES[id]?.h ?? FALLBACK_H);
      const next = total + (fitted.length ? CELL_GAP : 0) + h;
      if (fitted.length && next > maxHeight) break;
      fitted.push(id);
      total = next;
    }
    out.push({ widgets: fitted });
    if (i < col.widgets.length) {
      const overflow = col.widgets.slice(i);
      // Prepend overflow to the next existing column if any, else push as
      // a new column. Prepending keeps the user's intended order: the
      // spilled widgets are still adjacent to the ones above them.
      if (queue.length) queue[0].widgets = overflow.concat(queue[0].widgets);
      else queue.push({ widgets: overflow });
    }
  }
  return out;
}

function columnWidth(widgets, sizes) {
  let max = 0;
  for (const id of widgets) {
    const w = sizes[id]?.w ?? WIDGET_DEFAULT_SIZES[id]?.w ?? FALLBACK_W;
    if (w > max) max = w;
  }
  return max || FALLBACK_W;
}

// ─── FLIP ──────────────────────────────────────────────────
function captureRects(container) {
  const rects = new Map();
  for (const cell of container.querySelectorAll('.dock-cell')) {
    rects.set(cell.dataset.widget, cell.getBoundingClientRect());
  }
  return rects;
}
function playFlip(container, oldRects) {
  const cells = container.querySelectorAll('.dock-cell');
  for (const cell of cells) {
    const id = cell.dataset.widget;
    const before = oldRects.get(id);
    if (!before) continue; // newly added cell — fade in via CSS instead
    const after = cell.getBoundingClientRect();
    const dx = before.left - after.left;
    const dy = before.top - after.top;
    const sw = before.width  / Math.max(after.width,  1);
    const sh = before.height / Math.max(after.height, 1);
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sw - 1) < 0.01 && Math.abs(sh - 1) < 0.01) continue;
    cell.style.transition = 'none';
    cell.style.transform = `translate(${dx}px, ${dy}px) scale(${sw}, ${sh})`;
    // Force reflow before re-enabling transition.
    /* eslint-disable-next-line no-unused-expressions */
    cell.getBoundingClientRect();
    cell.style.transition = `transform ${window.OverkotMotion?.duration(FLIP_MS, cell) ?? FLIP_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
    cell.style.transform = '';
  }
}

// ─── Render ────────────────────────────────────────────────
function render() {
  const container = document.getElementById('dock-columns');
  const oldRects = captureRects(container);

  // Apply spillover for the on-screen layout. state.columns stays as the
  // user's intended grouping; on-screen we apply overflow each pass.
  const laidOut = applyOverflow(state.columns, state.sizes, Math.max(0, state.maxHeight - DOCK_PAD * 2));

  // Re-use existing iframes across re-renders so widgets aren't reloaded
  // (which would lose collapse/animation state inside them).
  const existing = new Map();
  for (const cell of Array.from(container.querySelectorAll('.dock-cell'))) {
    existing.set(cell.dataset.widget, cell);
  }

  // Keep iframe browsing contexts attached: clearing innerHTML and reattaching
  // the same node reloads its renderer, losing state and starting fresh polls.
  const existingColumns = Array.from(container.children);
  for (const [columnIndex, col] of laidOut.entries()) {
    const colEl = existingColumns[columnIndex] || document.createElement('div');
    if (!colEl.parentNode) {
      colEl.className = 'dock-column';
      container.appendChild(colEl);
    }
    const colW = columnWidth(col.widgets, state.sizes);
    colEl.style.width = colW + 'px';
    for (const [cellIndex, widgetId] of col.widgets.entries()) {
      let cell = existing.get(widgetId);
      if (!cell) {
        cell = document.createElement('iframe');
        cell.className = 'dock-cell';
        cell.dataset.widget = widgetId;
        cell.src = `widget-host.html?widget=${encodeURIComponent(widgetId)}&embed=1`;
      }
      const h = state.sizes[widgetId]?.h ?? WIDGET_DEFAULT_SIZES[widgetId]?.h ?? FALLBACK_H;
      cell.style.width = colW + 'px';
      cell.style.height = h + 'px';
      const currentAtIndex = colEl.children[cellIndex] || null;
      if (currentAtIndex !== cell) {
        // Chromium supports state-preserving moves; retain a fallback for
        // older development runtimes, which only reloads when order changes.
        if (cell.isConnected && typeof colEl.moveBefore === 'function') colEl.moveBefore(cell, currentAtIndex);
        else colEl.insertBefore(cell, currentAtIndex);
      }
      existing.delete(widgetId);
    }
  }
  // Anything still in `existing` was removed (widget hidden) — drop it.
  for (const orphan of existing.values()) orphan.remove();
  for (const column of existingColumns.slice(laidOut.length)) column.remove();

  if (shouldAnimate()) playFlip(container, oldRects);
  // While dragging we keep the dock window size stable — every mousemove
  // triggers a render to update the visual reflow, but we don't want each
  // one to round-trip a setBounds IPC to main. The dock will resize once
  // on drop via the post-endDrag re-render.
  if (!drag) requestDockResize();
}

// During a drag we re-render every time the drop slot changes. FLIP
// transitions are 200ms each and pile on top of the iframe re-layout,
// which makes the drag feel sticky. Skip the inverse-transform pass
// while dragging — the drop preview should be instant.
function shouldAnimate() { return drag == null && (window.OverkotMotion?.enabled() ?? true); }

// Ask main to size the dock window to fit our column layout exactly. We
// can't trust the container's bounding rect for this — the container is
// inline-flex / shrink-wrap so it follows what the window allows, which
// means measuring it would just report the dock's current size. Compute
// the desired size from column metrics instead.
function requestDockResize() {
  requestAnimationFrame(() => {
    let totalW = DOCK_PAD * 2;
    let maxColH = 0;
    const cols = document.querySelectorAll('.dock-column');
    cols.forEach((col, i) => {
      const colW = parseFloat(col.style.width) || col.getBoundingClientRect().width;
      totalW += colW;
      if (i > 0) totalW += COLUMN_GAP;
      // Sum cell heights + gaps for this column.
      let colH = 0;
      const cells = col.querySelectorAll('.dock-cell');
      cells.forEach((cell, j) => {
        const h = parseFloat(cell.style.height) || cell.getBoundingClientRect().height;
        colH += h;
        if (j > 0) colH += CELL_GAP;
      });
      if (colH > maxColH) maxColH = colH;
    });
    const totalH = maxColH + DOCK_PAD * 2;
    const w = Math.max(Math.ceil(totalW), 120);
    const h = Math.max(Math.ceil(totalH), 60);
    desiredDockSize = { width: w, height: h };
    syncDockOverflow();
    if (window.api.dockResizeRequest) window.api.dockResizeRequest(w, h);
  });
}

// ─── Drag and drop ─────────────────────────────────────────
// Iframes capture their own pointer events, so drag is initiated inside
// each widget-host instance: when the user mousedowns on the embedded
// widget body, widget-host posts an `overkot-embed-drag-start` message
// to us. We then track mousemove ourselves on the dock window and
// receive `overkot-embed-drag-move` from whichever iframe the cursor
// happens to be over. Mouseup ends the drag from either source.
let drag = null;

function bindDockDrag() {
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg) return;
    // Translate screen coords (sent from inside iframes, which can't see
    // their own offset within the dock window) into dock-local clientX/Y.
    const toLocal = (m) => ({
      x: (m.screenX != null ? m.screenX - window.screenX : m.clientX),
      y: (m.screenY != null ? m.screenY - window.screenY : m.clientY),
    });
    if (msg.type === 'overkot-embed-drag-start') {
      const p = toLocal(msg); beginDrag(msg.widget, p.x, p.y);
    } else if (msg.type === 'overkot-embed-drag-move') {
      const p = toLocal(msg); updateDrag(p.x, p.y);
    } else if (msg.type === 'overkot-embed-drag-end') {
      endDrag();
    }
  });
  window.addEventListener('mousemove', (e) => { if (drag) updateDrag(e.clientX, e.clientY); });
  window.addEventListener('mouseup',   () => { if (drag) endDrag(); });
  window.addEventListener('blur',      () => { if (drag) endDrag(); });
}

function beginDrag(widgetId, clientX, clientY) {
  if (drag) return;
  const container = document.getElementById('dock-columns');
  const sourceCell = container.querySelector(`.dock-cell[data-widget="${widgetId}"]`);
  if (!sourceCell) return;
  const rect = sourceCell.getBoundingClientRect();
  drag = {
    widgetId,
    offsetX: clientX - rect.left,
    offsetY: clientY - rect.top,
    width: rect.width,
    height: rect.height,
  };
  sourceCell.classList.add('dragging');
  // Disable pointer events on every iframe cell so mousemove events fire
  // on the dock window itself instead of being swallowed by whichever
  // iframe the cursor is currently over. Without this, every move forces
  // a postMessage round-trip from inside the iframe — the source of the
  // "laggy / kind of doesn't work" feel.
  container.classList.add('dragging');
  // Ghost is a translucent placeholder — we can't clone the iframe's DOM
  // (different document), so we just show a labeled rectangle.
  const ghost = document.createElement('div');
  ghost.className = 'dock-cell-ghost';
  ghost.style.width = rect.width + 'px';
  ghost.style.height = rect.height + 'px';
  ghost.textContent = widgetId;
  document.body.appendChild(ghost);
  drag.ghost = ghost;
  positionGhost(clientX, clientY);
}

function positionGhost(clientX, clientY) {
  if (!drag) return;
  drag.ghost.style.left = (clientX - drag.offsetX + drag.width / 2)  + 'px';
  drag.ghost.style.top  = (clientY - drag.offsetY + drag.height / 2) + 'px';
}

function updateDrag(clientX, clientY) {
  if (!drag) return;
  positionGhost(clientX, clientY);
  const target = computeDropTarget(clientX, clientY);
  if (!target) return;
  const next = moveWidget(state.columns, drag.widgetId, target.colIndex, target.rowIndex);
  if (!sameColumns(next, state.columns)) {
    state.columns = next;
    render();
  }
}

function endDrag() {
  if (!drag) return;
  const container = document.getElementById('dock-columns');
  const sourceCell = container.querySelector(`.dock-cell[data-widget="${drag.widgetId}"]`);
  if (sourceCell) sourceCell.classList.remove('dragging');
  container.classList.remove('dragging');
  if (drag.ghost) drag.ghost.remove();
  drag = null;
  // Now that drag is over, push the final size to main so the dock
  // resizes to match any new-column / removed-column changes.
  requestDockResize();
  // Persist the new layout.
  const layout = { columns: state.columns.map(c => ({ widgets: c.widgets.slice() })) };
  window.api.saveConfig({ gridLayout: layout });
}

// Find which column / which row inside that column the cursor sits in.
// The new-column drop zones live in the *right portion* of the last
// column and to the *left* of the first — we can't rely on the cursor
// going past the dock window's edge because the window is sized to its
// content (plus a tiny padding) and the cursor would leave the window
// first.
function computeDropTarget(clientX, clientY) {
  const container = document.getElementById('dock-columns');
  const cols = Array.from(container.querySelectorAll('.dock-column'));
  if (cols.length === 0) return { colIndex: 0, rowIndex: 0 };

  // Edge zone: cursor in the rightmost ~25% of the last column AND past
  // its widgets' midpoint => append a new column at the end.
  const lastCol = cols[cols.length - 1];
  const lastRect = lastCol.getBoundingClientRect();
  const newColZoneL = lastRect.right - lastRect.width * 0.25;
  if (clientX >= newColZoneL) {
    // Only treat as new-column if dragging out of a multi-cell column or
    // moving a widget that doesn't already sit alone in the last col
    // (otherwise we'd thrash between "alone in last col" and "new col").
    const lastIds = state.columns[state.columns.length - 1]?.widgets || [];
    const draggingId = drag?.widgetId;
    const aloneInLast = lastIds.length === 1 && lastIds[0] === draggingId;
    if (!aloneInLast) return { colIndex: cols.length, rowIndex: 0, newColumn: true };
  }

  for (let i = 0; i < cols.length; i++) {
    const cr = cols[i].getBoundingClientRect();
    if (clientX < cr.left - DROP_MARGIN) {
      return { colIndex: i, rowIndex: 0, newColumn: true };
    }
    if (clientX <= cr.right + DROP_MARGIN) {
      const cells = Array.from(cols[i].querySelectorAll('.dock-cell'));
      let row = cells.length;
      for (let r = 0; r < cells.length; r++) {
        const rr = cells[r].getBoundingClientRect();
        if (clientY < rr.top + rr.height / 2) { row = r; break; }
      }
      return { colIndex: i, rowIndex: row };
    }
  }
  return { colIndex: cols.length, rowIndex: 0, newColumn: true };
}

// Return a new columns array with `widgetId` removed from wherever it
// was and re-inserted at (colIndex, rowIndex). Trailing/empty columns
// are dropped so we don't accumulate stale buckets.
function moveWidget(columns, widgetId, colIndex, rowIndex) {
  const next = columns.map(c => ({ widgets: c.widgets.slice() }));
  for (const col of next) {
    const idx = col.widgets.indexOf(widgetId);
    if (idx !== -1) col.widgets.splice(idx, 1);
  }
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].widgets.length === 0) next.splice(i, 1);
  }
  while (next.length <= colIndex) next.push({ widgets: [] });
  const targetCol = next[colIndex];
  const r = Math.max(0, Math.min(rowIndex, targetCol.widgets.length));
  targetCol.widgets.splice(r, 0, widgetId);
  while (next.length && next[next.length - 1].widgets.length === 0) next.pop();
  return next;
}

function sameColumns(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const aw = a[i].widgets, bw = b[i].widgets;
    if (aw.length !== bw.length) return false;
    for (let j = 0; j < aw.length; j++) if (aw[j] !== bw[j]) return false;
  }
  return true;
}
