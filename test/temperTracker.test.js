const test = require('node:test');
const assert = require('node:assert/strict');
const { TemperTracker, inventoryTempers, setTemperCatalog } = require('../src/modules/temperTracker');
const catalog = require('../src/data/tempers.json');
assert.equal(setTemperCatalog(catalog), true);
const { projectTemperCompatibility, projectTemperData } = require('../scripts/build-temper-data');
const { temperInventory, temperProgress, weapon } = require('./fixtures/temper-inventory');
const row = (snapshot, name) => snapshot.rows.find(row => row.name === name);

test('mixed cached catalogs keep localized labels and recover legacy art by game ID', () => {
  const [legacy, current] = catalog.tempers;
  const streamed = 'temper-icons/' + 'f'.repeat(64) + '.png';
  const mixed = { ...catalog, tempers: [
    { ...legacy, name: 'Localized label', icon: 'RetiredName.webp' },
    { ...current, icon: streamed },
    { ...legacy, id: '/SF/Language/Upgrades/UnknownName', name: 'New temper', icon: 'RetiredName.webp' },
  ] };
  assert.ok(require('../src/modules/catalogData').validTemperCatalog(mixed));
  const snapshot = inventoryTempers({}, mixed);
  assert.equal(row(snapshot, 'Localized label').icon, legacy.icon);
  assert.equal(row(snapshot, current.name).icon, streamed);
  assert.equal(row(snapshot, 'New temper').icon, '');
});
function fixture() {
  let inventory = temperInventory(), cached = false, expired = false;
  let session = { getRawInventory: () => inventory, isInventoryCached: () => cached, isNonceExpired: () => expired };
  const tracker = new TemperTracker({ getSession: () => session });
  return { tracker, set: value => { inventory = value; }, cache: value => { cached = value; }, expire: () => { expired = true; },
    logout: () => { session = null; }, login: () => { inventory = null; session = { getRawInventory: () => inventory, isInventoryCached: () => false, isNonceExpired: () => false }; } };
}

test('counts every inventory weapon and repeated temper entries, never random roll values or curses', () => {
  const inv = temperInventory(), snapshot = inventoryTempers(inv);
  assert.equal(snapshot.weaponCount, 3);
  assert.equal(snapshot.unreadableWeapons, 0);
  assert.equal(row(snapshot, 'Fortified').copies, 2);
  assert.equal(row(snapshot, 'Fortified').weaponCount, 1);
  assert.deepEqual(row(snapshot, 'Fortified').sources, [{ name: 'Vetch', quality: 'Legendary', art: 'Long Blade', stacks: 2, count: 1, equippedCount: 1 }]);
  assert.equal(row(snapshot, 'Cowp').copies, 2);
  assert.equal(row(snapshot, 'Cowp').sources[0].count, 2);
  assert.equal(row(snapshot, 'Cowp').sources[0].equippedCount, 1);
  assert.equal(row(snapshot, 'Swift Strike').copies, 0);
  assert.equal(row(snapshot, 'Arcane Barrage').copies, 2);
  assert.equal(snapshot.rows.length, catalog.tempers.length);
});
test('blacksmith progress uses banked RawUpgrades, includes zero progress and unlocks at ten', () => {
  const inv = temperInventory();
  inv.Melee.push(weapon(4, 'Vetch', Array(12).fill('StaggerCritMod')));
  const snapshot = inventoryTempers(inv);
  assert.equal(row(snapshot, 'Fortified').unlockCount, 10);
  assert.equal(row(snapshot, 'Fortified').unlockTarget, 10);
  assert.equal(row(snapshot, 'Fortified').unlocked, true);
  assert.equal(row(snapshot, 'Cowp').copies, 14);
  assert.equal(row(snapshot, 'Cowp').unlockCount, 4);
  assert.equal(row(snapshot, 'Cowp').unlocked, false);
  assert.equal(row(snapshot, 'Swift Strike').unlockCount, 9);
  assert.equal(row(snapshot, 'Swift Strike').unlocked, false);
  assert.equal(row(snapshot, 'Arcane Barrage').unlockCount, 0);
  assert.equal(row(snapshot, 'Arcane Barrage').unlocked, false);
  const noWeapons = inventoryTempers({ RawUpgrades: inv.RawUpgrades });
  assert.equal(row(noWeapons, 'Fortified').unlocked, true);
  assert.equal(row(noWeapons, 'Fortified').copies, 0);
});
test('blacksmith item types distinguish Full Force and Arcane Barrage independently of weapon tags', () => {
  const snapshot = inventoryTempers({ RawUpgrades: [temperProgress('HeavyAttackDamageAndStaggerMod', 10),
    temperProgress('MagickHeavyAttackDamageAndStaggerMod', 3), temperProgress('OdeReduceDefenseMod', 7), temperProgress('StaggerCritMod', 2)] });
  assert.equal(row(snapshot, 'Full Force').unlockCount, 10);
  assert.equal(row(snapshot, 'Arcane Barrage').unlockCount, 3);
  assert.equal(row(snapshot, 'Bypass').unlockCount, 7);
  assert.equal(row(snapshot, 'Cowp').unlockCount, 2);
});
test('unlock totals clamp to ten, deduplicate and ignore unrelated or malformed upgrades', () => {
  const snapshot = inventoryTempers({ RawUpgrades: [temperProgress('BlockingLessStaggerMod', 25),
    temperProgress('AttackSpeedMod', 5), temperProgress('AttackSpeedMod', 5),
    { ItemType: '/SF/StoreItems/Types/Items/Aspects/Tempers/AttackSpeedMod', ItemCount: 6 },
    { ItemType: '/SF/Upgrades/Runes/AttackSpeedMod', ItemCount: 100 },
    ...[-1, 1.5, '10', null, Infinity].map(count => temperProgress('StaggerCritMod', count)),
    temperProgress('../StaggerCritMod', 10), null] });
  assert.equal(row(snapshot, 'Fortified').unlockCount, 10);
  assert.equal(row(snapshot, 'Swift Strike').unlockCount, 6);
  assert.equal(row(snapshot, 'Swift Strike').unlocked, false);
  assert.equal(row(snapshot, 'Cowp').unlockCount, 0);
  assert.equal(snapshot.unreadableTempers, 6);
  assert.equal(inventoryTempers({ RawUpgrades: {} }).unreadableTempers, 1);
  assert.equal(inventoryTempers({}).unreadableTempers, 0);
});
test('unknown banked tempers retain progress, while unknown weapon tags have no guessed unlock progress', () => {
  const inv = { RawUpgrades: [temperProgress('NewTemperMod', 3)], Melee: [weapon(1, 'Vetch', ['NewTemperMod', 'WeaponOnlyMod'])] };
  const snapshot = inventoryTempers(inv);
  const unknown = snapshot.rows.find(row => row.id === 'unknown:newtempermod');
  assert.equal(unknown.unknown, true);
  assert.equal(unknown.unlockCount, 3);
  assert.equal(unknown.copies, 1);
  assert.equal(row(snapshot, 'WeaponOnlyMod').unlockCount, null);
});
test('unlock-only inventory updates broadcast and account changes clear previous progress', () => {
  const f = fixture(); let events = 0;
  f.tracker.on('changed', () => events++); f.tracker.update();
  const next = temperInventory(); next.RawUpgrades[2].ItemCount = 10; f.set(next); f.tracker.update();
  assert.equal(events, 2);
  assert.equal(row(f.tracker.getSnapshot(), 'Swift Strike').unlocked, true);
  f.set(structuredClone(next)); f.tracker.update();
  assert.equal(events, 2);
  f.logout();
  assert.ok(f.tracker.getSnapshot().rows.every(row => row.unlockCount === 0 && !row.unlocked));
  f.login(); f.set({ RawUpgrades: [temperProgress('StaggerCritMod', 1)] });
  assert.equal(row(f.tracker.getSnapshot(), 'Swift Strike').unlockCount, 0);
  assert.equal(row(f.tracker.getSnapshot(), 'Cowp').unlockCount, 1);
});
test('Full Force and Arcane Barrage use the source weapon; Cowp and Bypass remain distinct', () => {
  const inv = temperInventory();
  inv.Melee.push(weapon(4, 'Orst-III', ['HeavyAttackDamageAndStaggerMod', 'OdeReduceDefenseMod']));
  const snapshot = inventoryTempers(inv);
  assert.equal(row(snapshot, 'Full Force').copies, 1);
  assert.equal(row(snapshot, 'Arcane Barrage').copies, 2);
  assert.equal(row(snapshot, 'Bypass').copies, 1);
  assert.equal(row(snapshot, 'Cowp').copies, 2);
});
test('new weapons, sales and deletions replace holdings without inventing banked progress', () => {
  const f = fixture(); f.tracker.update();
  const next = temperInventory(); next.Melee.push(weapon(4, 'Vetch', ['BlockingLessStaggerMod'])); f.set(next);
  assert.equal(row(f.tracker.getSnapshot(), 'Fortified').copies, 3);
  next.Melee = next.Melee.filter(item => item.ItemId.$oid !== next.Melee[0].ItemId.$oid); f.set(structuredClone(next));
  assert.equal(row(f.tracker.getSnapshot(), 'Fortified').copies, 1);
  f.set({ Melee: [], LongGuns: [] });
  assert.equal(f.tracker.getSnapshot().weaponCount, 0);
  assert.ok(f.tracker.getSnapshot().rows.every(row => row.copies === 0 && row.sources.length === 0));
});
test('same instance across arrays is counted once; configs cannot duplicate whole-weapon aspects', () => {
  const inv = temperInventory(); inv.LongGuns.push(structuredClone(inv.Melee[0]));
  inv.Melee[0].Configs = [{ AspectFingerprint: inv.Melee[0].AspectFingerprint }, { AspectFingerprint: inv.Melee[0].AspectFingerprint }];
  assert.equal(inventoryTempers(inv).weaponCount, 3);
  assert.equal(row(inventoryTempers(inv), 'Fortified').copies, 2);
});
test('fingerprints support object/string forms, Buffs casing, direct paths and empty stock weapons', () => {
  const inv = temperInventory(); inv.Melee[0].AspectFingerprint = { Buffs: ['/SF/Language/Upgrades/AspectLessStaggerBlockingName', { tag: 'BlockingLessStaggerMod' }] };
  inv.Melee.push({ ...weapon(5, 'Vetch'), AspectFingerprint: '' });
  assert.equal(row(inventoryTempers(inv), 'Fortified').copies, 2);
  assert.equal(inventoryTempers(inv).weaponCount, 4);
});
test('malformed fingerprints are reported and unmapped tempers retain their observed counts', () => {
  const inv = temperInventory(); inv.Melee[0].AspectFingerprint = '{broken';
  inv.Melee.push(weapon(5, 'Vetch', ['NewTemperMod', 'NewTemperMod']));
  const snapshot = inventoryTempers(inv);
  assert.equal(snapshot.unreadableWeapons, 1);
  assert.equal(row(snapshot, 'Fortified').copies, 0);
  assert.equal(row(snapshot, 'NewTemperMod').copies, 2);
  assert.equal(row(snapshot, 'NewTemperMod').unknown, true);
  assert.equal(row(snapshot, 'Cowp').copies, 1);
  for (const fp of ['x'.repeat(65537), 'null', '[]', 10, { buffs: true }, { buffs: Array(65).fill('StaggerMod') }]) {
    inv.Melee[0].AspectFingerprint = fp; assert.equal(inventoryTempers(inv).unreadableWeapons, 1);
  }
});
test('unrecognized weapons do not guess ambiguous temper names', () => {
  const inv = temperInventory(); inv.LongGuns[0].ItemType = '/SF/Weapons/NewWeapon';
  const snapshot = inventoryTempers(inv);
  assert.equal(row(snapshot, 'Arcane Barrage').copies, 0);
  assert.equal(row(snapshot, 'HeavyAttackDamageAndStaggerMod').copies, 2);
  assert.equal(row(snapshot, 'HeavyAttackDamageAndStaggerMod').sources[0].name, 'New Weapon');
});
test('cached status is explicit; logout, expired sessions and new accounts cannot show previous holdings', () => {
  const f = fixture(); f.cache(true); assert.equal(f.tracker.getSnapshot().status, 'cached');
  f.cache(false); assert.equal(f.tracker.getSnapshot().status, 'live');
  f.expire(); assert.equal(f.tracker.getSnapshot().status, 'connect');
  assert.equal(f.tracker.getSnapshot().weaponCount, 0);
  f.logout(); f.login(); assert.equal(f.tracker.getSnapshot().status, 'waiting');
  f.set({ Melee: [weapon(10, 'Vetch', ['AttackSpeedMod'])] });
  assert.equal(row(f.tracker.getSnapshot(), 'Swift Strike').copies, 1);
  assert.equal(row(f.tracker.getSnapshot(), 'Fortified').copies, 0);
  f.logout(); assert.equal(f.tracker.getSnapshot().weaponCount, 0);
});
test('unchanged polls do not broadcast or reparse; unrelated inventory changes do not redraw', () => {
  const f = fixture(), inv = temperInventory(); let reads = 0, events = 0;
  const fp = inv.Melee[0].AspectFingerprint;
  Object.defineProperty(inv.Melee[0], 'AspectFingerprint', { get: () => { reads++; return fp; }, enumerable: true });
  f.set(inv); f.tracker.on('changed', () => events++); f.tracker.update();
  for (let i = 0; i < 10; i++) f.tracker.update();
  assert.equal(reads, 1); assert.equal(events, 1);
  const next = temperInventory(); next.Credits = 100; next.Melee.reverse(); f.set(next); f.tracker.update();
  assert.equal(events, 1);
  next.Melee[0].Quality = 'IQ_NOBLE'; f.set(structuredClone(next)); f.tracker.update(); assert.equal(events, 2);
});
test('renderer snapshot contains only temper counts and weapon descriptions, no account credentials or instance IDs', () => {
  const snapshot = fixture().tracker.getSnapshot(), json = JSON.stringify(snapshot);
  assert.ok(!/private-|Nonce|AccountId|ItemId|\$oid|Fingerprint|2147483647/.test(json));
  assert.deepEqual(Object.keys(snapshot).sort(), ['rows', 'status', 'unreadableTempers', 'unreadableWeapons', 'weaponCount']);
});
test('catalogue generation joins corrected tags to canonical game identities and rejects missing mappings', () => {
  const reference = [{ name: 'Cowp', internalId: 'StaggerCritMod', icon: 'Cowp.png', description: '', origin: 'Universal' }];
  const icon = '/SF/Interface/Graphics/Aspects/Universal/Overpower.png';
  const items = [{ category: 'Temper', name: 'Cowp', tag: 'OdeReduceDefenseMod', lang_key: '/SF/Language/Upgrades/AspectStaggerCritName', icon }];
  const bytes = Buffer.from('89504e470d0a1a0a010203', 'hex');
  const data = projectTemperData(reference, [], items, file => {
    assert.equal(file, icon);
    return bytes;
  });
  const hash = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  assert.equal(data.tempers[0].icon, `temper-icons/${hash}.png`);
  assert.equal(data.aliases.staggercritmod, items[0].lang_key);
  assert.equal(data.aliases.odereducedefensemod, undefined);
  assert.throws(() => projectTemperData(reference, [], []), /No unique game mapping/);
  assert.throws(() => projectTemperData(reference, [], [{ ...items[0], icon: '../Cowp.png' }]), /Invalid pipeline temper icon/);
  assert.throws(() => projectTemperData(reference, [], items, () => Buffer.from('not a png')), /Invalid temper PNG/);
});

test('bundled temper compatibility data retains labels and ambiguous tags without the authoring dataset', () => {
  const compatibility = projectTemperCompatibility(catalog);
  assert.deepEqual(compatibility, require('../src/generated/temper-compatibility.json'));
  assert.deepEqual(Object.keys(compatibility).sort(), ['aliases', 'temperById', 'weaponAliases']);
  for (const { id, name, icon } of catalog.tempers) {
    assert.deepEqual(compatibility.temperById[id], { name, icon });
    assert.match(icon, /^temper-icons\/[a-f0-9]{64}\.png$/);
  }
  assert.deepEqual(compatibility.weaponAliases, catalog.weaponAliases);
  assert.equal(compatibility.aliases.cassidpoisonmod, '/SF/Language/Upgrades/AspectPoisonName');
  assert.equal(compatibility.aliases.aspectpoison, undefined);
});
