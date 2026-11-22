'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { storageCapacity } = require('../src/modules/storageCapacity');
const inventory = () => ({ UniversalBin: { Slots: 4 }, Melee: [{ ItemId: { $oid: 'one' }, ItemType: '/SF/Sword' }], LongGuns: [], Suits: [], WeaponSkins: [] });

test('storage adds free slots to counted equipment and excludes exempt and repeated instances', () => {
  const value = inventory();
  value.Melee.push(value.Melee[0], { ItemType: '/SF/Axe', IgnoreBinCount: true });
  value.WeaponSkins.push({ ItemId: 'two', ItemType: '/SF/Helmet' });
  const data = storageCapacity(value);
  assert.equal(data.used, 2); assert.equal(data.total, 6); assert.equal(data.free, 4);
  assert.equal(data.state, 'ready'); assert.ok(data.percent > 33 && data.percent < 34);
});
test('negative free slots remain over capacity and bar stays bounded', () => {
  const value = inventory(); value.UniversalBin.Slots = -1;
  value.Melee.push({ ItemType: '/SF/Axe' });
  const data = storageCapacity(value);
  assert.equal(data.total, 1); assert.equal(data.free, -1); assert.equal(data.percent, 100); assert.equal(data.overCapacity, true);
});
test('missing or malformed categories withhold totals without inventing empty categories', () => {
  const value = inventory(); delete value.Suits;
  let data = storageCapacity(value);
  assert.equal(data.free, 4); assert.equal(data.total, null); assert.equal(data.state, 'partial'); assert.equal(data.rows[2].count, null);
  value.Suits = [null, {}]; data = storageCapacity(value);
  assert.equal(data.total, null); assert.equal(data.unreadableCount, 2);
});
test('unknown capacity and impossible totals are never fabricated', () => {
  assert.equal(storageCapacity(null).state, 'unavailable');
  const value = inventory(); value.UniversalBin.Slots = '4';
  assert.equal(storageCapacity(value).free, null);
  value.UniversalBin.Slots = -5;
  assert.equal(storageCapacity(value).total, null);
});
test('malformed explicit slot exemptions withhold the total', () => {
  const value = inventory(); value.Melee[0].IgnoreBinCount = {};
  const data = storageCapacity(value);
  assert.equal(data.state, 'partial'); assert.equal(data.total, null); assert.equal(data.unreadableCount, 1);
  value.Melee[0].IgnoreBinCount = 'false'; assert.equal(storageCapacity(value).used, 1);
  value.Melee[0].IgnoreBinCount = 'true'; assert.equal(storageCapacity(value).used, 0);
});
