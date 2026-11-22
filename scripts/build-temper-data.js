// node scripts/build-temper-data.js <TemperList-directory> <pipeline-output-directory>
// Projects reference labels and the pipeline's game IDs and content-addressed PNG icons.
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { sourcePath } = require('./pipeline-paths');
const key = value => String(value || '').toLowerCase().replace('/sf/storeitems/', '/sf/');

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function projectTemperData(reference, weapons, items, readPipelineIcon) {
  const definitions = items.filter(row => row.category === 'Temper');
  const aliases = {}, ambiguous = new Set();
  const addAlias = (alias, id) => {
    if (!alias) return;
    const normalized = key(alias);
    if (aliases[normalized] && aliases[normalized] !== id) ambiguous.add(normalized);
    aliases[normalized] = id;
  };
  const tempers = reference.map(row => {
    const candidates = definitions.filter(item => item.tag === row.internalId);
    const named = definitions.filter(item => item.name === row.name);
    const item = named.length === 1 ? named[0] : candidates.length === 1 ? candidates[0] : null;
    if (!item?.lang_key) throw new Error(`No unique game mapping for ${row.name}`);
    if (!/^\/SF\/Interface\/Graphics\/Aspects\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.png$/.test(item.icon)) {
      throw new Error(`Invalid pipeline temper icon for ${row.name}`);
    }
    const bytes = readPipelineIcon(item.icon);
    if (bytes.length <= pngSignature.length || !bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
      throw new Error(`Invalid temper PNG for ${row.name}`);
    }
    const icon = `temper-icons/${createHash('sha256').update(bytes).digest('hex')}.png`;
    // TemperList corrects the older pipeline's Cowp tag. Use the reference's
    // InternalID; pipeline paths/language keys still supply canonical identity.
    for (const alias of [row.internalId, item.lang_key, item.path, item.unique_name]) addAlias(alias, item.lang_key);
    return { id: item.lang_key, name: row.name, description: row.description || '', origin: row.origin || 'Universal', icon };
  }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  if (!tempers.length || new Set(tempers.map(row => row.id)).size !== tempers.length) throw new Error('Empty or duplicate temper catalogue');
  for (const alias of ambiguous) delete aliases[alias];
  const weaponNames = new Map(weapons.map(row => [row.name, row]));
  const byPath = {}, weaponAliases = {};
  for (const item of items.filter(row => row.category === 'Weapon')) {
    const source = weaponNames.get(item.name);
    byPath[key(item.path)] = { name: item.name, art: source?.art || '', origin: source?.origin || '' };
    for (const alias of ambiguous) {
      const matches = reference.filter(row => key(row.internalId) === alias && row.possibleWeapons?.includes(item.name));
      if (matches.length === 1) {
        const temper = tempers.find(row => row.name === matches[0].name);
        (weaponAliases[key(item.path)] ||= {})[alias] = temper.id;
      }
    }
  }
  return { schema: 1, tempers, weapons: byPath, aliases, weaponAliases };
}

// Only the offline vendor labels, art keys and ambiguous weapon tags are
// needed at runtime. Clients can derive language IDs and conventional names.
function projectTemperCompatibility(catalog) {
  const temperById = Object.fromEntries(catalog.tempers.map(({ id, name, icon }) => [id, { name, icon }]));
  const aliases = Object.fromEntries(Object.entries(catalog.aliases).filter(([alias, id]) => {
    const languageId = id.toLowerCase();
    const uniqueName = languageId.slice(languageId.lastIndexOf('/') + 1).replace(/name$/, '');
    return alias !== languageId && alias !== uniqueName && !alias.endsWith(`#${uniqueName}`);
  }));
  return { temperById, aliases, weaponAliases: catalog.weaponAliases };
}

if (require.main === module) {
  const [referenceDir, pipelineDir] = process.argv.slice(2);
  if (!referenceDir || !pipelineDir) throw new Error('Pass the TemperList and pipeline output directories');
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const data = projectTemperData(read(path.join(referenceDir, 'src/data/tempers.json')),
    read(path.join(referenceDir, 'src/data/weapons.json')), read(sourcePath(pipelineDir, 'ava_api_items.json')).items,
    icon => fs.readFileSync(path.join(pipelineDir, 'images', icon.slice(1))));
  const root = path.resolve(__dirname, '..');
  const generated = path.join(root, 'src/generated');
  fs.mkdirSync(generated, { recursive: true });
  const compatibility = projectTemperCompatibility(data);
  fs.writeFileSync(path.join(generated, 'temper-compatibility.json'), JSON.stringify(compatibility) + '\n');
  fs.writeFileSync(path.join(root, 'src/data/tempers.json'), JSON.stringify(data) + '\n');
  console.log(`Projected ${data.tempers.length} tempers and ${Object.keys(data.weapons).length} weapon names`);
}
module.exports = { projectTemperCompatibility, projectTemperData };
