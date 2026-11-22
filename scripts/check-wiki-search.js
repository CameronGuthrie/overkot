// Exercise the built app's real widget -> IPC -> native wiki window flow.
// Uses a disposable profile and prevents game discovery and credential scanning.
if (process.platform !== 'win32') {
  console.error('This check requires Windows to isolate game discovery and LOCALAPPDATA.');
  process.exit(1);
}
const path = require('node:path');
const fs = require('node:fs');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { promisify } = require('node:util');
if (!process.versions.electron) {
  const result = require('./run-packaged-check').runPackagedCheck(__filename, process.argv.slice(2), 60000, { windowsHide: false });
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
}

const assert = require('node:assert/strict');
const { app, BrowserWindow, globalShortcut, screen, shell, ipcMain } = require('electron');
const root = path.resolve(__dirname, '..');
const packagedRoot = path.resolve(process.env.OVERKOT_PACKAGED_DIRECTORY || path.join(root, 'dist', 'win-unpacked'));
const archive = path.join(packagedRoot, 'resources', 'app.asar');
const appRoot = process.argv.includes('--source') ? root : archive;
const out = path.join(root, 'output', `wiki-search-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
process.env.LOCALAPPDATA = out;
process.env.OVERKOT_DATA_MANIFEST_URL = 'http://127.0.0.1:1/manifest.json';
const live = process.argv.includes('--live-wiki');
if (appRoot === root) require('./wiki-test-profile').configureWikiTestProfile(out, live);
app.setPath('userData', path.join(out, 'electron-profile'));
app.getAppPath = () => appRoot;
const externalPages = [];
const controlActions = [];
const registerHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => registerHandle(channel, channel === 'wiki:action' ? async (event, action) => {
  const accepted = await handler(event, action);
  controlActions.push({ action, accepted });
  return accepted;
} : handler);
shell.openExternal = async url => { externalPages.push(url); };
const game = process.argv.includes('--game');
const clickableWidgets = process.argv.includes('--clickable-widgets');
const nativeForeground = process.argv.includes('--native-foreground');
const focusOnly = process.argv.includes('--focus-only');
const desktopOpen = process.argv.includes('--desktop-open');
let gamePresent = game && !desktopOpen;
if (desktopOpen && (!game || !clickableWidgets)) throw new Error('--desktop-open requires --game --clickable-widgets');
// Discover only this fixture's PID, never a real game. The connecting state
// exercises the main process's complete game-session mouse lock.
cp.exec = (command, _options, callback) => {
  const output = gamePresent && command.startsWith('tasklist ')
    ? `"Soulframe.x64.exe","${process.pid}","Console","1","0 K"` : '';
  setImmediate(() => callback(null, output, ''));
  return { on() {}, kill() {} };
};
cp.exec[promisify.custom] = (command, options) => new Promise((resolve, reject) =>
  cp.exec(command, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
// Prevent source/assets helpers as well as packaged helpers from scanning even
// this fixture. No credentials or inventory network requests are supplied.
const originalExecFile = cp.execFile;
cp.execFile = (file, args, options, callback) => {
  if (/hostservice\.exe|overkot-session-scanner/i.test(file)) {
    setImmediate(() => callback(new Error('Credential helpers disabled by wiki check'), '', ''));
    return { on() {}, kill() {} };
  }
  return originalExecFile(file, args, options, callback);
};
cp.execFile[promisify.custom] = (file, args, options) => new Promise((resolve, reject) =>
  cp.execFile(file, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
// Supply deterministic foreground samples without relying on the user's
// current desktop. The separate native mouse helper still sends OS input.
const originalSpawn = cp.spawn;
let foregroundMonitor;
const foregroundSamples = [];
cp.spawn = (file, args, options) => {
  const encoded = args?.indexOf('-EncodedCommand');
  const layoutMonitor = file.toLowerCase() === 'powershell.exe' && encoded >= 0 &&
    Buffer.from(args[encoded + 1], 'base64').toString('utf16le').includes('OverlayLayoutKeys');
  if (!nativeForeground && layoutMonitor) {
    foregroundMonitor = new EventEmitter();
    foregroundMonitor.stdout = new PassThrough(); foregroundMonitor.stderr = new PassThrough();
    foregroundMonitor.kill = () => {}; foregroundMonitor.unref = () => {};
    return foregroundMonitor;
  }
  const child = originalSpawn(file, args, options);
  if (nativeForeground && layoutMonitor) child.stdout.on('data', chunk => {
    for (const line of chunk.toString().split(/\r?\n/)) if (/^foreground:\d+$/.test(line)) {
      const pid = Number(line.slice('foreground:'.length));
      if (foregroundSamples.at(-1)?.pid !== pid) {
        foregroundSamples.push({ time: Date.now(), pid });
        console.log(JSON.stringify({ nativeForegroundPid: pid, overlayPid: process.pid }));
      }
    }
  });
  return child;
};
function foreground(pid) { foregroundMonitor?.stdout.write(`foreground:${pid}\n`); }
const { ConfigStore } = require('../src/modules/config');
const config = new ConfigStore();
let toggleInteraction, toggleVisibility;
const originalRegisterShortcut = globalShortcut.register.bind(globalShortcut);
const originalUnregisterShortcut = globalShortcut.unregister.bind(globalShortcut);
globalShortcut.register = (key, callback) => {
  if (key === config.get('interactionHotkey', 'Shift+F1')) toggleInteraction = callback;
  if (key === config.get('overlayVisibilityHotkey', 'Shift+F2')) toggleVisibility = callback;
  return nativeForeground ? originalRegisterShortcut(key, callback) : true;
};
globalShortcut.unregister = key => { if (nativeForeground) originalUnregisterShortcut(key); };
config.setMany({ clickThrough: !clickableWidgets, hideWhenGameClosed: false,
  showOnlyWhenGameFocused: focusOnly, enableAlertSound: false,
  dockAutoHide: focusOnly,
  tutorialCompleted: { app: true, wiki: true },
  ...(nativeForeground ? { interactionHotkey: 'Control+Shift+F24', overlayVisibilityHotkey: 'Control+Alt+F24' } : {}),
  widgetOpen: { wiki: true }, widgetDocked: { wiki: focusOnly }, dockParadigmVersion: 1,
  widgetVisibility: { boss: false, crafting: false, other: false, affiliation: false,
    factions: false, odeinfamy: false, arena: false, minimap: false,
    groupfinder: false, wiki: true } });
const errors = [];
const wikiConsoleErrors = [];
let mouse;
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
process.on('unhandledRejection', error => { console.error(error); app.exit(1); });
app.on('web-contents-created', (_event, contents) => {
  contents.on('render-process-gone', (_e, detail) => errors.push(detail));
  contents.on('console-message', ({ message, sourceId, lineNumber }) => {
    if (/Uncaught|Error invoking|ReferenceError|TypeError/.test(message)) {
      const url = contents.getURL();
      // Record public-site errors separately; app exceptions, renderer crashes
      // and missing/blank wiki content still fail the check.
      (isWikiSession(contents.session) ? wikiConsoleErrors : errors)
        .push({ message, sourceId, lineNumber, url });
    }
  });
});
function isWikiSession(created) {
  return /^wiki(?:-[0-9a-f]{24})?$/.test(path.basename(created?.storagePath || ''));
}
let requestCount = 0;
app.on('session-created', created => {
  if (live || !isWikiSession(created)) return;
  const serveFixture = request => {
    requestCount++;
    const url = new URL(request.url);
    return new Response('<!doctype html><title>Soulframe Wiki</title><h1>' +
      (url.searchParams.get('search') || url.pathname) + '</h1><p>Wiki content loaded.</p>',
    { headers: { 'Content-Type': 'text/html' } });
  };
  created.protocol.handle('https', serveFixture);
  created.protocol.handle('http', serveFixture);
});
require(path.join(appRoot, 'src', 'main.js'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  const start = Date.now();
  while (Date.now() - start < 20000) {
    const value = await fn();
    if (value) return value;
    await pause(50);
  }
  throw new Error('Timed out: ' + label + '\nWindows: ' + JSON.stringify(BrowserWindow.getAllWindows().map(win => ({
    url: win.webContents.getURL(), visible: win.isVisible(), minimized: win.isMinimized(),
    hiddenByOverlay: win._visibleBeforeOverlayHide,
  }))));
}
function wikiWindow() {
  return BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/wiki-window.html'));
}
function articleContents(win) {
  return win.contentView.children.find(view => isWikiSession(view.webContents?.session))?.webContents;
}
app.whenReady().then(async () => {
  const main = await until(() => BrowserWindow.getAllWindows().find(win =>
    win.webContents.getURL().endsWith('/index.html')), 'main window');
  const widget = await until(() => BrowserWindow.getAllWindows().find(win =>
    /widget-host.html\?widget=wiki/.test(win.webContents.getURL())), 'wiki widget');
  await until(async () => !widget.webContents.isLoading() && await widget.webContents.executeJavaScript(
    '!!document.getElementById("wiki-search-input")'), 'search input');
  if (await widget.webContents.executeJavaScript('window.api.wikiAvailable') === false) {
    await until(() => widget.webContents.executeJavaScript('document.getElementById("wiki-search-input").disabled'), 'unconfigured wiki shows disabled search');
    assert.equal(wikiWindow(), undefined);
    assert.equal(requestCount, 0);
    console.log('Community wiki disabled; no navigation requests.');
    app.exit(0);
    return;
  }
  assert.equal(app.getLocale(), 'en-GB', 'the packaged UK English runtime locale must load');
  if (game && !desktopOpen) await until(async () => (await main.webContents.executeJavaScript('window.api.getState()')).status === 'connecting', 'isolated game connecting');
  await until(() => toggleInteraction, 'overlay interaction shortcut');
  foreground(process.pid);
  mouse = await require('./windows-native-mouse').createNativeMouse();
  if (!desktopOpen) {
    if (nativeForeground) await mouse.pressFocusChord();
    else toggleInteraction();
  } else {
    assert.equal((await main.webContents.executeJavaScript('window.api.getState()')).overlayInteractive, false,
      'clickable desktop widgets do not require the focus chord');
    const area = screen.getPrimaryDisplay().workArea;
    widget.setBounds({ x: area.x + Math.floor(area.width / 2) - 150, y: area.y + Math.floor(area.height / 2) - 26,
      width: 300, height: 53 });
    // Focus the fixture widget with a separate registered desktop chord. It
    // grants Windows foreground permission without changing overlayInteractive.
    assert.equal(originalRegisterShortcut('Control+Shift+F23', () => { widget.show(); widget.moveTop(); widget.focus(); }), true);
    await mouse.pressDesktopChord();
    await until(async () => widget.isVisible() && widget.isFocusable() && widget.isFocused() &&
      await mouse.foregroundPid() === process.pid, 'native desktop widget focus');
    assert.equal((await main.webContents.executeJavaScript('window.api.getState()')).overlayInteractive, false);
    await mouse.click(widget, 'wiki-search-input');
    console.log(JSON.stringify({ label: 'desktop widget clicked', widgetFocused: widget.isFocused(),
      widgetFocusable: widget.isFocusable(), widgetBounds: widget.getContentBounds() }));
  }
  app.once('will-quit', () => { void mouse.close().catch(() => {}); });
  const focusSamples = [];
  async function sample(label, win) {
    await pause(250);
    const state = await main.webContents.executeJavaScript('window.api.getState()');
    const detail = { label, status: state.status, overlayInteractive: state.overlayInteractive,
      wikiFocused: win.isFocused(), mainFocused: main.isFocused(), widgetFocused: widget.isFocused(),
      wikiFocusable: win.isFocusable(), chromeFocused: win.webContents.isFocused(), articleFocused: articleContents(win).isFocused(),
      nativeForegroundPid: foregroundSamples.at(-1)?.pid };
    focusSamples.push(detail);
    console.log(JSON.stringify(detail));
    assert.equal(state.overlayInteractive, true, label + ': wiki focus retains overlay interaction');
    assert.equal(win.isFocusable(), true, label + ': wiki remains focusable');
  }
  async function click(win, id) {
    await sample('before ' + id, win);
    await mouse.click(win, id);
  }
  async function search(query) {
    widget.show(); widget.focus();
    await widget.webContents.executeJavaScript(`{
      const input = document.getElementById('wiki-search-input');
      input.value = ${JSON.stringify(query)}; input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    }`);
    const win = await until(wikiWindow, 'wiki window');
    await until(async () => articleContents(win) && !articleContents(win).isLoading() &&
      (await articleContents(win).executeJavaScript('document.body.innerText')).toLowerCase().includes(query.toLowerCase()), 'wiki content: ' + query);
    await until(() => win.isVisible(), 'visible wiki: ' + query);
    const area = screen.getPrimaryDisplay().workArea;
    win.setBounds({ x: area.x + 120, y: area.y + 80, width: 900, height: 700 });
    assert.equal(win.isMinimized(), false, 'a search must restore a minimized wiki');
    assert.equal(win.isMenuBarVisible(), false);
    assert.equal(widget.isDestroyed(), false);
    return win;
  }
  let wiki = await search('vetch');
  if (desktopOpen) {
    console.log(JSON.stringify({ label: 'desktop wiki opened', overlayInteractive:
      (await main.webContents.executeJavaScript('window.api.getState()')).overlayInteractive,
      wikiFocused: wiki.isFocused(), wikiFocusable: wiki.isFocusable() }));
    // A search entered through a clickable desktop widget is an explicit user
    // focus request. Connecting to the game must preserve that wiki session.
    gamePresent = true;
    await until(async () => (await main.webContents.executeJavaScript('window.api.getState()')).status === 'connecting', 'game launched while reading wiki');
    const state = await main.webContents.executeJavaScript('window.api.getState()');
    console.log(JSON.stringify({ label: 'desktop wiki during game transition', overlayInteractive: state.overlayInteractive,
      wikiFocused: wiki.isFocused(), wikiFocusable: wiki.isFocusable() }));
    assert.equal(wiki.isFocusable(), true, 'a desktop search remains usable when the game starts');
  }
  const firstArticleURL = articleContents(wiki).getURL();
  assert.equal(await articleContents(wiki).executeJavaScript('typeof window.api'), 'undefined', 'Remote wiki has no app bridge');
  assert.deepEqual(await wiki.webContents.executeJavaScript('Object.keys(window.api).sort()'), ['getState', 'onThemeChanged']);
  assert.equal(await wiki.webContents.executeJavaScript('document.querySelector(".wiki-titlebar").getBoundingClientRect().height'), 44);
  const articleView = wiki.contentView.children.find(view => view.webContents === articleContents(wiki));
  assert.deepEqual(articleView.getBounds(), { x: 0, y: 44, width: wiki.getContentSize()[0], height: wiki.getContentSize()[1] - 44 });
  // Focus the remote article first. Native child-view focus must not cancel
  // interactive mode or make the chrome's physical toolbar stop receiving input.
  await mouse.clickPoint(wiki, { x: 150, y: 100 });
  await sample('remote article focused', wiki);
  {
    const beforeRefresh = requestCount;
    let reloadStarted = false;
    articleContents(wiki).once('did-start-loading', () => { reloadStarted = true; });
    await click(wiki, 'wiki-reload');
    await until(() => reloadStarted && !articleContents(wiki).isLoading(), 'native refresh request');
    if (!live) assert.ok(requestCount > beforeRefresh, 'Refresh reaches the fixture page');
    assert.equal(articleContents(wiki).getURL(), firstArticleURL);
  }
  await click(wiki, 'wiki-external');
  await until(() => externalPages.length === 1, 'external article button');
  assert.equal(externalPages[0], articleContents(wiki).getURL());
  wiki.webContents.send('theme-changed', { theme: 'dark-mint' });
  await until(() => wiki.webContents.executeJavaScript('document.documentElement.dataset.theme === "dark-mint"'), 'wiki chrome theme');
  wiki.maximize(); await pause(150); wiki.unmaximize();
  wiki.minimize(); await pause(150);
  // Minimizing any app window hides the complete overlay; restore it through
  // the registered visibility shortcut before submitting the next search.
  assert.equal(typeof toggleVisibility, 'function');
  toggleVisibility();
  foreground(process.pid);
  if (nativeForeground) await mouse.pressFocusChord();
  else toggleInteraction();
  await search('Bromius');
  const secondArticleURL = articleContents(wiki).getURL();
  await until(() => wiki.webContents.executeJavaScript('!document.getElementById("wiki-back").disabled'), 'back button');
  await click(wiki, 'wiki-back');
  await until(() => articleContents(wiki).getURL() === firstArticleURL, 'previous article');
  await until(() => wiki.webContents.executeJavaScript('!document.getElementById("wiki-forward").disabled'), 'forward button');
  await click(wiki, 'wiki-forward');
  await until(() => articleContents(wiki).getURL() === secondArticleURL, 'next article');
  const closedArticle = articleContents(wiki);
  await click(wiki, 'wiki-close');
  await until(() => !wikiWindow(), 'closed wiki');
  assert.equal(closedArticle.isDestroyed(), true, 'Closing chrome disposes the remote article');
  if (!live) {
    for (let i = 0; i < 20; i++) {
      await widget.webContents.executeJavaScript(`window.api.openWikiSearch('Closing search ${i}')`);
      const pending = await until(wikiWindow, 'pending wiki');
      // The native crash involved a mouse hit-test during view teardown.
      // Place the window under the cursor without moving the user's mouse.
      const cursor = screen.getCursorScreenPoint();
      pending.setBounds({ x: cursor.x - 150, y: cursor.y - 100, width: 500, height: 400 });
      pending.show();
      articleContents(pending).sendInputEvent({ type: 'mouseMove', x: 150, y: 56 });
      pending.close();
      await until(() => !wikiWindow(), 'cancelled search window');
    }
  }
  wiki = await search('Verminia');
  if (game) {
    // Returning to a game disarms chrome and panels, including a saved desktop
    // preference with click-through disabled. The next chord unlocks the wiki.
    if (nativeForeground) await mouse.pressFocusChord();
    else foreground(process.pid + 100000);
    await until(async () => !(await main.webContents.executeJavaScript('window.api.getState()')).overlayInteractive && !wiki.isFocusable(), 'passive game mouse policy');
    assert.equal(widget.isFocusable(), false, 'game lock applies to clickable widgets too');
    const beforePassive = externalPages.length;
    foreground(process.pid);
    if (nativeForeground) await mouse.pressFocusChord();
    else toggleInteraction();
    wiki.show(); wiki.focus();
    await mouse.clickPoint(wiki, { x: 150, y: 100 });
    await click(wiki, 'wiki-external');
    await until(() => externalPages.length === beforePassive + 1, 'chord unlocks native wiki control');
  }
  // Electron captures each WebContents surface separately, excluding siblings.
  // Save both actual surfaces and assert their native placement above.
  fs.writeFileSync(path.join(out, 'wiki-titlebar.png'), (await wiki.webContents.capturePage({ x: 0, y: 0, width: wiki.getContentSize()[0], height: 44 })).toPNG());
  fs.writeFileSync(path.join(out, 'wiki-article.png'), (await articleContents(wiki).capturePage()).toPNG());
  await pause(1000);
  assert.deepEqual(errors, []);
  for (const action of ['back', 'forward', 'reload', 'external', 'close']) {
    assert.ok(controlActions.some(call => call.action === action && call.accepted), 'Native toolbar action: ' + action);
  }
  assert.ok(controlActions.every(call => call.accepted), 'Every toolbar action comes from the trusted chrome');
  await mouse.close();
  const summary = { ok: true, live, game, clickableWidgets, nativeForeground, focusOnly, desktopOpen, nativeMouseControls: true,
    focusSamples, foregroundSamples, controlActions, appRoot, electron: process.versions.electron, out,
    locale: app.getLocale(), title: wiki.getTitle(), windows: BrowserWindow.getAllWindows().length,
    wikiConsoleErrors };
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  if (process.argv.includes('--inspect')) await pause(30000);
  app.exit(0);
}).catch(async error => { console.error(error.stack); console.error(JSON.stringify({ appRoot, controlActions,
  articles: BrowserWindow.getAllWindows().filter(win => articleContents(win)).map(win => ({ url: articleContents(win).getURL(),
    history: articleContents(win).navigationHistory.getAllEntries() })) })); await mouse?.close().catch(() => {}); app.exit(1); });
setTimeout(() => { console.error('Wiki search check timed out'); app.exit(1); }, 55000).unref();
