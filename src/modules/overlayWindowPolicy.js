'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const configuredWindows = new WeakSet();
const overlaySurfaces = new WeakSet();
const retriedWindows = new WeakSet();
let warned = false;

function overlayHelperPath() {
  const packaged = process.resourcesPath && path.join(process.resourcesPath, 'bin', 'overkot-overlay-window');
  return packaged && fs.existsSync(packaged) ? packaged
    : path.join(__dirname, '..', '..', '.build', 'bin', 'overkot-overlay-window');
}

/** X11 fullscreen games occupy a higher layer than docks and ABOVE windows. */
function configureOverlayWorkspace(win, support, {
  run = execFileSync,
  helperPath = overlayHelperPath(),
  warn = console.warn,
} = {}) {
  if (support.platform === 'linux' && ['x11', 'xwayland'].includes(support.displayBackend)) {
    win.setVisibleOnAllWorkspaces(true);
    overlaySurfaces.add(win);
    if (configuredWindows.has(win)) return;
    try {
      const xid = win.getNativeWindowHandle().readUInt32LE(0);
      // Apply before mapping. The helper only sets window hints: no focus,
      // remapping, input grabs, or changes to other applications' windows.
      run(helperPath, ['0x' + xid.toString(16)], { timeout: 1500, stdio: 'pipe', windowsHide: true });
      configuredWindows.add(win);
    } catch (error) {
      // A new XID can reach our connection before the X server has processed
      // Electron's create request. Retry once before the first show callback.
      if (!retriedWindows.has(win) && typeof win.once === 'function') {
        retriedWindows.add(win);
        win.once('ready-to-show', () => {
          if (!win.isDestroyed()) configureOverlayWorkspace(win, support, { run, helperPath, warn });
        });
      }
      // Keep the existing dock/always-on-top behavior if a development helper
      // has not been built, or the X server rejects the window's hints.
      if (!warned) {
        warned = true;
        warn('[overlay] Linux fullscreen window hints unavailable. Build the overlay helper with npm run build:overlay:linux. ' + error.message);
      }
    }
  }
}

/** Normal popouts inherit the overlay layer without losing native move/resize. */
function configureOverlayPopout(win, parent, support) {
  if (support.platform !== 'linux' || !['x11', 'xwayland'].includes(support.displayBackend)) return;
  if (!parent || parent.isDestroyed() || win === parent || overlaySurfaces.has(win)) return;
  win.setVisibleOnAllWorkspaces(true);
  // Assign after construction: Electron forces constructor children to dialog
  // type. A transient relationship alone preserves the window's original type.
  win.setParentWindow(parent);
  const raise = () => {
    if (win.isDestroyed() || parent.isDestroyed() || !win.isVisible() || !parent.isVisible()) return;
    // KWin puts a normal transient immediately above its parent. Raise the
    // rail above independent widget surfaces before raising its popout.
    parent.moveTop();
    win.moveTop();
  };
  win.on('show', raise);
  win.on('focus', raise);
}

/** Raise mapped overlays in layer order without activating or showing them. */
function refreshOverlayStack(windows, support) {
  const nativeStack = support.platform === 'win32'
    || (support.platform === 'linux' && ['x11', 'xwayland'].includes(support.displayBackend));
  if (!nativeStack) return;
  for (const win of windows) {
    if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized?.()) continue;
    // Windows ignores setAlwaysOnTop's macOS-only relativeLevel argument.
    // Explicit raises keep peers ordered there and within X11 overlay layers.
    // Repeating an unchanged always-on-top flag can leave the native stack
    // untouched. moveTop issues a raise, and deliberately does not focus.
    win.moveTop();
  }
}

module.exports = { configureOverlayWorkspace, configureOverlayPopout, refreshOverlayStack };
