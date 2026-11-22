'use strict';

const path = require('node:path');

const DEFAULT_SIZE = Object.freeze({ width: 520, height: 680 });
const MIN_SIZE = Object.freeze({ width: 360, height: 360 });
const BOUNDS_KEY = 'dailyBriefBounds';

/** A pop-out has its own placement, independent of widget/dock geometry. */
function dailyBriefWindowBounds(saved, screen) {
  const valid = saved && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(saved[key]))
    && Math.abs(saved.x) <= 1_000_000 && Math.abs(saved.y) <= 1_000_000
    && saved.width > 0 && saved.width <= 32768 && saved.height > 0 && saved.height <= 32768;
  const area = (valid ? screen.getDisplayMatching(saved) : screen.getPrimaryDisplay()).workArea;
  const width = Math.round(Math.min(area.width, Math.max(MIN_SIZE.width, valid ? saved.width : DEFAULT_SIZE.width)));
  const height = Math.round(Math.min(area.height, Math.max(MIN_SIZE.height, valid ? saved.height : DEFAULT_SIZE.height)));
  return { width, height,
    x: Math.round(Math.max(area.x, Math.min(valid ? saved.x : area.x + (area.width - width) / 2, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(valid ? saved.y : area.y + (area.height - height) / 2, area.y + area.height - height))) };
}

/** Own one normal native window; opening Daily Brief never creates a widget. */
function createDailyBriefWindow({ BrowserWindow, screen, config, rendererRoot, preloadPath, iconPath,
  trackBounds = () => {}, onCreated = () => {}, onClosed = () => {},
  canShow = () => true, onError = () => {} }) {
  let current = null, ready = false, pendingFocus = false;
  const getWindow = () => current && !current.isDestroyed() ? current : null;

  function reveal(win, focus) {
    if (win.isDestroyed()) return;
    if (!canShow()) {
      // An app-hide pass can run while this window is still loading. Retain
      // the pending open request so revealing Overkot also reveals the brief.
      win._visibleBeforeOverlayHide = true;
      return;
    }
    // Automatic login/reset prompts must not undo a deliberate minimization.
    if (win.isMinimized()) {
      if (!focus) return;
      win.restore();
    }
    if (focus) { win.show(); win.focus(); }
    else win.showInactive();
  }

  function open({ focus = true } = {}) {
    const existing = getWindow();
    if (existing) {
      if (ready) reveal(existing, focus);
      else pendingFocus = pendingFocus || focus;
      return existing;
    }
    const bounds = dailyBriefWindowBounds(config.get(BOUNDS_KEY), screen);
    const win = new BrowserWindow({ ...bounds,
      minWidth: Math.min(MIN_SIZE.width, bounds.width), minHeight: Math.min(MIN_SIZE.height, bounds.height),
      show: false, frame: false, transparent: false, resizable: true,
      alwaysOnTop: true, skipTaskbar: true, backgroundColor: '#1b1b1b',
      ...(iconPath ? { icon: iconPath } : {}),
      webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    current = win; ready = false; pendingFocus = focus;
    trackBounds(win, BOUNDS_KEY);
    win.once('closed', () => {
      if (current !== win) return;
      current = null; ready = false; pendingFocus = false;
      onClosed(win);
    });
    win.once('ready-to-show', () => {
      if (current !== win || win.isDestroyed()) return;
      ready = true;
      reveal(win, pendingFocus);
      pendingFocus = false;
    });
    onCreated(win);
    Promise.resolve(win.loadFile(path.join(rendererRoot, 'daily-brief-window.html'), { query: { widget: 'daily' } }))
      .catch(error => { onError(error); if (!win.isDestroyed()) win.close(); });
    return win;
  }

  function close() {
    const win = getWindow();
    if (win) win.close();
  }
  return { open, close, getWindow };
}

module.exports = { DEFAULT_SIZE, MIN_SIZE, BOUNDS_KEY, dailyBriefWindowBounds, createDailyBriefWindow };
