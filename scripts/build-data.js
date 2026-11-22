#!/usr/bin/env node
'use strict';

// Produce a static feed. Nothing is uploaded and no credentials are needed.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { sourcePath, defaultSource, localTilePaths, TILE_COUNT } = require('./pipeline-paths');

const brotliCompress = promisify(zlib.brotliCompress);
const APP_DIR = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(APP_DIR, 'output');
const DEFAULT_SOURCE = defaultSource(APP_DIR);
const DEFAULT_OUT = path.join(OUTPUT_DIR, 'data-feed');
const POI_LAYERS = [
  'faction_enclaves', 'world_trees', 'avakot_spawns', 'sap_trees',
  'vadagar_pools', 'ode_organs', 'boss_encounters', 'named_locations',
  'dungeon_entrances',
];
const FACTION_TYPES = new Set([
  'MapChampionFactionMarkerInfo', 'MapFeyFactionMarkerInfo', 'MapSilentRoseFactionMarkerInfo',
]);

function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Cannot publish non-JSON data');
  return encoded;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function validateOutputDirectory(out) {
  if (!isWithin(OUTPUT_DIR, out)) throw new Error(`--out must be a subdirectory of ${OUTPUT_DIR}`);
  // Check existing ancestors too, so a symlink/junction cannot redirect writes
  // outside App/output. No cleanup or recursive deletion is performed here.
  const appReal = await fs.realpath(APP_DIR);
  const expectedRoot = path.join(appReal, 'output');
  let cursor = out;
  while (cursor !== APP_DIR) {
    try {
      const real = await fs.realpath(cursor);
      if (real !== expectedRoot && !isWithin(expectedRoot, real)) {
        throw new Error(`Output path resolves outside App/output: ${cursor}`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error('Invalid output path');
    cursor = parent;
  }
}

function validPosition(value) {
  return value && ['x', 'y', 'z'].every(axis => typeof value[axis] === 'number' && Number.isFinite(value[axis])) &&
    Math.abs(value.x) <= 1792 && Math.abs(value.z) <= 1792;
}

function projectMapLayer(name, data) {
  const arrayKey = name === 'faction_enclaves' ? 'enclaves' : name === 'vadagar_pools' ? 'pools' : 'positions';
  const arrayLayer = name === 'boss_encounters' || name === 'named_locations';
  const rows = name === 'dungeon_entrances'
    ? require('../src/renderer/map-pois').rows(name, data) : arrayLayer ? data : data?.[arrayKey];
  if (!Array.isArray(rows)) throw new Error(`${name}.json has an incompatible shape`);
  const visible = rows.filter(row => {
    if (!row || typeof row !== 'object') return false;
    if (row.enabled === false) return false;
    if (name === 'boss_encounters') return !row.is_siege && row.position
      && !['BossBanneret', 'BossBanneretPatrol', 'BossCollectorShip'].includes(row.subboss_type);
    if (name === 'named_locations') return row.has_position === true;
    if (name === 'faction_enclaves') return FACTION_TYPES.has(row.entity_type);
    if (name === 'avakot_spawns') return row.npc_type === 'AvakotVendorNpc';
    return true;
  });
  for (const row of visible) {
    if (!validPosition(row.position)) throw new Error(`${name}.json has a marker outside the current map or invalid XYZ coordinates`);
    if (name === 'boss_encounters' && typeof row.subboss_type !== 'string') {
      throw new Error(`${name}.json has a boss without subboss_type`);
    }
  }
  // Keep only fields consumed by the overlay. Extraction notes, asset paths,
  // byte offsets and other raw pipeline details do not belong in a client pack.
  const keys = ['position', 'name', 'loc_tag', 'has_position', 'entity_type', 'faction',
    'npc_type', 'enabled', 'start_hidden', 'tag', 'subboss_type', 'camp_tag', 'is_siege',
    'category', 'marker_kind'];
  const compact = visible.map(row => Object.fromEntries(keys.filter(key => row[key] !== undefined)
    .map(key => [key, row[key]])));
  return arrayLayer ? compact : { [arrayKey]: compact };
}

function projectLocations(language, mapLayers) {
  const required = new Set([
    '/SF/Language/NPC/Avakot', '/SF/Language/Items/WevetWoodSap',
    ...mapLayers.named_locations.map(row => row.loc_tag).filter(Boolean),
    ...mapLayers.boss_encounters.map(row => `/SF/Language/Characters/${row.subboss_type}`),
  ]);
  return Object.fromEntries(Object.entries(language).filter(([key, value]) =>
    typeof value === 'string' && (key.startsWith('/SF/Language/Locations/') || required.has(key))));
}

async function readJSON(filename) {
  return JSON.parse((await fs.readFile(filename, 'utf8')).replace(/^\uFEFF/, ''));
}

async function writeAtomic(filename, bytes) {
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx' });
    await fs.rename(temporary, filename);
  } finally {
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function buildData(options = {}) {
  const source = path.resolve(options.source || DEFAULT_SOURCE);
  const out = path.resolve(options.out || DEFAULT_OUT);
  const mapJSON = path.resolve(options.mapJSON || sourcePath(source, 'map/map-json'));
  await validateOutputDirectory(out);
  await validateOutputDirectory(path.join(out, 'objects'));
  const { deriveNames, CACHE_VERSION, SUPPORTED_LOCALES } = require('../src/modules/languageNames');
  if (typeof deriveNames !== 'function') throw new Error('languageNames must export deriveNames for feed generation');

  // Validate every source before creating output. A partial extraction must not
  // replace a complete public map, even if a JSON parser accepts it.
  const layers = {};
  for (const name of POI_LAYERS) {
    try {
      layers[name] = projectMapLayer(name, await readJSON(path.join(mapJSON, `${name}.json`)));
    } catch (error) {
      if (name === 'dungeon_entrances' && error.code === 'ENOENT') { layers[name] = null; continue; }
      throw new Error(`${error.message}. Fix the map extraction or pass --map-json <validated map directory>.`);
    }
  }
  const tileFiles = localTilePaths(source);
  const expectedTiles = Array.from({ length: TILE_COUNT }, (_, index) => `${index}.webp`);
  const pending = [];
  for (const [index, name] of expectedTiles.entries()) {
    const bytes = await fs.readFile(tileFiles.get(index));
    if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') {
      throw new Error(`${name} is not a WebP image`);
    }
    pending.push({ key: `map-tiles/${name}`, bytes, encoding: 'identity', suffix: '.webp' });
  }
  const addJSON = (key, value) => pending.push({ key, bytes: Buffer.from(canonicalJSON(value)), encoding: 'br', suffix: '.json.br' });
  for (const name of POI_LAYERS) if (layers[name] !== null) addJSON(`map-json/${name}.json`, layers[name]);
  for (const locale of SUPPORTED_LOCALES) {
    const language = await readJSON(sourcePath(source, `Languages_${locale}.json`));
    if (!language || Array.isArray(language) || typeof language !== 'object') {
      throw new Error(`Languages_${locale}.json must be a translation dictionary`);
    }
    const names = deriveNames(language, locale);
    const locations = projectLocations(language, layers);
    if (!Object.keys(names).length || !Object.keys(locations).length) {
      throw new Error(`Languages_${locale}.json does not contain the required overlay translations`);
    }
    addJSON(`names/${locale}.json`, names);
    addJSON(`locations/${locale}.json`, locations);
  }
  addJSON('timers/durations.json', await readJSON(path.join(APP_DIR, 'src', 'data', 'timerDurations.json')));

  await fs.mkdir(path.join(out, 'objects'), { recursive: true });
  const files = {};
  const stats = { files: pending.length, objectsWritten: 0, bytes: 0, downloadBytes: 0, jsonBytes: 0, jsonDownloadBytes: 0 };
  for (const entry of pending.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) {
    const hash = sha256(entry.bytes);
    const compressed = entry.encoding === 'br' ? await brotliCompress(entry.bytes, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT },
    }) : entry.bytes;
    // The object URL identifies its exact wire bytes. A different Brotli
    // encoder can emit a different stream for identical decoded JSON.
    const url = `objects/${sha256(compressed)}${entry.suffix}`;
    const filename = path.join(out, url);
    const existing = await fs.readFile(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!existing || !existing.equals(compressed)) {
      await writeAtomic(filename, compressed);
      stats.objectsWritten++;
    }
    files[entry.key] = { sha256: hash, bytes: entry.bytes.length, encoding: entry.encoding, downloadBytes: compressed.length, url };
    stats.bytes += entry.bytes.length;
    stats.downloadBytes += compressed.length;
    if (entry.encoding === 'br') { stats.jsonBytes += entry.bytes.length; stats.jsonDownloadBytes += compressed.length; }
  }
  const manifest = { schema: 1, namesVersion: CACHE_VERSION, version: sha256(canonicalJSON(files)), files };
  const manifestBytes = Buffer.from(canonicalJSON(manifest));
  await writeAtomic(path.join(out, 'manifest.json'), manifestBytes);
  return { out, source, mapJSON, manifest, stats: { ...stats, manifestBytes: manifestBytes.length } };
}

function parseArguments(args) {
  const options = {};
  const fields = { '--source': 'source', '--out': 'out', '--map-json': 'mapJSON' };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (!fields[argument] || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new Error(`Unknown option or missing value: ${argument}`);
    }
    options[fields[argument]] = args[++index];
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/build-data.js [--source <pipeline directory>] [--map-json <validated map directory>] [--out <App/output/subdirectory>]');
    return;
  }
  const result = await buildData(options);
  console.log(JSON.stringify({ out: result.out, mapJSON: result.mapJSON, version: result.manifest.version, ...result.stats }, null, 2));
}

if (require.main === module) main().catch(error => { console.error(`Data feed build failed: ${error.message}`); process.exitCode = 1; });

module.exports = { buildData, canonicalJSON, projectMapLayer, projectLocations, parseArguments, validateOutputDirectory, POI_LAYERS, TILE_COUNT };
