'use strict';

// Isolated Chromium/native surface QA. The fixture's own audio is muted and
// showInactive is recorded without mapping the flash onto the user's desktop.
if (!process.versions.electron) {
  const args = process.argv.slice(2), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = args.includes('--packaged')
    ? require('./run-packaged-check').runPackagedCheck(__filename, args, 40000)
    : require('node:child_process').spawnSync(require('electron'), [__filename, ...args], { env, stdio: 'inherit', windowsHide: true, timeout: 40000 });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createMoonsteelAlertWindow } = require('../src/modules/moonsteelAlertWindow');
const root = path.resolve(__dirname, '..'), packaged = process.argv.includes('--packaged');
const appRoot = packaged ? path.join(process.env.OVERKOT_PACKAGED_DIRECTORY || path.join(root, 'dist', 'win-unpacked'), 'resources', 'app.asar') : root;
const out = path.join(root, 'output', `moonsteel-alert-check-${packaged ? 'packaged' : 'source'}-${Date.now()}`);
fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(out, 'profile'));
app.on('window-all-closed', () => {});
const records = [], errors = [];
let controller;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label, timeout = 10000) {
  const began = Date.now();
  while (Date.now() - began < timeout) { const result = await test(); if (result) return result; await pause(40); }
  throw new Error('Timed out: ' + label);
}
function ProbeWindow(options) {
  const win = new BrowserWindow({ ...options, webPreferences: { ...options.webPreferences, offscreen: true } });
  const record = { win, options, ready: false, loaded: false, shows: 0, ignored: [], payloads: [] };
  records.push(record); win.webContents.setAudioMuted(true);
  win.once('ready-to-show', () => { record.ready = true; });
  win.webContents.once('did-finish-load', () => { record.loaded = true; });
  win.webContents.on('console-message', ({ level, message }) => { if (level === 'error' && /Uncaught|ReferenceError|TypeError|Content Security Policy/.test(message)) errors.push(message); });
  const ignore = win.setIgnoreMouseEvents.bind(win);
  win.setIgnoreMouseEvents = (value, ...args) => { record.ignored.push(value); return ignore(value, ...args); };
  const send = win.webContents.send.bind(win.webContents);
  win.webContents.send = (channel, payload) => {
    if (channel === 'moonsteel-alert:data') {
      assert(record.ready && record.loaded, 'No payload is delivered before the renderer and first paint are ready');
      record.payloads.push(payload);
    }
    return send(channel, payload);
  };
  win.showInactive = () => { record.shows++; };
  win.show = win.focus = () => { throw new Error('Native QA must never activate or map the flash'); };
  win.moveTop = () => {};
  return win;
}

async function inspectNative(windows) {
  if (process.platform !== 'win32') return [];
  const handles = windows.map(win => {
    const handle = win.getNativeWindowHandle();
    return (handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString();
  });
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MoonsteelNativeProbe {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  public class Info { public long Handle; public uint Owner; public long ExStyle; public int X, Y, Width, Height; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint owner);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  public static Info Read(long handle) {
    var window = new IntPtr(handle); uint owner; GetWindowThreadProcessId(window, out owner);
    if (owner != ${process.pid}) throw new InvalidOperationException("Probe refuses an external window");
    Rect rect; if (!GetWindowRect(window, out rect)) throw new InvalidOperationException("Missing fixture window");
    return new Info { Handle=handle, Owner=owner, ExStyle=GetWindowLongPtr(window,-20).ToInt64(), X=rect.Left, Y=rect.Top, Width=rect.Right-rect.Left, Height=rect.Bottom-rect.Top };
  }
}
'@
[void][MoonsteelNativeProbe]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
[Console]::WriteLine((@(${handles.map(handle => `[MoonsteelNativeProbe]::Read([long]${handle})`).join(';')}) | ConvertTo-Json -Compress))
`;
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 12000 });
  const result = JSON.parse(stdout.trim()); return Array.isArray(result) ? result : [result];
}

app.whenReady().then(async () => {
  controller = createMoonsteelAlertWindow({ BrowserWindow: ProbeWindow, screen,
    rendererRoot: path.join(appRoot, 'src', 'renderer'), preloadPath: path.join(appRoot, 'src', 'moonsteel-alert-preload.js'),
    onError: error => errors.push(error.message) });
  assert.equal(controller.show({ settings: { monitor: 'all', duration: 12 }, items: [{ id: 'isolated', name: 'Stultin' }], preview: true }), true);
  await until(() => records.length && records.every(record => record.payloads.length === 1), 'all display renderers start');
  const audible = records.filter(record => record.payloads[0].settings.soundEnabled);
  assert.equal(audible.length, 1, 'Exactly one display plays the sound');
  const audioState = await until(() => audible[0].win.webContents.executeJavaScript(`document.documentElement.dataset.soundPlayed==='chime'&&document.documentElement.dataset.audioState==='running'`), 'WebAudio starts without a user gesture');
  const displays = screen.getAllDisplays().filter((display, index, all) => all.findIndex(other =>
    ['x', 'y', 'width', 'height'].every(key => other.bounds[key] === display.bounds[key])) === index);
  assert.equal(records.length, displays.length, 'Mirrored display rectangles share one native flash surface');
  for (let index = 0; index < records.length; index++) {
    const { win, options, shows, ignored } = records[index];
    const expected = displays[index].bounds;
    assert.deepEqual(win.getBounds(), expected, 'The native window uses full display bounds');
    assert.equal(win.isFocusable(), false); assert.deepEqual(ignored, [true]); assert.equal(shows, 1);
    assert.equal(options.skipTaskbar, true); assert.equal(options.transparent, true); assert.equal(options.frame, false);
    await win.webContents.executeJavaScript(`for(const animation of document.getAnimations()){animation.pause();animation.currentTime=Number(animation.effect.getTiming().duration)/2;}`);
  }
  const native = await inspectNative(records.map(record => record.win));
  native.forEach((entry, index) => {
    assert(entry.ExStyle & 0x20, 'WS_EX_TRANSPARENT keeps native mouse input in the game');
    assert(entry.ExStyle & 0x08000000, 'WS_EX_NOACTIVATE prevents native focus stealing');
    const expected = screen.dipToScreenRect(records[index].win, displays[index].bounds);
    for (const [field, key] of [['X','x'],['Y','y'],['Width','width'],['Height','height']]) assert(Math.abs(entry[field] - expected[key]) <= 1, 'Physical monitor rectangle: ' + key);
  });
  const image = await records[0].win.webContents.capturePage(), size = image.getSize(), bitmap = image.toBitmap();
  const pixel = (x, y) => [...bitmap.subarray((y * size.width + x) * 4, (y * size.width + x) * 4 + 4)];
  const center = pixel(Math.floor(size.width / 2), Math.floor(size.height / 2));
  const edge = pixel(Math.floor(size.width / 2), 4);
  assert.equal(center[3], 0, 'The center of the screen remains transparent');
  assert(edge[3] > 0 && edge[0] > edge[1] && edge[2] > edge[1], 'The border is visible purple BGRA');
  const screenshot = path.join(out, 'edge-flash.png'); fs.writeFileSync(screenshot, image.toPNG());
  controller.close(); assert.equal(controller.activeWindows.length, 0);
  const before = records.length;
  assert(controller.show({ settings: { flashEnabled: false, sound: 'soft', monitor: 'all', duration: 1 } }));
  await until(() => records[before]?.payloads.length === 1, 'sound-only renderer starts');
  const soundOnly = records[before];
  assert.equal(records.length, before + 1); assert.equal(soundOnly.shows, 0);
  assert.equal(soundOnly.win.getBounds().width, 1); assert.equal(soundOnly.win.getBounds().height, 1);
  await until(() => soundOnly.win.webContents.executeJavaScript(`document.documentElement.dataset.soundPlayed==='soft'&&document.documentElement.dataset.audioState==='running'`), 'sound-only WebAudio starts');
  controller.dispose(); assert.equal(controller.activeWindows.length, 0); assert.deepEqual(errors, []);
  const summary = { ok: true, packaged, appRoot, out, displays: displays.map(display => display.bounds), native,
    audioState, soundOnly: true, center, edge, screenshot, errors };
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary, null, 2)); app.exit(0);
}).catch(error => { controller?.dispose(); console.error(error.stack); console.error(JSON.stringify({ out, errors })); app.exit(1); });
setTimeout(() => { controller?.dispose(); console.error('Moonsteel alert QA timed out: ' + out); app.exit(1); }, 35000).unref();
