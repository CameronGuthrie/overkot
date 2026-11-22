'use strict';

// Run only on a disposable X11 desktop: this check sends real mouse/keyboard
// input, launches a separate Xlib game fixture, and changes its fullscreen state.
if (process.platform !== 'linux' || process.env.OVERKOT_ISOLATED_X11_QA !== '1') {
  console.error('Use an isolated Linux X11 desktop and set OVERKOT_ISOLATED_X11_QA=1.');
  process.exit(1);
}
if (!process.versions.electron) {
  const result = require('./run-packaged-check').runPackagedCheck(__filename, process.argv.slice(2), 90000);
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const runtime = require('electron');
const { app, BrowserWindow, screen, session, globalShortcut, desktopCapturer } = runtime;
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output', `linux-fullscreen-check-${Date.now()}`);
const appRootArg = process.argv.find(arg => arg.startsWith('--app-root='));
const appRoot = appRootArg ? path.resolve(appRootArg.slice('--app-root='.length)) : root;
app.setAppPath(appRoot);
fs.mkdirSync(out, { recursive: true });
const runtimeHelper = path.join(process.resourcesPath, 'bin', 'overkot-overlay-window');
if (process.env.OVERKOT_PACKAGED_DIRECTORY || appRootArg) {
  assert.ok(fs.existsSync(runtimeHelper), 'Packaged QA exercises the helper in resources/bin');
}
process.env.XDG_DATA_HOME = path.join(out, 'data');
process.env.XDG_CONFIG_HOME = path.join(out, 'config');
process.env.OVERKOT_BUILD_CHANNEL = 'stable';
process.env.OVERKOT_DATA_MANIFEST_URL = 'http://127.0.0.1:1/manifest.json';
process.env.OVERKOT_CALENDAR_MANIFEST_URL = 'http://127.0.0.1:1/calendar.json';
app.setPath('userData', path.join(out, 'profile'));

// Retain the real window manager, native helper, global shortcuts and Electron
// input handling. Only network access and discovery of real games are disabled.
global.fetch = async () => { throw new Error('Remote requests disabled in Linux fullscreen QA'); };
const closedRequest = (...args) => http.request({ hostname: '127.0.0.1', port: 1, path: '/', method: 'GET', agent: false },
  typeof args.at(-1) === 'function' ? args.at(-1) : undefined);
const networkFacade = actual => new Proxy(actual, { get(target, key) {
  if (key === 'request') return closedRequest;
  if (key === 'get') return (...args) => { const request = closedRequest(...args); request.end(); return request; };
  return target[key];
} });
const fsFacade = new Proxy(fs, { get(target, key) {
  if (key === 'readdirSync') return (directory, ...args) => directory === '/proc' ? [] : fs.readdirSync(directory, ...args);
  return target[key];
} });
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'http' || request === 'node:http') return networkFacade(http);
  if (request === 'https' || request === 'node:https') return networkFacade(https);
  if (request === 'fs' || request === 'node:fs') return fsFacade;
  return originalLoad.call(this, request, parent, isMain);
};
const { ConfigStore } = require('../src/modules/config');
const { TUTORIAL_IDS } = require('../src/modules/tutorials');
new ConfigStore().setMany({ clickThrough: true, hideWhenGameClosed: false, showOnlyWhenGameFocused: false,
  launchToTray: false, automaticUpdates: false, dockAutoHide: false, dockEdge: 'bottom',
  interactionHotkey: 'Shift+F1', overlayVisibilityHotkey: 'Shift+F2',
  widgetVisibility: { boss: true, wiki: true }, widgetOpen: { boss: true, wiki: true },
  widgetDocked: { boss: true, wiki: true }, language: 'en', startupLayoutChoice: 'native-qa',
  tutorialCompleted: Object.fromEntries(TUTORIAL_IDS.map(id => [id, true])) });

const errors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', ({ level, message }) => {
    if ((level === 'error' || level >= 3) && /Uncaught|ReferenceError|TypeError/.test(message)) errors.push(message);
  });
  contents.on('render-process-gone', (_event, details) => errors.push('Renderer exited: ' + details.reason));
  contents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
    if (mainFrame && code !== -3) errors.push(`Renderer load failed (${code}): ${description}`);
  });
});
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }));
});
require(path.join(appRoot, 'src', 'main.js'));

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await fn();
    if (value) return value;
    await pause(50);
  }
  throw new Error('Timed out: ' + label);
}
async function ready(file, widget) {
  const win = await until(() => BrowserWindow.getAllWindows().find(candidate => {
    const url = new URL(candidate.webContents.getURL() || 'about:blank');
    return url.pathname.endsWith('/' + file) && (!widget || url.searchParams.get('widget') === widget);
  }), `window ${file}:${widget || ''}`);
  await until(async () => !win.webContents.isLoading() && await win.webContents.executeJavaScript('!!window.api'), file + ' preload');
  return win;
}
const evaluate = (win, code) => win.webContents.executeJavaScript(code);
const state = win => evaluate(win, 'window.api.getState()');
const xid = win => win.getNativeWindowHandle().readUInt32LE(0);
const hex = id => '0x' + id.toString(16);
const command = (file, args) => execFileSync(file, args, { encoding: 'utf8' }).trim();
const property = (id, name) => command('xprop', ['-id', hex(id), name]);
const rootProperty = name => command('xprop', ['-root', name]);
const active = () => Number(rootProperty('_NET_ACTIVE_WINDOW').match(/0x[\da-f]+/i)?.[0]);
const stacking = () => (rootProperty('_NET_CLIENT_LIST_STACKING').match(/0x[\da-f]+/gi) || []).map(Number);
const key = chord => command('xdotool', ['key', '--clearmodifiers', chord]);
function assertAbove(windows, gameId) {
  const order = stacking();
  assert.ok(order.includes(gameId), 'Game belongs to the window manager stacking list');
  for (const win of windows) {
    assert.ok(order.indexOf(xid(win)) > order.indexOf(gameId), `${win.webContents.getURL()} must stack above the active game`);
    assert.equal(win.isVisible(), true);
  }
  return order.map(hex);
}
function assertHints(win) {
  const types = property(xid(win), '_NET_WM_WINDOW_TYPE');
  assert.match(types, /_KDE_NET_WM_WINDOW_TYPE_CRITICAL_NOTIFICATION.*_NET_WM_WINDOW_TYPE_NOTIFICATION.*_NET_WM_WINDOW_TYPE_DOCK/,
    'Native window advertises ordered fullscreen-safe compositor types');
  assert.match(property(xid(win), '_NET_WM_BYPASS_COMPOSITOR'), /= 2\s*$/, 'Native window keeps compositor rendering enabled');
}
async function screenshot(name) {
  const display = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: display.size });
  assert.ok(sources.length, 'Native desktop capture is available');
  fs.writeFileSync(path.join(out, name + '.png'), sources[0].thumbnail.toPNG());
}

// An independent native client avoids accidentally testing Electron sibling
// ordering. It records real ButtonPress delivery beneath pass-through panels.
const gameSource = String.raw`
#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <stdio.h>
#include <string.h>
#include <sys/select.h>
#include <unistd.h>
static void message(Display *d, Window w, const char *name, long a, long b) {
  XEvent e = {0}; e.xclient.type = ClientMessage; e.xclient.window = w;
  e.xclient.message_type = XInternAtom(d, name, False); e.xclient.format = 32;
  e.xclient.data.l[0] = a; e.xclient.data.l[1] = b; e.xclient.data.l[2] = 0;
  XSendEvent(d, DefaultRootWindow(d), False, SubstructureRedirectMask | SubstructureNotifyMask, &e); XFlush(d);
}
int main(void) {
  Display *d = XOpenDisplay(NULL); if (!d) return 1; setbuf(stdout, NULL); setbuf(stdin, NULL);
  Window root = DefaultRootWindow(d); int s = DefaultScreen(d);
  Window w = XCreateSimpleWindow(d, root, 0, 0, DisplayWidth(d,s), DisplayHeight(d,s), 0, 0, 0x314159);
  unsigned long motif[] = {2,0,0,0,0};
  XChangeProperty(d,w,XInternAtom(d,"_MOTIF_WM_HINTS",False),XInternAtom(d,"_MOTIF_WM_HINTS",False),32,PropModeReplace,(unsigned char*)motif,5);
  XStoreName(d,w,"Overkot independent fullscreen QA game");
  XSelectInput(d,w,ButtonPressMask | StructureNotifyMask | ExposureMask);
  XMapWindow(d,w); XFlush(d); printf("window %lu\n",w);
  for (;;) {
    while (XPending(d)) { XEvent e; XNextEvent(d,&e); if (e.type == ButtonPress) puts("click"); }
    fd_set fds; FD_ZERO(&fds); FD_SET(0,&fds); FD_SET(ConnectionNumber(d),&fds);
    if (select(ConnectionNumber(d)+1,&fds,NULL,NULL,NULL)<0) break;
    if (FD_ISSET(0,&fds)) {
      char line[64]; if (!fgets(line,sizeof(line),stdin)) break;
      if (!strncmp(line,"quit",4)) break;
      if (!strncmp(line,"fullscreen",10)) message(d,w,"_NET_WM_STATE",1,XInternAtom(d,"_NET_WM_STATE_FULLSCREEN",False));
      if (!strncmp(line,"borderless",10)) { message(d,w,"_NET_WM_STATE",0,XInternAtom(d,"_NET_WM_STATE_FULLSCREEN",False)); XMoveResizeWindow(d,w,0,0,DisplayWidth(d,s),DisplayHeight(d,s)); }
      if (!strncmp(line,"activate",8)) message(d,w,"_NET_ACTIVE_WINDOW",2,CurrentTime);
    }
  }
  XDestroyWindow(d,w); XCloseDisplay(d); return 0;
}`;
let game;
let gameId;
let clicks = 0;
let gameOutput = '';
async function startGame() {
  const source = path.join(out, 'fullscreen-game.c');
  const binary = path.join(out, 'fullscreen-game');
  fs.writeFileSync(source, gameSource);
  command(process.env.CC || 'cc', ['-Wall', '-Wextra', '-Werror', source, '-o', binary, '-lX11']);
  game = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  game.on('error', error => errors.push('Game fixture: ' + error.message));
  game.stderr.on('data', data => { gameOutput += data.toString(); });
  let partial = '';
  game.stdout.on('data', data => {
    partial += data.toString();
    for (;;) {
      const newline = partial.indexOf('\n');
      if (newline < 0) break;
      const line = partial.slice(0, newline); partial = partial.slice(newline + 1);
      if (line.startsWith('window ')) gameId = Number(line.slice(7));
      if (line === 'click') clicks++;
    }
  });
  await until(() => gameId, 'separate native game window');
}
async function activateGame() {
  game.stdin.write('activate\n');
  await until(() => active() === gameId, 'game foreground ownership');
  await pause(300);
}
async function clickThrough(win) {
  const before = clicks;
  const bounds = win.getBounds();
  command('xdotool', ['mousemove', '--sync', String(bounds.x + Math.min(25, bounds.width - 1)),
    String(bounds.y + Math.min(25, bounds.height - 1)), 'click', '1']);
  await until(() => clicks > before, 'mouse click reaches game beneath ' + win.webContents.getURL());
  assert.equal(active(), gameId, 'Passive overlay must retain game focus');
}
function cleanup() { if (game && game.exitCode === null) { game.stdin.end('quit\n'); game.kill(); } }
app.on('will-quit', cleanup);

app.whenReady().then(async () => {
  const rail = await ready('index.html');
  const boss = await ready('widget-host.html', 'boss');
  const wiki = await ready('widget-host.html', 'wiki');
  const overlays = [rail, boss, wiki];
  await until(() => overlays.every(win => win.isVisible()), 'visible rail and widgets');
  const initial = await state(rail);
  assert.ok(['x11', 'xwayland'].includes(initial.platformSupport.displayBackend));
  assert.ok(globalShortcut.isRegistered('Shift+F1'), 'Real interaction shortcut is bound');
  assert.ok(globalShortcut.isRegistered('Shift+F2'), 'Real visibility shortcut is bound');
  await until(() => overlays.every(win => /_KDE_NET_WM_WINDOW_TYPE_CRITICAL_NOTIFICATION/.test(property(xid(win), '_NET_WM_WINDOW_TYPE'))), 'native helper finishes');
  overlays.forEach(assertHints);
  const checks = ['real native window hints, compositor bypass disabled, native shortcut registration'];
  const samples = [];
  await startGame();
  for (const mode of ['borderless', 'fullscreen', 'borderless', 'fullscreen']) {
    game.stdin.write(mode + '\n');
    await until(() => property(gameId, '_NET_WM_STATE').includes('_NET_WM_STATE_FULLSCREEN') === (mode === 'fullscreen'), mode + ' native state');
    await activateGame();
    assert.equal(active(), gameId);
    let order;
    try { order = assertAbove(overlays, gameId); }
    catch (error) { error.message += ` (mode=${mode}, game=${hex(gameId)}, order=${stacking().map(hex).join(',')})`; throw error; }
    for (const win of overlays) await clickThrough(win);
    samples.push({ mode, active: hex(active()), stacking: order });
  }
  await screenshot('fullscreen-passive');
  checks.push('rail and widgets stay above active independent borderless/fullscreen game across mode changes; native clicks reach game and retain focus');

  key('shift+F1');
  await until(async () => (await state(rail)).overlayInteractive && rail.isFocused(), 'Shift+F1 focuses overlay');
  assertAbove(overlays, gameId);
  await evaluate(rail, 'window.api.openSettings()');
  const settings = await ready('settings.html');
  await until(() => settings.isVisible() && settings.isFocused(), 'Settings opens focused');
  assert.doesNotMatch(property(xid(settings), '_NET_WM_WINDOW_TYPE'), /CRITICAL_NOTIFICATION|_NET_WM_WINDOW_TYPE_NOTIFICATION|_NET_WM_WINDOW_TYPE_DOCK/,
    'Resizable Settings keeps an ordinary window type');
  assert.ok(property(xid(settings), 'WM_TRANSIENT_FOR').includes(hex(xid(rail))), 'Settings follows the fullscreen-safe rail as a transient');
  assertAbove([...overlays, settings], gameId);
  const popupOrder = stacking();
  for (const win of overlays) assert.ok(popupOrder.indexOf(xid(settings)) > popupOrder.indexOf(xid(win)),
    `Settings stacks above rail and widgets (settings=${hex(xid(settings))}, surface=${hex(xid(win))}, order=${popupOrder.map(hex).join(',')})`);
  const before = settings.getBounds();
  command('xdotool', ['windowsize', hex(xid(settings)), String(before.width - 80), String(before.height - 40)]);
  await until(() => settings.getBounds().width === before.width - 80 && settings.getBounds().height === before.height - 40,
    'ordinary Settings native resize');
  command('xdotool', ['windowmove', hex(xid(settings)), String(before.x + 20), String(before.y + 20)]);
  await until(() => settings.getBounds().x === before.x + 20 && settings.getBounds().y === before.y + 20, 'ordinary Settings native move');
  assertAbove([settings], gameId);
  await screenshot('fullscreen-settings');
  key('shift+F1');
  await until(async () => !(await state(rail)).overlayInteractive, 'Shift+F1 restores passive mode');
  await activateGame();
  await evaluate(rail, 'window.api.saveConfig({dockAutoHide:true})');
  const display = screen.getPrimaryDisplay();
  command('xdotool', ['mousemove', '--sync', String(display.bounds.x + display.bounds.width / 2),
    String(display.bounds.y + display.bounds.height / 2)]);
  await until(() => !rail.isVisible(), 'rail auto-hides away from pointer');
  assert.equal(settings.isVisible(), true, 'Auto-hidden rail retains an open Settings window');
  assert.match(command('xwininfo', ['-id', hex(xid(settings))]), /Map State: IsViewable/, 'Settings remains natively mapped with hidden parent');
  assertAbove([settings], gameId);
  await screenshot('fullscreen-settings-autohidden-rail');
  await evaluate(rail, 'window.api.saveConfig({dockAutoHide:false})');
  await until(() => rail.isVisible(), 'rail restores after disabling auto-hide');
  settings.close();
  await clickThrough(boss);
  checks.push('real Shift+F1 activates rail and restores pass-through; ordinary transient Settings remains movable, resizable and above game and widgets, including while rail auto-hides');

  key('shift+F2');
  await until(() => overlays.every(win => !win.isVisible()), 'visibility shortcut hides overlay');
  game.stdin.write('borderless\nfullscreen\nactivate\n');
  await until(() => property(gameId, '_NET_WM_STATE').includes('_NET_WM_STATE_FULLSCREEN'), 'hidden overlay game fullscreen transition');
  key('shift+F1');
  await pause(800);
  assert.ok(overlays.every(win => !win.isVisible()), 'Fullscreen changes and interaction shortcut must not reveal hidden windows');
  key('shift+F2');
  await until(() => overlays.every(win => win.isVisible()), 'visibility shortcut restores overlay');
  await activateGame();
  assertAbove(overlays, gameId);
  overlays.forEach(assertHints);
  await clickThrough(wiki);
  checks.push('hidden windows remain hidden during fullscreen changes and Shift+F1; restored windows keep layering, hints and pass-through');

  assert.deepEqual(errors, []);
  const result = { ok: true, checks, windowManager: rootProperty('_NET_SUPPORTING_WM_CHECK'),
    appRoot, runtime: process.versions.electron, displayBackend: initial.platformSupport.displayBackend,
    nativeHelper: { path: fs.existsSync(runtimeHelper) ? runtimeHelper : path.join(root, '.build', 'bin', 'overkot-overlay-window'),
      packagedResource: fs.existsSync(runtimeHelper) },
    chromiumSandbox: !app.commandLine.hasSwitch('no-sandbox'), samples, screenshots: out };
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  cleanup(); app.exit(0);
}).catch(error => {
  console.error(error.stack);
  console.error(JSON.stringify({ message: error.message, errors, gameOutput, output: out }));
  fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ message: error.message, error: error.stack, errors, gameOutput,
    appRoot, runtime: process.versions.electron, chromiumSandbox: !app.commandLine.hasSwitch('no-sandbox') }, null, 2));
  cleanup(); app.exit(1);
});
