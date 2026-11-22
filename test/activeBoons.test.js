'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createActiveBoonsModel } = require('../src/modules/activeBoons');

const NOW = 1800000000000;
const BOON = '/SF/Types/Boosters/AffiliationBooster';
const OTHER = '/SF/Types/Boosters/ResourceBooster';
const read = (inventory, context = {}) => createActiveBoonsModel().read(inventory, { now: NOW, ...context });

test('active boons project their own fields and sort the soonest expiration first', () => {
  const snapshot = read({
    accountNonce: 'private-session-value',
    Boosters: [
      { ItemType: BOON, ExpiryDate: NOW / 1000 + 3600, secret: 'private-boon-field' },
      { ItemType: OTHER, ExpiryDate: String(NOW / 1000 + 30) },
    ],
  }, { names: { [BOON]: 'Affiliation blessing', [OTHER]: 'Gathering blessing' }, accountId: 'private-account-id' });
  assert.equal(snapshot.state, 'ready');
  assert.equal(snapshot.activeCount, 2);
  assert.equal(snapshot.expiredCount, 0);
  assert.deepEqual(snapshot.rows, [
    { id: OTHER, name: 'Gathering blessing', expiresAt: NOW + 30000, active: true },
    { id: BOON, name: 'Affiliation blessing', expiresAt: NOW + 3600000, active: true },
  ]);
  assert.equal(JSON.stringify(snapshot).includes('private-'), false);
});

test('expiration boundary is exclusive and ended records remain distinguishable', () => {
  const inventory = { Boosters: [
    { ItemType: BOON, ExpiryDate: NOW / 1000 },
    { ItemType: OTHER, ExpiryDate: NOW / 1000 - 1 },
  ] };
  const atBoundary = read(inventory);
  assert.equal(atBoundary.activeCount, 0);
  assert.equal(atBoundary.expiredCount, 2);
  assert.deepEqual(atBoundary.rows.map(row => row.id), [BOON, OTHER]);
  const beforeBoundary = read(inventory, { now: NOW - 1 });
  assert.equal(beforeBoundary.activeCount, 1);
  assert.equal(beforeBoundary.rows[0].id, BOON);
});

test('a missing boon list, explicit empty list and malformed list are different states', () => {
  assert.equal(read(null).state, 'unavailable');
  assert.equal(read({}).state, 'unavailable');
  assert.equal(read({ Boosters: [] }).state, 'empty');
  for (const value of [null, {}, '[]', 4]) {
    const snapshot = read({ Boosters: value });
    assert.equal(snapshot.state, 'unreadable');
    assert.equal(snapshot.unreadableCount, 1);
    assert.deepEqual(snapshot.rows, []);
  }
});

test('malformed expiration values never become zero-duration or permanent boons', () => {
  const invalid = [undefined, null, '', ' ', false, true, 0, -1, NaN, Infinity, 'Infinity', '1e10',
    NOW + 10000, { $date: NOW }, { $numberLong: String(NOW / 1000) }];
  const snapshot = read({ Boosters: invalid.map(ExpiryDate => ({ ItemType: BOON, ExpiryDate })) });
  assert.equal(snapshot.state, 'unreadable');
  assert.equal(snapshot.unreadableCount, invalid.length);
  assert.deepEqual(snapshot.rows, []);
});

test('valid numeric seconds accept whitespace and fractional seconds without rounding up', () => {
  const snapshot = read({ Boosters: [{ ItemType: BOON, ExpiryDate: ` ${NOW / 1000 + .123} ` }] });
  assert.equal(snapshot.rows[0].expiresAt, NOW + 123);
  assert.equal(snapshot.rows[0].active, true);
});

test('duplicate boon types keep the latest valid expiration without adding durations', () => {
  const inventory = { Boosters: [
    { ItemType: BOON, ExpiryDate: NOW / 1000 - 10 },
    { ItemType: BOON, ExpiryDate: NOW / 1000 + 100 },
    { ItemType: BOON, ExpiryDate: NOW / 1000 + 50 },
    { ItemType: BOON, ExpiryDate: NOW / 1000 + 100 },
    { ItemType: BOON, ExpiryDate: 'broken' },
  ] };
  const snapshot = read(inventory);
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0].expiresAt, NOW + 100000);
  assert.equal(snapshot.duplicateCount, 3);
  assert.equal(snapshot.unreadableCount, 1);
  assert.equal(snapshot.activeCount, 1);
});

test('a partial list keeps readable boons while reporting invalid records', () => {
  const snapshot = read({ Boosters: [null, 3, {}, { ItemType: '../outside', ExpiryDate: NOW / 1000 + 10 },
    { ItemType: BOON, ExpiryDate: NOW / 1000 + 10 }] });
  assert.equal(snapshot.state, 'ready');
  assert.equal(snapshot.unreadableCount, 4);
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0].name, 'Affiliation Booster');
});

test('the model neither mutates inventory nor retains rows across accounts', () => {
  const model = createActiveBoonsModel();
  const inventory = { Boosters: [{ ItemType: BOON, ExpiryDate: NOW / 1000 + 10 }] };
  const original = structuredClone(inventory);
  const first = model.read(inventory, { accountId: 'one', now: NOW });
  first.rows[0].name = 'edited projection';
  const next = model.read(inventory, { accountId: 'two', now: NOW + 10000 });
  assert.notEqual(next.rows[0].name, 'edited projection');
  assert.equal(next.rows[0].active, false);
  assert.deepEqual(model.read({}, { accountId: 'three' }).rows, []);
  assert.deepEqual(inventory, original);
});

function rendererHarness() {
  let options, repaintCount = 0;
  const node = (tag, className, text) => ({ tag, className, textContent: text, children: [], attributes: {},
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this.attributes[name] = value; },
  });
  const toolbar = node('div', 'toolbar');
  const button = (className, text, handler) => ({ ...node('button', className, text), click: handler });
  const context = { window: { InventoryWidgetUI: { mount(element, value) {
    options = value;
    const handle = { setLanguage() {}, destroy() {}, repaint() { repaintCount++; }, refresh() { throw new Error('must not fetch'); } };
    options.setup(toolbar, { node, button }, handle);
    return handle;
  } } }, Date };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/renderer/active-boons'), 'utf8'), context);
  context.window.ActiveBoonsWidget.mount({ classList: { add() {} } });
  return { options, node, get repaintCount() { return repaintCount; },
    render(snapshot, now = NOW) {
      const body = node('div', 'body');
      const tr = (_key, fallback, values = {}) => fallback.replace(/\{(\w+)\}/g, (token, name) => values[name] ?? token);
      options.render(body, snapshot, { node, button, number: String, language: 'en', now, tr });
      const rendered = node('div', 'rendered'); rendered.append(toolbar, body); return rendered;
    },
  };
}

const descendants = node => [node, ...node.children.flatMap(descendants)];

test('renderer moves a boon to ended locally when its expiration is reached', () => {
  const harness = rendererHarness();
  const snapshot = { ...read({ Boosters: [{ ItemType: BOON, ExpiryDate: NOW / 1000 + 1 }] }), status: 'live' };
  const before = descendants(harness.render(snapshot));
  assert.equal(before.find(node => node.className === 'boons-countdown').textContent, '00:00:01');
  const after = descendants(harness.render(snapshot, NOW + 1000));
  assert.equal(after.some(node => node.className === 'boons-countdown'), false);
  const toggle = after.find(node => node.className === 'boons-ended-toggle');
  assert.equal(toggle.textContent, 'Show ended (1)');
  toggle.click();
  assert.equal(harness.repaintCount, 1);
  const expanded = descendants(harness.render(snapshot, NOW + 1000));
  assert.equal(expanded.find(node => node.className === 'boons-ended-toggle'), toggle, 'the keyboard-focused control is not replaced by each paint');
  assert.equal(expanded.find(node => node.className === 'boons-state').textContent, 'Ended');
});

test('cached boon countdowns explicitly explain the source and do not run a polling interval', () => {
  const harness = rendererHarness();
  const snapshot = { ...read({ Boosters: [{ ItemType: BOON, ExpiryDate: NOW / 1000 + 86461 }] }), status: 'cached' };
  const nodes = descendants(harness.render(snapshot));
  assert.equal(nodes.find(node => node.className === 'boons-countdown').textContent, '1d 0h 1m');
  assert.ok(nodes.some(node => node.textContent?.includes('saved expiration times')));
  assert.equal(harness.options.tickMs, 1000);
});
