'use strict';

const { BrowserWindow, WebContentsView, session, ipcMain, shell } = require('electron');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const Appearance = require('./appearance');
const { windowMessages } = require('./localization');
const chromeLabels = ['wikiWidget', 'wikiControls', 'wikiBack', 'wikiForward', 'wikiExternal', 'wikiReload',
  'wikiClose', 'wikiLoadFailed', 'wikiOpening', 'wikiLoading', 'wikiRetry', 'wikiOpenBrowser'];

const { services } = require('./serviceConfig');
const WIKI_ORIGIN = services.wikiWebsite;
const wikiPartition = services.storageScope ? `persist:wiki-${services.storageScope}` : 'persist:wiki';
const CHROME_HEIGHT = 44;
const searches = new WeakMap();
const chromeWindows = new Map();
let ipcRegistered = false;
const searchURL = query => `${WIKI_ORIGIN}/w/index.php?title=Special:Search&search=${encodeURIComponent(query || '')}`;
function isWikiURL(value) {
  try { const url = new URL(value); return url.origin === WIKI_ORIGIN && !url.username && !url.password; } catch { return false; }
}
function isExternalURL(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}
function reveal(win) {
  if (win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.focus();
}
function snapshot(win) {
  const state = searches.get(win), contents = state.view.webContents;
  const config = state.getConfig?.() || {};
  return {
    config: Appearance.appearanceConfig(config),
    ...windowMessages(config.language, chromeLabels),
    url: state.url, loading: state.loading, error: state.error,
    canGoBack: !contents.isDestroyed() && contents.navigationHistory.canGoBack(),
    canGoForward: !contents.isDestroyed() && contents.navigationHistory.canGoForward(),
  };
}
function update(win) {
  if (win.isDestroyed()) return;
  const state = searches.get(win);
  if (!state || state.disposed) return;
  win.webContents.send('wiki:changed', snapshot(win));
}
function showError(win, message) {
  if (win.isDestroyed()) return;
  const state = searches.get(win);
  state.error = message || 'The wiki could not be reached. Check your connection and try again.';
  state.loading = false;
  state.view.setVisible(false);
  update(win);
}
function navigate(win, url) {
  const state = searches.get(win);
  if (!state || state.disposed || win.isDestroyed() || !isWikiURL(url)) return;
  const attempt = ++state.attempt;
  state.url = url;
  state.loading = true;
  state.error = '';
  update(win);
  // Rapid searches share cache preparation; only the latest request navigates.
  state.ready.then(async () => {
    if (win.isDestroyed() || state.disposed || state.attempt !== attempt) return;
    try {
      await state.view.webContents.loadURL(url);
    } catch (error) {
      if (win.isDestroyed() || state.disposed || state.attempt !== attempt || error.code === 'ERR_ABORTED' || error.errno === -3) return;
      showError(win, error.message);
    }
  }).catch(() => {});
}
function reload(win, hard = false) {
  const state = searches.get(win);
  if (!state || state.disposed || win.isDestroyed()) return;
  const contents = state.view.webContents, current = contents.getURL();
  // Retry an unfinished/failed search rather than reloading the old article
  // still displayed underneath it. A committed article uses native reload so
  // Chromium retains its history, scroll position and reload semantics.
  if (state.loading || state.error || !isWikiURL(current)) {
    if (hard) state.ready = state.ready.then(() => contents.session.clearCache()).catch(() => {});
    navigate(win, state.url || searchURL(''));
    return;
  }
  state.attempt++;
  state.url = current;
  state.error = '';
  state.loading = true;
  update(win);
  if (hard) contents.reloadIgnoringCache();
  else contents.reload();
}
function moveHistory(win, direction) {
  const state = searches.get(win);
  if (!state || state.disposed || win.isDestroyed()) return false;
  const contents = state.view.webContents, history = contents.navigationHistory;
  if (direction === 'back' ? !history.canGoBack() : !history.canGoForward()) return false;
  // A history action supersedes queued searches and their late failures.
  state.attempt++;
  const current = contents.getURL();
  if (isWikiURL(current)) state.url = current;
  state.error = '';
  state.loading = false;
  update(win);
  if (direction === 'back') history.goBack();
  else history.goForward();
  return true;
}
function windowForEvent(event) {
  const win = chromeWindows.get(event.sender);
  if (!win || win.isDestroyed() || event.senderFrame !== event.sender.mainFrame) return null;
  try {
    const url = new URL(event.senderFrame.url);
    if (url.search || url.hash) return null;
    // Chromium leaves '~' literal in Windows short paths; Node's
    // pathToFileURL encodes it as %7E. Compare the decoded local filename so
    // a portable extracted under ADMIN~1 has the same trusted toolbar.
    return path.relative(searches.get(win).chromeFile, fileURLToPath(url)) === '' ? win : null;
  } catch { return null; }
}
function registerChromeIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.handle('wiki:state', event => {
    const win = windowForEvent(event);
    return win ? snapshot(win) : { error: 'Wiki window is unavailable.' };
  });
  ipcMain.handle('wiki:action', async (event, action) => {
    const win = windowForEvent(event);
    if (!win) return false;
    const state = searches.get(win), contents = state.view.webContents;
    if (action === 'close') win.close();
    else if (action === 'reload') reload(win);
    else if (action === 'back' || action === 'forward') return moveHistory(win, action);
    else if (action === 'external') {
      // The renderer supplies an action, never an arbitrary URL or shell command.
      const current = contents.getURL();
      const url = isWikiURL(current) && !state.error ? current : state.url;
      if (isWikiURL(url)) await shell.openExternal(url);
      else return false;
    } else return false;
    return true;
  });
}

function createWikiBrowser({ bounds, icon, rendererRoot = path.join(__dirname, '..', 'renderer'), getConfig = () => ({}) }) {
  if (!WIKI_ORIGIN) return null;
  registerChromeIpc();
  const wikiSession = session.fromPartition(wikiPartition);
  wikiSession.setUserAgent(`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`);
  // The local chrome alone has a small preload. Remote wiki pages retain their
  // own session and CSP, with no Node access or app bridge.
  const win = new BrowserWindow({
    ...bounds, icon, frame: false, resizable: true, show: false, alwaysOnTop: false,
    minWidth: 500, minHeight: 400, title: 'Wiki Search · Overkot', backgroundColor: '#1b1b1b',
    paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(rendererRoot, 'wiki-preload.js'), backgroundThrottling: false },
  });
  const view = new WebContentsView({ webPreferences: {
    contextIsolation: true, nodeIntegration: false, sandbox: true, session: wikiSession, backgroundThrottling: false,
  } });
  const chromeFile = path.join(rendererRoot, 'wiki-window.html');
  const state = { view, attempt: 0, url: '', error: '', loading: true, disposed: false,
    chromeFile, getConfig, ready: wikiSession.clearCache().catch(() => {}) };
  const chromeContents = win.webContents;
  searches.set(win, state);
  chromeWindows.set(win.webContents, win);
  win.setMenu(null);
  win.contentView.addChildView(view);
  view.setVisible(false);
  const layout = () => {
    if (win.isDestroyed() || state.disposed) return;
    const [width, height] = win.getContentSize();
    view.setBounds({ x: 0, y: CHROME_HEIGHT, width, height: Math.max(0, height - CHROME_HEIGHT) });
  };
  layout();
  win.on('resize', layout);
  // Child WebContents must be closed explicitly. Removing the child before its
  // WebContents closes also prevents hit-tests reaching a view during teardown.
  const dispose = () => {
    if (state.disposed) return;
    state.disposed = true;
    state.attempt++;
    chromeWindows.delete(chromeContents);
    if (!win.isDestroyed()) win.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  };
  win.on('close', dispose);
  win.on('closed', dispose); // Also handles callers using destroy().
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('did-finish-load', () => update(win));
  win.loadFile(chromeFile).catch(() => { if (!win.isDestroyed()) win.close(); });

  const contents = view.webContents;
  const allowNavigation = (event, url) => {
    if (isWikiURL(url)) return;
    event.preventDefault();
    if (isExternalURL(url)) shell.openExternal(url).catch(() => {});
  };
  contents.on('will-navigate', allowNavigation);
  contents.on('will-redirect', (event, url, _inPlace, mainFrame) => {
    if (mainFrame && !isWikiURL(url)) event.preventDefault();
    else if (mainFrame) state.url = url;
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isWikiURL(url)) navigate(win, url);
    else if (isExternalURL(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  contents.on('did-start-loading', () => { state.loading = true; update(win); });
  contents.on('did-start-navigation', (_event, url, inPlace, mainFrame) => {
    if (mainFrame && isWikiURL(url)) {
      state.url = url;
      state.error = '';
      state.loading = !inPlace;
      update(win);
    }
  });
  contents.on('did-stop-loading', () => { state.loading = false; update(win); });
  contents.on('did-navigate', (_event, url) => { if (isWikiURL(url)) state.url = url; update(win); });
  contents.on('did-navigate-in-page', (_event, url, mainFrame) => {
    if (mainFrame && isWikiURL(url)) {
      state.url = url;
      state.error = '';
      state.loading = false;
      view.setVisible(true);
    }
    update(win);
  });
  contents.on('did-finish-load', () => {
    if (win.isDestroyed() || state.disposed || !isWikiURL(contents.getURL())) return;
    state.error = '';
    state.loading = false;
    view.setVisible(true);
    update(win);
  });
  contents.on('did-fail-load', (_event, code, description, url, mainFrame) => {
    if (mainFrame && code !== -3 && !state.disposed && url === state.url) showError(win, description);
  });
  const shortcuts = (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if ((input.control && key === 'r') || key === 'f5') { event.preventDefault(); reload(win, input.shift); }
    else if (input.control && input.shift && key === 'i') { event.preventDefault(); contents.openDevTools({ mode: 'detach' }); }
    else if (input.alt && ['left', 'arrowleft'].includes(key) && moveHistory(win, 'back')) event.preventDefault();
    else if (input.alt && ['right', 'arrowright'].includes(key) && moveHistory(win, 'forward')) event.preventDefault();
  };
  contents.on('before-input-event', shortcuts);
  win.webContents.on('before-input-event', shortcuts);
  return win;
}

function loadWikiSearch(win, query) {
  const state = searches.get(win);
  if (!state || state.disposed || win.isDestroyed()) return;
  navigate(win, searchURL(query));
  // Focus belongs to the user's search request, never its later completion.
  // Otherwise a slow article or error takes focus back from the game.
  reveal(win);
}
function getWikiWebContents(win) { return searches.get(win)?.view.webContents || null; }

module.exports = { wikiPartition, createWikiBrowser, loadWikiSearch, getWikiWebContents };
