'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerAvakotAccountIpc, isAvakotAccountSettingsFrame, publicAvakotAccountState } = require('../src/modules/avakotAccountIpc');
const root = path.resolve(__dirname, '../src/renderer');
function event(page = 'settings.html') {
  const frame = { url: pathToFileURL(path.join(root, page)).href };
  return { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false } };
}
function register(account) {
  const handlers = {};
  registerAvakotAccountIpc({ ipcMain: { handle: (name, handler) => { handlers[name] = handler; } }, account, rendererRoot: root });
  return handlers;
}

test('Avakot Account IPC accepts only the local Settings main frame', async () => {
  const remote = event(); remote.senderFrame.url = 'https://account.avakot.dev/settings.html';
  const nested = event(); nested.senderFrame = { url: nested.senderFrame.url };
  const destroyed = event(); destroyed.sender.isDestroyed = () => true;
  const disallowed = [remote, nested, destroyed, {}, { senderFrame: event().senderFrame }, event('market.html'), event('index.html'), event('../settings.html')];
  let calls = 0;
  const service = Object.fromEntries(['snapshot', 'signIn', 'cancelSignIn', 'signOut', 'openAccount', 'reconnect'].map(name => [name, () => { calls++; return {}; }]));
  const handlers = register(service);
  assert.equal(isAvakotAccountSettingsFrame(event(), root), true);
  for (const value of disallowed) {
    assert.equal(isAvakotAccountSettingsFrame(value, root), false);
    for (const handler of Object.values(handlers)) assert.equal((await handler(value)).ok, false);
  }
  assert.equal(calls, 0);
  for (const handler of Object.values(handlers)) await handler(event());
  assert.equal(calls, 11); // Five actions refresh the public snapshot.
});

test('state and action results expose only account identity and game status', async () => {
  const snapshot = {
    signedIn: true, hasCredential: true, busy: false, authorizing: false, accessToken: 'secret-access', refreshToken: 'secret-refresh',
    account: { email: 'envoy@example.com', displayName: 'Envoy', passwordHash: 'secret-hash' },
    game: { online: true, accountId: 'soulframe-id', displayName: 'Soulframe Envoy', inventory: { private: true } },
    sessionPersistent: true, marketSignIn: true, error: '',
  };
  const expected = {
    signedIn: true, hasCredential: true, busy: false, authorizing: false,
    account: { email: 'envoy@example.com', displayName: 'Envoy' },
    game: { online: true, accountId: 'soulframe-id', displayName: 'Soulframe Envoy' },
    sessionPersistent: true, marketSignIn: true, error: '',
  };
  const calls = [];
  const service = { snapshot: () => snapshot };
  for (const name of ['signIn', 'cancelSignIn', 'signOut', 'openAccount', 'reconnect']) {
    service[name] = (...args) => { calls.push([name, args]); return { ok: true, state: snapshot, accessToken: 'secret-access' }; };
  }
  const handlers = register(service);
  assert.deepEqual(await handlers['avakot-account:state'](event()), expected);
  for (const action of ['login', 'cancel', 'logout', 'open', 'reconnect']) {
    assert.deepEqual(await handlers['avakot-account:' + action](event(), { redirectUri: 'https://evil.example', online: true }), { ok: true, state: expected });
  }
  assert.deepEqual(calls, ['signIn', 'cancelSignIn', 'signOut', 'openAccount', 'reconnect'].map(name => [name, []]));
  assert.equal(publicAvakotAccountState({ game: { online: 'true' } }).game.online, false);
});

test('sign-in remains cancellable and exceptions do not reveal credentials', async () => {
  let finish;
  const handlers = register({
    snapshot: () => ({ signedIn: false }),
    signIn: () => new Promise(resolve => { finish = resolve; }),
    cancelSignIn: () => { finish({ ok: false, message: 'Sign-in cancelled.' }); return { ok: true }; },
    signOut: () => { throw new Error('secret-token'); },
  });
  const signIn = handlers['avakot-account:login'](event());
  assert.equal((await handlers['avakot-account:cancel'](event())).ok, true);
  assert.equal((await signIn).message, 'Sign-in cancelled.');
  const failure = await handlers['avakot-account:logout'](event());
  assert.equal(failure.ok, false);
  assert.doesNotMatch(JSON.stringify(failure), /secret-token/);
});
