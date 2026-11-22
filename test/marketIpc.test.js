const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isMarketFrame, registerMarketIpc, marketWindowBounds } = require('../src/modules/marketIpc');
const root = path.resolve(__dirname, '../src/renderer');
const event = name => ({ senderFrame: { url: pathToFileURL(path.join(root, name)).href } });

test('market IPC only accepts local app frames and limits mutations to the market page', () => {
  assert.equal(isMarketFrame(event('market.html'), root, true), true);
  assert.equal(isMarketFrame(event('widget-host.html'), root), true);
  assert.equal(isMarketFrame(event('widget-host.html'), root, true), false);
  for (const value of [event('../market.html'), event('settings.html'), { senderFrame: { url: 'https://avakot.market/market.html' } }, {}]) assert.equal(isMarketFrame(value, root), false);
  const handlers = {}, calls = [];
  registerMarketIpc({ ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; }, on: (channel, fn) => { handlers[channel] = fn; } },
    rendererRoot: root, openWindow: () => calls.push('open'), market: { createListing: draft => calls.push(draft), snapshot: () => ({ authenticated: false }) } });
  assert.equal(handlers['market:create'](event('widget-host.html'), {}).error, 'FORBIDDEN');
  handlers['market:create'](event('market.html'), { quantity: 1 }); assert.deepEqual(calls, [{ quantity: 1 }]);
  assert.deepEqual(handlers['market:state'](event('widget-host.html')), { authenticated: false });
});

test('market bounds recover missing and off-screen saved displays', () => {
  const screen = { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }) };
  assert.deepEqual(marketWindowBounds(null, screen), { x: 160, y: 0, width: 960, height: 720 });
  assert.deepEqual(marketWindowBounds({ x: 5000, y: -100, width: 2000, height: 3000 }, screen), { x: 0, y: 0, width: 1280, height: 720 });
});

test('Settings can view, open and sign out of Market without listing or credential access', () => {
  const handlers = {}, calls = [];
  registerMarketIpc({ ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; }, on: (channel, fn) => { handlers[channel] = fn; } },
    rendererRoot: root, openWindow: () => calls.push('open'), market: {
      snapshot: () => ({ authenticated: true }), logout: () => calls.push('logout'),
    } });
  const settings = event('settings.html');
  assert.deepEqual(handlers['market:state'](settings), { authenticated: true });
  handlers['market:open'](settings); handlers['market:logout'](settings);
  assert.deepEqual(calls, ['open', 'logout']);
  for (const action of ['login', 'avakot-login', 'avakot-cancel', 'create', 'update', 'browse', 'refresh', 'website']) {
    assert.equal(handlers['market:' + action](settings, {}).error, 'FORBIDDEN');
  }
});
