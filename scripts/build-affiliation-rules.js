#!/usr/bin/env node
'use strict';

// Authoring only. Inspect the installed PE as bytes; never load or run game code.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
// FactionStanding.lua calls this gGameConfig method with the game player level.
// Its separate gGameData:GetDailyStandingLimit(bin) call supplies remaining favour.
const CAP_METHOD_ATOM = 0x2c7ac218;
const fail = message => { throw new Error(`Unrecognised affiliation rules: ${message}`); };

function readPE(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 0x100 || bytes.toString('ascii', 0, 2) !== 'MZ') fail('invalid executable');
  const pe = bytes.readUInt32LE(0x3c);
  if (pe + 0x108 > bytes.length || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0'
      || bytes.readUInt16LE(pe + 4) !== 0x8664 || bytes.readUInt16LE(pe + 24) !== 0x20b) fail('expected x64 PE');
  const count = bytes.readUInt16LE(pe + 6), optionalSize = bytes.readUInt16LE(pe + 20), optional = pe + 24;
  const base = bytes.readBigUInt64LE(optional + 24), table = optional + optionalSize;
  if (optionalSize < 112 || count < 1 || count > 96 || table + count * 40 > bytes.length) fail('invalid PE sections');
  const sections = [];
  for (let index = 0; index < count; index++) {
    const at = table + index * 40, rva = bytes.readUInt32LE(at + 12), size = bytes.readUInt32LE(at + 16), offset = bytes.readUInt32LE(at + 20);
    if (offset + size > bytes.length) fail('section outside executable');
    sections.push({ rva, size, offset, executable: Boolean(bytes.readUInt32LE(at + 36) & 0x20000000) });
  }
  const atRva = (rva, size) => {
    const section = sections.find(row => rva >= row.rva && rva + size <= row.rva + row.size);
    return section ? bytes.subarray(section.offset + rva - section.rva, section.offset + rva - section.rva + size) : null;
  };
  const codeRva = rva => sections.some(row => row.executable && rva >= row.rva && rva < row.rva + row.size);
  if (optionalSize < 144) fail('missing PE function index');
  const exceptionRva = bytes.readUInt32LE(optional + 136), exceptionSize = bytes.readUInt32LE(optional + 140);
  const index = exceptionSize && exceptionSize % 12 === 0 ? atRva(exceptionRva, exceptionSize) : null;
  if (!index) fail('missing PE function index');
  const functions = [];
  for (let at = 0; at < index.length; at += 12) functions.push({ start: index.readUInt32LE(at), end: index.readUInt32LE(at + 4) });
  const functionRange = rva => functions.find(row => row.start <= rva && rva < row.end);
  return { base, sections, atRva, codeRva, functionRange };
}

function extractAffiliationRules(bytes, { buildLabel } = {}) {
  if (!/^\d{4}\.\d{2}\.\d{2}\.\d{2}\.\d{2}$/.test(buildLabel || '')) fail('missing game build label');
  const pe = readPE(bytes), methods = [];
  const atom = Buffer.alloc(8); atom.writeUInt32LE(CAP_METHOD_ATOM);
  // A game Luau registration consists of atom u32, zero padding u32, function VA.
  for (const section of pe.sections.filter(row => !row.executable)) {
    const data = bytes.subarray(section.offset, section.offset + section.size);
    for (let at = data.indexOf(atom); at >= 0; at = data.indexOf(atom, at + 1)) {
      if (at + 16 > data.length) continue;
      const address = data.readBigUInt64LE(at + 8) - pe.base;
      if (address < 0n || address > 0xffffffffn || !pe.codeRva(Number(address))) continue;
      const wrapperRva = Number(address), wrapper = pe.atRva(wrapperRva, 0x80);
      if (!wrapper) continue;
      for (let call = 0; call + 5 <= wrapper.length; call++) {
        if (wrapper[call] !== 0xe8) continue;
        const formulaRva = wrapperRva + call + 5 + wrapper.readInt32LE(call + 1), formula = pe.atRva(formulaRva, 16);
        // imul edx,[rcx+perRank]; add edx,[rcx+base]; mov eax,edx; ret
        if (!pe.codeRva(formulaRva) || !formula || formula.subarray(0, 3).toString('hex') !== '0faf91'
            || formula.subarray(7, 9).toString('hex') !== '0391' || formula.subarray(13).toString('hex') !== '8bc2c3') continue;
        const perRankOffset = formula.readUInt32LE(3), baseOffset = formula.readUInt32LE(9);
        if (baseOffset < 4 || perRankOffset !== baseOffset + 4 || perRankOffset > 0x10000) continue;
        methods.push({ registrationRva: section.rva + at, wrapperRva, formulaRva, baseOffset, perRankOffset });
      }
    }
  }
  if (methods.length !== 1) fail('daily-cap binding or multiply-add formula changed or is ambiguous');
  const method = methods[0], defaults = [], configVtables = [];
  const className = Buffer.from('SFGameConfig\0');
  for (const section of pe.sections.filter(row => !row.executable)) {
    const data = bytes.subarray(section.offset, section.offset + section.size);
    for (let at = data.indexOf(className); at >= 0; at = data.indexOf(className, at + 1)) {
      if (at > 0 && data[at - 1] !== 0) continue;
      const vtableRva = Math.ceil((section.rva + at + className.length) / 8) * 8, pointer = pe.atRva(vtableRva, 8);
      if (!pointer) continue;
      const first = pointer.readBigUInt64LE() - pe.base;
      if (first >= 0n && first <= 0xffffffffn && pe.codeRva(Number(first))) configVtables.push(vtableRva);
    }
  }
  if (configVtables.length !== 1) fail('SFGameConfig type table changed or is ambiguous');
  for (const section of pe.sections.filter(row => row.executable)) {
    const data = bytes.subarray(section.offset, section.offset + section.size);
    for (let at = 0; at + 20 <= data.length; at++) {
      // Adjacent constructor stores using the same object register. The two
      // field offsets come from the proven daily-cap routine, not guessed names.
      if (data[at] !== 0xc7 || data[at + 1] < 0x80 || data[at + 1] > 0x87 || data[at + 1] === 0x84
          || data.readUInt32LE(at + 2) !== method.baseOffset || data[at + 10] !== 0xc7
          || data[at + 11] !== data[at + 1] || data.readUInt32LE(at + 12) !== method.perRankOffset) continue;
      // Other game classes can use the same offsets. Require this constructor
      // to install the table identified by the exact SFGameConfig class name.
      const range = pe.functionRange(section.rva + at);
      if (!range || range.start < section.rva) continue;
      let configConstructor = false;
      for (let lea = range.start - section.rva; lea + 7 <= at; lea++) {
        if (data[lea] === 0x48 && data[lea + 1] === 0x8d && (data[lea + 2] & 0xc7) === 0x05
            && section.rva + lea + 7 + data.readInt32LE(lea + 3) === configVtables[0]) configConstructor = true;
      }
      if (!configConstructor) continue;
      const base = data.readUInt32LE(at + 6), perRank = data.readUInt32LE(at + 16);
      if (!base || base > 1000000 || !perRank || perRank > 1000000) fail('invalid daily-cap coefficients');
      defaults.push({ base, perRank, rva: section.rva + at });
    }
  }
  if (defaults.length !== 1) fail('daily-cap constructor defaults changed or are ambiguous');
  const { base, perRank, rva } = defaults[0], hex = value => '0x' + value.toString(16);
  return { schema: 1, base, perRank, source: { buildLabel, sha256: createHash('sha256').update(bytes).digest('hex'),
    method: 'gGameConfig daily standing cap', bindingAtom: hex(CAP_METHOD_ATOM),
    registrationRva: hex(method.registrationRva), wrapperRva: hex(method.wrapperRva), formulaRva: hex(method.formulaRva),
    defaultsRva: hex(rva), classVtableRva: hex(configVtables[0]), baseFieldOffset: hex(method.baseOffset), perRankFieldOffset: hex(method.perRankOffset) } };
}

async function buildAffiliationRules({ executable, version, out = path.resolve(__dirname, '../src/data/affiliation-rules.json') } = {}) {
  if (!executable || !version) throw new Error('Provide --executable <Soulframe.x64.exe> and --version <versionInfo.json>');
  const bytes = await fs.readFile(path.resolve(executable));
  const info = JSON.parse((await fs.readFile(path.resolve(version), 'utf8')).replace(/^\uFEFF/, ''));
  const rules = extractAffiliationRules(bytes, { buildLabel: info.build_label });
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await fs.writeFile(path.resolve(out), JSON.stringify(rules, null, 2) + '\n');
  return { out, base: rules.base, perRank: rules.perRank, buildLabel: rules.source.buildLabel };
}

if (require.main === module) {
  const options = {}, args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    if (!['--executable', '--version', '--out'].includes(args[index]) || !args[index + 1]) {
      throw new Error('Usage: node scripts/build-affiliation-rules.js --executable <Soulframe.x64.exe> --version <versionInfo.json> [--out <file>]');
    }
    options[args[index].slice(2)] = args[++index];
  }
  buildAffiliationRules(options).then(value => console.log(JSON.stringify(value, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { CAP_METHOD_ATOM, readPE, extractAffiliationRules, buildAffiliationRules };
