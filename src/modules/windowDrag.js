'use strict';

const { constrainBounds, moveDragTarget, snapBounds } = require('./windowGeometry');

// Frameless overlay sizes are owned by the app. Keep requested DIP dimensions
// separate from X11's enclosing pixel rectangles, including between gestures.
const intendedSizes = new WeakMap();

function rememberWindowSize(win, { width, height }) {
  intendedSizes.set(win, { width, height });
}

function getWindowBounds(win) {
  return { ...win.getBounds(), ...intendedSizes.get(win) };
}

function setWindowBounds(win, bounds) {
  rememberWindowSize(win, bounds);
  win.setBounds(bounds);
}

/** Keep drag geometry independent of asynchronous window-manager configure events. */
function createWindowDragController({ screen, getOtherWindows = () => [], nativeCursor = false,
  schedule = setInterval, cancel = clearInterval, now = Date.now } = {}) {
  const active = new Map();

  function place(win, state, target) {
    win._dragTarget = target;
    const workArea = screen.getDisplayMatching({ ...target, x: Math.round(target.x), y: Math.round(target.y) }).workArea;
    const others = state.snap ? getOtherWindows()
      .filter(other => other && other !== win && !other.isDestroyed() && other.isVisible())
      .map(other => getWindowBounds(other)) : [];
    const next = state.snap ? snapBounds(target, workArea, others) : constrainBounds(target, workArea);
    if (next.x === state.last.x && next.y === state.last.y) return;
    win._dragMoveActiveUntil = now() + 180;
    // Electron's setPosition internally reads the live size and calls setBounds.
    // Keep our frozen size instead: repeatedly round-tripping X11 bounds through
    // fractional DIP scaling can otherwise grow the window on every move.
    win.setBounds(next);
    state.last = next;
  }

  function sample(win, state) {
    if (win.isDestroyed()) { end(win, false); return; }
    const cursor = screen.getCursorScreenPoint();
    const dx = cursor.x - state.cursor.x;
    const dy = cursor.y - state.cursor.y;
    if (!state.moved && Math.max(Math.abs(dx), Math.abs(dy)) <= state.threshold) return;
    state.moved = true;
    place(win, state, moveDragTarget(state.origin, dx, dy));
  }

  function start(win, { threshold = 3, snap = false } = {}) {
    end(win, false);
    if (!win || win.isDestroyed()) return;
    const origin = getWindowBounds(win);
    rememberWindowSize(win, origin);
    const state = { origin, last: origin, snap: !!snap, moved: false,
      threshold: Number.isFinite(threshold) ? Math.min(20, Math.max(0, threshold)) : 3,
      cursor: nativeCursor ? screen.getCursorScreenPoint() : null,
    };
    active.set(win, state);
    win._isDragging = true;
    win._dragLockWidth = origin.width;
    win._dragLockHeight = origin.height;
    win._dragTarget = origin;
    state.abort = () => end(win, false);
    win.on('blur', state.abort);
    win.on('closed', state.abort);
    win.webContents.on('render-process-gone', state.abort);
    if (nativeCursor) {
      state.timer = schedule(() => sample(win, state), 16);
      state.timer?.unref?.();
    }
  }

  function moveBy(win, dx, dy, snap = false) {
    if (!win || win.isDestroyed() || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const state = active.get(win);
    if (!state) return;
    state.snap = !!snap;
    // Moving an X11 window can itself generate renderer pointer events with
    // stale screen coordinates. Only the desktop cursor determines movement.
    if (nativeCursor || (dx === 0 && dy === 0)) return;
    place(win, state, moveDragTarget(win._dragTarget, dx, dy));
  }

  function end(win, flush = true) {
    const state = active.get(win);
    if (!state) return;
    if (flush && nativeCursor && !win.isDestroyed()) sample(win, state);
    active.delete(win);
    if (state.timer !== undefined) cancel(state.timer);
    win.removeListener('blur', state.abort);
    win.removeListener('closed', state.abort);
    win.webContents.removeListener('render-process-gone', state.abort);
    win._isDragging = false;
    // Let the final X11 configure reply arrive before accepting content resizes.
    win._dragMoveActiveUntil = nativeCursor && state.moved ? now() + 180 : 0;
    win._dragLockWidth = null;
    win._dragLockHeight = null;
    win._dragTarget = null;
    // Native configure replies can still lag this final request. Let callers
    // use the displayed target for release decisions rather than stale bounds.
    return { ...state.last };
  }

  return { start, moveBy, end, dispose() { for (const win of active.keys()) end(win, false); } };
}

module.exports = { createWindowDragController, rememberWindowSize, getWindowBounds, setWindowBounds };
