'use strict';

// Exercise real Windows z-order with offscreen, non-activating Electron windows.
// The source helpers run without game IO, network requests or the user's profile.
if (process.platform !== 'win32') throw new Error('Native window stacking check requires Windows');
if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], {
    env, stdio: 'inherit', windowsHide: true, timeout: 45000,
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { refreshOverlayStack } = require('../src/modules/overlayWindowPolicy');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'output'), { recursive: true });
const out = fs.mkdtempSync(path.join(root, 'output', 'window-stack-'));
app.setPath('userData', path.join(out, 'profile'));
app.on('window-all-closed', () => {});

const probe = path.join(out, 'inspect.ps1');
fs.writeFileSync(probe, `param([string]$Handles)
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class WindowStackProbe { [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr parent); [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint command); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }'
$targets = @($Handles.Split(','))
$order = @()
$window = [WindowStackProbe]::GetTopWindow([IntPtr]::Zero)
while ($window -ne [IntPtr]::Zero) {
  $handle = $window.ToInt64().ToString()
  if ($targets -contains $handle) { $order += $handle }
  $window = [WindowStackProbe]::GetWindow($window, 2)
}
[pscustomobject]@{ foreground = [WindowStackProbe]::GetForegroundWindow().ToInt64().ToString(); order = $order } | ConvertTo-Json -Compress
`);

const source = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
const preferences = {};
const context = vm.createContext({ platformSupport: { platform: 'win32' }, refreshOverlayStack, setImmediate,
  mainWindow: null, dockWindow: null, dungeonOverlayWindow: null, widgetWindows: new Map(), alertWindows: new Set(),
  settingsWindow: null, tutorialWindow: null, changelogWindow: null, widgetsWindow: null, groupFinderWindow: null,
  marketWindow: null, wikiWindow: null, mapWindow: null, calendarSettingsWindow: null, updateWindow: null,
  marketShutdownStarted: false, overlayHiddenByUser: false, gameHiddenActive: false,
  mainHiddenForFocus: false, dockAutoHidden: false, config: { get: (key, fallback) => preferences[key] ?? fallback },
});
for (const [start, end] of [['function raiseAlertWindows()', '// ─── App lifecycle'],
  ['function canShowAlerts()', 'function createAlertWindow(']]) {
  vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))), context);
}
app.on('browser-window-created', (_event, win) => context.watchOverlayStack(win));
const windows = new Map();
const settle = () => new Promise(resolve => setImmediate(resolve));
function inspect() {
  const handles = new Map([...windows].map(([name, win]) => [win.getNativeWindowHandle().readBigUInt64LE().toString(), name]));
  const result = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', probe, [...handles.keys()].join(',')], { encoding: 'utf8', windowsHide: true, timeout: 10000 }));
  return { foreground: result.foreground, order: result.order.map(handle => handles.get(handle)) };
}

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.error('Window stacking check timed out'); app.exit(1); }, 35000);
  try {
    for (const name of ['dungeon', 'widget', 'menu', 'settings', 'map', 'alert']) {
      const win = new BrowserWindow({ x: -12000, y: -12000, width: 320, height: 200,
        show: false, frame: false, focusable: false, skipTaskbar: true, alwaysOnTop: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      windows.set(name, win);
      win.setAlwaysOnTop(true, 'screen-saver', name === 'alert' ? 5 : 1);
      await win.loadURL('data:text/html,<title>Overkot stacking check</title>');
    }
    Object.assign(context, { mainWindow: windows.get('menu'), dungeonOverlayWindow: windows.get('dungeon'),
      settingsWindow: windows.get('settings'), mapWindow: windows.get('map') });
    context.widgetWindows.set('widget', windows.get('widget'));
    context.alertWindows.add(windows.get('alert'));
    windows.get('alert')._alertReady = true;
    const foreground = inspect().foreground;
    for (const win of windows.values()) win.showInactive();
    await settle();
    const expected = ['alert', 'map', 'settings', 'menu', 'widget', 'dungeon'];
    assert.deepEqual(inspect().order, expected);

    // Reproduce Windows ignoring relativeLevel before running the focus repair.
    const dungeon = windows.get('dungeon');
    dungeon.moveTop();
    assert.equal(inspect().order[0], 'dungeon');
    dungeon.emit('focus');
    await settle();
    assert.deepEqual(inspect().order, expected, 'Large dungeon cannot cover the menu');

    const popout = windows.get('map');
    popout.moveTop();
    popout.emit('focus');
    await settle();
    assert.equal(inspect().order[0], 'alert', 'Focused popouts cannot cover alerts');

    const showEvents = [];
    popout.on('show', () => showEvents.push('show'));
    popout.showInactive();
    await settle();
    const repeatedShow = { emittedShow: showEvents.length > 0, top: inspect().order[0] };
    context.raiseAlertWindows();
    assert.equal(inspect().order[0], 'alert');

    context.overlayHiddenByUser = true;
    context.syncAlertVisibility();
    assert.equal(windows.get('alert').isVisible(), false);
    preferences.showAlertsWhenHidden = true;
    context.syncAlertVisibility();
    assert.equal(windows.get('alert').isVisible(), true);
    assert.equal(inspect().order[0], 'alert');
    assert.equal(inspect().foreground, foreground, 'Stack repairs must not steal foreground focus');
    console.log(JSON.stringify({ passed: true, order: expected, foregroundPreserved: true, repeatedShow }));
  } finally {
    clearTimeout(watchdog);
    for (const win of windows.values()) if (!win.isDestroyed()) win.destroy();
  }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
