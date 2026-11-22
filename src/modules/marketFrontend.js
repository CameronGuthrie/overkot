'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { services } = require('./serviceConfig');
const { requestMarketFrontend } = require('./marketFrontendApi');

const MARKET_SCHEME = 'overkot-market';
const MARKET_ORIGIN = `${MARKET_SCHEME}://app`;
const INVENTORY_ASSETS = new Set(['market.js', 'market.css', 'theme.js', 'theme.css', 'icons.css', 'ui-icons.js', 'inventory-bridge.js', 'inventory-embedded.css', 'game-artwork-recovery.js']);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https: overkot-game-data: overkot-map-tiles://data/temper-icons/; font-src 'self' data: https://fonts.gstatic.com; connect-src 'none'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";

function isMarketUrl(value) {
  try { const url = new URL(value); return url.protocol === `${MARKET_SCHEME}:` && url.hostname === 'app' && !url.port && !url.username && !url.password; }
  catch { return false; }
}

function inside(root, pathname) {
  const file = path.resolve(root, '.' + pathname);
  const relative = path.relative(root, file);
  return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep) ? file : null;
}

function createMarketProtocolHandler({ uiRoot, rendererRoot, assetsRoot }) {
  return async request => {
    if (!isMarketUrl(request.url)) return new Response('Not found', { status: 404 });
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url).pathname); } catch { return new Response('Not found', { status: 404 }); }
    if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part === '..' || part === '.')) return new Response('Not found', { status: 404 });
    let file, inventory = false;
    if (pathname === '/inventory.html') { file = path.join(rendererRoot, 'market.html'); inventory = true; }
    else if (pathname.startsWith('/inventory-assets/')) {
      const name = pathname.slice('/inventory-assets/'.length);
      if (INVENTORY_ASSETS.has(name)) file = path.join(rendererRoot, name);
    } else if (pathname === '/modules/gameDataImages.js') file = path.join(rendererRoot, '../modules/gameDataImages.js');
    else if (pathname === '/overkot-icon.png') file = path.join(assetsRoot, 'overkot.png');
    else if (pathname === '/assets/icons/market-sack.svg') file = path.join(assetsRoot, 'icons', 'market-sack.svg');
    else {
      file = inside(uiRoot, pathname);
      // tinro uses history routing. Only document requests get the SPA fallback;
      // missing JS/CSS/images must remain real 404s.
      const route = !path.extname(pathname) || /^\/(?:envoys|i|listing|l|offer|o)\/[^/]+(?:\/.*)?$/.test(pathname);
      if ((!file || !fs.existsSync(file)) && route) file = path.join(uiRoot, 'index.html');
    }
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('Not found', { status: 404 });
    let body = await fs.promises.readFile(file);
    if (inventory) body = body.toString('utf8')
      .replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, '')
      .replace(/\s*<link rel="stylesheet" href="theme\.css">/i, '')
      // The embedded composer inherits the Market's own tokens through its
      // bridge. Standalone overlay appearance scripts have no protocol route.
      .replace(/\s*<script src="(?:theme\.js|motion\.js|\.\.\/modules\/appearance\.js)"><\/script>/gi, '')
      .replace('../../assets/overkot.png', '/overkot-icon.png')
      .replace('<head>', '<head><base href="/inventory-assets/"><script src="inventory-bridge.js"></script>')
      .replace('</head>', '<link rel="stylesheet" href="inventory-embedded.css"></head>')
      .replace('<body>', '<body class="inventory-embedded">');
    else if (file === path.join(uiRoot, 'index.html')) {
      body = body.toString('utf8').replace('</head>', '<script src="/inventory-assets/game-artwork-recovery.js" defer></script></head>');
    }
    return new Response(body, { headers: { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' } });
  };
}

function accountConnectionState(state = {}) {
  return { signedIn: state.signedIn === true, authorizing: state.authorizing === true, busy: state.busy === true,
    connected: state.connected === true, requiresReconnect: state.requiresReconnect === true, requiresLink: state.requiresLink === true,
    error: typeof state.error === 'string' ? state.error : '',
    account: state.account ? { displayName: typeof state.account.displayName === 'string' ? state.account.displayName : '' } : null };
}

function marketFrontendState(market, connection = {}) {
  const snapshot = market.snapshot();
  return { ...snapshot, websiteAvailable: !!services.marketWebsite, accountConnection: accountConnectionState({ ...connection, ...snapshot.accountConnection }) };
}

function registerMarketFrontendIpc({ ipcMain, market, getWindow, getAppearance = () => ({}),
  getConnectionState = () => ({}), openAccountSettings = () => ({ ok: false, error: 'UNAVAILABLE' }) }) {
  const trusted = event => {
    const window = getWindow();
    return window && !window.isDestroyed() && event.sender === window.webContents
      && event.senderFrame === window.webContents.mainFrame && isMarketUrl(event.senderFrame.url);
  };
  ipcMain.handle('market-frontend:request', (event, value) => trusted(event)
    ? requestMarketFrontend(market, value)
    : { status: 403, body: { error: { code: 'FORBIDDEN', message: 'Open the Market window to continue.' } } });
  const actions = {
    state: () => marketFrontendState(market, getConnectionState()), refresh: () => market.refresh(), login: value => market.login(value),
    'avakot-login': value => market.loginWithAvakot(value), 'avakot-cancel': () => market.cancelAvakotLogin(),
    logout: () => market.sharedAccount ? openAccountSettings() : market.logout(), browse: value => market.browse(value), create: value => market.createListing(value),
    update: value => market.updateListing(value), 'copy-contact': value => market.copyContact(value), website: value => market.openWebsite(value),
    appearance: () => ({ config: getAppearance() }), close: () => getWindow().close(),
    'account-settings': () => openAccountSettings(),
  };
  ipcMain.handle('market-frontend:action', (event, action, value) => {
    if (!trusted(event) || !Object.hasOwn(actions, action)) return { ok: false, error: 'FORBIDDEN' };
    return actions[action](value);
  });
}

function configureMarketNavigation(window, openExternal) {
  const external = value => {
    try { const url = new URL(value); if (url.protocol === 'https:' && !url.username && !url.password) void openExternal(url.href); } catch {}
  };
  window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (!isMarketUrl(url)) { event.preventDefault(); external(url); } });
  window.webContents.on('will-frame-navigate', details => {
    if (!isMarketUrl(details.url)) { details.preventDefault(); if (details.isMainFrame) external(details.url); }
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
}

module.exports = { MARKET_SCHEME, MARKET_ORIGIN, isMarketUrl, createMarketProtocolHandler, registerMarketFrontendIpc,
  configureMarketNavigation, accountConnectionState, marketFrontendState };
