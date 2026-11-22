'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WOLF_TYPE, projectWolfProgression, packageNumber } = require('../scripts/build-wolf-progression');
const snapshot = require('../src/data/wolf-progression.json');
const { DEFAULT_PROGRESSION } = require('../src/modules/wolfTraining');
const source = { buildLabel: '2026.11.18.14.58', sha256: 'a'.repeat(64) };

test('wolf caps project exact game package attributes with retained build provenance', () => {
  const result = projectWolfProgression({ [WOLF_TYPE]: { attributes: { MaxEnergy: [150, 150], MaxMaturity: 15,
    DefaultPetStats: { Energy: 85 }, InternalField: 'not shipped' } },
  '/SF/Types/Game/Pets/OtherPet': { attributes: { MaxEnergy: 900 } } }, source);
  assert.deepEqual(result, { schema: 1, source: { ...source, package: WOLF_TYPE }, maxEnergy: 150, maxMaturity: 15 });
  assert.equal(packageNumber(175), 175, 'new game values are read instead of a fixed cap');
  assert.equal(DEFAULT_PROGRESSION.maxEnergy, snapshot.maxEnergy);
  assert.equal(DEFAULT_PROGRESSION.maxMaturity, snapshot.maxMaturity);
  assert.match(snapshot.source.sha256, /^[a-f0-9]{64}$/);
});

test('conflicting duplicate declarations and missing authoritative caps cannot invent a maximum', () => {
  for (const value of [[100, 150], [], [150, null], '150', -1, 0, NaN, Infinity, 1.5, 1000001, { value: 150 }]) {
    assert.throws(() => packageNumber(value), /Missing or conflicting/);
  }
  for (const packages of [{}, { [WOLF_TYPE]: { attributes: { DefaultPetStats: { Energy: 150 }, MaxMaturity: 15 } } },
    { [WOLF_TYPE]: { attributes: { MaxEnergy: 150 } } }]) {
    assert.throws(() => projectWolfProgression(packages, source), /Missing or conflicting/);
  }
  for (const invalid of [{ ...source, sha256: 'bad' }, { ...source, buildLabel: 'unknown' }, null]) {
    assert.throws(() => projectWolfProgression({}, invalid), /Invalid wolf progression source/);
  }
});
