#!/usr/bin/env node
'use strict';

// Authoring only. Published S3 objects are hash-checked by openSource; nothing is uploaded.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { openSource, hash } = require('./overlay-feed/source');
const { sourcePath } = require('./pipeline-paths');
const { CATEGORIES, normalizeItemType, itemId, validIcon, validateCollectionCatalog } = require('../src/modules/collectionCatalog');
const { normalizeMasteryData } = require('../src/modules/masteryTracker');
const safeKey = value => typeof value === 'string' && /^\/SF\/Language\/[A-Za-z0-9_/-]+$/.test(value) ? value : null;
const safeName = value => typeof value === 'string' && value.trim() && value.length <= 400 ? value.trim() : null;
const cleanType = value => normalizeItemType(value);

function allowedItemTypes(availability) {
  if (availability?.schema !== 1 || !Array.isArray(availability.items) || !availability.items.length
      || availability.items.some(row => !cleanType(row?.itemType)
        || row.defaultOwned !== undefined && typeof row.defaultOwned !== 'boolean')) throw new Error('An explicit obtainable-item allowlist is required');
  return new Set(availability.items.map(row => itemId(row.itemType)));
}

function validateCatalogAvailability(catalog, availability) {
  const allowed = allowedItemTypes(availability);
  const defaultOwned = new Set(availability.items.filter(row => row.defaultOwned === true).map(row => itemId(row.itemType)));
  const references = catalog.items.flatMap(row => [row.itemType, ...(row.recipe ? [row.recipe.itemType,
    ...row.recipe.ingredients.flatMap(value => [value.itemType, ...value.alternatives])] : [])]);
  references.push(...catalog.mastery.items.map(row => row.itemType));
  if (catalog.mastery.excludedItemTypes.length || references.some(value => !allowed.has(itemId(value)))) {
    throw new Error('Collection catalogue contains an item outside the obtainable-item allowlist');
  }
  if (catalog.items.some(row => row.defaultOwned === true && !defaultOwned.has(row.id))) {
    throw new Error('Collection catalogue contains unapproved default ownership');
  }
  return catalog;
}

function projectCollectionData(source, masterySource, provenance, availability) {
  if (!Array.isArray(source?.items) || !masterySource?.formula || !masterySource?.sources) throw new Error('Incomplete collection sources');
  const allowed = allowedItemTypes(availability);
  const defaultOwned = new Set(availability.items.filter(row => row.defaultOwned === true).map(row => itemId(row.itemType)));
  const all = new Map();
  for (const item of source.items) if (allowed.has(itemId(item.path))) all.set(itemId(item.path), item);
  function ingredient(row, alternatives) {
    const itemType = cleanType(row?.item_path);
    const reference = all.get(itemId(itemType));
    if (!itemType || !allowed.has(itemId(itemType)) || !Number.isSafeInteger(row.count) || row.count <= 0) return null;
    return { itemType, name: safeName(reference?.name) || safeName(row.item) || itemType.split('/').at(-1),
      langKey: safeKey(reference?.lang_key), count: row.count,
      alternatives: (alternatives?.[row.item] || []).map(cleanType).filter(value => allowed.has(itemId(value))) };
  }
  const items = new Map();
  for (const row of source.items) {
    const itemType = cleanType(row.path), name = safeName(row.name), langKey = safeKey(row.lang_key);
    // The extraction includes pickup bundles and internal definitions. A real
    // localized name is required; ability/skill-tree definitions are not Pacts.
    if (!itemType || !allowed.has(itemId(itemType)) || !name || !langKey || !CATEGORIES.includes(row.category)
        || row.category === 'Soul' && !/Soul$/.test(itemType)) continue;
    const ingredients = (Array.isArray(row.ingredients) ? row.ingredients : []).map(value => ingredient(value, row.ingredient_alternatives));
    const recipeType = cleanType(row.crafting_recipe);
    const output = { id: itemId(itemType), itemType, name, langKey, descriptionKey: safeKey(row.lang_desc_key),
      category: row.category, subcategory: typeof row.subcategory === 'string' ? row.subcategory.slice(0, 160) : '',
      icon: validIcon(row.icon) ? row.icon : null,
      ...(defaultOwned.has(itemId(itemType)) && ['Armor', 'Cosmetic'].includes(row.category) ? { defaultOwned: true } : {}),
      recipe: recipeType && allowed.has(itemId(recipeType)) && ingredients.length && ingredients.every(Boolean) ? { itemType: recipeType, ingredients } : null };
    items.set(output.id, output);
  }
  const sections = masterySource.sources;
  const mastery = normalizeMasteryData({ levelXP: masterySource.formula.level_xp, itemRankXP: masterySource.formula.item_rank_xp,
    items: sections.items.entries.filter(row => items.has(itemId(row.type))).map(row => ({ itemType: cleanType(row.type), kind: row.kind, name: row.name,
      langKey: safeKey(row.name_key), subcategory: row.subcategory || '', masteryPerRank: row.mastery_per_rank,
      maxRank: row.max_rank, maxMastery: row.max_mastery, xpForMaxRank: row.xp_for_max_rank })),
    // A list of forbidden definitions would disclose those definitions too.
    excludedItemTypes: [],
    playerSkillsPerRank: sections.player_skills.mastery_per_rank });
  const discoveries = sections.location_lore.entries.map(row => ({ id: itemId(row.type), itemType: cleanType(row.type),
    name: row.name, langKey: safeKey(row.name_key), required: row.threshold, kind: 'location', masteryEligible: true, mastery: row.mastery }));
  for (const row of sections.world_trees.entries) {
    const itemType = '/SF/Types/Lore/MapTreeLoreFragmentMidrath';
    discoveries.push({ id: `${itemId(itemType)}:bit:${row.bit}`, itemType, name: row.name,
      langKey: safeKey(row.name_key), required: 1, kind: 'tree', bit: row.bit,
      masteryEligible: sections.world_trees.counts_in_client_formula === true, mastery: row.mastery });
  }
  return validateCatalogAvailability(validateCollectionCatalog({ schema: 1, source: provenance,
    items: [...items.values()].sort((a, b) => a.id.localeCompare(b.id)), mastery, discoveries }), availability);
}

async function buildCollectionData({ source, availability: availabilityFile = path.resolve(__dirname, 'data/collection-availability.json'), out = path.resolve(__dirname, '../src/data/collection-catalog.json') } = {}) {
  const availabilityBytes = await fs.readFile(availabilityFile);
  const availability = JSON.parse(availabilityBytes.toString('utf8').replace(/^\uFEFF/, ''));
  let items, mastery, provenance;
  if (source) {
    const root = path.resolve(source);
    const bytes = await fs.readFile(sourcePath(root, 'ava_api_items.json'));
    const masteryBytes = await fs.readFile(path.join(root, 'Artifacts/mastery.json'));
    items = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); mastery = JSON.parse(masteryBytes.toString('utf8').replace(/^\uFEFF/, ''));
    provenance = { buildId: 'local-authoring', generatedAt: items.metadata.generated_at, sha256: hash(bytes), masterySha256: hash(masteryBytes) };
  } else {
    const remote = await openSource({ cacheDir: path.resolve(__dirname, '../output/collection-source/cache') });
    const itemsKey = remote.resolveKey('ava_api_items.json');
    const masteryKey = remote.entries.has('Artifacts/mastery.json') ? 'Artifacts/mastery.json' : 'map/mastery.json';
    [items, mastery] = await Promise.all([remote.readJSON(itemsKey), remote.readJSON(masteryKey)]);
    provenance = { buildId: remote.pointer.build_id, generatedAt: remote.manifest.generated_at,
      sha256: remote.entries.get(itemsKey).sha256, masterySha256: remote.entries.get(masteryKey).sha256 };
  }
  provenance.availabilitySha256 = hash(availabilityBytes);
  const catalog = projectCollectionData(items, mastery, provenance, availability);
  await fs.mkdir(path.dirname(out), { recursive: true });
  const temporary = `${out}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(catalog) + '\n');
  await fs.rename(temporary, out);
  return { out, buildId: provenance.buildId, items: catalog.items.length, masteryItems: catalog.mastery.items.length, discoveries: catalog.discoveries.length };
}
if (require.main === module) {
  const options = {}, args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    if (!['--source', '--availability', '--out'].includes(args[index]) || !args[index + 1]) throw new Error('Usage: node scripts/build-collection-data.js [--source <pipeline output>] [--availability <reviewed allowlist>] [--out <filename>]');
    options[args[index].slice(2)] = args[++index];
  }
  buildCollectionData(options).then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { projectCollectionData, buildCollectionData, validateCatalogAvailability };
