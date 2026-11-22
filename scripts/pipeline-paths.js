'use strict';

// Developer import paths only; public overlay asset keys remain unchanged.
const fs = require('node:fs');
const path = require('node:path');
const { isGameLanguageFile } = require('../src/modules/gameLocales');
const TILE_COUNT = 196;

function sourcePaths(key) {
  if (key === 'Artifacts/ava_api_items.json') key = 'ava_api_items.json';
  if (key.startsWith('Languages/Languages_')) key = key.slice('Languages/'.length);
  if (key === 'maps/map-json' || key.startsWith('maps/map-json/')) key = key.replace(/^maps\//, 'map/');
  if (key === 'ava_api_items.json') return [`Artifacts/${key}`, key];
  if (isGameLanguageFile(key)) return [`Languages/${key}`, key];
  if (key === 'map/map-json' || key.startsWith('map/map-json/')) return [key.replace(/^map\//, 'maps/'), key];
  return [key];
}

function sourcePath(root, key) {
  const candidates = sourcePaths(key).map(name => path.join(root, name));
  return candidates.find(filename => fs.existsSync(filename)) || candidates[0];
}

function defaultSource(appDir) {
  const current = path.resolve(appDir, '../../soulframe-pipeline-runner/output');
  return fs.existsSync(current) ? current : path.resolve(appDir, '../../soulframe-pipeline-ouput');
}

function tilePaths(layout) {
  if (!Array.isArray(layout?.tiles) || layout.tiles.length !== TILE_COUNT) {
    throw new Error(`Tile layout must contain exactly ${TILE_COUNT} tiles`);
  }
  const result = new Map();
  for (const tile of layout.tiles) {
    const image = tile?.image;
    if (!Number.isInteger(tile?.index) || tile.index < 0 || tile.index >= TILE_COUNT || result.has(tile.index)) {
      throw new Error('Invalid or duplicate tile layout index');
    }
    if (typeof image !== 'string' || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.webp$/.test(image)) {
      throw new Error('Unsafe tile layout image path');
    }
    result.set(tile.index, image);
  }
  return result;
}

function localTilePaths(root, mapJSON = sourcePath(root, 'map/map-json')) {
  const mapRoot = path.dirname(mapJSON);
  const layoutFile = path.join(mapJSON, 'tile_layout.json');
  if (fs.existsSync(layoutFile)) {
    const layout = JSON.parse(fs.readFileSync(layoutFile, 'utf8').replace(/^\uFEFF/, ''));
    return new Map([...tilePaths(layout)].map(([index, image]) => [index, path.join(mapRoot, image)]));
  }
  // Older offline fixtures predate tile_layout.json.
  const tileDir = path.join(root, 'map', 'map-tiles');
  const names = fs.readdirSync(tileDir);
  const expected = Array.from({ length: TILE_COUNT }, (_, index) => `${index}.webp`);
  if (expected.some(name => !names.includes(name)) || names.some(name => /^\d+\.webp$/.test(name) && !expected.includes(name))) {
    throw new Error(`Map tiles must contain exactly 0.webp through ${TILE_COUNT - 1}.webp`);
  }
  return new Map(expected.map((name, index) => [index, path.join(tileDir, name)]));
}

module.exports = { sourcePaths, sourcePath, defaultSource, tilePaths, localTilePaths, TILE_COUNT };
