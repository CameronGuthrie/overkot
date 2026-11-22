// Verify every advertised production object through the desktop's real client.
// This deliberately downloads all locales/tiles for release validation only.
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const axios = require('axios');
const { DataUpdateManager, MANIFEST_URL, LOCALES } = require('../src/modules/dataUpdates');
const { validTemperCatalog, validBuildCatalog } = require('../src/modules/catalogData');
const { validateCalendar } = require('../src/modules/calendarData');
const { validWolfTrainingCatalog } = require('../src/modules/wolfTraining');
const { DungeonMap } = require('../src/modules/dungeonMap');
const { DungeonWatcher } = require('../src/modules/dungeonWatcher');
async function main() {
  const out = path.resolve(__dirname, '../output', 'overlay-client-check-' + Date.now());
  let requests = 0, transferred = 0, manifestStatus;
  const manifestUrl = process.env.OVERKOT_DATA_MANIFEST_URL || MANIFEST_URL;
  const http = { get: async (url, options) => {
    requests++;
    const response = await axios.get(url, options);
    if (url === manifestUrl) manifestStatus = response.status;
    else transferred += Buffer.byteLength(response.data);
    return response;
  } };
  const manager = new DataUpdateManager({ rootDir: out, manifestUrl, http });
  await manager.initialize();
  const result = await manager.checkForUpdates();
  assert.equal(result.error, undefined);
  assert.deepEqual(manager.getInfo().unavailable, {});
  const keys = Object.keys(manager.manifest.files);
  await Promise.all(keys.map(async key => assert.ok(await manager.ensureAsset(key), 'Missing verified object: ' + key)));
  // The v2 manifest advertises its original compact packs. Languages added
  // later use full dictionaries on the protected file route.
  assert.ok(manager.manifest.files['names/en.json'], 'Missing English compact catalogue');
  for (const locale of LOCALES.filter(code => manager.manifest.files[`names/${code}.json`])) {
    assert.ok(validTemperCatalog(manager.readJSON(`tempers/${locale}.json`)), locale + ' catalogue');
    assert.ok(Object.keys(manager.readJSON(`names/${locale}.json`)).length > 0);
    if (manifestUrl.includes('/overlay/v2/')) {
      const wolf = manager.readJSON(`wolf-training/${locale}.json`);
      assert.ok(validWolfTrainingCatalog(wolf), locale + ' wolf catalogue');
      assert.equal(wolf.progression.estimated, false);
      assert.deepEqual(wolf.progression.skillThresholds, [600, 2000, 3900, 6300, 9000]);
      assert.deepEqual(wolf.progression.bondThresholds, [125000, 421900, 1000000, 1953100]);
    }
  }
  assert.ok(validBuildCatalog(manager.readJSON('build-export/catalog.json')));
  validateCalendar(manager.readJSON('calendar/calendar.json'));
  let dungeonSets = 0, dungeonRooms = 0, connectedRooms = 0, underCityLayouts = [];
  if (manifestUrl.includes('/overlay/v2/')) {
    const index = manager.readJSON('dungeons/index.json');
    assert.equal(index?.schema, 1);
    const maps = new DungeonMap({ dataManager: manager });
    for (const set of index.sets) {
      const document = manager.readJSON(set.rooms);
      assert.ok(document?.rooms?.length > 0, set.key + ' room outlines');
      dungeonSets++; dungeonRooms += document.rooms.length;
      const atlas = await maps.getSnapshot({ active: true, set: set.set, key: set.key, levelPath: set.level_paths[0], layoutCode: null });
      assert.equal(atlas.mode, 'gallery', set.key + ' atlas is available before its fingerprint');
      assert.ok(atlas.rooms.length > 0);
    }
    const fortress = await maps.getSnapshot({ active: true, set: 'FallenFortress', key: 'fallenFortress',
      levelPath: '/SF/Levels/Procs/FallenFortress/FallenFortressProcLevel', layoutCode: 'SSMCETyBURHUPG29PZBAQAAAAIAIIgA' });
    assert.equal(fortress.mode, 'placed', 'published geometry and ordered portal tables assemble the captured layout');
    assert.deepEqual(fortress.missingRooms, []);
    connectedRooms = fortress.rooms.length;
    const watcher = new DungeonWatcher({ getIndex: () => index });
    const level = '/SF/Levels/Procs/UnderCityCliffCave';
    for (const [code, count] of [['KhGCACHMpRNZ3fAghiCAAQjA', 8], ['ShGaIa5IZlKJq676AAGIIAhAEYA', 9]]) {
      watcher._processLine(`Sys [Info]: ${level}/${code}.lp`);
      assert.equal(watcher.getState().active, false, 'Background generation cannot activate the map');
      watcher._processLine('LoadTriggers.lua: StreamTrigger location is UndercityPortalSproutCave');
      watcher._processLine(`StreamTrigger: Streaming started on level ${level} layer 256.`);
      watcher._processLine(`ProcLevelSetup.lua: STATS ENTER_LEVEL ${level}`);
      const scene = await maps.getSnapshot(watcher.getState());
      assert.equal(scene.mode, 'placed', 'The recorded Undercity trip loads connected outlines through the real client');
      assert.equal(scene.rooms.length, count);
      assert.deepEqual(scene.missingRooms, []);
      underCityLayouts.push(count);
      watcher._processLine(`LoadTriggers.lua: STATS EXIT_LEVEL ${level}`);
      watcher._processLine(`Game [Info]: ${level}/${code}.lp fully destroyed [layer=256]`);
      assert.equal(watcher.getState().active, false, 'Exit cleanup cannot reactivate a finished trip');
    }
  }
  const initialRequests = requests;
  await manager.checkForUpdates({ force: true });
  assert.equal(manifestStatus, 304);
  await Promise.all(keys.map(key => manager.ensureAsset(key)));
  assert.equal(requests, initialRequests + 1, 'Unchanged hashes cause no asset transfers');
  let offlineRequests = 0;
  const offline = new DataUpdateManager({ rootDir: out, manifestUrl, http: { get: async () => { offlineRequests++; throw new Error('offline'); } } });
  await offline.initialize();
  await offline.checkForUpdates({ force: true });
  await Promise.all(keys.map(async key => assert.ok(await offline.ensureAsset(key), 'Offline cache: ' + key)));
  assert.equal(offlineRequests, 1, 'Only the manifest was retried offline');
  const summary = { ok: true, manifestUrl, version: manager.manifest.version, files: keys.length,
    downloadedBytes: transferred, unchangedAssetDownloads: 0, offlineFiles: keys.length,
    dungeonSets, dungeonRooms, connectedRooms, underCityLayouts, warnings: manager.getInfo().warnings };
  await fs.writeFile(path.join(out, 'verification.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, output: out }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
