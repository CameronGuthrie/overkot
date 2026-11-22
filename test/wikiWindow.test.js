const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');

const flush = () => new Promise(resolve => setImmediate(resolve));
function setup(ready = Promise.resolve(), rendererRoot, services = { wikiWebsite: 'https://wiki.avakot.org', storageScope: '' }) {
  const handlers = new Map(), external = [];
  const wikiSession = { setUserAgent() {}, clearCache: () => ready };
  class Contents extends EventEmitter {
    constructor(options = {}) {
      super(); this.options = options; this.urls = []; this.messages = []; this.mainFrame = { url: '' };
      this.session = options.session || {};
      this.history = []; this.historyIndex = -1;
      this.navigationHistory = {
        canGoBack: () => this.historyIndex > 0,
        canGoForward: () => this.historyIndex < this.history.length - 1,
        goBack: () => this.commit(this.history[--this.historyIndex]),
        goForward: () => this.commit(this.history[++this.historyIndex]),
      };
    }
    getURL() { return this.currentURL || this.urls.at(-1) || ''; }
    isDestroyed() { return !!this.destroyed; }
    openDevTools() {}
    setWindowOpenHandler(handler) { this.openHandler = handler; }
    send(channel, data) { this.messages.push({ channel, data }); }
    close() { this.destroyed = true; this.closeCount = (this.closeCount || 0) + 1; }
    commit(url) {
      this.currentURL = url;
      this.emit('did-start-navigation', {}, url, false, true);
      this.emit('did-navigate', {}, url);
      this.emit('did-finish-load');
      this.emit('did-stop-loading');
    }
    reload() { this.reloadCount = (this.reloadCount || 0) + 1; this.commit(this.getURL()); }
    reloadIgnoringCache() { this.hardReloadCount = (this.hardReloadCount || 0) + 1; this.commit(this.getURL()); }
    async loadURL(url) {
      this.urls.push(url); this.currentURL = url;
      this.emit('did-start-navigation', {}, url, false, true);
      if (this.failure) throw this.failure;
      this.history.splice(this.historyIndex + 1);
      this.history.push(url); this.historyIndex++;
      this.emit('did-navigate', {}, url);
      this.emit('did-finish-load');
      this.emit('did-stop-loading');
    }
  }
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.visible = false;
      this.webContents = new Contents(options.webPreferences);
      this.contentView = { addChildView: view => { this.view = view; }, removeChildView: view => { this.removedView = view; } };
    }
    setMenu(value) { this.menu = value; }
    isDestroyed() { return !!this.destroyed; }
    isMinimized() { return !!this.minimized; }
    restore() { this.minimized = false; }
    show() { this.visible = true; }
    focus() { this.focusCount = (this.focusCount || 0) + 1; }
    setAlwaysOnTop() {}
    getContentSize() { return [this.options.width, this.options.height]; }
    async loadFile(file) { this.file = file; this.webContents.mainFrame.url = pathToFileURL(file).href; this.webContents.emit('did-finish-load'); }
    close() { this.emit('close'); this.destroyed = true; this.emit('closed'); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  class View {
    constructor(options) { this.options = options; this.webContents = new Contents(options.webPreferences); }
    setBounds(bounds) { this.bounds = bounds; }
    setVisible(visible) { this.visible = visible; }
  }
  const context = { module: { exports: {} }, URL, __dirname: path.join(__dirname, '../src/modules'), process: { versions: { chrome: '144.0.0.0' } },
    require: name => name === 'electron' ? { BrowserWindow: Window, WebContentsView: View,
      session: { fromPartition: () => wikiSession }, ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      shell: { openExternal: async url => { external.push(url); } } } : name === './serviceConfig' ? { services } : name.startsWith('./') ? require('../src/modules/' + name.slice(2)) : require(name) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/modules/wikiWindow.js'), 'utf8'), context);
  const api = context.module.exports;
  const win = api.createWikiBrowser({ bounds: { width: 900, height: 700 }, icon: '', rendererRoot, getConfig: () => ({ theme: 'ember', password: 'never exposed' }) });
  if (!win) return { ...api, win, handlers, external };
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  return { ...api, win, contents: api.getWikiWebContents(win), handlers, event, external };
}

test('a missing wiki stays offline and a configured wiki uses its own origin and session', async () => {
  const disabled = setup(undefined, undefined, { storageScope: 'community' });
  assert.equal(disabled.win, null);
  assert.equal(disabled.handlers.size, 0);
  const fork = setup(undefined, undefined, { wikiWebsite: 'https://wiki.example.org', storageScope: 'community' });
  assert.equal(fork.wikiPartition, 'persist:wiki-community');
  fork.loadWikiSearch(fork.win, 'item');
  await flush();
  assert.deepEqual(fork.contents.urls, ['https://wiki.example.org/w/index.php?title=Special:Search&search=item']);
});

test('wiki chrome and remote article are isolated, correctly sized, and search reveals content', async () => {
  const { win, contents, loadWikiSearch } = setup();
  loadWikiSearch(win, 'Garren & Rood'); await flush();
  assert.deepEqual(contents.urls, ['https://wiki.avakot.org/w/index.php?title=Special:Search&search=Garren%20%26%20Rood']);
  assert.equal(win.visible, true);
  assert.equal(win.menu, null);
  assert.equal(win.options.frame, false);
  assert.match(win.file, /wiki-window\.html$/);
  assert.match(win.options.webPreferences.preload, /wiki-preload\.js$/);
  assert.equal(contents.options.preload, undefined);
  assert.equal(contents.options.nodeIntegration, false);
  assert.equal(contents.options.contextIsolation, true);
  assert.equal(contents.options.sandbox, true);
  assert.equal(JSON.stringify(win.view.bounds), JSON.stringify({ x: 0, y: 44, width: 900, height: 656 }));
  win.options.width = 500; win.emit('resize');
  assert.equal(win.view.bounds.width, 500);
});

test('only the latest search navigates after cache preparation and closed windows stay closed', async () => {
  let release;
  const { win, contents, loadWikiSearch } = setup(new Promise(resolve => { release = resolve; }));
  loadWikiSearch(win, 'Orlick'); loadWikiSearch(win, 'Bromius');
  release(); await flush();
  assert.equal(contents.urls.length, 1);
  assert.ok(contents.urls[0].endsWith('search=Bromius'));
  win.close();
  loadWikiSearch(win, 'Verminia'); await flush();
  assert.equal(contents.urls.length, 1);
  assert.equal(contents.closeCount, 1);
  assert.equal(win.removedView, win.view);
});

test('subframe failures and stale failed searches cannot hide the current article', async () => {
  const { win, contents, loadWikiSearch } = setup();
  loadWikiSearch(win, 'Orlick'); await flush();
  contents.emit('did-fail-load', {}, -105, 'DNS failure', 'https://widget.invalid/', false);
  contents.emit('did-fail-load', {}, -105, 'Old search failure', 'https://wiki.avakot.org/Old', true);
  assert.equal(win.view.visible, true);
  assert.equal(contents.urls.length, 1);
});

test('main document failure shows the local retry state without navigating to a data page', async () => {
  const { win, contents, loadWikiSearch, handlers, event } = setup();
  contents.failure = Object.assign(new Error('<unavailable>'), { code: 'ERR_NAME_NOT_RESOLVED' });
  loadWikiSearch(win, 'Orlick'); await flush();
  const state = handlers.get('wiki:state')(event);
  assert.equal(state.error, '<unavailable>');
  assert.equal(win.view.visible, false);
  assert.equal(contents.urls.length, 1);
  assert.equal(win.visible, true);
  contents.failure = null;
  await handlers.get('wiki:action')(event, 'reload'); await flush();
  assert.equal(win.view.visible, true);
  assert.equal(handlers.get('wiki:state')(event).error, '');
});

test('native hard refresh and external button use the current article and restore minimized searches', async () => {
  const { win, contents, loadWikiSearch, handlers, event, external } = setup();
  win.minimized = true;
  loadWikiSearch(win, 'Orlick'); await flush();
  assert.equal(win.minimized, false);
  contents.currentURL = 'https://wiki.avakot.org/Bromius';
  let prevented = false;
  contents.emit('before-input-event', { preventDefault: () => { prevented = true; } },
    { type: 'keyDown', control: true, shift: true, key: 'R' });
  await flush();
  assert.equal(prevented, true);
  assert.equal(contents.hardReloadCount, 1);
  assert.equal(contents.getURL(), 'https://wiki.avakot.org/Bromius');
  await handlers.get('wiki:action')(event, 'external');
  assert.deepEqual(external, ['https://wiki.avakot.org/Bromius']);
});

test('refresh preserves forward history and F5 works with either chrome or article focused', async () => {
  const { win, contents, loadWikiSearch, handlers, event } = setup();
  loadWikiSearch(win, 'Orlick'); await flush();
  loadWikiSearch(win, 'Bromius'); await flush();
  await handlers.get('wiki:action')(event, 'back');
  assert.ok(contents.getURL().endsWith('search=Orlick'));
  assert.equal(handlers.get('wiki:state')(event).canGoForward, true);
  await handlers.get('wiki:action')(event, 'reload');
  assert.equal(contents.reloadCount, 1);
  assert.equal(contents.urls.length, 2, 'refresh does not start a new URL navigation');
  assert.equal(handlers.get('wiki:state')(event).canGoForward, true);
  let prevented = 0;
  const inputEvent = { preventDefault() { prevented++; } };
  win.webContents.emit('before-input-event', inputEvent, { type: 'keyDown', key: 'F5' });
  contents.emit('before-input-event', inputEvent, { type: 'keyDown', key: 'F5', shift: true });
  assert.equal(prevented, 2);
  assert.equal(contents.reloadCount, 2);
  assert.equal(contents.hardReloadCount, 1);
  await handlers.get('wiki:action')(event, 'forward');
  assert.ok(contents.getURL().endsWith('search=Bromius'));
});

test('history navigation supersedes a pending search and its late failure', async () => {
  const { win, contents, loadWikiSearch, handlers, event } = setup();
  loadWikiSearch(win, 'Orlick'); await flush();
  loadWikiSearch(win, 'Bromius'); await flush();
  let rejectSearch;
  contents.loadURL = url => {
    contents.emit('did-start-navigation', {}, url, false, true);
    return new Promise((_resolve, reject) => { rejectSearch = reject; });
  };
  loadWikiSearch(win, 'Verminia'); await flush();
  await handlers.get('wiki:action')(event, 'back');
  rejectSearch(Object.assign(new Error('Late search failure'), { code: 'ERR_NAME_NOT_RESOLVED' }));
  await flush();
  const state = handlers.get('wiki:state')(event);
  assert.ok(state.url.endsWith('search=Orlick'));
  assert.equal(state.error, '');
  assert.equal(win.view.visible, true);
  assert.equal(state.canGoForward, true);
});

test('same-document history navigation restores an article after an error without a full load event', async () => {
  const { win, contents, loadWikiSearch, handlers, event } = setup();
  loadWikiSearch(win, 'Orlick'); await flush();
  loadWikiSearch(win, 'Bromius'); await flush();
  contents.failure = Object.assign(new Error('Offline'), { code: 'ERR_NAME_NOT_RESOLVED' });
  loadWikiSearch(win, 'Verminia'); await flush();
  assert.equal(win.view.visible, false);
  contents.navigationHistory.goBack = () => {
    contents.currentURL = 'https://wiki.avakot.org/Orlick#Lore';
    contents.emit('did-navigate-in-page', {}, contents.currentURL, true);
  };
  await handlers.get('wiki:action')(event, 'back');
  const state = handlers.get('wiki:state')(event);
  assert.equal(state.error, '');
  assert.equal(state.loading, false);
  assert.equal(state.url, 'https://wiki.avakot.org/Orlick#Lore');
  assert.equal(win.view.visible, true);
});

test('navigation completion and failure never take focus back after the search request', async () => {
  let release;
  const { win, contents, loadWikiSearch } = setup(new Promise(resolve => { release = resolve; }));
  loadWikiSearch(win, 'Orlick');
  assert.equal(win.focusCount, 1, 'the explicit search activates synchronously');
  release(); await flush();
  win.emit('ready-to-show');
  assert.equal(win.focusCount, 1, 'loading the article and chrome do not reactivate');
  contents.failure = Object.assign(new Error('Offline'), { code: 'ERR_NAME_NOT_RESOLVED' });
  loadWikiSearch(win, 'Bromius');
  assert.equal(win.focusCount, 2);
  await flush();
  assert.equal(win.focusCount, 2, 'a delayed error does not reactivate');
});

test('retry while a new search is queued keeps the requested search instead of the previous article', async () => {
  const { win, contents, loadWikiSearch, handlers, event } = setup();
  loadWikiSearch(win, 'Orlick'); await flush();
  loadWikiSearch(win, 'Bromius');
  await handlers.get('wiki:action')(event, 'reload'); await flush();
  assert.ok(contents.getURL().endsWith('search=Bromius'));
  assert.equal(contents.urls.length, 2);
});

test('wiki IPC accepts only its local main frame and exposes only theme configuration', async () => {
  const { win, contents, handlers, event } = setup();
  assert.equal(handlers.get('wiki:state')(event).config.password, undefined);
  assert.equal(handlers.get('wiki:state')(event).config.theme, 'ember');
  assert.equal(await handlers.get('wiki:action')({ sender: contents, senderFrame: contents.mainFrame }, 'close'), false);
  assert.equal(await handlers.get('wiki:action')({ sender: win.webContents, senderFrame: { url: event.senderFrame.url } }, 'close'), false);
  assert.equal(await handlers.get('wiki:action')(event, 'https://attacker.test'), false);
  assert.equal(win.isDestroyed(), false);
});

test('portable wiki controls accept Chromium and Node spellings of short-path file URLs', async () => {
  const rendererRoot = path.join(path.parse(__dirname).root, 'Users', 'ADMIN~1.WOR', 'AppData', 'Local', 'Temp',
    'Overkot portable #1 %', 'resources', 'app.asar', 'src', 'renderer');
  for (const spelling of ['encoded', 'literal tilde', 'lowercase escape']) {
    const { win, contents, handlers, event, external, loadWikiSearch } = setup(Promise.resolve(), rendererRoot);
    const encoded = pathToFileURL(win.file).href.replace(/~/g, '%7E');
    // Electron's actual portable frame uses ADMIN~1.WOR while Node's
    // pathToFileURL produces ADMIN%7E1.WOR. Both name the same local file.
    event.senderFrame.url = spelling === 'encoded' ? encoded : encoded.replace(/%7E/g, spelling === 'literal tilde' ? '~' : '%7e');
    assert.equal(handlers.get('wiki:state')(event).config?.theme, 'ember', spelling + ': trusted state');
    loadWikiSearch(win, 'First'); await flush();
    loadWikiSearch(win, 'Second'); await flush();
    assert.equal(await handlers.get('wiki:action')(event, 'back'), true, spelling + ': back');
    assert.ok(contents.getURL().endsWith('search=First'));
    assert.equal(await handlers.get('wiki:action')(event, 'forward'), true, spelling + ': forward');
    assert.ok(contents.getURL().endsWith('search=Second'));
    assert.equal(await handlers.get('wiki:action')(event, 'reload'), true, spelling + ': refresh');
    assert.equal(contents.reloadCount, 1);
    assert.equal(await handlers.get('wiki:action')(event, 'external'), true, spelling + ': browser');
    assert.deepEqual(external, [contents.getURL()]);
    assert.equal(await handlers.get('wiki:action')(event, 'close'), true, spelling + ': close');
    assert.equal(win.isDestroyed(), true);
    assert.equal(contents.closeCount, 1);
  }
});

test('wiki IPC rejects another document and invalid URL spellings despite a known main-frame sender', async () => {
  const rendererRoot = path.join(path.parse(__dirname).root, 'Users', 'ADMIN~1.WOR', 'Temp', 'resources', 'app.asar', 'src', 'renderer');
  const { win, handlers, event } = setup(Promise.resolve(), rendererRoot);
  const trusted = pathToFileURL(win.file).href.replace(/~/g, '%7E');
  for (const url of [
    'https://wiki.avakot.org/', 'javascript:void(0)', 'not a URL', 'file:///%ZZ',
    trusted.replace('wiki-window.html', 'settings.html'), trusted + '?untrusted=1', trusted + '#untrusted',
    trusted.replace(/%7E/g, '%257E'),
  ]) {
    event.senderFrame.url = url;
    assert.equal(handlers.get('wiki:state')(event).error, 'Wiki window is unavailable.', url);
    assert.equal(await handlers.get('wiki:action')(event, 'close'), false, url);
    assert.equal(win.isDestroyed(), false, url);
  }
});

test('navigation keeps wiki links in-app, opens web links externally, and blocks other protocols', async () => {
  const { win, contents, external } = setup();
  let prevented = false;
  const event = { preventDefault: () => { prevented = true; } };
  contents.emit('will-navigate', event, 'https://wiki.avakot.org/Orlick');
  assert.equal(prevented, false);
  contents.emit('will-navigate', event, 'https://example.com/article');
  assert.equal(prevented, true);
  assert.deepEqual(external, ['https://example.com/article']);
  contents.openHandler({ url: 'file:///C:/secret' });
  contents.openHandler({ url: 'javascript:alert(1)' });
  assert.equal(external.length, 1);
  contents.openHandler({ url: 'https://wiki.avakot.org/Bromius' }); await flush();
  assert.equal(contents.urls.at(-1), 'https://wiki.avakot.org/Bromius');
  prevented = false;
  win.webContents.emit('will-navigate', event, 'https://wiki.avakot.org/');
  assert.equal(prevented, true, 'The local chrome cannot be replaced by remote content');
});

test('forced destruction also closes the child WebContents once', () => {
  const { win, contents } = setup();
  win.destroy();
  assert.equal(contents.closeCount, 1);
});
