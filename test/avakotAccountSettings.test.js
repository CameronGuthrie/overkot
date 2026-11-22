'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '../src/renderer/settings.js'), 'utf8');

function settings(api = {}) {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { textContent: '', hidden: false, disabled: false, dataset: {} });
    return elements.get(selector);
  };
  const context = vm.createContext({ document: { querySelector: element, addEventListener() {} }, window: { api }, setTimeout, clearTimeout });
  vm.runInContext(script, context);
  return { element, run: code => vm.runInContext(code, context),
    state(value) { context.nextState = value; vm.runInContext('avakotAccountState = nextState; renderAvakotAccount();', context); } };
}

test('remembered credentials that fail to restore offer retry and sign-out', async () => {
  let resolve, retries = 0;
  const ui = settings({ avakotAccountLogin: () => { retries++; return new Promise(done => { resolve = done; }); } });
  ui.state({ hasCredential: true, signedIn: false, sessionPersistent: true, error: 'Connection unavailable.' });
  assert.equal(ui.element('#btn-avakot-account-login').textContent, 'Retry connection');
  assert.equal(ui.element('#btn-avakot-account-logout').hidden, false);
  assert.equal(ui.element('#btn-avakot-account-logout').disabled, false);
  assert.match(ui.element('#avakot-account-status').textContent, /saved sign-in could not be restored/);
  const work = ui.run("changeAvakotAccount('login')");
  assert.equal(retries, 1);
  assert.equal(ui.element('#btn-avakot-account-login').disabled, true);
  assert.equal(ui.element('#btn-avakot-account-cancel').hidden, true, 'Retry must not pretend a browser authorization is pending');
  assert.match(ui.element('#avakot-account-status').textContent, /Restoring/);
  resolve({ ok: true, state: { hasCredential: true, signedIn: true, account: { email: 'envoy@example.com' } } });
  await work;
  assert.equal(ui.element('#avakot-account-details').hidden, false);
  assert.equal(ui.element('#btn-avakot-account-login').hidden, true);
});

test('game status stays distinct from account sign-in and identity is rendered as text', () => {
  const ui = settings();
  const state = { signedIn: true, hasCredential: true, account: { email: 'envoy@example.com', displayName: '<Envoy>' }, game: { online: false, displayName: 'Resolved Envoy' } };
  ui.state(state);
  assert.equal(ui.element('#avakot-account-game-status').textContent, 'Offline');
  assert.equal(ui.element('#avakot-account-name').textContent, '<Envoy>');
  assert.equal(ui.element('#avakot-account-game-name').textContent, 'Resolved Envoy');
  assert.match(ui.element('#avakot-account-session-hint').textContent, /session only/);
  ui.state({ ...state, game: { ...state.game, online: true } });
  assert.equal(ui.element('#avakot-account-game-status').textContent, 'Online');
});

test('cancelling pending browser sign-in ignores a late login response', async () => {
  let finish;
  const ui = settings({
    avakotAccountLogin: () => new Promise(resolve => { finish = resolve; }),
    avakotAccountCancel: async () => ({ ok: true, state: { signedIn: false, hasCredential: false } }),
  });
  ui.state({ signedIn: false });
  const work = ui.run("changeAvakotAccount('login')");
  assert.equal(ui.element('#btn-avakot-account-cancel').hidden, false);
  assert.equal(ui.element('#btn-avakot-account-cancel').disabled, false);
  await ui.run("changeAvakotAccount('cancel')");
  finish({ ok: false, message: 'Stale error', state: { signedIn: true, hasCredential: true } });
  await work;
  assert.equal(ui.element('#avakot-account-details').hidden, true);
  assert.equal(ui.element('#btn-avakot-account-login').hidden, false);
  assert.equal(ui.element('#avakot-account-error').hidden, true);
});

test('legacy account connections offer a reconnect action for explicit Market approval', async () => {
  let reconnects = 0;
  const ui = settings({ avakotAccountReconnect: async () => { reconnects++; return { ok: true, state: { authorizing: true } }; } });
  ui.state({ signedIn: true, hasCredential: true, marketSignIn: false });
  assert.equal(ui.element('#btn-avakot-account-reconnect').hidden, false);
  await ui.run("changeAvakotAccount('reconnect')");
  assert.equal(reconnects, 1);
  assert.equal(ui.element('#btn-avakot-account-cancel').hidden, false);
  ui.state({ signedIn: true, marketSignIn: true });
  assert.equal(ui.element('#btn-avakot-account-reconnect').hidden, true);
});
