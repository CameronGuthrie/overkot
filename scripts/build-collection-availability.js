#!/usr/bin/env node
'use strict';

// Authoring only: public wiki entries and the moderated market feed establish
// a positive list. Unknown extraction rows never establish their own approval.
const fs = require('node:fs/promises');
const path = require('node:path');
const { openSource, hash } = require('./overlay-feed/source');
const { normalizeItemType, itemId } = require('../src/modules/collectionCatalog');

const TABLE_CATEGORIES = Object.freeze({
  Weapons: ['Weapon'], Armour: ['Armor'], Pacts: ['Soul'], Cosmetics: ['Cosmetic'],
  Totems: ['Totem'], Runes: ['Rune', 'Mote', 'Technique'], Joineries: ['Kintsugi'],
  CraftingResources: ['Resource', 'Key Item', 'Consumable', 'Kintsugi', 'Pact Upgrade', 'Mote', 'Rune', 'Technique'],
  Consumables: ['Consumable', 'Key Item'], Prisms: ['Key Item'],
  CraftingTable: ['Weapon', 'Armor', 'Soul', 'Cosmetic', 'Consumable', 'Resource', 'Totem', 'Kintsugi', 'Rune', 'Mote', 'Technique', 'Key Item'],
});
const EXCLUDED_TAGS = new Set(['unobtainable', 'archive', 'archived', 'off', 'disabled', 'upcoming content', 'upcoming']);
const MARKET_URL = 'https://avakot.market/api/v1/catalogue/feed';

/** Parse only literal Lua data. No Lua execution, functions, or expressions. */
function parseLuaTable(input) {
  if (typeof input !== 'string' || input.length > 2000000) throw new Error('Invalid wiki table');
  let position = 0;
  const fail = () => { throw new Error(`Unsupported wiki table syntax at offset ${position}`); };
  function longString() {
    const match = input.slice(position).match(/^\[(=*)\[/);
    if (!match) return null;
    position += match[0].length;
    const closing = `]${match[1]}]`, end = input.indexOf(closing, position);
    if (end < 0) fail();
    const result = input.slice(position, end).replace(/^\r?\n/, '');
    position = end + closing.length;
    return result;
  }
  function skip() {
    for (;;) {
      while (/\s/.test(input[position] || '') && position < input.length) position++;
      if (!input.startsWith('--', position)) return;
      position += 2;
      if (longString() === null) {
        const end = input.indexOf('\n', position);
        position = end < 0 ? input.length : end + 1;
      }
    }
  }
  function quoted() {
    const quote = input[position++];
    let result = '';
    while (position < input.length) {
      const character = input[position++];
      if (character === quote) return result;
      if (character !== '\\') { result += character; continue; }
      const escaped = input[position++];
      const escapes = { a: '\u0007', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"', "'": "'" };
      if (Object.hasOwn(escapes, escaped)) result += escapes[escaped];
      else if (/[0-9]/.test(escaped || '')) {
        const digits = escaped + (input.slice(position).match(/^[0-9]{0,2}/)?.[0] || '');
        if (Number(digits) > 255) fail();
        position += digits.length - 1; result += String.fromCharCode(Number(digits));
      } else if (escaped === '\n') result += '\n';
      else if (escaped === '\r') { if (input[position] === '\n') position++; result += '\n'; }
      else fail();
    }
    fail();
  }
  function value(depth = 0) {
    if (depth > 32) fail();
    skip();
    if (input[position] === '"' || input[position] === "'") return quoted();
    const multiline = longString();
    if (multiline !== null) return multiline;
    if (input[position] === '{') return table(depth + 1);
    const number = input.slice(position).match(/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\b/);
    if (number) { position += number[0].length; return Number(number[0]); }
    const literal = input.slice(position).match(/^(true|false|nil)\b/);
    if (literal) { position += literal[0].length; return literal[0] === 'nil' ? null : literal[0] === 'true'; }
    fail();
  }
  function table(depth) {
    const output = Object.create(null); let nextIndex = 1;
    position++;
    for (;;) {
      skip();
      if (input[position] === '}') { position++; return output; }
      let key;
      if (input[position] === '[' && !/^\[(=*)\[/.test(input.slice(position))) {
        position++; key = value(depth); skip();
        if (input[position++] !== ']') fail();
        skip(); if (input[position++] !== '=') fail();
      } else {
        const assignment = input.slice(position).match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (assignment) { key = assignment[1]; position += assignment[0].length; }
        else key = nextIndex++;
      }
      if (!['string', 'number'].includes(typeof key) || Object.hasOwn(output, key)) fail();
      output[key] = value(depth);
      skip();
      if (input[position] === ',' || input[position] === ';') position++;
      else if (input[position] !== '}') fail();
    }
  }
  skip();
  if (!/^return\b/.test(input.slice(position))) fail();
  position += 6;
  const result = value(); skip();
  if (position !== input.length || !result || typeof result !== 'object') fail();
  return result;
}

function hasTags(raw, wanted) {
  if (raw == null || raw === '') return false;
  if (typeof raw === 'string') return raw.split(/[,;]+/).some(tag => wanted.has(tag.trim().toLowerCase()));
  if (typeof raw === 'object') return Object.values(raw).some(value => hasTags(value, wanted));
  throw new Error('Unsupported wiki tags');
}
const excludedTags = raw => hasTags(raw, EXCLUDED_TAGS);
const preOwnedTags = raw => hasTags(raw, new Set(['pre-owned']));

function projectAvailability({ sourceItems, wikiTables, marketItems, sources, generatedAt }) {
  if (!Array.isArray(sourceItems) || !sourceItems.length || !Array.isArray(marketItems) || !marketItems.length
      || !Array.isArray(wikiTables) || !wikiTables.length) throw new Error('Incomplete availability sources');
  const allowed = new Map(), denied = new Set();
  const add = (raw, evidence, defaultOwned = false) => {
    const itemType = normalizeItemType(raw);
    if (!itemType) return;
    const key = itemId(itemType), row = allowed.get(key) || { itemType, evidence: [] };
    for (const index of evidence) if (!row.evidence.includes(index)) row.evidence.push(index);
    if (defaultOwned) row.defaultOwned = true;
    allowed.set(key, row);
  };
  for (const { table, data, sourceIndex, identitySourceIndex } of wikiTables) {
    const categories = TABLE_CATEGORIES[table];
    if (!categories || !data || typeof data !== 'object' || !Object.keys(data).length) throw new Error('Invalid wiki availability table');
    for (const [name, row] of Object.entries(data)) {
      if (!row || typeof row !== 'object') throw new Error('Invalid wiki availability row');
      const direct = normalizeItemType(row.InternalID);
      const candidates = sourceItems.filter(item => item.name === name && categories.includes(item.category));
      const types = [...new Map(candidates.map(item => [itemId(item.path), normalizeItemType(item.path)]))]
        .map(([, value]) => value).filter(Boolean);
      if (excludedTags(row.Tags ?? row.tags)) {
        for (const itemType of [...types, direct].filter(Boolean)) denied.add(itemId(itemType));
      } else if (table !== 'CraftingTable') {
        // Default appearances need no inventory copy. Keep the reviewed tag
        // only after the same exact identity check used for approval.
        const defaultOwned = ['Cosmetics', 'Armour'].includes(table) && preOwnedTags(row.Tags ?? row.tags);
        if (direct) add(direct, [sourceIndex], defaultOwned);
        else if (types.length === 1) add(types[0], [sourceIndex, identitySourceIndex], defaultOwned);
      }
    }
  }
  const marketSourceIndex = sources.findIndex(source => source.url === MARKET_URL);
  if (marketSourceIndex < 0) throw new Error('Missing approved market provenance');
  // A recipe can expose its excluded product through a blueprint row, even if
  // the market separately approved that recipe. Product denial takes precedence.
  for (const row of sourceItems) {
    if (!denied.has(itemId(row.path))) continue;
    const recipeType = normalizeItemType(row.crafting_recipe);
    if (recipeType) denied.add(itemId(recipeType));
  }
  for (const row of marketItems) add(row.path, [marketSourceIndex]);
  // A public crafting entry establishes the recipe of an independently approved
  // product. It does not approve its ingredients, alternatives, or other copies.
  for (const { table, data, sourceIndex, identitySourceIndex } of wikiTables) {
    if (table !== 'CraftingTable') continue;
    for (const [name, row] of Object.entries(data)) {
      if (excludedTags(row.Tags ?? row.tags) || !row.Ingredients || !Object.keys(row.Ingredients).length) continue;
      const candidates = sourceItems.filter(item => item.name === name && TABLE_CATEGORIES.CraftingTable.includes(item.category)
        && allowed.has(itemId(item.path)) && !denied.has(itemId(item.path)));
      const recipes = [...new Set(candidates.map(item => normalizeItemType(item.crafting_recipe)).filter(Boolean))];
      if (recipes.length === 1) add(recipes[0], [sourceIndex, identitySourceIndex]);
    }
  }
  const items = [...allowed.values()].filter(row => !denied.has(itemId(row.itemType)))
    .map(row => ({ ...row, evidence: row.evidence.sort((a, b) => a - b) }))
    .sort((a, b) => a.itemType.localeCompare(b.itemType));
  if (!items.length || !sources.every(source => typeof source.url === 'string' && /^[a-f0-9]{64}$/.test(source.sha256))
      || !items.every(row => row.evidence.length && row.evidence.every(index => Number.isInteger(index) && sources[index]))) {
    throw new Error('Invalid availability projection');
  }
  return { schema: 1, generatedAt, sources, items };
}

async function buildCollectionAvailability({ source, out = path.resolve(__dirname, 'data/collection-availability.json'), fetcher = fetch } = {}) {
  let sourceItems, identitySource;
  if (source) {
    const bytes = await fs.readFile(path.resolve(source));
    sourceItems = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')).items;
    identitySource = { url: 'pipeline:ava_api_items.json', sha256: hash(bytes) };
  } else {
    const remote = await openSource({ cacheDir: path.resolve(__dirname, '../output/collection-source/cache') });
    const key = remote.resolveKey('ava_api_items.json');
    sourceItems = (await remote.readJSON(key)).items;
    identitySource = { url: 'pipeline:ava_api_items.json', sha256: remote.entries.get(key).sha256, buildId: remote.pointer.build_id };
  }
  const sources = [identitySource], wikiTables = [];
  for (const table of Object.keys(TABLE_CATEGORIES)) {
    const url = `https://wiki.avakot.org/index.php?title=Module:Data/${table}&action=raw`;
    const response = await fetcher(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Wiki availability source ${table} returned HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const sourceIndex = sources.length;
    sources.push({ url, sha256: hash(bytes), table });
    wikiTables.push({ table, data: parseLuaTable(bytes.toString('utf8')), sourceIndex, identitySourceIndex: 0 });
  }
  const response = await fetcher(MARKET_URL, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Approved market availability source returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer()), market = JSON.parse(bytes.toString('utf8'));
  sources.push({ url: MARKET_URL, sha256: hash(bytes) });
  const value = projectAvailability({ sourceItems, wikiTables, marketItems: market.items, sources, generatedAt: new Date().toISOString() });
  await fs.mkdir(path.dirname(out), { recursive: true });
  const temporary = `${out}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(temporary, out);
  return { out, items: value.items.length, sources: value.sources.length };
}

if (require.main === module) {
  const options = {}, args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    if (!['--source', '--out'].includes(args[index]) || !args[index + 1]) throw new Error('Usage: node scripts/build-collection-availability.js [--source <items.json>] [--out <filename>]');
    options[args[index].slice(2)] = args[++index];
  }
  buildCollectionAvailability(options).then(value => console.log(JSON.stringify(value)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { TABLE_CATEGORIES, MARKET_URL, parseLuaTable, excludedTags, projectAvailability, buildCollectionAvailability };
