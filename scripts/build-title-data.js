'use strict';

// Read-only catalog authoring. Normal builds use the reviewed snapshot; an
// explicit refresh uses AWS CLI credentials, which never enter the app.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { projectEpithets, validateTitleCatalog, MAX_BYTES } = require('../src/modules/epithetsData');
const run = promisify(execFile);
const BUCKET = 'soulframe-pipeline-data';
const SOURCE_PATH = 'Artifacts/epithets.json';
const CATALOG_FILE = path.resolve(__dirname, '../src/data/title-catalog.json');
const SOURCE_FILE = path.resolve(__dirname, '../src/data/title-catalog-source.json');
const buildIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const catalogHash = catalog => createHash('sha256').update(JSON.stringify(catalog)).digest('hex');

async function awsObject(key) {
  try {
    const result = await run('aws', ['s3', 'cp', `s3://${BUCKET}/${key}`, '-', '--no-progress', '--region', 'us-east-1'], {
      encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout: 30000, windowsHide: true,
    });
    return result.stdout;
  } catch {
    throw new Error(`Could not read ${key} from the pipeline S3 bucket. Refreshing title data requires AWS CLI read access.`);
  }
}

async function loadBetaTitleCatalog({ getObject = awsObject } = {}) {
  const pointer = JSON.parse(await getObject('current.json'));
  if (!buildIdPattern.test(pointer?.build_id || '')) throw new Error('Invalid title data S3 build id');
  const prefix = `builds/${pointer.build_id}`;
  if ((pointer.prefix != null && pointer.prefix !== prefix)
    || (pointer.manifest != null && pointer.manifest !== `${prefix}/manifest.json`)) {
    throw new Error('Unexpected title data S3 manifest location');
  }
  const manifest = JSON.parse(await getObject(`${prefix}/manifest.json`));
  if (manifest?.build_id !== pointer.build_id || !Array.isArray(manifest.files)) throw new Error('Title data S3 pointer/manifest mismatch');
  const matching = manifest.files.filter(entry => entry?.path === SOURCE_PATH);
  const entry = matching[0];
  if (matching.length !== 1 || !sha256Pattern.test(entry?.sha256 || '')
    || !Number.isSafeInteger(entry?.bytes) || entry.bytes < 1 || entry.bytes > MAX_BYTES) {
    throw new Error('Missing or invalid epithets entry in the S3 manifest');
  }
  const bytes = Buffer.from(await getObject(`${prefix}/${SOURCE_PATH}`));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== entry.bytes || sha256 !== entry.sha256) throw new Error('Title data S3 content hash mismatch');
  const catalog = validateTitleCatalog(projectEpithets(JSON.parse(bytes.toString('utf8'))));
  return { catalog, source: { bucket: BUCKET, buildId: pointer.build_id, path: SOURCE_PATH, sha256 } };
}

function loadTitleCatalogSnapshot({ catalogPath = CATALOG_FILE, sourcePath = SOURCE_FILE } = {}) {
  if (fs.statSync(catalogPath).size > MAX_BYTES || fs.statSync(sourcePath).size > 4096) {
    throw new Error('Title catalog snapshot exceeds its size limit');
  }
  const catalog = validateTitleCatalog(JSON.parse(fs.readFileSync(catalogPath, 'utf8')));
  const provenance = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  if (provenance?.bucket !== BUCKET || !buildIdPattern.test(provenance.buildId || '')
    || provenance.path !== SOURCE_PATH || !sha256Pattern.test(provenance.sha256 || '')
    || !sha256Pattern.test(provenance.catalogSha256 || '')) {
    throw new Error('Invalid title catalog snapshot provenance');
  }
  if (catalogHash(catalog) !== provenance.catalogSha256) throw new Error('Title catalog snapshot hash mismatch');
  const { bucket, buildId, path: source, sha256 } = provenance;
  return { catalog, source: { bucket, buildId, path: source, sha256 } };
}

async function refreshTitleCatalogSnapshot({ catalogPath = CATALOG_FILE, sourcePath = SOURCE_FILE, ...options } = {}) {
  const data = await loadBetaTitleCatalog(options);
  const provenance = { ...data.source, catalogSha256: catalogHash(data.catalog) };
  for (const [filename, value] of [[catalogPath, data.catalog], [sourcePath, provenance]]) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value) + '\n');
    fs.renameSync(temporary, filename);
  }
  return data;
}

module.exports = { loadBetaTitleCatalog, loadTitleCatalogSnapshot, refreshTitleCatalogSnapshot,
  BUCKET, SOURCE_PATH, CATALOG_FILE, SOURCE_FILE };
if (require.main === module) {
  if (process.argv.length !== 3 || process.argv[2] !== '--refresh') {
    console.error('Usage: node scripts/build-title-data.js --refresh');
    process.exitCode = 1;
  } else refreshTitleCatalogSnapshot().then(data => {
    console.log(`[title-data] Saved ${data.catalog.titles.length} verified titles from S3 build ${data.source.buildId}`);
  }).catch(error => {
    console.error('[title-data]', error.message);
    process.exitCode = 1;
  });
}
