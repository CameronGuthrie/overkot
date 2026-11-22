'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createEquipmentProgressModel, WEAPON_MASTERY_XP } = require('../src/modules/equipmentProgress');
const sword = '/SF/Weapons/Melee/FixtureSword';
const bow = '/SF/Weapons/Bows/FixtureBow';
const pact = '/SF/Souls/FixtureSoul';
const unknownWeapon = '/SF/Weapons/Unknown/Fixture';
const fixtureCatalog = { items: [sword, bow, pact, unknownWeapon].map(itemType => ({ itemType })) };
const read = (inventory, context) => createEquipmentProgressModel({ getCatalog: () => fixtureCatalog }).read(inventory, context);

test('equipment merges historical XP and owned copies by highest XP without adding duplicate totals', () => {
  const inventory = { XPInfo: [{ ItemType: sword, XP: WEAPON_MASTERY_XP }, { ItemType: sword, XP: 1000 }],
    Melee: [{ ItemType: sword, XP: 0 }, { ItemType: sword, XP: 1000 }, { ItemType: sword, XP: 1000 }] };
  const before = JSON.stringify(inventory);
  const value = read(inventory, { names: { [sword]: 'Fixture sword' } });
  assert.equal(value.rows.length, 1);
  assert.equal(value.rows[0].name, 'Fixture sword');
  assert.equal(value.rows[0].xp, WEAPON_MASTERY_XP);
  assert.equal(value.rows[0].recordedXP, WEAPON_MASTERY_XP);
  assert.equal(value.rows[0].ownedXP, 1000);
  assert.equal(value.rows[0].mastered, true);
  assert.equal(value.rows[0].owned, true);
  assert.equal(value.rows[0].recorded, true);
  assert.deepEqual(value.summary, { total: 1, owned: 1, recorded: 1, masteredWeapons: 1 });
  assert.equal(JSON.stringify(inventory), before);
});

test('equipment output omits types absent the approved catalogue even when present in inventory', () => {
  const unreleased = '/SF/Weapons/Melee/PrivateFixture';
  const value = read({ XPInfo: [{ ItemType: unreleased, XP: 999999 }],
    Melee: [{ ItemType: unreleased, XP: 999999 }, { ItemType: sword, XP: 112500 }] },
  { names: { [unreleased]: 'Private name' } });
  assert.deepEqual(value.rows.map(row => row.itemType), [sword]);
  assert.equal(value.rows[0].mastered, true); assert.equal(value.untrackedEquipment, 1);
  assert.doesNotMatch(JSON.stringify(value), /PrivateFixture|Private name/);
});

test('historical equipment remains listed without claiming ownership and owned-only entries stay distinct', () => {
  const value = read({ XPInfo: [{ ItemType: sword, XP: 123 }], Melee: [], LongGuns: [{ ItemType: bow, XP: 456 }] });
  const historical = value.rows.find(row => row.id === sword.toLowerCase());
  const owned = value.rows.find(row => row.id === bow.toLowerCase());
  assert.equal(historical.owned, false);
  assert.equal(historical.recorded, true);
  assert.equal(historical.ownedXP, null);
  assert.equal(owned.recorded, false);
  assert.equal(owned.owned, true);
  assert.equal(owned.category, 'ranged');
  assert.equal(owned.xp, 456);
});

test('omitted or incomplete ownership sections leave historical ownership unknown until a complete observation', () => {
  for (const section of [undefined, null, {}, [null], [{ ItemType: pact }]]) {
    const value = read({ XPInfo: [{ ItemType: sword, XP: 123 }], Melee: section });
    assert.equal(value.rows[0].owned, null);
    assert.ok(value.ownershipUnavailableSections.includes('Melee'));
    assert.equal(value.summary.owned, 0);
  }
  assert.equal(read({ XPInfo: [{ ItemType: sword, XP: 123 }], Melee: [] }).rows[0].owned, false);
  assert.equal(read({ XPInfo: [{ ItemType: sword, XP: 123 }], Melee: [null, { ItemType: sword }] }).rows[0].owned, true,
    'A known owned copy remains positive evidence even when another record is malformed');
  assert.equal(read({ XPInfo: [{ ItemType: sword, XP: 123 }], Melee: [], LongGuns: null }).rows[0].owned, false,
    'An unrelated missing category does not hide complete melee ownership evidence');
});

test('zero XP is valid, missing XP is unavailable, and Pact or unclassified weapon ranks are never inferred', () => {
  const value = read({ XPInfo: [{ ItemType: pact, XP: 9000000 }, { ItemType: '/SF/Weapons/Unknown/Fixture', XP: 9000000 }],
    Suits: [{ ItemType: pact }], Melee: [{ ItemType: sword, XP: 0 }], LongGuns: [{ ItemType: bow }] });
  assert.equal(value.rows.find(row => row.id === sword.toLowerCase()).xp, 0);
  assert.equal(value.rows.find(row => row.id === bow.toLowerCase()).xp, null);
  for (const row of value.rows.filter(row => ['pact', 'weapon'].includes(row.category))) {
    assert.equal(row.masteryTarget, null); assert.equal(row.mastered, null);
  }
  assert.equal(value.summary.masteredWeapons, 0);
  assert.equal(value.unreadableRecords, 0);
});

test('weapon threshold matches existing exporter while intermediate levels are absent', () => {
  for (const [xp, mastered] of [[WEAPON_MASTERY_XP - 1, false], [WEAPON_MASTERY_XP, true], [WEAPON_MASTERY_XP + 1, true]]) {
    const row = read({ Melee: [{ ItemType: sword, XP: xp }] }).rows[0];
    assert.equal(row.mastered, mastered); assert.equal(row.masteryTarget, 112500);
    assert.equal('rank' in row, false); assert.equal('level' in row, false);
  }
});

test('Player equipment reads its mastery boundary from the supplied S3 table', () => {
  const model = createEquipmentProgressModel({ getCatalog: () => ({ items: fixtureCatalog.items, mastery: {
    itemRankXP: { weapon: Array.from({ length: 31 }, (_, rank) => rank * 100) }, items: [],
  } }) });
  const low = model.read({ Melee: [{ ItemType: sword, XP: 2999 }] }).rows[0];
  const mastered = model.read({ Melee: [{ ItemType: sword, XP: 3000 }] }).rows[0];
  assert.equal(low.masteryTarget, 3000); assert.equal(low.mastered, false); assert.equal(mastered.mastered, true);
});

test('type normalization joins store paths and case variants while preserving normalized names', () => {
  const value = read({ XPInfo: [{ ItemType: sword.toLowerCase(), XP: 2 }],
    Melee: [{ ItemType: sword.replace('/SF/', '/SF/StoreItems/'), XP: 7 }] }, { names: { [sword]: 'Named weapon' } });
  assert.equal(value.rows.length, 1); assert.equal(value.rows[0].name, 'Named weapon'); assert.equal(value.rows[0].xp, 7);
  assert.equal(value.rows[0].owned, true); assert.equal(value.rows[0].recorded, true);
});

test('equipment thumbnails resolve catalogue aliases without exposing arbitrary image locations', () => {
  const icon = '/SF/Interface/Graphics/StoreItems/Weapons/FixtureSword.png';
  const getCatalog = () => ({ items: [{ itemType: sword, icon }, { itemType: bow }], mastery: {} });
  const model = createEquipmentProgressModel({ getCatalog });
  assert.equal(model.read({ Melee: [{ ItemType: sword.toLowerCase(), XP: 5 }] }).rows[0].icon, icon);
  assert.equal(model.read({ Melee: [{ ItemType: sword.replace('/SF/', '/SF/StoreItems/'), XP: 5 }] }).rows[0].icon, icon);
  assert.equal(model.read({ Melee: [{ ItemType: bow, XP: 5 }] }).rows[0].icon, null);
  const invalid = createEquipmentProgressModel({ getCatalog: () => ({ items: [{ itemType: sword, icon: 'https://example.com/weapon.png' }] }) });
  assert.equal(invalid.read({ Melee: [{ ItemType: sword, XP: 5 }] }).rows[0].icon, null);
});

test('malformed records are bounded to equipment scope and numeric strings never manufacture XP', () => {
  const value = read({ XPInfo: [null, { ItemType: sword, XP: '222000' }, { ItemType: sword, XP: Infinity },
    { ItemType: sword, XP: -1 }, { ItemType: sword, XP: 1.5 }, { ItemType: '/SF/Weapons/../Bad', XP: 5 },
    { ItemType: '/SF/Types/NonEquipment', XP: 99 }], LongGuns: {},
    Melee: [null, { ItemType: pact, XP: 900000 }, { ItemType: sword, XP: NaN }] });
  assert.equal(value.rows.length, 1); assert.equal(value.rows[0].xp, null); assert.equal(value.rows[0].mastered, null);
  assert.equal(value.unreadableRecords, 10);
});

test('conflicting ownership buckets do not assert a mastery threshold', () => {
  const row = read({ Melee: [{ ItemType: sword, XP: 222000 }], Pistols: [{ ItemType: sword, XP: 222000 }] }).rows[0];
  assert.equal(row.category, 'weapon'); assert.equal(row.mastered, null); assert.equal(row.masteryTarget, null);
});

test('projection is stateless across accounts and never includes session or instance identifiers', () => {
  const model = createEquipmentProgressModel({ getCatalog: () => fixtureCatalog });
  const first = model.read({ Nonce: 'secret', AccountId: 'private', Melee: [{ ItemType: sword, ItemId: { $oid: 'private-instance' }, XP: 10 }] }, { accountId: 'private', status: 'live' });
  assert.doesNotMatch(JSON.stringify(first), /secret|private/);
  assert.deepEqual(model.read({}, { accountId: 'another', status: 'live' }).rows, []);
  assert.deepEqual(model.read({ Melee: [{ ItemType: sword, XP: 10 }] }, { status: 'connect' }).rows, []);
  assert.deepEqual(model.read(null, { status: 'waiting' }).rows, []);
  assert.equal(model.read({ Melee: [{ ItemType: sword, XP: 10 }] }, { status: 'cached' }).rows.length, 1);
});

function rendererFixture() {
  const document = { activeElement: null };
  function node(tag) {
    const events = new Map();
    const element = { tagName: tag, className: '', children: [], dataset: {}, style: {}, attributes: {}, value: '', textContent: '',
      classList: { contains(value) { return element.className.split(' ').includes(value); }, add(value) { element.className += ' ' + value; } },
      append(...items) {
        element.children.push(...items);
        if (tag === 'select' && !element.value) element.value = element.children[0]?.value || '';
      },
      replaceChildren(...items) { element.children = items; },
      setAttribute(key, value) { element.attributes[key] = value; },
      addEventListener(type, handler) { if (!events.has(type)) events.set(type, new Set()); events.get(type).add(handler); },
      removeEventListener(type, handler) { events.get(type)?.delete(handler); },
      dispatch(type) { for (const handler of events.get(type) || []) handler({ target: element }); },
      focus() { document.activeElement = element; },
      querySelectorAll(selector) {
        const all = element.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
        return selector === '*' ? all : all.filter(child => child.classList.contains(selector.slice(1)));
      },
      querySelector(selector) { return element.querySelectorAll(selector)[0] || null; },
    };
    return element;
  }
  document.createElement = node;
  let callback, calls = 0, unsubscribed = 0;
  const initial = { ...read({ XPInfo: [{ ItemType: sword, XP: 200 }], LongGuns: [{ ItemType: bow, XP: 100 }], Suits: [{ ItemType: pact, XP: 500 }] }), status: 'live' };
  const api = { getInventoryWidget: async id => { assert.equal(id, 'equipment-progress'); calls++; return initial; },
    onInventoryWidgetChanged(id, handler) { assert.equal(id, 'equipment-progress'); callback = handler; return () => { unsubscribed++; }; } };
  const window = { api, ItemImages: { create(_icon, options = {}) {
    const image = node('span'); image.className = options.className || ''; return image;
  } } };
  const context = vm.createContext({ document, window, console, setInterval, clearInterval });
  for (const file of ['inventory-widget-ui.js', 'equipment-progress.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer', file), 'utf8'), context);
  }
  const element = node('div');
  const handle = window.EquipmentProgressWidget.mount(element, { api });
  return { element, document, handle, initial, update: value => callback(value),
    find: value => element.querySelector('.' + value), rows: () => element.querySelectorAll('.equipment-row'),
    get calls() { return calls; }, get unsubscribed() { return unsubscribed; } };
}

test('equipment filters repaint locally and search remains focused across snapshot updates', async () => {
  const fixture = rendererFixture(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.rows().length, 3);
  const search = fixture.find('equipment-search'); search.focus(); search.value = 'FixtureSword'; search.dispatch('input');
  assert.equal(fixture.rows().length, 1);
  assert.equal(fixture.rows()[0].dataset.equipmentId, sword.toLowerCase());
  assert.equal(fixture.calls, 1, 'typing must not make another inventory request');
  fixture.update({ ...fixture.initial, status: 'cached' });
  assert.strictEqual(fixture.find('equipment-search'), search);
  assert.strictEqual(fixture.document.activeElement, search);
  assert.equal(search.value, 'FixtureSword');
  assert.equal(fixture.rows().length, 1);
  search.value = ''; search.dispatch('input');
  const ownership = fixture.find('equipment-ownership'); ownership.value = 'owned'; ownership.dispatch('change');
  assert.equal(fixture.rows().length, 2);
  const category = fixture.find('equipment-category'); category.value = 'pact'; category.dispatch('change');
  assert.equal(fixture.rows().length, 1);
  assert.equal(fixture.rows()[0].dataset.equipmentId, pact.toLowerCase());
  assert.equal(fixture.rows()[0].querySelector('.equipment-progress'), null, 'Pacts must not get a guessed mastery bar');
  fixture.handle.destroy(); assert.equal(fixture.unsubscribed, 1);
});

test('historical ownership filter excludes unknown ownership and labels incomplete records clearly', async () => {
  const fixture = rendererFixture(); await new Promise(resolve => setImmediate(resolve));
  const swordRow = fixture.rows().find(row => row.dataset.equipmentId === sword.toLowerCase());
  assert.equal(swordRow.querySelector('.equipment-history').textContent, 'Ownership unavailable');
  assert.match(fixture.find('equipment-notice').textContent, /ownership sections are unavailable/);
  const ownership = fixture.find('equipment-ownership'); ownership.value = 'history'; ownership.dispatch('change');
  assert.equal(fixture.rows().length, 0);
  fixture.update({ ...read({ XPInfo: [{ ItemType: sword, XP: 200 }], Melee: [] }), status: 'live' });
  assert.equal(fixture.rows().length, 1);
  assert.equal(fixture.rows()[0].querySelector('.equipment-history').textContent, 'Historical record');
  fixture.handle.destroy();
});
