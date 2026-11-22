'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MARKET_URL, parseLuaTable, excludedTags, projectAvailability, buildCollectionAvailability } = require('../scripts/build-collection-availability');

const sources = [
  { url: 'pipeline:ava_api_items.json', sha256: 'a'.repeat(64) },
  { url: 'https://wiki.avakot.org/test', sha256: 'b'.repeat(64) },
  { url: MARKET_URL, sha256: 'c'.repeat(64) },
];
const item = (name, suffix = name, category = 'Cosmetic') => ({ name, category, path: `/SF/Types/Items/${suffix}` });
function project(sourceItems, data, marketItems = [{ path: '/SF/Types/Items/Market' }], table = 'Cosmetics') {
  return projectAvailability({ sourceItems, wikiTables: [{ table, data, sourceIndex: 1, identitySourceIndex: 0 }],
    marketItems, sources, generatedAt: '2026-11-18T00:00:00Z' });
}

test('literal Lua parser keeps nested tags within their own row and respects quoted comments', () => {
  const data = parseLuaTable(`-- heading
    return {
      ["Public"] = { Description = "contains -- braces } and \\\"quotes\\\"", Tags = {"Pre-Owned", "Event"}, Ingredients = {{item='Iron', qty=4}} },
      --[=[ block comment { ]=]
      ["Hidden"] = { Tags = "Upcoming; Founders", Description = [=[long -- string]=] },
      ["After"] = { Tags = "" },
    }`);
  assert.equal(data.Public.Description, 'contains -- braces } and "quotes"');
  assert.equal(data.Public.Ingredients[1].item, 'Iron');
  assert.equal(excludedTags(data.Public.Tags), false);
  assert.equal(excludedTags(data.Hidden.Tags), true);
  assert.equal(excludedTags(data.After.Tags), false);
  for (const raw of ['return os.execute("bad")', 'return {x=function() end}', 'return {x=1, x=2}', 'return {x="unterminated}', 'return {} ignored']) {
    assert.throws(() => parseLuaTable(raw), /wiki table/);
  }
});

test('wiki exclusions override market approvals and denied metadata is absent from the snapshot', () => {
  const data = parseLuaTable('return { ["Public"]={Tags=""}, ["Hidden"]={Tags={"Event", " UNOBTAINABLE "}} }');
  const value = project([item('Public'), item('Hidden')], data,
    [{ path: '/SF/StoreItems/Types/Items/Hidden' }, { path: '/SF/Types/Items/Market' }]);
  assert.deepEqual(value.items.map(row => row.itemType), ['/SF/Types/Items/Market', '/SF/Types/Items/Public']);
  assert.equal(JSON.stringify(value).includes('Hidden'), false);
  assert.deepEqual(value.items[1].evidence, [0, 1]);
  for (const tag of ['Archive', 'Archived', 'OFF', 'Disabled', 'Upcoming Content', 'Upcoming']) assert.equal(excludedTags(tag), true);
});

test('an excluded product also excludes its market-approved crafting blueprint', () => {
  const raw = [item('Public', 'Public', 'Weapon'),
    { ...item('Hidden', 'Hidden', 'Weapon'), crafting_recipe: '/SF/StoreItems/Types/Recipes/Hidden' }];
  const data = parseLuaTable('return { ["Public"]={}, ["Hidden"]={Tags="Upcoming"} }');
  const value = project(raw, data, [{ path: '/SF/Types/Recipes/Hidden' }], 'Weapons');
  assert.deepEqual(value.items.map(row => row.itemType), ['/SF/Types/Items/Public']);
  assert.equal(JSON.stringify(value).includes('Hidden'), false);
});

test('unreviewed or ambiguous extracted names never authorize paths; excluded ambiguity denies every candidate', () => {
  const raw = [item('Ambiguous', 'One'), item('Ambiguous', 'Two'), item('Unreviewed'), item('Public')];
  const data = parseLuaTable('return { ["Ambiguous"]={}, ["Public"]={} }');
  assert.deepEqual(project(raw, data).items.map(row => row.itemType), ['/SF/Types/Items/Market', '/SF/Types/Items/Public']);
  const denied = parseLuaTable('return { ["Ambiguous"]={Tags="Archive"}, ["Public"]={} }');
  assert.equal(project(raw, denied, [{ path: raw[0].path }, { path: raw[1].path }]).items.length, 1);
});

test('explicit wiki InternalID authorizes its path without authorizing similarly named extraction rows', () => {
  const data = parseLuaTable('return { ["Entry"]={InternalID="/SF/Types/Items/Public"} }');
  const value = project([item('Entry', 'Other')], data);
  assert.deepEqual(value.items.map(row => row.itemType), ['/SF/Types/Items/Market', '/SF/Types/Items/Public']);
  assert.deepEqual(value.items[1].evidence, [1]);
});

test('default ownership requires an exact reviewed Pre-Owned tag and unambiguous appearance identity', () => {
  const raw = [item('Default'), item('Ordinary'), item('Ambiguous', 'One'), item('Ambiguous', 'Two'), item('Explicit', 'Other')];
  const data = parseLuaTable(`return {
    ["Default"]={Tags={"Event", " PRE-OWNED "}},
    ["Ordinary"]={Tags="Not Pre-Owned; Pre-Owned Preview"},
    ["Ambiguous"]={Tags="Pre-Owned"},
    ["Explicit"]={InternalID="/SF/Types/Items/Exact",Tags="Event;Pre-Owned"}
  }`);
  const value = project(raw, data, [{ path: '/SF/Types/Items/One' }, { path: '/SF/Types/Items/Two' }]);
  assert.deepEqual(value.items.filter(row => row.defaultOwned).map(row => row.itemType),
    ['/SF/Types/Items/Default', '/SF/Types/Items/Exact']);
  assert.equal(value.items.find(row => row.itemType.endsWith('/Ordinary')).defaultOwned, undefined);
  assert.deepEqual(value.items.find(row => row.itemType.endsWith('/Default')).evidence, [0, 1]);
  assert.deepEqual(value.items.find(row => row.itemType.endsWith('/Exact')).evidence, [1]);
  const weapon = project([item('Default', 'Default', 'Weapon')], { Default: { Tags: 'Pre-Owned' } }, undefined, 'Weapons');
  assert.ok(weapon.items.every(row => row.defaultOwned === undefined), 'appearance defaults cannot grant equipment ownership');
});

test('excluded appearances never retain default ownership despite a market approval', () => {
  const data = parseLuaTable('return { ["Hidden"]={Tags="Pre-Owned, Upcoming"}, ["Public"]={Tags="Pre-Owned"} }');
  const value = project([item('Hidden'), item('Public')], data, [{ path: '/SF/Types/Items/Hidden' }]);
  assert.deepEqual(value.items.map(row => [row.itemType, row.defaultOwned]), [['/SF/Types/Items/Public', true]]);
});

test('public crafting recipes require independent product approval and never approve their ingredients', () => {
  const raw = [{ ...item('Public', 'Public', 'Weapon'), crafting_recipe: '/SF/Types/Recipes/Public' },
    { ...item('Unreviewed', 'Unreviewed', 'Weapon'), crafting_recipe: '/SF/Types/Recipes/Unreviewed' }];
  const data = parseLuaTable('return { ["Public"]={Ingredients={{item="Private Ingredient",qty=1}}}, ["Unreviewed"]={Ingredients={{item="Iron",qty=1}}} }');
  const value = project(raw, data, [{ path: raw[0].path }], 'CraftingTable');
  assert.deepEqual(value.items.map(row => row.itemType), ['/SF/Types/Items/Public', '/SF/Types/Recipes/Public']);
  assert.equal(JSON.stringify(value).includes('Private Ingredient'), false);
  assert.equal(JSON.stringify(value).includes('Unreviewed'), false);
});

test('availability projection fails closed on malformed sources or unsupported tag shapes', () => {
  assert.throws(() => project([], { Public: {} }), /Incomplete/);
  assert.throws(() => project([item('Public')], {}), /Invalid wiki/);
  assert.throws(() => project([item('Public')], { Public: { Tags: true } }), /Unsupported wiki tags/);
  assert.throws(() => projectAvailability({ sourceItems: [item('Public')], wikiTables: [{ table: 'Cosmetics', data: { Public: {} }, sourceIndex: 10, identitySourceIndex: 0 }], marketItems: [{ path: '/SF/Types/Items/Market' }], sources }), /Invalid availability/);
});

test('a failed authoring refresh preserves the previous approved snapshot', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overkot-availability-'));
  const source = path.join(directory, 'items.json'), out = path.join(directory, 'availability.json');
  try {
    await fs.writeFile(source, JSON.stringify({ items: [item('Public')] }));
    await fs.writeFile(out, 'previous-approved-snapshot');
    await assert.rejects(buildCollectionAvailability({ source, out,
      fetcher: async () => ({ ok: true, arrayBuffer: async () => Buffer.from('return {x=function() end}') }) }), /Unsupported wiki table/);
    assert.equal(await fs.readFile(out, 'utf8'), 'previous-approved-snapshot');
  } finally {
    await fs.unlink(source);
    await fs.unlink(out);
    await fs.rmdir(directory);
  }
});
