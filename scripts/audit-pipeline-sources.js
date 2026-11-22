'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { API, IMAGES, LAYERS, hash, validImage, pool, outputDirectory, openSource, probe } = require('./overlay-feed/source');
const { sourcePath, TILE_COUNT } = require('./pipeline-paths');

async function audit({ out = path.resolve(__dirname, '../output/pipeline-source-audit'), local } = {}) {
  out = await outputDirectory(out);
  const source = await openSource({ cacheDir: path.join(out, 'source-cache') });
  const required = ['ava_api_items.json', 'weapons.json', 'Languages_en.json', 'zenith-calendar.json', 'gods-and-ghosts-calendar.json/index.json',
    ...LAYERS.map(name => `map/map-json/${name}.json`)];
  if (source.entries.has('gods-and-ghosts-calendar.json/index.json')) {
    const index = await source.readJSON('gods-and-ghosts-calendar.json/index.json');
    for (const row of index.variations || []) {
      if (!/^[a-z0-9-]+\.json$/.test(row.file)) throw new Error('Invalid calendar variation');
      required.push(`gods-and-ghosts-calendar.json/${row.file}`);
    }
  }
  const datasets = await pool(required, async key => {
    key = source.resolveKey(key);
    const entry = source.entries.get(key);
    const row = { path: key, inS3Manifest: !!entry, sha256: entry?.sha256, bytes: entry?.bytes };
    if (entry) { await source.readJSON(key); row.s3HashVerified = true; }
    if (local) {
      const bytes = await fs.readFile(sourcePath(path.resolve(local), key)).catch(() => null);
      row.localPresent = !!bytes; row.matchesLocal = !!entry && !!bytes && hash(bytes) === entry.sha256;
    }
    row.public = await probe(`${API}/files/${key}`); return row;
  });
  const weapons = await source.readJSON('weapons.json');
  const catalogue = await source.readJSON('ava_api_items.json');
  const iconPaths = [...new Set([...weapons.weapons.flatMap(row => row.possibleTempers || []), ...catalogue.items.filter(row => row.category === 'Temper')]
    .map(row => row.icon).filter(validImage))].sort();
  const icons = await pool(iconPaths, icon => probe(IMAGES + icon));
  const tileEntries = await source.tileEntries();
  const tiles = await pool(Array.from({ length: TILE_COUNT }, (_, index) => index), async index => {
    const { path: key, entry } = tileEntries.get(index);
    return { name: `${index}.webp`, path: key, inS3Manifest: !!entry, sha256: entry?.sha256,
      public: await probe(`${IMAGES}/map/map-tiles/${index}.webp`) };
  });
  const feeds = await pool(['/overlay-data/manifest.json', '/overlay-data/calendar/manifest.json', '/map/map-tiles-manifest.json'], key => probe(IMAGES + key));
  const issues = [];
  for (const row of datasets) {
    if (!row.inS3Manifest) issues.push(`${row.path}: absent from the published S3 manifest`);
    // Raw routes are intentionally restricted. Their status is informational;
    // use check-overlay-client.js to validate public projected data access.
  }
  for (const row of icons) if (row.status !== 200) issues.push(`Required icon unavailable: ${row.url}`);
  for (const row of tiles) if (!row.inS3Manifest) issues.push(`${row.path}: absent from the published S3 manifest`);
  for (const row of tiles) if (row.public.status !== 200) issues.push(`Required tile unavailable: ${row.name}`);
  const report = { checkedAt: new Date().toISOString(), build: source.pointer.build_id, generatedAt: source.manifest.generated_at,
    publishedFileCount: source.manifest.files.length, datasets, icons, tiles, feeds, issues,
    summary: { requiredDatasets: datasets.length, verifiedS3Datasets: datasets.filter(row => row.s3HashVerified).length,
      publicDatasets: datasets.filter(row => row.public.status === 200).length, publicIcons: icons.filter(row => row.status === 200).length,
      iconCount: icons.length, publicTiles: tiles.filter(row => row.public.status === 200).length,
      tileCount: tiles.length, missing: datasets.filter(row => !row.inS3Manifest).map(row => row.path),
      differsFromLocal: local ? datasets.filter(row => row.localPresent && !row.matchesLocal).map(row => row.path) : undefined } };
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  return { out, build: report.build, ...report.summary };
}
if (require.main === module) {
  const options = {}, args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    if (!['--out', '--local'].includes(args[index]) || !args[index + 1]) throw new Error('Usage: node scripts/audit-pipeline-sources.js [--local <pipeline directory>] [--out <App/output/subdirectory>]');
    options[args[index].slice(2)] = args[++index];
  }
  audit(options).then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { audit };
