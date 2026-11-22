'use strict';

process.env.OVERKOT_SERVICES_FILE = '';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { MARKET_ORIGIN, isMarketUrl, createMarketProtocolHandler, registerMarketFrontendIpc, accountConnectionState } = require('../src/modules/marketFrontend');

function protocolFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-market-protocol-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const uiRoot = path.join(root, 'ui'), rendererRoot = path.join(root, 'renderer'), assetsRoot = path.join(root, 'assets');
  for (const directory of [uiRoot, rendererRoot, assetsRoot]) fs.mkdirSync(directory);
  fs.mkdirSync(path.join(uiRoot, 'assets'));
  fs.writeFileSync(path.join(uiRoot, 'index.html'), '<!doctype html><head><title>Market fixture</title></head>');
  fs.writeFileSync(path.join(uiRoot, 'assets', 'app.js'), '/* frontend fixture */');
  fs.writeFileSync(path.join(rendererRoot, 'market.html'), '<html><head><meta http-equiv="Content-Security-Policy" content="base-uri \'none\'"><link rel="stylesheet" href="theme.css"><link rel="stylesheet" href="market.css"><script src="../modules/appearance.js"></script><script src="theme.js"></script><script src="motion.js"></script></head><body><img src="../../assets/overkot.png">Inventory fixture<script src="market.js"></script></body></html>');
  fs.writeFileSync(path.join(rendererRoot, 'market.js'), '/* inventory fixture */');
  fs.writeFileSync(path.join(rendererRoot, 'game-artwork-recovery.js'), '/* artwork fixture */');
  fs.writeFileSync(path.join(rendererRoot, 'inventory-bridge.js'), '/* embedded theme bridge */');
  fs.writeFileSync(path.join(rendererRoot, 'preload.js'), 'PRIVATE PRELOAD');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'PRIVATE FILE');
  fs.writeFileSync(path.join(assetsRoot, 'overkot.png'), Buffer.from([137, 80, 78, 71]));
  const handler = createMarketProtocolHandler({ uiRoot, rendererRoot, assetsRoot });
  return value => handler({ url: value.startsWith('/') ? MARKET_ORIGIN + value : value });
}

test('market URL accepts only the dedicated app origin', () => {
  for (const value of [MARKET_ORIGIN, MARKET_ORIGIN + '/overkot-inventory?view=list']) assert.equal(isMarketUrl(value), true);
  for (const value of ['https://app/', 'file:///market.html', 'overkot-market://other/', 'overkot-market://app.evil/',
    'overkot-market://user:password@app/', 'overkot-market://app:443/', 'not a URL', null]) assert.equal(isMarketUrl(value), false, String(value));
});

test('protocol serves built assets and history routes with a restrictive CSP', async t => {
  const request = protocolFixture(t);
  for (const value of ['/', '/overkot-inventory', '/envoys/test-envoy', '/envoys/test.envoy/history', '/i/test.item', '/settings?section=profile']) {
    const response = await request(value);
    assert.equal(response.status, 200, value);
    const html = await response.text();
    assert.match(html, /Market fixture/);
    assert.match(html, /src="\/inventory-assets\/game-artwork-recovery\.js"/);
    assert.equal(response.headers.get('content-type'), 'text/html');
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /(?:^|;\s*)script-src 'self'(?:;|$)/);
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /frame-src 'self'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
  const asset = await request('/assets/app.js');
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('content-type'), 'text/javascript');
  assert.equal(await asset.text(), '/* frontend fixture */');
  assert.equal(await (await request('/inventory-assets/game-artwork-recovery.js')).text(), '/* artwork fixture */');
});

test('protocol keeps missing assets as 404s instead of returning the SPA', async t => {
  const request = protocolFixture(t);
  for (const value of ['/assets/missing.js', '/missing.css', '/missing.png', '/inventory-assets/preload.js', '/inventory-assets/nested/market.js']) {
    const response = await request(value);
    assert.equal(response.status, 404, value);
    assert.equal(await response.text(), 'Not found');
  }
});

test('protocol rejects encoded traversal, malformed escaping, backslashes and foreign origins', async t => {
  const request = protocolFixture(t);
  for (const value of ['/%2e%2e%2fsecret.txt', '/%2f..%2fsecret.txt', '/assets%5c..%5c..%5csecret.txt',
    '/%00secret.txt', '/%E0%A4%A', '/inventory-assets/%2e%2e%2fpreload.js',
    'https://app/index.html', 'overkot-market://evil/index.html', 'overkot-market://user@app/index.html']) {
    const response = await request(value);
    assert.equal(response.status, 404, value);
    assert.doesNotMatch(await response.text(), /PRIVATE/);
  }
});

test('inventory document receives only its allowlisted assets and embedded bridge', async t => {
  const request = protocolFixture(t);
  const document = await request('/inventory.html');
  assert.equal(document.status, 200);
  const source = await document.text();
  assert.match(document.headers.get('Content-Security-Policy'), /overkot-map-tiles:\/\/data\/temper-icons\//);
  assert.match(source, /<base href="\/inventory-assets\/">/);
  assert.match(source, /<script src="inventory-bridge\.js"><\/script>/);
  assert.match(source, /<body class="inventory-embedded">/);
  assert.doesNotMatch(source, /http-equiv="Content-Security-Policy"/);
  assert.doesNotMatch(source, /(?:href="theme\.css"|src="(?:theme\.js|motion\.js|\.\.\/modules\/appearance\.js)")/);
  assert.ok(source.indexOf('href="inventory-embedded.css"') > source.indexOf('href="market.css"'), 'Market integration overrides load after legacy styles');
  assert.match(source, /src="\/overkot-icon\.png"/);
  assert.equal((await request('/inventory-assets/market.js')).status, 200);
  const scriptUrls = [...source.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => new URL(match[1], MARKET_ORIGIN + '/inventory-assets/').href);
  assert.equal(scriptUrls.length, 2, 'Only the embedded bridge and inventory composer remain');
  for (const url of scriptUrls) assert.equal((await request(url)).status, 200, 'Embedded scripts must have an allowlisted protocol route: ' + url);
  assert.equal((await request('/overkot-icon.png')).headers.get('content-type'), 'image/png');
});

test('the inventory document serves its scripts and resolves protected thumbnails and temper icons', async () => {
  const handler = createMarketProtocolHandler({ uiRoot: path.join(__dirname, 'fixtures'),
    rendererRoot: path.join(__dirname, '../src/renderer'), assetsRoot: path.join(__dirname, '../assets') });
  const document = await handler({ url: MARKET_ORIGIN + '/inventory.html' });
  const source = await document.text();
  const scripts = [...source.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)]
    .map(match => new URL(match[1], MARKET_ORIGIN + '/inventory-assets/').href);
  assert.ok(scripts.some(url => url.endsWith('/ui-icons.js')));
  assert.ok(scripts.includes(MARKET_ORIGIN + '/inventory-assets/game-artwork-recovery.js'));
  const helper = MARKET_ORIGIN + '/modules/gameDataImages.js';
  assert.ok(scripts.indexOf(helper) >= 0 && scripts.indexOf(helper) < scripts.indexOf(MARKET_ORIGIN + '/inventory-assets/market.js'));
  const context = { URL };
  vm.runInNewContext(await (await handler({ url: helper })).text(), context);
  const item = '/SF/Interface/Graphics/StoreItems/Currency/ArcsBundleSmall.png';
  const temper = '/SF/Interface/Graphics/Aspects/Ode/Crush.png';
  for (const artwork of [item, temper]) {
    const url = 'overkot-game-data://images' + artwork;
    assert.equal(context.GameDataImages.marketImageUrl(url), url);
    assert.equal(context.GameDataImages.marketImageUrl('https://avakot.market/api/v1/data-assets' + artwork), url);
  }
  assert.equal(context.GameDataImages.marketImageUrl('https://example.com/item.png'), 'https://example.com/item.png');
  const key = 'temper-icons/' + 'e'.repeat(64) + '.png';
  assert.equal(context.GameDataImages.temperIconUrl(key), 'overkot-map-tiles://data/' + key);
  assert.equal(context.GameDataImages.temperIconUrl('old.webp'), null);
  for (const invalid of ['file:///private.png', 'overkot-game-data://other' + item, 'overkot-game-data://images/unlisted.png']) {
    assert.equal(context.GameDataImages.marketImageUrl(invalid), '');
  }
  for (const url of scripts) {
    const response = await handler({ url });
    assert.equal(response.status, 200, url);
    assert.equal(response.headers.get('content-type'), 'text/javascript');
  }
  assert.equal((await handler({ url: MARKET_ORIGIN + '/inventory-assets/preload.js' })).status, 404);
});

function ipcFixture() {
  const handlers = {}, calls = [];
  const mainFrame = { url: MARKET_ORIGIN + '/' };
  const contents = { mainFrame };
  let destroyed = false, currentWindow = true;
  const window = { webContents: contents, isDestroyed: () => destroyed, close: () => calls.push('close') };
  const market = { generation: 0, snapshot: () => ({ authenticated: false }),
    initialize: async () => {}, request: async route => { calls.push(route); return { data: [] }; },
    createListing: draft => { calls.push(draft); return { ok: true }; } };
  registerMarketFrontendIpc({ ipcMain: { handle: (channel, handler) => { handlers[channel] = handler; } },
    market, getWindow: () => currentWindow ? window : null, getAppearance: () => ({ theme: 'dark-mint' }),
    getConnectionState: () => ({ signedIn: true, account: { displayName: 'Envoy', email: 'private@example.com' }, token: 'SECRET' }),
    openAccountSettings: () => { calls.push('connections'); return { ok: true }; } });
  return { handlers, calls, mainFrame, contents, event: { sender: contents, senderFrame: mainFrame },
    destroy: () => { destroyed = true; }, remove: () => { currentWindow = false; } };
}

test('frontend IPC accepts the exact trusted main frame and its limited actions', async () => {
  const fixture = ipcFixture();
  const action = fixture.handlers['market-frontend:action'];
  assert.deepEqual(action(fixture.event, 'state'), { authenticated: false, websiteAvailable: false,
    accountConnection: accountConnectionState({ signedIn: true, account: { displayName: 'Envoy' } }) });
  assert.doesNotMatch(JSON.stringify(action(fixture.event, 'state')), /SECRET|private@example/);
  assert.deepEqual(action(fixture.event, 'account-settings'), { ok: true });
  assert.deepEqual(action(fixture.event, 'appearance'), { config: { theme: 'dark-mint' } });
  assert.deepEqual(action(fixture.event, 'create', { rowKey: 'fixture', quantity: 1 }), { ok: true });
  const result = await fixture.handlers['market-frontend:request'](fixture.event, { path: '/v1/listings/recent' });
  assert.equal(result.status, 200);
  assert.deepEqual(fixture.calls, ['connections', { rowKey: 'fixture', quantity: 1 }, 'listings/recent']);
  for (const name of ['__proto__', 'constructor', 'arbitrary-file-read']) assert.deepEqual(action(fixture.event, name), { ok: false, error: 'FORBIDDEN' });
});

test('frontend IPC denies child frames, other windows, replaced frames and navigated origins', async () => {
  const fixture = ipcFixture();
  const events = [{}, { sender: fixture.contents },
    { sender: {}, senderFrame: fixture.mainFrame },
    { sender: fixture.contents, senderFrame: { url: fixture.mainFrame.url } },
    { sender: fixture.contents, senderFrame: { url: MARKET_ORIGIN + '/inventory.html', parent: fixture.mainFrame } }];
  for (const event of events) {
    assert.deepEqual(fixture.handlers['market-frontend:action'](event, 'create', {}), { ok: false, error: 'FORBIDDEN' });
    assert.equal((await fixture.handlers['market-frontend:request'](event, { path: '/v1/me' })).status, 403);
  }
  fixture.mainFrame.url = 'https://avakot.market/';
  assert.deepEqual(fixture.handlers['market-frontend:action'](fixture.event, 'state'), { ok: false, error: 'FORBIDDEN' });
  assert.equal((await fixture.handlers['market-frontend:request'](fixture.event, { path: '/v1/me' })).status, 403);
  assert.deepEqual(fixture.calls, []);
});

test('frontend IPC denies closed or absent Market windows', async () => {
  for (const method of ['destroy', 'remove']) {
    const fixture = ipcFixture();
    fixture[method]();
    assert.deepEqual(fixture.handlers['market-frontend:action'](fixture.event, 'state'), { ok: false, error: 'FORBIDDEN' });
    assert.equal((await fixture.handlers['market-frontend:request'](fixture.event, { path: '/v1/me' })).status, 403);
    assert.deepEqual(fixture.calls, []);
  }
});
