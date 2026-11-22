// Build the small temper lookup used by the exporter, not a copy of the catalog.
// node scripts/build-export-data.js <pipeline-output-directory>
const fs = require('node:fs');
const path = require('node:path');
const { sourcePath } = require('./pipeline-paths');

function projectExportData(items) {
  const tempers = {}, ambiguous = new Set(), weaponTempers = {};
  for (const item of items) {
    if (item.category !== 'Temper' || !item.tag || !item.lang_key) continue;
    for (const key of [item.tag, item.unique_name, item.path, item.lang_key]) {
      if (typeof key !== 'string' || !key) continue;
      const normalized = key.toLowerCase();
      if (tempers[normalized] && tempers[normalized] !== item.lang_key) ambiguous.add(normalized);
      tempers[normalized] = item.lang_key;
    }
  }
  for (const key of ambiguous) delete tempers[key];
  // Some melee and casting tempers share a tag but have different names.
  for (const item of items) {
    const choices = {};
    for (const temper of item.possible_tempers || []) {
      if (ambiguous.has(temper.tag?.toLowerCase()) && temper.lang_key) choices[temper.tag.toLowerCase()] = temper.lang_key;
    }
    if (Object.keys(choices).length) weaponTempers[item.path.toLowerCase().replace('/sf/storeitems/', '/sf/')] = choices;
  }
  if (!Object.keys(tempers).length) throw new Error('No temper mappings found');
  return { schema: 1, tempers: Object.fromEntries(Object.entries(tempers).sort(([a], [b]) => a.localeCompare(b))), weaponTempers };
}
if (require.main === module) {
  const source = process.argv[2];
  if (!source) throw new Error('Pass the pipeline output directory');
  const inventory = JSON.parse(fs.readFileSync(sourcePath(source, 'ava_api_items.json'), 'utf8'));
  const data = projectExportData(inventory.items);
  const output = path.join(__dirname, '../src/data/build-export.json');
  fs.writeFileSync(output, JSON.stringify(data) + '\n');
  console.log(`Wrote ${Object.keys(data.tempers).length} temper aliases (${fs.statSync(output).size} bytes)`);
}
module.exports = { projectExportData };
