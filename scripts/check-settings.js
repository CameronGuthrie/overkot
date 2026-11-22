'use strict';

// Real main/preload/Settings smoke in the native packaged Windows runtime.
// --source uses the working tree; the default loads app.asar. A temporary
// profile, empty game log, simulated foreground/game process, and blocked
// remote renderer requests keep this check independent of the user's session.
// --tutorials-only checks global tutorial controls without unrelated layout gestures.
// --moonsteel-only checks alert preferences and the passive full-monitor preview.
if (process.platform !== 'win32') throw new Error('Settings native smoke requires Windows');
if (!process.versions.electron) {
  const result = require('./run-packaged-check').runPackagedCheck(__filename, process.argv.slice(2), 100000, { windowsHide: false });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const Module = require('node:module');
const { promisify } = require('node:util');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { app, BrowserWindow, session, globalShortcut, nativeImage, screen, dialog } = require('electron');
const root = path.resolve(__dirname, '..');
const startedAt = Date.now();
const phase = label => console.log(`[settings-check +${Date.now() - startedAt}ms] ${label}`);
const nativeMouse = process.argv.includes('--native-mouse');
const startupOnly = process.argv.includes('--startup-only');
const startupChoice = process.argv.find(value => value.startsWith('--startup-layout='))?.split('=')[1] || 'current';
if (startupOnly && !['current', 'named'].includes(startupChoice)) throw new Error('Choose --startup-layout=current or named');
const interactionHotkey = nativeMouse ? 'Control+Shift+F24' : 'Alt+F1';
const appRoot = process.argv.includes('--source') ? root : path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');
const out = path.join(root, 'output', `settings-smoke-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
// Appearance import/export exercises the real main-process file handling while
// supplying paths from this isolated fixture instead of opening native dialogs.
const appearanceDialogs = { open: null, save: null };
dialog.showOpenDialog = async () => {
  const filename = appearanceDialogs.open; appearanceDialogs.open = null;
  return filename ? { canceled: false, filePaths: [filename] } : { canceled: true, filePaths: [] };
};
dialog.showSaveDialog = async () => {
  const filename = appearanceDialogs.save; appearanceDialogs.save = null;
  return filename ? { canceled: false, filePath: filename } : { canceled: true };
};
fs.mkdirSync(path.join(out, 'screenshots'));
fs.writeFileSync(path.join(out, 'EE.log'), '');
process.env.LOCALAPPDATA = out;
process.env.OVERKOT_DATA_MANIFEST_URL = 'http://127.0.0.1:1/manifest.json';
process.env.OVERKOT_CALENDAR_MANIFEST_URL = 'http://127.0.0.1:1/calendar.json';
app.setPath('userData', path.join(out, 'electron-profile'));
// Do not resolve a private source-tree .env.local even with --source.
app.getAppPath = () => path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request.endsWith('/modules/marketConfig')) return { readMarketApiKey: () => '' };
  return originalLoad.call(this, request, parent, isMain);
};

// Child-process interception works for both source and bundled main modules.
// Only the fixture's own PID is advertised as a game; scanners never execute.
cp.exec = (command, _options, callback) => {
  setImmediate(() => callback(null, command.startsWith('tasklist ')
    ? `"Soulframe.x64.exe","${process.pid}","Console","1","0 K"` : '', ''));
  return { on() {}, kill() {} };
};
cp.exec[promisify.custom] = (command, options) => new Promise((resolve, reject) =>
  cp.exec(command, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
cp.execFile = (_file, _args, _options, callback) => {
  setImmediate(() => callback(new Error('Native process helpers disabled by Settings smoke'), '', ''));
  return { on() {}, kill() {} };
};
cp.execFile[promisify.custom] = (file, args, options) => new Promise((resolve, reject) =>
  cp.execFile(file, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
const originalSpawn = cp.spawn;
let foregroundMonitor;
cp.spawn = (file, args, options) => {
  const encoded = args?.indexOf('-EncodedCommand');
  const script = encoded >= 0 ? Buffer.from(args[encoded + 1], 'base64').toString('utf16le') : args?.join(' ');
  if (file.toLowerCase() === 'powershell.exe' && /OverlayLayoutKeys|public static class FG/.test(script)) {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => {}; child.unref = () => {};
    if (script.includes('OverlayLayoutKeys')) foregroundMonitor = child;
    return child;
  }
  return originalSpawn(file, args, options);
};
const shortcuts = new Map();
const shortcutRegistrations = [], shortcutFirings = [];
const nativeRegister = globalShortcut.register.bind(globalShortcut);
const nativeUnregister = globalShortcut.unregister.bind(globalShortcut);
const nativeUnregisterAll = globalShortcut.unregisterAll.bind(globalShortcut);
globalShortcut.register = (key, callback) => {
  const wrapped = () => { shortcutFirings.push({ key, at: Date.now() }); callback(); };
  shortcuts.set(key, wrapped);
  const registered = nativeMouse && key === interactionHotkey ? nativeRegister(key, wrapped) : true;
  shortcutRegistrations.push({ key, registered, at: Date.now() });
  return registered;
};
globalShortcut.unregister = key => { shortcuts.delete(key); if (nativeMouse) nativeUnregister(key); };
globalShortcut.unregisterAll = () => { shortcuts.clear(); if (nativeMouse) nativeUnregisterAll(); };
const { ConfigStore } = require('../src/modules/config');
const fixtureConfig = new ConfigStore();
fixtureConfig.setMany({ clickThrough: true, hideWhenGameClosed: false, showOnlyWhenGameFocused: false,
  launchToTray: false, automaticUpdates: false, enableAlertSound: false, enableAlertPopup: false,
  interactionHotkey, overlayVisibilityHotkey: 'Alt+F2', dockAutoHide: false,
  eeLogPath: path.join(out, 'EE.log'), screenshotDir: path.join(out, 'screenshots'),
  widgetVisibility: { clock: true }, widgetOpen: {}, widgetDocked: {}, tutorialCompleted: { app: true, clock: true, resources: true, boss: true },
  dockParadigmVersion: 1, startupLayoutPending: false,
});
const startupSize = { width: 437, height: 181 };
const currentBounds = { x: 150, y: 150, ...startupSize };
const namedBounds = { x: 240, y: 180, ...startupSize };
const startupSavedId = 'native-startup-named';
if (startupOnly) {
  const layout = require('../src/modules/layouts').normalizeLayout({ dockEdge: 'right',
    widgetVisibility: { clock: true }, widgetOpen: { clock: true }, widgetDocked: { clock: false },
    widgetSizes: { clock: startupSize }, widgetResizeMode: 'free', widgetBounds: { clock: namedBounds } });
  fixtureConfig.setMany({ dockEdge: 'left', widgetVisibility: { clock: true },
    widgetOpen: { clock: true }, widgetDocked: { clock: false }, widgetSizes: { clock: startupSize },
    widgetResizeMode: 'free', widgetBounds_clock: currentBounds,
    savedLayouts: [{ id: startupSavedId, name: 'Native startup layout', layout }],
    startupLayoutId: startupChoice === 'named' ? startupSavedId : null });
}

const errors = [], failedLoads = [], lifecycle = [], checks = [], captures = [], nativeSnapshots = [], inputSamples = [];
const startupSnapshots = [];
const { readEncryptedJSON } = require('../src/modules/fileEncryption');
const { CONFIG_PATH } = require('../src/modules/appPaths');
if (startupOnly) app.on('browser-window-created', (_event, win) => {
  const config = readEncryptedJSON(CONFIG_PATH);
  startupSnapshots.push({ id: win.id, dockEdge: config.dockEdge, startupLayoutId: config.startupLayoutId,
    widgetSizes: config.widgetSizes, widgetBounds_clock: config.widgetBounds_clock,
    widgetOpen: config.widgetOpen, widgetDocked: config.widgetDocked });
});
let nativeInspector, mouse;
const mousePolicy = new WeakMap();
const ignoreMouse = BrowserWindow.prototype.setIgnoreMouseEvents;
BrowserWindow.prototype.setIgnoreMouseEvents = function(ignore, ...options) {
  const result = ignoreMouse.call(this, ignore, ...options); mousePolicy.set(this, ignore); return result;
};
for (const method of ['show', 'showInactive', 'hide', 'focus', 'setFocusable']) {
  const nativeMethod = BrowserWindow.prototype[method];
  BrowserWindow.prototype[method] = function(...args) {
    const result = nativeMethod.apply(this, args);
    lifecycle.push({ id: this.id, method, args, url: this.webContents.getURL(),
      visible: this.isVisible(), loading: this.webContents.isLoading(), time: Date.now() });
    return result;
  };
}
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', ({ message, sourceId, lineNumber }) => {
    if (/Uncaught|Error invoking|ReferenceError|TypeError/.test(message)) errors.push({ message, sourceId, lineNumber, url: contents.getURL() });
  });
  contents.on('render-process-gone', (_event, detail) => errors.push(detail));
  contents.on('did-fail-load', (_event, code, description, url, mainFrame) => {
    if (mainFrame && code !== -3) failedLoads.push({ code, description, url });
  });
});
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest((details, callback) =>
  callback({ cancel: /^https?:/.test(details.url) })));
require(path.join(appRoot, 'src', 'main.js'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = (win, code) => win.webContents.executeJavaScript(code);
const state = main => evaluate(main, 'window.api.getState()');
const find = file => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().split('?')[0].endsWith('/' + file));
async function until(fn, label, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await fn(); if (result) return result; await pause(40);
  }
  throw new Error('Timed out: ' + label);
}
function foreground(pid) {
  assert.ok(foregroundMonitor, 'Fixture foreground monitor has started');
  foregroundMonitor.stdout.write(`foreground:${pid}\n`);
}
async function createNativeInspector() {
  // Read HWND/RenderWidgetHost flags and desktop pixels before capturePage(),
  // which can itself request a compositor repaint. No OS input is sent.
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System; using System.Collections.Generic; using System.Text; using System.Runtime.InteropServices; public static class SettingsPaintProbe {
  public delegate bool EnumCallback(IntPtr window, IntPtr parameter);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  public class WindowInfo { public long Handle; public string ClassName; public bool Visible; public long Style; public long ExStyle; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref Point point);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int count);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr window, EnumCallback callback, IntPtr parameter);
  public static WindowInfo Inspect(IntPtr window) { var name = new StringBuilder(256); GetClassName(window, name, 256); return new WindowInfo { Handle=window.ToInt64(), ClassName=name.ToString(), Visible=IsWindowVisible(window), Style=GetWindowLongPtr(window,-16).ToInt64(), ExStyle=GetWindowLongPtr(window,-20).ToInt64() }; }
  public static WindowInfo[] Children(IntPtr window) { var children = new List<WindowInfo>(); EnumChildWindows(window, (child, unused) => { children.Add(Inspect(child)); return true; }, IntPtr.Zero); return children.ToArray(); }
}'
[void][SettingsPaintProbe]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
[Console]::WriteLine('ready')
while (($line = [Console]::ReadLine()) -ne $null) {
  try {
    $request = $line | ConvertFrom-Json
    $handle = [IntPtr]::new([int64]$request.handle)
    [uint32]$owner = 0
    [void][SettingsPaintProbe]::GetWindowThreadProcessId($handle, [ref]$owner)
    if ($owner -ne ${process.pid}) { throw 'Native paint probe refuses an external window' }
    $rect = New-Object SettingsPaintProbe+Rect
    [void][SettingsPaintProbe]::GetClientRect($handle, [ref]$rect)
    $origin = New-Object SettingsPaintProbe+Point
    [void][SettingsPaintProbe]::ClientToScreen($handle, [ref]$origin)
    $width = $rect.Right - $rect.Left; $height = $rect.Bottom - $rect.Top
    $unobscured = $true
    foreach ($horizontal in @(.15, .5, .85)) { foreach ($vertical in @(.15, .5, .85)) {
      $point = New-Object SettingsPaintProbe+Point
      $point.X = $origin.X + [int]($width * $horizontal); $point.Y = $origin.Y + [int]($height * $vertical)
      if ([SettingsPaintProbe]::GetAncestor([SettingsPaintProbe]::WindowFromPoint($point),2) -ne $handle) { $unobscured = $false }
    } }
    if ($unobscured) {
      $bitmap = New-Object System.Drawing.Bitmap($width, $height)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try { $graphics.CopyFromScreen($origin.X, $origin.Y, 0, 0, $bitmap.Size); $bitmap.Save($request.filename, [System.Drawing.Imaging.ImageFormat]::Png) }
      finally { $graphics.Dispose(); $bitmap.Dispose() }
    }
    [Console]::WriteLine(([ordered]@{ top=[SettingsPaintProbe]::Inspect($handle); children=@([SettingsPaintProbe]::Children($handle)); unobscured=$unobscured; filename=$request.filename } | ConvertTo-Json -Depth 4 -Compress))
  } catch { [Console]::WriteLine((@{ error=$_.Exception.Message } | ConvertTo-Json -Compress)) }
}`;
  const child = originalSpawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let pending = '', errorText = '', next;
  child.stdout.on('data', chunk => {
    pending += chunk.toString(); const lines = pending.split(/\r?\n/); pending = lines.pop();
    for (const line of lines) {
      if (line !== 'ready' && !line.startsWith('{')) continue;
      const callback = next; next = null;
      try { callback?.resolve(line === 'ready' ? undefined : JSON.parse(line)); } catch (error) { callback?.reject(error); }
    }
  });
  child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-2000); });
  child.on('error', error => next?.reject(error));
  child.on('exit', code => next?.reject(new Error('Native Settings paint probe exited: ' + code + ': ' + errorText)));
  function response() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Native Settings paint probe timed out: ' + errorText)), 8000);
      next = { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
    });
  }
  await response();
  return {
    async inspect(win, name) {
      const bytes = win.getNativeWindowHandle();
      const handle = (bytes.length === 8 ? bytes.readBigUInt64LE() : BigInt(bytes.readUInt32LE())).toString();
      const answer = response();
      child.stdin.write(JSON.stringify({ handle, filename: path.join(out, name + '-desktop.png') }) + '\n');
      const detail = await answer;
      if (detail.error) throw new Error(detail.error);
      nativeSnapshots.push({ name, ...detail, focusable: win.isFocusable(), ignoresMouse: mousePolicy.get(win) });
      assert.equal(detail.top.Visible, true, name + ': native top-level HWND is visible');
      assert.equal(detail.top.ExStyle & 0x08000000, 0, name + ': interactive native Settings has no WS_EX_NOACTIVATE flag');
      const renderWidget = detail.children.find(window => window.ClassName === 'Chrome_RenderWidgetHostHWND');
      assert.ok(renderWidget, name + ': native Chromium render widget exists');
      // Chromium sometimes hides the legacy input HWND on a retained window
      // while the visible Direct3D compositor still paints. Record both flags;
      // the real desktop bitmap is the paint assertion, native mouse mode
      // independently checks input routing through the retained window.
      assert.ok(renderWidget.Visible || detail.children.some(window => window.ClassName === 'Intermediate D3D Window' && window.Visible),
        name + ': a native Chromium surface is visible before capturePage');
      if (detail.unobscured) validatePaint(nativeImage.createFromPath(detail.filename), name + '-desktop', detail.filename);
      return detail;
    },
    close() { child.stdin.end(); },
  };
}
function validatePaint(screenshot, name, filename) {
  assert.equal(screenshot.isEmpty(), false, name + ': window has painted pixels');
  const size = screenshot.getSize(), pixels = screenshot.toBitmap();
  let white = 0, dark = 0, samples = 0;
  const colors = new Set();
  for (let i = 0; i < pixels.length; i += 64) {
    const [b, g, r, a] = pixels.subarray(i, i + 4);
    samples++; if (r > 245 && g > 245 && b > 245) white++;
    if (r < 125 && g < 125 && b < 125 && a > 200) dark++;
    colors.add(`${r >> 3},${g >> 3},${b >> 3}`);
  }
  if (!filename) { filename = path.join(out, name + '.png'); fs.writeFileSync(filename, screenshot.toPNG()); }
  const detail = { name, filename, size, whiteFraction: white / samples, darkFraction: dark / samples, colors: colors.size };
  captures.push(detail);
  assert.ok(white / samples < .2 && dark / samples > .5 && colors.size > 12,
    name + ': actual painted Settings contains themed content instead of a blank white surface: ' + JSON.stringify(detail));
  return detail;
}
async function capturePaint(win, name) { return validatePaint(await win.webContents.capturePage(), name); }
async function click(win, id) {
  if (nativeMouse) await evaluate(win, `(() => {
    if (!window.__settingsSmokePointer) {
      window.__settingsSmokePointer = [];
      for (const type of ['pointerdown', 'pointerup', 'click']) document.addEventListener(type, event =>
        window.__settingsSmokePointer.push({ type, id: event.target.id, x: event.clientX, y: event.clientY }), true);
    }
  })()`);
  const point = await evaluate(win, `(() => {
    const element = document.getElementById(${JSON.stringify(id)});
    element.scrollIntoView({block: 'nearest'});
    const rect = element.getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  })()`);
  if (nativeMouse) await mouse.clickPoint(win, point);
  else {
    // Default Chromium input exercises rendered control handlers. Optional
    // --native-mouse uses guarded HWND input and restores the user's cursor.
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  }
  await pause(75);
  if (nativeMouse && !win.isDestroyed()) inputSamples.push({ id, point, bounds: win.getContentBounds(), focused: win.isFocused(),
    focusable: win.isFocusable(), foregroundPid: await mouse.foregroundPid(), events: await evaluate(win, 'window.__settingsSmokePointer.splice(0)') });
}
async function openSettings(main, name) {
  await evaluate(main, "document.getElementById('settings-btn').click()");
  const win = await until(() => find('settings.html'), name + ': Settings created through launcher IPC');
  await until(() => win.isVisible(), name + ': native Settings visible');
  // Model the native foreground sample delivered when the explicit Settings
  // opening acquires focus. Keeping the earlier fake game PID indefinitely
  // would disarm a correctly focused window once its 200ms grace expires.
  if (nativeMouse) assert.equal(await mouse.foregroundPid(), process.pid, name + ': Settings opening acquired native app foreground');
  foreground(process.pid);
  if (nativeMouse) {
    const area = screen.getPrimaryDisplay().workArea;
    win.setBounds({ x: area.x + 100, y: area.y + 80, width: 780, height: 650 });
  }
  await nativeInspector.inspect(win, name);
  // Check painted pixels independently of DOM readiness. A complete DOM with
  // an unpainted native compositor surface previously passed other smokes.
  await capturePaint(win, name + '-initial');
  await until(async () => !win.webContents.isLoading() && await evaluate(win,
    "document.readyState === 'complete' && !document.getElementById('settings-content').inert && document.getElementById('appearance-base')?.options.length > 1"), name + ': Settings initialized');
  assert.equal(win.isFocusable(), true, name + ': Settings is focusable');
  assert.notEqual(mousePolicy.get(win), true, name + ': Settings accepts mouse input');
  return win;
}
async function closeSettings(win) {
  await click(win, 'close-btn');
  await until(() => win.isDestroyed(), 'Settings close button sends real window-close IPC');
}

app.whenReady().then(async () => {
  if (startupOnly) {
    const main = await until(() => find('index.html'), 'startup launcher');
    await until(async () => !main.webContents.isLoading() && (await state(main)).config,
      'startup launcher initialized');
    const clock = await until(() => BrowserWindow.getAllWindows().find(win =>
      win.webContents.getURL().includes('widget-host.html?widget=clock')), 'startup open clock');
    await until(() => !clock.webContents.isLoading() && clock.isVisible(), 'startup clock visible');
    const expectedEdge = startupChoice === 'named' ? 'right' : 'left';
    const expectedBounds = startupChoice === 'named' ? namedBounds : currentBounds;
    const config = (await state(main)).config;
    assert.ok(startupSnapshots.length >= 2, 'Native launcher and widget were created');
    for (const snapshot of startupSnapshots) {
      assert.equal(snapshot.dockEdge, expectedEdge, 'Startup choice is persisted before each native window is created');
      assert.deepEqual(snapshot.widgetSizes.clock, startupSize, 'Manual sizes exist before native window creation');
      assert.deepEqual(snapshot.widgetBounds_clock, expectedBounds, 'The chosen positions exist before native window creation');
      assert.equal(snapshot.widgetOpen.clock, true);
      assert.equal(snapshot.widgetDocked.clock, false);
    }
    assert.equal(config.startupLayoutId, startupChoice === 'named' ? startupSavedId : null);
    assert.equal(config.dockEdge, expectedEdge);
    assert.deepEqual(config.widgetSizes.clock, startupSize);
    assert.deepEqual(clock.getBounds(), expectedBounds, 'First widget window retains the chosen position and 437 × 181 manual size');
    const area = screen.getDisplayMatching(main.getBounds()).bounds;
    assert.deepEqual(main.getBounds(), { x: expectedEdge === 'left' ? area.x : area.x + area.width - 48,
      y: area.y, width: 48, height: area.height }, 'First native bar uses the chosen screen edge');
    fs.writeFileSync(path.join(out, 'startup-clock.png'), (await clock.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(out, 'startup-bar.png'), (await main.webContents.capturePage()).toPNG());
    assert.deepEqual(errors, []); assert.deepEqual(failedLoads, []);
    const summary = { ok: true, source: process.argv.includes('--source'), startupChoice, out,
      startupSnapshots, config: { dockEdge: config.dockEdge, startupLayoutId: config.startupLayoutId,
        widgetSizes: config.widgetSizes }, barBounds: main.getBounds(), widgetBounds: clock.getBounds(), errors, failedLoads };
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary)); app.exit(0); return;
  }
  nativeInspector = await createNativeInspector();
  const main = await until(() => find('index.html'), 'launcher window');
  await until(async () => !main.webContents.isLoading() && foregroundMonitor && shortcuts.has(interactionHotkey)
    && (await state(main)).status === 'connecting', 'main initialized with isolated game session');
  if (process.argv.includes('--alerts-only')) {
    await require('./alert-native-checks').checkAlerts({ main, evaluate, until, state, foreground, BrowserWindow, out, checks });
    assert.deepEqual(errors, []); assert.deepEqual(failedLoads, []);
    fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify({ok:true,source:process.argv.includes('--source'),alertsOnly:true,out,checks},null,2));
    console.log(JSON.stringify({ok:true,source:process.argv.includes('--source'),alertsOnly:true,out,checks}));
    nativeInspector.close();app.exit(0);return;
  }
  foreground(process.pid + 100000);
  await until(() => !main.isFocusable(), 'passive gameplay disables launcher input');
  if (nativeMouse) { mouse = await require('./windows-native-mouse').createNativeMouse(); await mouse.pressFocusChord(); }
  else shortcuts.get(interactionHotkey)();
  foreground(process.pid);
  await until(async () => (await state(main)).overlayInteractive, 'focus chord grants overlay interaction');
  let settings = await openSettings(main, 'first-open');
  if (process.argv.includes('--monitor-only')) {
    await require('./overlay-monitor-native-checks').checkOverlayMonitor({ settings, main, evaluate, until, click, state, capturePaint, checks, BrowserWindow, out });
    assert.deepEqual(errors, []); assert.deepEqual(failedLoads, []);
    const summary = { ok: true, source: process.argv.includes('--source'), monitorOnly: true, out, checks };
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary)); nativeInspector.close(); app.exit(0); return;
  }
  if (process.argv.includes('--moonsteel-only')) {
    await require('./moonsteel-settings-native-checks').checkMoonsteelSettings({ settings, main, evaluate, until, click, state, capturePaint, checks, BrowserWindow, foreground, out });
    assert.deepEqual(errors, []); assert.deepEqual(failedLoads, []);
    const summary = { ok: true, source: process.argv.includes('--source'), moonsteelOnly: true, out, checks };
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary)); nativeInspector.close(); app.exit(0); return;
  }
  if (process.argv.includes('--tutorials-only')) {
    await click(settings, 'tab-tutorials');
    await until(() => evaluate(settings, "document.getElementById('chk-tutorials-enabled').checked"), 'all tutorials default on');
    assert.equal(await evaluate(main, 'window.api.setTutorialsEnabled(false)'), false, 'unrelated renderer cannot change the global preference');
    assert.equal(await evaluate(settings, "window.api.setTutorialsEnabled('false')"), false, 'tutorial preference accepts only booleans');
    const completed = (await state(main)).config.tutorialCompleted;
    await click(settings, 'chk-tutorials-enabled');
    await until(async () => (await state(main)).config.tutorialsEnabled === false, 'Settings switches all tutorials off');
    assert.equal(readEncryptedJSON(CONFIG_PATH).tutorialsEnabled, false, 'global off is persisted on disk');
    await capturePaint(settings, 'tutorials-off');
    await click(settings, 'btn-replay-tutorial');
    const replay = await until(() => find('tutorial.html'), 'manual replay remains available with tutorials off');
    await until(async () => replay.isVisible() && !replay.webContents.isLoading() && await evaluate(replay,
      "!!document.getElementById('tutorial-disable-all')"), 'tour includes the global off button');
    await capturePaint(replay, 'tutorial-global-off-button');
    await click(replay, 'tutorial-disable-all');
    await until(() => replay.isDestroyed(), 'turn off all tours closes the replay');
    assert.equal((await state(main)).config.tutorialsEnabled, false);
    assert.deepEqual((await state(main)).config.tutorialCompleted, completed, 'global off preserves existing completion');
    settings.focus(); foreground(process.pid);
    await click(settings, 'chk-tutorials-enabled');
    await until(async () => (await state(main)).config.tutorialsEnabled === true, 'Settings switches all tutorials on');
    assert.equal(readEncryptedJSON(CONFIG_PATH).tutorialsEnabled, true, 'global on is persisted on disk');
    await closeSettings(settings);
    settings = await openSettings(main, 'tutorial-preference-reopen');
    await click(settings, 'tab-tutorials');
    assert.equal(await evaluate(settings, "document.getElementById('chk-tutorials-enabled').checked"), true, 'reopened Settings retains the saved preference');
    await capturePaint(settings, 'tutorials-on-reopened');
    checks.push('global Tutorials toggle saves both states, survives Settings recreation, and rejects invalid or unrelated requests');
    checks.push('manual replay remains available while off; the tour footer can turn off all tours without changing completion');
    assert.deepEqual(errors, []); assert.deepEqual(failedLoads, []);
    const summary = { ok: true, source: process.argv.includes('--source'), tutorialsOnly: true, out, checks };
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary)); nativeInspector.close(); app.exit(0); return;
  }
  if (process.argv.includes('--sizing-only')) {
    await require('./widget-sizing-native-checks').checkWidgetSizing({ settings, main, evaluate, until, click, state, capturePaint, checks, BrowserWindow, foreground, out });
    console.log(JSON.stringify({ok:true,source:process.argv.includes('--source'),sizingOnly:true,out,checks}));
    app.exit(0);return;
  }
  checks.push('launcher open-settings IPC paints a themed native Settings surface and initializes controls');
  for (const tab of ['appearance', 'overlay', 'widgets', 'connections', 'files', 'tutorials', 'updates', 'about']) {
    await click(settings, 'tab-' + tab);
    await until(() => evaluate(settings, `document.getElementById('tab-${tab}').getAttribute('aria-selected') === 'true'`), tab + ': native tab click selects panel');
    const panel = await evaluate(settings, `(() => {
      const panel = document.getElementById('panel-${tab}'); const rect = panel.getBoundingClientRect();
      return { hidden: panel.hidden, width: rect.width, title: panel.querySelector('h1').textContent };
    })()`);
    assert.equal(panel.hidden, false); assert.ok(panel.width > 150 && panel.title.length > 0);
    await capturePaint(settings, 'tab-' + tab);
  }
  assert.match(await evaluate(settings, "document.getElementById('icon-credits').textContent"), /Lucide/);
  assert.match(await evaluate(settings, "document.getElementById('icon-license-notices').textContent"), /ISC|Permission to use/);
  checks.push('all eight tabs including About switch visible panels, paint nonblank content and include commercial icon licence credits');
  const savedLayoutId = await require('./layout-native-checks').checkLayouts({ settings, main, evaluate, until, click, state,
    capturePaint, checks, out, dialogs: appearanceDialogs, BrowserWindow });
  await click(settings, 'tab-appearance');
  const appearanceResult = await require('./appearance-native-checks').checkAppearance({ settings, main, evaluate, until, click, state,
    capturePaint, checks, out, dialogs: appearanceDialogs, BrowserWindow, appRoot });
  appearanceResult.persisted = await require('./icon-native-checks').checkAnimatedIcons({ settings, main, evaluate, until, capturePaint, checks, BrowserWindow });
  await require('./opacity-native-checks').checkOpacity({ settings, main, evaluate, until, state, checks, BrowserWindow, out });
  await require('./widget-sizing-native-checks').checkWidgetSizing({ settings, main, evaluate, until, click, state, capturePaint, checks, BrowserWindow, foreground, out });
  phase('Appearance helper complete; checking ordinary settings');
  await until(() => evaluate(settings, "document.documentElement.dataset.theme === 'dark-mint'"), 'applied appearance repaints Settings');
  await click(settings, 'tab-overlay');
  const previousAutoHide = (await state(main)).config.dockAutoHide;
  await click(settings, 'chk-dock-auto-hide');
  await until(async () => (await state(main)).config.dockAutoHide === !previousAutoHide, 'checkbox autosaves through IPC');
  await click(settings, 'chk-dock-auto-hide');
  await until(async () => (await state(main)).config.dockAutoHide === previousAutoHide, 'checkbox can save again');
  checks.push('appearance Apply and ordinary settings autosave remain independent and usable in the isolated profile');
  await click(settings, 'tab-widgets');
  const previousWorldDrops = (await state(main)).config.showWorldDrops;
  await click(settings, 'chk-world-drops');
  await until(async () => (await state(main)).config.showWorldDrops === !previousWorldDrops, 'nearby weapon checkbox autosaves');
  await click(settings, 'chk-world-drops');
  await until(async () => (await state(main)).config.showWorldDrops === previousWorldDrops, 'nearby weapon checkbox restores its preference');
  checks.push('nearby dropped-weapon visibility is configurable through the real Settings autosave endpoint');
  console.log('[settings-check] Ordinary settings passed; checking tutorial replay');
  await click(settings, 'tab-tutorials');
  assert.ok(await evaluate(settings, "document.getElementById('widget-tutorial-select').options.length > 1"), 'widget tutorials populate');
  const tutorialsEnabled = (await state(main)).config.tutorialsEnabled;
  await click(settings, 'chk-tutorials-enabled');
  await until(async () => (await state(main)).config.tutorialsEnabled === !tutorialsEnabled, 'global tutorial toggle saves through actual IPC');
  await click(settings, 'chk-tutorials-enabled');
  await until(async () => (await state(main)).config.tutorialsEnabled === tutorialsEnabled, 'global tutorial toggle restores its preference');
  await click(settings, 'btn-replay-tutorial');
  const tour = await until(() => find('tutorial.html'), 'Settings replay opens tutorial via actual IPC');
  await until(async () => tour.isVisible() && !tour.webContents.isLoading() && await evaluate(tour, "!!document.getElementById('tutorial-skip')"), 'tutorial replay painted');
  await click(tour, 'tutorial-skip');
  await until(() => tour.isDestroyed(), 'tutorial skip closes actual tutorial window');
  settings.focus();
  phase('Tutorial closed; selecting Appearance');
  await click(settings, 'tab-appearance');
  phase('Appearance tab selected; starting draft');
  await evaluate(settings,"{const control=document.getElementById('appearance-cornerRadius');control.value=22;control.dispatchEvent(new Event('input',{bubbles:true}));}");
  await until(async()=>(await state(main)).config.appearance.global.cornerRadius===22,'unapplied appearance draft previews before close');
  phase('Draft preview ready; closing Settings');
  await closeSettings(settings);
  console.log('[settings-check] Settings closed; checking draft restoration');
  await until(async()=>JSON.stringify((await state(main)).config.appearance)===JSON.stringify(appearanceResult.persisted),'closing Settings restores the applied appearance');
  checks.push('closing Settings discards its unapplied appearance across affected windows');
  checks.push('tutorial replay and Settings titlebar close controls send their real IPC actions');
  console.log('[settings-check] Draft restoration passed; checking native reopen');

  foreground(process.pid + 100000);
  await until(async () => !(await state(main)).overlayInteractive && !main.isFocusable(), 'returning to game restores passive policy');
  if (nativeMouse) await mouse.pressFocusChord(); else shortcuts.get(interactionHotkey)();
  foreground(process.pid);
  settings = await openSettings(main, 'reopened-after-game');
  assert.ok((await state(main)).config.savedLayouts.some(layout => layout.id === savedLayoutId), 'Named layouts survive Settings reconstruction');
  assert.equal(await evaluate(settings, "document.getElementById('layout-startup').value"), savedLayoutId,
    'The separately saved startup choice survives Settings reconstruction');
  assert.equal(await evaluate(settings, "document.getElementById('appearance-base').value"), appearanceResult.base, 'saved appearance survives Settings reconstruction');
  assert.deepEqual((await state(main)).config.appearance, appearanceResult.persisted, 'corners, borders, motion and widget overrides survive Settings reconstruction');
  await click(settings, 'tab-tutorials');
  await capturePaint(settings, 'reopened-tutorials');
  // Existing-window reopen follows a different main-process branch.
  // Reopen the retained window while game policy has removed focusability.
  // Exercise reopening Settings after returning to gameplay.
  foreground(process.pid + 100000);
  await until(async () => !(await state(main)).overlayInteractive && !settings.isFocusable(), 'existing Settings becomes passive');
  settings.hide();
  settings = await openSettings(main, 'existing-window-reopen');
  await click(settings, 'tab-overlay');
  await until(() => evaluate(settings, "!document.getElementById('panel-overlay').hidden"), 'retained Settings native tab click selects Overlay');
  await closeSettings(settings);
  checks.push('closed and hidden Settings reopen with rendered usable controls after passive gameplay and focus chord');
  assert.deepEqual(errors, []); assert.deepEqual(failedLoads, []);
  const summary = { ok: true, source: process.argv.includes('--source'), nativeMouse, appRoot, out, checks, captures, nativeSnapshots, inputSamples, shortcutRegistrations, shortcutFirings, lifecycle, errors, failedLoads, electron: process.versions.electron };
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ok: true, source: summary.source, nativeMouse, out, checks }));
  await mouse?.close(); nativeInspector.close(); app.exit(0);
}).catch(async error => {
  console.error(error.stack);
  for (const win of BrowserWindow.getAllWindows()) {
    try { fs.writeFileSync(path.join(out, 'failure-window-' + win.id + '.png'), (await win.webContents.capturePage()).toPNG()); } catch {}
  }
  fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ message: error.message, out, errors, failedLoads, captures, nativeSnapshots, inputSamples, shortcutRegistrations, shortcutFirings, lifecycle, startupSnapshots,
    windows: BrowserWindow.getAllWindows().filter(win => !win.isDestroyed()).map(win => ({ id: win.id, url: win.webContents.getURL(), visible: win.isVisible(), focusable: win.isFocusable(), bounds: win.getBounds() })),
  }, null, 2));
  await mouse?.close().catch(() => {}); nativeInspector?.close(); app.exit(1);
});
setTimeout(() => { console.error('Settings native smoke timed out: ' + out); app.exit(1); }, 90000).unref();
