'use strict';

const path = require('node:path');
const { normalize } = require('./moonsteelAlertSettings');
const { configureOverlayWorkspace: configureDefaultWorkspace } = require('./overlayWindowPolicy');

const SOUND_TAIL_MS = 1800;
const LOAD_TIMEOUT_MS = 10000;

/** A short-lived, nonactivating surface; detection never depends on its renderer. */
function createMoonsteelAlertWindow({ BrowserWindow, screen,
  rendererRoot = path.join(__dirname, '..', 'renderer'),
  preloadPath = path.join(__dirname, '..', 'moonsteel-alert-preload.js'),
  platformSupport = { platform: process.platform },
  configureOverlayWorkspace = configureDefaultWorkspace,
  schedule = setTimeout, cancel = clearTimeout, onError = () => {} } = {}) {
  const records = new Set();
  let generation = 0, disposed = false;

  function destroy(record) {
    if (record.timer !== null) cancel(record.timer);
    if (record.geometryTimer !== null) cancel(record.geometryTimer);
    record.timer = null;
    record.geometryTimer = null;
    records.delete(record);
    if (!record.win.isDestroyed()) record.win.destroy();
  }
  function close() {
    generation++;
    for (const record of [...records]) destroy(record);
  }
  function targets(settings) {
    const all = screen.getAllDisplays();
    let selected;
    if (settings.monitor === 'all') selected = all;
    else if (settings.monitor === 'cursor') selected = [screen.getDisplayNearestPoint(screen.getCursorScreenPoint())];
    else selected = [screen.getPrimaryDisplay()];
    const seen = new Set();
    return selected.filter(display => {
      const bounds = display?.bounds;
      if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key]))
        || bounds.width <= 0 || bounds.height <= 0) return false;
      // Mirrored monitors share desktop coordinates. One surface already
      // appears on each mirror; stacking another would double the intensity.
      const key = JSON.stringify(['x', 'y', 'width', 'height'].map(axis => bounds[axis]));
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }
  function raise() {
    for (const { win } of records) {
      if (!win.isDestroyed() && win.isVisible()) win.moveTop();
    }
  }
  function show(payload = {}) {
    if (disposed) return false;
    close();
    const settings = normalize(payload.settings);
    const visual = settings.flashEnabled && settings.opacity > 0;
    const audible = settings.soundEnabled && settings.volume > 0;
    if ((!settings.enabled && payload.preview !== true) || (!visual && !audible)) return false;
    const current = generation;
    let soundClaimed = false;
    let displays;
    try { displays = targets(settings); } catch (error) { onError(error); return false; }
    if (!visual) displays = displays.slice(0, 1);
    const items = (Array.isArray(payload.items) ? payload.items : []).slice(0, 64).map(item => ({
      id: typeof item?.id === 'string' ? item.id.slice(0, 128) : '',
      name: typeof item?.name === 'string' ? item.name.slice(0, 100) : null,
    }));
    for (const display of displays) {
      let win, record;
      try {
        const bounds = visual ? display.bounds : { x: display.bounds.x, y: display.bounds.y, width: 1, height: 1 };
        win = new BrowserWindow({ ...bounds, title: 'Moonsteel alert',
          frame: false, transparent: true, backgroundColor: '#00000000',
          show: false, focusable: false, skipTaskbar: true, resizable: false,
          movable: false, minimizable: false, maximizable: false, fullscreenable: false,
          hasShadow: false, alwaysOnTop: true,
          ...(platformSupport.platform === 'linux' ? { type: 'dock' } : {}),
          webPreferences: { preload: preloadPath, contextIsolation: true,
            nodeIntegration: false, sandbox: true, backgroundThrottling: false,
            autoplayPolicy: 'no-user-gesture-required' },
        });
        win._moonsteelAlert = true;
        record = { win, ready: false, loaded: false, started: false, timer: null, geometryTimer: null, repairs: 0 };
        records.add(record);
        const active = () => current === generation && records.has(record) && !win.isDestroyed();
        const repairBounds = () => {
          if (!active() || !visual || !record.started) return;
          const actual = win.getBounds();
          if (['x', 'y', 'width', 'height'].every(key => actual[key] === display.bounds[key])) { record.repairs = 0; return; }
          if (record.repairs++ < 3) win.setBounds(display.bounds, false);
        };
        const queueBoundsRepair = () => {
          if (!active() || !visual || !record.started || record.geometryTimer !== null || record.repairs >= 3) return;
          record.geometryTimer = schedule(() => { record.geometryTimer = null; repairBounds(); }, 50);
          record.geometryTimer?.unref?.();
        };
        const start = () => {
          if (!active() || record.started || !record.ready || !record.loaded) return;
          record.started = true;
          if (record.timer !== null) cancel(record.timer);
          const playSound = audible && !soundClaimed;
          if (playSound) soundClaimed = true;
          win.webContents.send('moonsteel-alert:data', { items,
            settings: { ...settings, flashEnabled: visual, soundEnabled: playSound }, preview: payload.preview === true });
          if (visual && active()) {
            win.showInactive();
            // Windows can shorten a newly mapped borderless window to the
            // taskbar work area. Restore the full monitor after native mapping.
            repairBounds(); queueBoundsRepair(); win.moveTop();
          }
          if (active()) {
            const lifetime = Math.max(visual ? settings.duration * 1000 : 0, playSound ? SOUND_TAIL_MS : 0) + 250;
            record.timer = schedule(() => { if (active()) destroy(record); }, lifetime);
            record.timer?.unref?.();
          }
        };
        win.setIgnoreMouseEvents(true);
        win.setAlwaysOnTop(true, 'screen-saver', 6);
        configureOverlayWorkspace(win, platformSupport);
        if (platformSupport.platform !== 'win32') win.setVisibleOnAllWorkspaces?.(true);
        win.once('ready-to-show', () => { record.ready = true; start(); });
        win.webContents.once('did-finish-load', () => { record.loaded = true; start(); });
        for (const event of ['show', 'resize', 'move']) win.on(event, queueBoundsRepair);
        win.once('closed', () => {
          if (record.timer !== null) cancel(record.timer);
          if (record.geometryTimer !== null) cancel(record.geometryTimer);
          record.timer = record.geometryTimer = null; records.delete(record);
        });
        record.timer = schedule(() => { if (active()) destroy(record); }, LOAD_TIMEOUT_MS);
        record.timer?.unref?.();
        Promise.resolve(win.loadFile(path.join(rendererRoot, 'moonsteel-alert.html'))).catch(error => {
          if (active()) { destroy(record); onError(error); }
        });
      } catch (error) {
        if (record) destroy(record);
        else if (win && !win.isDestroyed()) win.destroy();
        onError(error);
      }
    }
    return records.size > 0;
  }
  return { show, close, raise,
    dispose() { disposed = true; close(); },
    get activeWindows() { return [...records].map(record => record.win).filter(win => !win.isDestroyed()); },
  };
}

module.exports = { createMoonsteelAlertWindow, SOUND_TAIL_MS, LOAD_TIMEOUT_MS };
