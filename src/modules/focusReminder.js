'use strict';

const path = require('node:path');
const { configureOverlayWorkspace } = require('./overlayWindowPolicy');
const { windowMessages } = require('./localization');
const { fontStack } = require('./appearance');

const REMINDER_DURATION_MS = 60_000;

/** Position the speech bubble beside the brand icon, including negative displays. */
function reminderPlacement(dock, display, edge = 'bottom') {
  const width = Math.min(330, display.width), height = Math.min(110, display.height);
  const vertical = edge === 'left' || edge === 'right';
  const anchor = { x: dock.x + (vertical ? dock.width / 2 : 28),
    y: dock.y + (vertical ? 28 : dock.height / 2) };
  let x = vertical ? (edge === 'left' ? dock.x + dock.width : dock.x - width) : anchor.x - 28;
  let y = vertical ? anchor.y - 28 : (edge === 'top' ? dock.y + dock.height : dock.y - height);
  x = Math.round(Math.max(display.x, Math.min(display.x + display.width - width, x)));
  y = Math.round(Math.max(display.y, Math.min(display.y + display.height - height, y)));
  const arrowOffset = Math.max(18, Math.min((vertical ? height : width) - 18,
    vertical ? anchor.y - y : anchor.x - x));
  return { bounds: { x, y, width, height }, edge, arrowOffset };
}

/** One reminder per process launch. Hiding the overlay never resets its deadline. */
function createFocusReminder({ BrowserWindow, platformSupport, getDockBounds, getDisplay,
  getEdge, getHotkey, getWarning = () => '', getLanguage = () => 'en', getFontFamily = () => 'system', canShow, durationMs = REMINDER_DURATION_MS,
  onRaised = () => {},
  rendererDirectory = path.join(__dirname, '..', 'renderer'),
  schedule = setTimeout, cancel = clearTimeout, poll = setInterval, stopPoll = clearInterval }) {
  let win = null, armed = false, dismissed = false, ready = false, expiry = null, monitor = null;
  let lastBounds = '';

  function dismiss() {
    dismissed = true;
    if (expiry !== null) cancel(expiry);
    if (monitor !== null) stopPoll(monitor);
    expiry = monitor = null;
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  }

  function refresh() {
    if (!armed || dismissed) return;
    if (!canShow()) {
      if (win && !win.isDestroyed()) win.hide();
      return;
    }
    if (!win) {
      const placement = reminderPlacement(getDockBounds(), getDisplay(), getEdge());
      win = new BrowserWindow({ ...placement.bounds, frame: false, transparent: true,
        show: false, focusable: false, skipTaskbar: true, resizable: false, movable: false,
        hasShadow: false, alwaysOnTop: true,
        ...(platformSupport.platform === 'linux' ? { type: 'dock' } : {}),
        webPreferences: { preload: path.join(rendererDirectory, 'focus-reminder-preload.js'),
          contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      win.setIgnoreMouseEvents(true);
      win.setAlwaysOnTop(true, 'screen-saver');
      configureOverlayWorkspace(win, platformSupport);
      if (platformSupport.platform !== 'win32') win.setVisibleOnAllWorkspaces(true);
      win.once('ready-to-show', () => { ready = true; refresh(); });
      win.once('closed', () => { win = null; if (!dismissed) dismiss(); });
      win.loadFile(path.join(rendererDirectory, 'focus-reminder.html'));
    }
    if (!ready || win.isDestroyed()) return;
    const placement = reminderPlacement(getDockBounds(), getDisplay(), getEdge());
    const nextBounds = JSON.stringify(placement.bounds);
    if (nextBounds !== lastBounds) { win.setBounds(placement.bounds); lastBounds = nextBounds; }
    const messages = windowMessages(getLanguage(), ['focusReady', 'focusUnavailable', 'focusTrayHint', 'focusPress', 'focusSettingsHint']);
    win.webContents.send('focus-reminder:state', { edge: placement.edge, arrowOffset: placement.arrowOffset,
      hotkey: getHotkey(), warning: getWarning(), font: fontStack(getFontFamily(), messages.locale), ...messages });
    if (!win.isVisible()) win.showInactive();
    // Raising a passive bubble does not activate it or steal the game's input.
    win.moveTop();
    onRaised();
    if (expiry === null) expiry = schedule(dismiss, durationMs);
  }

  return {
    start() {
      if (armed || dismissed) return;
      armed = true;
      monitor = poll(refresh, 500);
      monitor?.unref?.();
      refresh();
    },
    refresh, dismiss, dispose: dismiss,
  };
}

module.exports = { REMINDER_DURATION_MS, reminderPlacement, createFocusReminder };
