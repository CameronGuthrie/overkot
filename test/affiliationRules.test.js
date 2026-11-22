'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { CAP_METHOD_ATOM, extractAffiliationRules } = require('../scripts/build-affiliation-rules');
const buildLabel = '2026.11.18.14.58';

// A synthetic PE containing the registration, wrapper, arithmetic and named
// class constructor. No proprietary executable bytes are needed by the suite.
function executable({ base = 30000, perRank = 1000 } = {}) {
  const bytes = Buffer.alloc(0x1000), pe = 0x80, optional = pe + 24, table = optional + 0xf0;
  bytes.write('MZ'); bytes.writeUInt32LE(pe, 0x3c); bytes.write('PE\0\0', pe);
  bytes.writeUInt16LE(0x8664, pe + 4); bytes.writeUInt16LE(3, pe + 6); bytes.writeUInt16LE(0xf0, pe + 20);
  bytes.writeUInt16LE(0x20b, optional); bytes.writeBigUInt64LE(0x140000000n, optional + 24);
  bytes.writeUInt32LE(0x3000, optional + 136); bytes.writeUInt32LE(36, optional + 140);
  for (const [index, rva, offset, flags] of [[0, 0x1000, 0x400, 0x60000020], [1, 0x2000, 0x800, 0x40000040], [2, 0x3000, 0xc00, 0x40000040]]) {
    const section = table + index * 40;
    bytes.writeUInt32LE(rva, section + 12); bytes.writeUInt32LE(0x400, section + 16);
    bytes.writeUInt32LE(offset, section + 20); bytes.writeUInt32LE(flags, section + 36);
  }
  for (const [index, start, end] of [[0, 0x1010, 0x1070], [1, 0x1100, 0x1200], [2, 0x1300, 0x1400]]) {
    bytes.writeUInt32LE(start, 0xc00 + index * 12); bytes.writeUInt32LE(end, 0xc04 + index * 12);
  }
  bytes.writeUInt32LE(CAP_METHOD_ATOM, 0x800); bytes.writeBigUInt64LE(0x140001010n, 0x808);
  bytes[0x410] = 0xe8; bytes.writeInt32LE(0x1080 - (0x1010 + 5), 0x411);
  Buffer.from('0faf91340500000391300500008bc2c3', 'hex').copy(bytes, 0x480);
  bytes.write('SFGameConfig\0', 0x850); bytes.writeBigUInt64LE(0x140001100n, 0x860);
  Buffer.from('488d05', 'hex').copy(bytes, 0x500); bytes.writeInt32LE(0x2060 - (0x1100 + 7), 0x503);
  Buffer.from('c7873005000000000000c7873405000000000000', 'hex').copy(bytes, 0x520);
  bytes.writeUInt32LE(base, 0x526); bytes.writeUInt32LE(perRank, 0x530);
  return bytes;
}

test('affiliation authoring extracts changing native coefficients and retains exact source evidence', () => {
  for (const coefficients of [{ base: 30000, perRank: 1000 }, { base: 42000, perRank: 1500 }]) {
    const bytes = executable(coefficients), rules = extractAffiliationRules(bytes, { buildLabel });
    assert.equal(rules.base, coefficients.base); assert.equal(rules.perRank, coefficients.perRank);
    assert.equal(rules.source.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(rules.source.buildLabel, buildLabel); assert.equal(rules.source.bindingAtom, '0x2c7ac218');
    assert.equal(rules.source.formulaRva, '0x1080'); assert.equal(rules.source.defaultsRva, '0x1120');
  }
});

test('affiliation authoring rejects changed formulas, unnamed constructors and ambiguous native evidence', () => {
  const changes = [
    bytes => { bytes[0x480] = 0x90; },
    bytes => { bytes.write('OtherConfig\0', 0x850); },
    bytes => { bytes.copy(bytes, 0x820, 0x800, 0x810); },
    bytes => { bytes.copy(bytes, 0x560, 0x520, 0x534); },
    bytes => { bytes[0x500] = 0x90; },
    bytes => { bytes.writeUInt32LE(0, 0x526); },
    bytes => { bytes.writeUInt16LE(0x14c, 0x84); },
  ];
  for (const change of changes) {
    const bytes = executable(); change(bytes);
    assert.throws(() => extractAffiliationRules(bytes, { buildLabel }), /Unrecognised affiliation rules/);
  }
  assert.throws(() => extractAffiliationRules(executable()), /game build label/);
  assert.throws(() => extractAffiliationRules(Buffer.alloc(10), { buildLabel }), /invalid executable/);
});

test('unrelated classes cannot supply daily-cap defaults even when their field offsets match', () => {
  const bytes = executable();
  bytes.copy(bytes, 0x700, 0x520, 0x534); bytes.writeUInt32LE(999, 0x706);
  assert.equal(extractAffiliationRules(bytes, { buildLabel }).base, 30000);
});
