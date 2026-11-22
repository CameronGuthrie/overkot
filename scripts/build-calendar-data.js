#!/usr/bin/env node
'use strict';

// Compact the two pipeline calendars to one tiny, independently updatable feed.
// Writes only inside App; publishing is a separate, deliberate operation.
const fs = require('node:fs/promises');
const path = require('node:path');
const { brotliCompressSync, constants } = require('node:zlib');
const { createHash } = require('node:crypto');
const { projectCalendar } = require('../src/modules/calendarData');
const { defaultSource } = require('./pipeline-paths');
const root = path.resolve(__dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const readJSON = async filename => JSON.parse((await fs.readFile(filename, 'utf8')).replace(/^\uFEFF/, ''));

async function buildCalendar({ source = defaultSource(root), bundle = false } = {}) {
  const directory = path.join(source, 'gods-and-ghosts-calendar.json');
  const index = await readJSON(path.join(directory, 'index.json'));
  if (!Array.isArray(index.variations) || index.variations.length !== 64) throw new Error('Calendar index requires 64 variations');
  const variations = await Promise.all(index.variations.map(entry => {
    if (typeof entry.file !== 'string' || !/^[a-z0-9-]+\.json$/.test(entry.file)) throw new Error('Invalid variation filename');
    return readJSON(path.join(directory, entry.file));
  }));
  const data = projectCalendar(await readJSON(path.join(source, 'zenith-calendar.json')), index, variations);
  const bytes = Buffer.from(JSON.stringify(data));
  const compressed = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT } });
  const manifest = { schema: 1, sha256: hash(bytes), bytes: bytes.length, downloadBytes: compressed.length, url: `objects/${hash(compressed)}.json.br` };
  const out = path.join(root, 'output/calendar-feed');
  await fs.mkdir(path.join(out, 'objects'), { recursive: true });
  await fs.writeFile(path.join(out, manifest.url), compressed);
  await fs.writeFile(path.join(out, 'manifest.json.tmp'), JSON.stringify(manifest));
  await fs.rename(path.join(out, 'manifest.json.tmp'), path.join(out, 'manifest.json'));
  if (bundle) await fs.writeFile(path.join(root, 'src/data/calendar.json'), bytes);
  return { out, bundled: bundle, zenithDays: data.zenith.days.length, encounterDays: data.encounters.days.length, ...manifest };
}

async function main() {
  const options = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bundle') options.bundle = true;
    else if (args[i] === '--source' && args[i + 1] && !args[i + 1].startsWith('--')) options.source = path.resolve(args[++i]);
    else throw new Error('Usage: node scripts/build-calendar-data.js [--source <pipeline directory>] [--bundle]');
  }
  console.log(JSON.stringify(await buildCalendar(options), null, 2));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildCalendar };
