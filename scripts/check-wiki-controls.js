// Exercise native wiki controls independently of game discovery and dock state.
// Build the unpacked app first; --source uses current source in its runtime.
'use strict';
if (!process.versions.electron) {
  // SW_HIDE suppresses the first native ShowWindow even when Electron emits
  // "show". This GUI fixture must use normal Windows startup visibility.
  const result = require('./run-packaged-check').runPackagedCheck(__filename, process.argv.slice(2), 45000, { windowsHide: false });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, globalShortcut, session, shell } = require('electron');
const { createNativeMouse } = require('./windows-native-mouse');
const root = path.resolve(__dirname, '..');
const source = process.argv.includes('--source');
const packagedRoot = path.resolve(process.env.OVERKOT_PACKAGED_DIRECTORY || path.join(root, 'dist', 'win-unpacked'));
const appRoot = source ? root : path.join(packagedRoot, 'resources', 'app.asar');
const out = fs.mkdtempSync(path.join(root, 'output', 'wiki-controls-'));
require('./wiki-test-profile').configureWikiTestProfile(out);
app.setPath('userData', path.join(out, 'profile'));
// Keep the fixture alive after Close so teardown assertions and the summary
// cannot be skipped by Electron's default last-window shutdown.
app.on('window-all-closed', () => {});
// The release build bundles this factory into main.js, so it is not a separate
// module in the archive. Exercise its source with the packaged chrome/runtime;
// check-wiki-search.js covers the bundled factory through the real app IPC.
let mouse;
async function fail(error) {
  console.error(error.stack);
  await mouse?.close().catch(() => {});
  app.exit(1);
}
process.on('uncaughtException', error => { void fail(error); });
process.on('unhandledRejection', error => { void fail(error); });
const { wikiPartition, createWikiBrowser, loadWikiSearch, getWikiWebContents } = require(path.join(root, 'src', 'modules', 'wikiWindow'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await fn();
    if (value) return value;
    await pause(25);
  }
  throw new Error('Timed out: ' + label);
}

app.whenReady().then(async () => {
  const external = [], errors = [];
  let releaseRequest, failOffline = true, requestCount = 0;
  shell.openExternal = async url => { external.push(url); };
  session.fromPartition(wikiPartition).protocol.handle('https', async request => {
    requestCount++;
    const query = new URL(request.url).searchParams.get('search');
    if (query === 'Slow' || (query === 'Offline' && failOffline)) {
      await new Promise(resolve => { releaseRequest = resolve; });
    }
    if (query === 'Offline' && failOffline) return Response.error();
    return new Response('<!doctype html><title>Wiki fixture</title><h1>' + query + '</h1>',
      { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
  });
  const win = createWikiBrowser({ bounds: { width: 900, height: 700 }, rendererRoot: path.join(appRoot, 'src', 'renderer') });
  mouse = await createNativeMouse();
  // A real registered hotkey grants Windows foreground permission once. Do
  // not refocus the chrome before each click: article focus and native
  // draggable-region hit testing are the behavior under test.
  assert.equal(globalShortcut.register('Control+Shift+F23', () => {
    win.show(); win.moveTop(); win.focus();
  }), true, 'fixture foreground shortcut');
  app.once('will-quit', () => { void mouse.close().catch(() => {}); });
  await mouse.pressDesktopChord();
  await until(async () => win.isVisible() && win.isFocused() &&
    await mouse.foregroundPid() === process.pid, 'native fixture foreground');
  const contents = getWikiWebContents(win);
  const view = win.contentView.children.find(child => child.webContents === contents);
  for (const surface of [contents, win.webContents]) {
    surface.on('render-process-gone', (_event, details) => errors.push(details));
    surface.on('console-message', ({ message, sourceId, lineNumber }) => {
      if (/Uncaught|Error invoking|ReferenceError|TypeError/.test(message)) errors.push({ message, sourceId, lineNumber });
    });
  }
  const state = async () => {
    const value = await win.webContents.executeJavaScript('window.wikiChrome.getState()');
    assert.notEqual(value.error, 'Wiki window is unavailable.', `Toolbar IPC rejected ${win.webContents.getURL()} loaded from ${appRoot}`);
    return value;
  };
  async function settled(url) {
    await until(async () => contents.getURL() === url && !contents.isLoading() &&
      !(await state()).loading && view.getVisible(), 'settled article: ' + url);
  }
  async function search(query) {
    loadWikiSearch(win, query);
    const url = 'https://wiki.example.test/w/index.php?title=Special:Search&search=' + query;
    await settled(url);
    await until(() => win.isVisible() && win.isFocused(), 'visible focused wiki search');
    return url;
  }
  async function click(id) {
    assert.equal(win.isVisible(), true, 'visible control: ' + id);
    await mouse.click(win, id);
  }
  async function focusArticle() {
    await mouse.clickPoint(win, { x: 120, y: 100 });
    await until(() => contents.isFocused(), 'native article focus');
  }
  async function refresh(url) {
    const beforeRequest = requestCount;
    await click('wiki-reload');
    await until(() => requestCount > beforeRequest, 'refresh request');
    await settled(url);
  }
  const first = await search('First'), second = await search('Second');
  await focusArticle();
  await until(async () => (await state()).canGoBack, 'enabled Back');
  await click('wiki-back'); await settled(first);
  const beforeRefresh = contents.navigationHistory.getAllEntries().map(entry => entry.url);
  contents.setZoomFactor(1.25);
  await until(() => contents.getZoomFactor() === 1.25, 'article zoom');
  await focusArticle();
  await refresh(first);
  assert.deepEqual(contents.navigationHistory.getAllEntries().map(entry => entry.url), beforeRefresh);
  win.setSize(760, 620);
  await until(() => win.getSize()[0] === 760 && view.getBounds().width === win.getContentSize()[0], 'resized article');
  await focusArticle();
  await until(async () => (await state()).canGoForward, 'enabled Forward');
  await click('wiki-forward'); await settled(second);
  win.maximize();
  await until(() => win.isMaximized() && view.getBounds().width === win.getContentSize()[0], 'maximized article');
  await focusArticle();
  await click('wiki-external');
  await until(() => external.length === 1, 'external browser request');
  assert.equal(external[0], second);
  win.unmaximize();
  await until(() => !win.isMaximized() && view.getBounds().width === win.getContentSize()[0], 'restored article');
  await focusArticle();
  await refresh(second);
  for (const surface of [win.webContents, contents]) {
    const count = requestCount;
    surface.sendInputEvent({ type: 'keyDown', keyCode: 'F5', modifiers: ['shift'] });
    surface.sendInputEvent({ type: 'keyUp', keyCode: 'F5', modifiers: ['shift'] });
    await until(() => requestCount > count, 'Shift+F5 from either surface'); await settled(second);
  }
  const third = await search('Third');
  await focusArticle();
  await refresh(third);
  await contents.executeJavaScript('location.hash = "Lore"', true);
  await settled(third + '#Lore');
  await focusArticle();
  await click('wiki-back'); await settled(third);
  await focusArticle();
  await click('wiki-forward'); await settled(third + '#Lore');
  fs.writeFileSync(path.join(out, 'wiki-controls.png'), (await win.webContents.capturePage({ x: 0, y: 0, width: win.getContentSize()[0], height: 44 })).toPNG());
  fs.writeFileSync(path.join(out, 'wiki-article.png'), (await contents.capturePage()).toPNG());

  const other = new BrowserWindow({ width: 200, height: 200 });
  await other.loadURL('data:text/html,<title>Focus fixture</title>');
  for (const query of ['Slow', 'Offline']) {
    releaseRequest = null;
    loadWikiSearch(win, query);
    await until(() => releaseRequest, 'delayed request: ' + query);
    other.show(); other.focus();
    await until(() => other.isFocused(), 'other window focus');
    releaseRequest();
    if (query === 'Slow') await settled('https://wiki.example.test/w/index.php?title=Special:Search&search=Slow');
    else await until(async () => (await state()).error, 'offline error');
    await pause(75);
    assert.equal(other.isFocused(), true, query + ' completion must preserve the other window focus');
  }
  assert.equal(view.getVisible(), false);
  fs.writeFileSync(path.join(out, 'wiki-error.png'), (await win.webContents.capturePage()).toPNG());
  await click('wiki-error-external');
  await until(() => external.length === 2, 'error external browser request');
  assert.equal(external[1], 'https://wiki.example.test/w/index.php?title=Special:Search&search=Offline');
  failOffline = false;
  await click('wiki-retry');
  await settled('https://wiki.example.test/w/index.php?title=Special:Search&search=Offline');
  assert.equal((await state()).error, '');
  other.close();
  await focusArticle();
  await click('wiki-close');
  await until(() => win.isDestroyed(), 'close control');
  assert.equal(contents.isDestroyed(), true);
  assert.deepEqual(errors, []);
  await mouse.close();
  globalShortcut.unregister('Control+Shift+F23');
  const summary = { ok: true, source, serviceSource: 'source', rendererSource: source ? 'source' : 'packaged', electron: process.versions.electron,
    nativeMouseControls: true, nativeVisibilityAndFocus: true, articleFocusPreserved: true,
    articleZoom: 1.25, resizeAndMaximize: true, repeatedSearch: true,
    historyAndRefresh: true, delayedFocusPreserved: true, out };
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  app.exit(0);
}).catch(fail);
setTimeout(() => { void fail(new Error('Wiki controls check timed out')); }, 40000).unref();
