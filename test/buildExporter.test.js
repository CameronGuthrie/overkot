const test = require('node:test');
const assert = require('node:assert/strict');
const { inflateRawSync } = require('node:zlib');
const { BuildExporter, currentPreset, inventoryToBuild, buildImportUrl, setBuildExportCatalog } = require('../src/modules/buildExporter');
setBuildExportCatalog(require('../src/data/build-export.json'));
const { projectExportData } = require('../scripts/build-export-data');
const { buildInventory, id } = require('./fixtures/build-inventory');
const { getCollectionCatalog } = require('../src/modules/collectionCatalog');

test('exports the equipped NORMAL preset, its selected configs and every planner section', () => {
  const { state, partial } = inventoryToBuild(buildInventory());
  assert.equal(partial, false);
  assert.equal(state.name, 'Héros 🌿');
  assert.equal(state.rank, 18);
  assert.deepEqual(state.stats, { courage: 16, spirit: 9, grace: 9 });
  assert.deepEqual(state.questVirtues, { shewolf: 'spirit', wasteBear: 'courage' });
  assert.equal(state.equipment.helm, '/SF/Upgrades/Skins/Helmets/BromiusHelmet');
  assert.equal(Object.values(state.equipment).filter(Boolean).length, 7);
  assert.deepEqual(state.weaponRanks, { weapon: 30, sidearm: 30 });
  assert.deepEqual(state.craftworks, { weapon: 3, sidearm: 0 });
  assert.equal(state.runes.weapon.rank, 3);
  assert.match(state.runes.weapon.id, /GreatSword/);
  assert.equal(state.runes.sidearm.id, '', 'Missing sockets must not resolve an uninstanced RawUpgrade');
  assert.equal(state.motes.sidearm.courage.id, '');
  assert.deepEqual(Object.values(state.motes.weapon).map(mote => mote.virtue), ['courage', 'grace', 'spirit', 'spirit']);
  assert.deepEqual(Object.values(state.motes.weapon).map(mote => mote.rank), [0, 1, 2, 3]);
  assert.equal(state.motes.weapon.bonus.grip, '/SF/Upgrades/Techniques/SwordSkillTree');
  assert.equal(state.joineries.weapon, '/SF/Types/Items/Kintsugi/Weapons/KintsugiUpgradeMeleeR');
  assert.deepEqual(state.tempers.weapon, Array(2).fill('/SF/Language/Upgrades/AspectLessStaggerBlockingName'));
  assert.deepEqual(state.skillTrees[0].skills.map(skill => skill.level), [0, 2]);
});
test('exporter uses the P17 weapon boundary at 112500 XP', () => {
  for (const [xp, rank, partial] of [[112499, 0, true], [112500, 30, false], [225000, 30, false]]) {
    const inv = buildInventory(); inv.Melee[0].XP = xp;
    const exported = inventoryToBuild(inv);
    assert.equal(exported.state.weaponRanks.weapon, rank); assert.equal(exported.partial, partial);
  }
  const inv = buildInventory(); delete inv.Melee[0].XP;
  const itemType = inv.Melee[0].ItemType;
  inv.XPInfo = [{ ItemType: itemType, XP: 60000 },
    { ItemType: itemType.toLowerCase().replace('/sf/', '/sf/storeitems/'), XP: 60000 }];
  assert.equal(inventoryToBuild(inv).state.weaponRanks.weapon, 0, 'Duplicate historical totals must not manufacture mastery');
});
test('never falls back to the first preset or invents missing equipment', () => {
  const inv = buildInventory(); inv.CurrentLoadOutIds = [id(3)];
  assert.equal(currentPreset(inv), null);
  assert.throws(() => inventoryToBuild(inv), { code: 'no-loadout' });
  inv.CurrentLoadOutIds = [id(1)];
  assert.throws(() => inventoryToBuild(inv), { code: 'incomplete-loadout' });
  inv.CurrentLoadOutIds = [id(1), id(2)]; assert.equal(currentPreset(inv), null);
  assert.equal(currentPreset(null), null);
});
test('empty sidearms, direct upgrade paths, fingerprint forms and invalid skill rows are handled', () => {
  const inv = buildInventory();
  inv.LoadOutPresets.NORMAL[1].l.ItemId = id(0);
  inv.Melee[0].Configs[1].Upgrades[0] = inv.Upgrades[0].ItemType;
  inv.Upgrades[1].UpgradeFingerprint = JSON.stringify({ lvl: 9, Pol: 'AP_GRACE', Compat: '/SF/Upgrades/Techniques/GenericRollMarker' });
  inv.SkillTrees[0].Skills.push({ ItemType: '/SF/Bad', Level: -1 }, { ItemType: '/SF/Bad', Level: 8 }, { Level: 0 });
  const { state } = inventoryToBuild(inv);
  assert.equal(state.equipment.sidearm, ''); assert.equal(state.runes.weapon.rank, 3);
  assert.equal(state.motes.weapon.courage.rank, 3); assert.equal(state.motes.weapon.courage.virtue, 'grace');
  assert.equal(state.motes.weapon.courage.grip, ''); assert.equal(state.skillTrees[0].skills.length, 2);
});
test('virtues preserve the Envoy rank and base pool, including old perk-array coordinates', () => {
  const inv = buildInventory(), preset = inv.LoadOutPresets.NORMAL[1];
  delete preset.vu; delete preset.vv;
  preset.p = [{ v: '/SF/Types/Items/AttributeItems/DynamicVirtues', vu: 0, vv: 0 }];
  const { state } = inventoryToBuild(inv);
  assert.deepEqual(state.stats, { courage: 32, spirit: 1, grace: 1 }); assert.equal(state.rank, 18);
});

test('build rank and virtue pool follow inventory mastery regardless of raw inventory or profile levels', () => {
  const inventory = buildInventory();
  inventory.LoreFragmentScans = getCollectionCatalog().discoveries.filter(item => item.masteryEligible)
    .map(item => ({ ItemType: item.itemType, Progress: item.required }));
  inventory.Stats = { PlayerLevel: 50 };
  inventory.Profile = { PlayerLevel: 70 };
  for (const rawLevel of [21, 5, 0, undefined]) {
    inventory.PlayerLevel = rawLevel;
    const original = JSON.stringify(inventory);
    const { state, partial } = inventoryToBuild(inventory);
    assert.equal(partial, false);
    assert.equal(state.rank, 19);
    assert.equal(Object.values(state.stats).reduce((sum, value) => sum + value, 0), 16 + 19);
    assert.equal(JSON.stringify(inventory), original);
  }
  // 453,000 equipment/discovery mastery plus readable skill mastery reaches
  // 501,000 XP and ER 20. The exporter must not retain a rank-19 ceiling.
  inventory.PlayerSkills = [32];
  const future = inventoryToBuild(inventory);
  assert.equal(future.state.rank, 20);
  assert.equal(Object.values(future.state.stats).reduce((sum, value) => sum + value, 0), 16 + 20);
  assert.equal(future.partial, false);
});

test('missing inventory rank stays editable and partial rather than falling back to a profile level', () => {
  const inventory = buildInventory();
  delete inventory.LoreFragmentScans;
  inventory.PlayerLevel = 21;
  inventory.Stats = { PlayerLevel: 19 };
  const { state, partial } = inventoryToBuild(inventory);
  assert.equal(state.rank, 0);
  assert.equal(partial, true);
});
test('flags unsupported tempers and unmastered ranks without silently guessing them', () => {
  const inv = buildInventory(); inv.Melee[0].XP = 2000;
  inv.Melee[0].AspectFingerprint = { buffs: ['NewUnknownTemper', 'constructor'] };
  const result = inventoryToBuild(inv);
  assert.equal(result.partial, true); assert.equal(result.state.weaponRanks.weapon, 0);
  assert.deepEqual(result.state.tempers.weapon, []);
});
test('temper export caps stacks and chooses a weapon-specific meaning for shared tags', () => {
  const inv = buildInventory();
  inv.Melee[0].AspectFingerprint = { buffs: Array(4).fill('HeavyAttackDamageAndStaggerMod') };
  const path = inv.Melee[0].ItemType.toLowerCase();
  const { state } = inventoryToBuild(inv, { tempers: {}, weaponTempers: { [path]: { heavyattackdamageandstaggermod: '/SF/Language/Upgrades/AspectHeavyCastAttackName' } } });
  assert.deepEqual(state.tempers.weapon, Array(2).fill('/SF/Language/Upgrades/AspectHeavyCastAttackName'));
});
test('pipeline projection retains exact IDs and resolves ambiguous temper tags per weapon', () => {
  const data = projectExportData([
    { category: 'Temper', tag: 'Shared', lang_key: '/SF/One', path: '/SF/Aspect/One' },
    { category: 'Temper', tag: 'Shared', lang_key: '/SF/Two', path: '/SF/Aspect/Two' },
    { path: '/SF/StoreItems/Weapons/Two', possible_tempers: [{ tag: 'Shared', lang_key: '/SF/Two' }] },
  ]);
  assert.equal(data.tempers.shared, undefined);
  assert.equal(data.weaponTempers['/sf/weapons/two'].shared, '/SF/Two');
});
test('the compressed website envelope contains build data only', () => {
  const { state } = inventoryToBuild(buildInventory());
  const url = new URL(buildImportUrl(state, 'https://build.example.org'));
  assert.equal(url.origin, 'https://build.example.org'); assert.equal(url.search, '?new=1&import=1');
  assert.match(url.hash, /^#lg=v1z\.[A-Za-z0-9_-]+$/);
  const json = inflateRawSync(Buffer.from(url.hash.slice(8), 'base64url')).toString();
  const envelope = JSON.parse(json);
  assert.deepEqual(envelope, { v: 1, source: 'little-genius', state });
  for (const secret of ['private-account', 'private-session', 'ItemId', '$oid', 'AspectFingerprint']) assert.ok(!json.includes(secret));
  assert.ok(url.href.length < JSON.stringify(state).length);
  assert.throws(() => buildImportUrl({ notes: 'x'.repeat(100000) }, 'https://build.example.org'), { code: 'too-large' });
});

function service() {
  let inventory = buildInventory(), current, reads = 0;
  const opened = [];
  const session = { accountId: 'local-account', nonce: 'local-nonce', isNonceExpired: () => false, isInventoryCached: () => false,
    getRawInventory: () => inventory, api: { fetchInventory: async () => { reads++; return { data: inventory }; } } };
  current = session;
  const exporter = new BuildExporter({ website: 'https://build.example.org', getSession: () => current, openDraft: async url => { opened.push(url); } });
  return { exporter, session, opened, get reads() { return reads; }, setInventory: value => { inventory = value; }, setSession: value => { current = value; } };
}
test('export reads fresh inventory at click time and deduplicates concurrent clicks', async () => {
  const f = service(); let release;
  f.session.api.fetchInventory = () => new Promise(resolve => { release = resolve; });
  const a = f.exporter.exportCurrent(), b = f.exporter.exportCurrent(); assert.equal(a, b);
  const inv = buildInventory(); inv.LoadOutPresets.NORMAL[1].n = 'Fresh build'; release({ data: inv });
  assert.deepEqual(await a, { ok: true, partial: false }); assert.equal(f.opened.length, 1);
  const payload = JSON.parse(inflateRawSync(Buffer.from(new URL(f.opened[0]).hash.slice(8), 'base64url')));
  assert.equal(payload.state.name, 'Fresh build');
});
test('a changed session or a failed fresh read never opens cached or previous-account gear', async () => {
  const f = service(); let release;
  f.session.api.fetchInventory = () => new Promise(resolve => { release = resolve; });
  const pending = f.exporter.exportCurrent(); f.setSession(null); release({ data: buildInventory() });
  assert.equal((await pending).error, 'session-changed'); assert.equal(f.opened.length, 0);
  assert.equal((await f.exporter.exportCurrent()).error, 'connect');
  f.setSession(f.session); f.session.api.fetchInventory = async () => ({ data: null });
  assert.equal((await f.exporter.exportCurrent()).error, 'refresh-failed'); assert.equal(f.opened.length, 0);
  f.session.api.fetchInventory = async () => { throw new Error('Network failure'); };
  assert.equal((await f.exporter.exportCurrent()).error, 'refresh-failed');
  f.session.api.fetchInventory = async () => ({ nonceExpired: true });
  assert.equal((await f.exporter.exportCurrent()).error, 'session-changed');
});
test('module status is small, disables cached inventory and notifies only on changes', () => {
  const f = service(); const updates = []; f.exporter.on('changed', value => updates.push(value));
  f.exporter.update(); f.exporter.update(); assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], { available: true, reason: 'ready', name: 'Héros 🌿' });
  f.session.isInventoryCached = () => true; f.exporter.update(); assert.equal(updates[1].reason, 'waiting');
  f.setSession(null); f.exporter.update(); assert.equal(updates[2].reason, 'connect');
  assert.equal(f.reads, 0);
});
test('unconfigured export reads no inventory and opens no browser', async () => {
  const unexpected = () => assert.fail('Unconfigured export must stay local');
  const exporter = new BuildExporter({ website: '', getSession: unexpected, openDraft: unexpected });
  assert.equal(exporter.getStatus().reason, 'not-configured');
  assert.deepEqual(await exporter.exportCurrent(), { ok: false, error: 'not-configured' });
  assert.throws(() => buildImportUrl({}, ''), { code: 'not-configured' });
});

test('browser errors are contained and the user can retry', async () => {
  const f = service(); f.exporter.openDraft = async () => { throw new Error('OS error with sensitive diagnostics'); };
  assert.deepEqual(await f.exporter.exportCurrent(), { ok: false, error: 'open-failed' });
  f.exporter.openDraft = async () => {};
  assert.equal((await f.exporter.exportCurrent()).ok, true);
});
