// Verify the exported payload against the website's actual decoder.
// node scripts/check-build-export-contract.js <soulframe-builds-directory>
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { buildInventory } = require('../test/fixtures/build-inventory');
const { inventoryToBuild, buildImportUrl } = require('../src/modules/buildExporter');

(async () => {
  if (!process.argv[2]) throw new Error('Pass the soulframe-builds directory');
  const website = await import(pathToFileURL(path.resolve(process.argv[2], 'src/lib/build-transfer.js')).href);
  const { state } = inventoryToBuild(buildInventory());
  const url = new URL(buildImportUrl(state, 'https://build.example.org'));
  const imported = await website.decodeLittleGeniusTransfer(url.hash.slice(4));
  assert.deepEqual(imported.state, state);
  const tree = state.skillTrees[0];
  const mapped = website.mapLittleGeniusSkillTrees(imported.state.skillTrees, { combatArts: [{ id: tree.treeId,
    nodes: tree.skills.map((skill, index) => ({ id: skill.skillId, index, maxRank: 3 })),
  }] });
  assert.ok(Object.keys(mapped.combatArts).length, 'Website restores skill selections');
  console.log(JSON.stringify({ ok: true, urlLength: url.href.length, sections: Object.keys(imported.state).length }));
})().catch(error => { console.error(error); process.exitCode = 1; });
