'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountWalletModel } = require('../src/modules/accountWallet');
test('wallet reports exact balances including zero without combining free premium funds', () => {
  const data = createAccountWalletModel().read({ RegularCredits: 14500, PremiumCredits: 12, PremiumCreditsFree: 50, TradesRemaining: 0, Nonce: 'private' });
  assert.deepEqual(data.rows.map(row => row.value), [14500, 12, 0]);
  assert.equal(data.available, 3); assert.equal(JSON.stringify(data).includes('private'), false);
});
test('wallet distinguishes unavailable and malformed values from actual zero', () => {
  const model = createAccountWalletModel();
  assert.equal(model.read(null).available, 0);
  for (const value of [undefined, null, '', '12', -1, NaN, Infinity, .5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(model.read({ RegularCredits: value }).rows[0].value, null);
  }
  assert.equal(model.read({ RegularCredits: 0 }).rows[0].value, 0);
});
