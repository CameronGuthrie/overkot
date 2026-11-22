#!/usr/bin/env node
'use strict';

// Authoring only: project the installed game's Packages.bin extraction. No
// credentials, raw package data or account inventory are included in the result.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const WOLF_TYPE = '/SF/Types/Game/Pets/OmenWolfs/WolfCubPetPowerSuit';
const cap = value => Number.isSafeInteger(value) && value > 0 && value <= 1000000;

function packageNumber(value) {
  // Packages.bin can repeat a property; the formatter preserves those values
  // as an array. Only identical declarations describe an unambiguous scalar.
  const values = Array.isArray(value) ? value : [value];
  if (!values.length || !values.every(cap) || values.some(number => number !== values[0])) {
    throw new Error('Missing or conflicting wolf progression cap');
  }
  return values[0];
}

function projectWolfProgression(packages, source) {
  if (!packages || Array.isArray(packages) || typeof packages !== 'object'
      || !source || !/^[a-f0-9]{64}$/.test(source.sha256)
      || !/^\d{4}\.\d{2}\.\d{2}\.\d{2}\.\d{2}$/.test(source.buildLabel)) {
    throw new Error('Invalid wolf progression source');
  }
  const attributes = packages[WOLF_TYPE]?.attributes;
  return { schema: 1, source: { buildLabel: source.buildLabel, sha256: source.sha256, package: WOLF_TYPE },
    maxEnergy: packageNumber(attributes?.MaxEnergy), maxMaturity: packageNumber(attributes?.MaxMaturity) };
}

async function buildWolfProgression({ source, version, out = path.resolve(__dirname, '../src/data/wolf-progression.json') } = {}) {
  if (!source || !version) throw new Error('Provide --source <formatted_packages.json> and --version <versionInfo.json>');
  const bytes = await fs.readFile(path.resolve(source));
  const versionInfo = JSON.parse((await fs.readFile(path.resolve(version), 'utf8')).replace(/^\uFEFF/, ''));
  const result = projectWolfProgression(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')), {
    buildLabel: versionInfo.build_label, sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await fs.writeFile(out, JSON.stringify(result, null, 2) + '\n');
  return { out, maxEnergy: result.maxEnergy, maxMaturity: result.maxMaturity, buildLabel: result.source.buildLabel };
}

if (require.main === module) {
  const options = {}, args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    if (!['--source', '--version', '--out'].includes(args[index]) || !args[index + 1]) {
      throw new Error('Usage: node scripts/build-wolf-progression.js --source <formatted_packages.json> --version <versionInfo.json> [--out <file>]');
    }
    options[args[index].slice(2)] = args[++index];
  }
  buildWolfProgression(options).then(value => console.log(JSON.stringify(value, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { WOLF_TYPE, packageNumber, projectWolfProgression, buildWolfProgression };
