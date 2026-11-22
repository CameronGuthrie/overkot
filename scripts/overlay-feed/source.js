'use strict';
// Authoring/audit tooling only. Credentials stay in the AWS CLI, never in a feed.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { sourcePaths, tilePaths, TILE_COUNT } = require('../pipeline-paths');
const { isGameLanguageFile } = require('../../src/modules/gameLocales');
const run = promisify(execFile);
const BUCKET = 'soulframe-pipeline-data';
const API = 'https://d2855gck1tg5bh.cloudfront.net';
const IMAGES = 'https://dap1x6lmnonv6.cloudfront.net';
const LAYERS = ['faction_enclaves', 'world_trees', 'avakot_spawns', 'sap_trees', 'vadagar_pools', 'ode_organs', 'boss_encounters', 'named_locations', 'dungeon_entrances'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const validFile = key => ['ava_api_items.json', 'Artifacts/ava_api_items.json', 'Artifacts/mastery.json', 'map/mastery.json', 'weapons.json', 'zenith-calendar.json', 'gods-and-ghosts-calendar.json/index.json'].includes(key)
  || isGameLanguageFile(key.replace(/^Languages\//, ''))
  || /^gods-and-ghosts-calendar\.json\/[a-z0-9-]+\.json$/.test(key)
  || [...LAYERS, 'tile_layout'].some(name => [`map/map-json/${name}.json`, `maps/map-json/${name}.json`].includes(key));
const validTile = key => /^(?:map\/map-tiles|maps\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)\/(?:0|[1-9]\d{0,2})\.webp$/.test(key);
const validImage = key => /^\/SF\/Interface\/Graphics\/Aspects\/[A-Za-z0-9_/-]+\.png$/.test(key) && !key.includes('..');

async function outputDirectory(value) {
  const root = path.resolve(__dirname, '../../output');
  const out = path.resolve(value);
  const within = target => target === root || target.startsWith(root + path.sep);
  if (!within(out) || out === root) throw new Error('Output must be a subdirectory of App/output');
  // Do not follow an existing junction outside the intended workspace.
  for (let cursor = out; within(cursor); cursor = path.dirname(cursor)) {
    try { if (!within(await fs.realpath(cursor))) throw new Error('Output resolves outside App/output'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await fs.mkdir(out, { recursive: true }); return out;
}
async function awsObject(key) {
  const result = await run('aws', ['s3', 'cp', `s3://${BUCKET}/${key}`, '-', '--no-progress', '--region', 'us-east-1'],
    { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout: 30000, windowsHide: true });
  return result.stdout;
}
async function pool(items, fn, concurrency = 4) {
  const results = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await fn(items[index], index); }
  }));
  return results;
}
async function openSource({ cacheDir, getObject = awsObject } = {}) {
  const pointer = JSON.parse(await getObject('current.json'));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(pointer.build_id)) throw new Error('Invalid S3 build id');
  const prefix = pointer.prefix ?? `builds/${pointer.build_id}`;
  if (prefix !== `builds/${pointer.build_id}` || (pointer.manifest && pointer.manifest !== `${prefix}/manifest.json`)) throw new Error('Unexpected S3 manifest location');
  const manifest = JSON.parse(await getObject(`${prefix}/manifest.json`));
  if (manifest.build_id !== pointer.build_id || !Array.isArray(manifest.files)) throw new Error('S3 pointer/manifest mismatch');
  const entries = new Map();
  for (const entry of manifest.files) {
    if (!validFile(entry.path) && !validTile(entry.path)) continue;
    if (entries.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > 8 * 1024 * 1024) throw new Error('Invalid required S3 manifest entry');
    entries.set(entry.path, entry);
  }
  if (cacheDir) await fs.mkdir(cacheDir, { recursive: true });
  const reads = new Map();
  const resolveKey = key => sourcePaths(key).find(candidate => entries.has(candidate)) || sourcePaths(key)[0];
  async function readBytes(key) {
    if (!validFile(key)) throw new Error('File outside overlay source allowlist');
    key = resolveKey(key);
    const entry = entries.get(key);
    if (!entry) throw new Error(`Missing from published S3 build: ${key}`);
    let bytes;
    const cached = cacheDir && path.join(cacheDir, entry.sha256);
    if (cached) bytes = await fs.readFile(cached).catch(() => null);
    if (!bytes || bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) {
      bytes = await getObject(`${prefix}/${key}`);
      if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error(`S3 content hash mismatch: ${key}`);
      if (cached) await fs.writeFile(cached, bytes);
    }
    return bytes;
  }
  const source = { pointer, manifest, entries, resolveKey, readBytes, readJSON(key) {
    if (!reads.has(key)) reads.set(key, readBytes(key).then(bytes => JSON.parse(bytes.toString('utf8'))));
    return reads.get(key);
  }, async tileEntries() {
    const layoutKey = resolveKey('map/map-json/tile_layout.json');
    const images = entries.has(layoutKey) ? tilePaths(await source.readJSON(layoutKey))
      : new Map(Array.from({ length: TILE_COUNT }, (_, index) => [index, `map-tiles/${index}.webp`]));
    const mapRoot = layoutKey.startsWith('maps/') && entries.has(layoutKey) ? 'maps' : 'map';
    return new Map([...images].map(([index, image]) => {
      const key = `${mapRoot}/${image}`;
      return [index, { path: key, entry: entries.get(key) }];
    }));
  } };
  return source;
}
async function probe(url) {
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(10000) });
    return { url, status: response.status, bytes: Number(response.headers.get('content-length')) || null,
      type: response.headers.get('content-type'), etag: response.headers.get('etag'), sha256: response.headers.get('x-amz-meta-sha256') };
  } catch (error) { return { url, error: error.message }; }
}
module.exports = { BUCKET, API, IMAGES, LAYERS, hash, canonical, validFile, validImage, pool, outputDirectory, openSource, probe };
