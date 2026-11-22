process.env.OVERKOT_SERVICES_FILE = require('node:path').resolve(__dirname, '../config/official-services.json');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const encryption = require('../src/modules/fileEncryption');

const sourcePath = path.resolve(__dirname, '..', 'src', 'modules', 'languageNames.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const nimrodKey = '/SF/Language/Characters/SubBossNimrod';
const blessedKey = '/SF/Language/SystemMessages/AncestorBoosterNotification';
const blessedTag = 'UPGRADEGIVEN_GODANDGHOST';

function fixture(t) {
  const base = path.resolve(__dirname, '..', '.build', 'language-tests');
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'names-'));
  const appPaths = { LANG_DIR: path.join(directory, 'lang'), CACHE_DIR: path.join(directory, 'cache') };
  for (const location of Object.values(appPaths)) fs.mkdirSync(location);
  t.after(() => {
    assert.equal(path.dirname(directory), base);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const requests = [];
  const control = {
    now: 1_000_000,
    response: { status: 200, headers: { etag: '"initial"' }, data: JSON.stringify({ [nimrodKey]: 'Downloaded name' }) },
    catalog: { items: [{ itemType: '/SF/Upgrades/Skins/Helmets/ApprovedHelmet', name: 'Approved helmet',
      langKey: '/SF/Language/Armour/ApprovedHelmetName', recipe: { itemType: '/SF/Types/Recipes/Armor/ApprovedHelmBlueprint' } }] },
  };
  class FixtureDate extends Date { static now() { return control.now; } }
  function load() {
    const module = { exports: {} };
    vm.runInNewContext(source, {
      module, exports: module.exports, console, Date: FixtureDate,
      require: name => {
        if (name === './serviceConfig') return require('../src/modules/serviceConfig');
        if (name === './gameLocales') return require('../src/modules/gameLocales');
        if (name === './appPaths') return appPaths;
        if (name === './fileEncryption') return encryption;
        if (name === './collectionCatalog') return { getCollectionCatalog: () => control.catalog };
        if (name === 'axios') return { get: async (url, options) => {
          requests.push({ url, options });
          if (control.response instanceof Error) throw control.response;
          return control.response;
        } };
        if (name === 'fs' || name === 'path') return require(name);
        throw new Error(`Unexpected language module dependency: ${name}`);
      },
    }, { filename: sourcePath });
    return module.exports;
  }
  let revision = 0;
  function writeLanguage(locale, entries) {
    const file = path.join(appPaths.LANG_DIR, `${locale}.json`);
    encryption.writeEncryptedJSON(file, entries);
    // Ensure a distinct source signature even for equal-length translations.
    const modified = new Date(1_000_000 + (++revision * 2000));
    fs.utimesSync(file, modified, modified);
    return file;
  }
  return { api: load(), load, appPaths, control, requests, writeLanguage };
}

function compactManager(packs, { installed = false } = {}) {
  const downloaded = [];
  const available = new Map(installed ? Object.entries(packs) : []);
  return {
    downloaded,
    manifest: { files: Object.fromEntries(Object.keys(packs).map(key => [key, {}])) },
    ensureAsset: async key => { downloaded.push(key); if (packs[key]) available.set(key, packs[key]); return key; },
    readJSON: key => available.get(key) || null,
  };
}

test('compact names and locations fetch only the selected locale without a full-language request', async t => {
  const f = fixture(t);
  const names = { 'RuinsHint12-SubBoss': 'Nom français' };
  const locations = { '/SF/Language/Locations/FortCurlail': 'Fort français' };
  const manager = compactManager({
    'names/fr.json': names, 'locations/fr.json': locations,
    'names/en.json': { 'RuinsHint12-SubBoss': 'English name' }, 'locations/en.json': {},
  });
  f.api.setDataManager(manager);
  assert.deepEqual(plain(await f.api.ensureNamesForLanguage('fr')), { ...names, [blessedTag]: 'Rencontre Bénie' });
  assert.deepEqual(manager.downloaded.sort(), ['locations/fr.json', 'names/fr.json']);
  assert.deepEqual(plain(f.api.loadLanguageData('fr')), locations);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(fs.readdirSync(f.appPaths.LANG_DIR), []);
});

test('recipe labels derive only from approved recipes and preserve inventory timer suffix conventions', t => {
  const f = fixture(t);
  f.control.catalog.items.push({ name: 'Approved brew', langKey: '/SF/Language/Consumables/ApprovedBrewName',
    recipe: { itemType: '/SF/Types/Recipes/Consumables/ApprovedBrewRecipeItem' } });
  const names = f.api.deriveNames({
    '/SF/Language/Armour/ApprovedHelmetName': 'Casque autorisé',
    '/SF/Language/Armour/UnreleasedHelmetName': 'Private future helmet',
  }, 'fr');
  assert.equal(names['PendingRecipe:ApprovedHelm'], 'Casque autorisé');
  assert.equal(names['PendingRecipe:ApprovedBrew'], 'Approved brew');
  assert.doesNotMatch(JSON.stringify(names), /UnreleasedHelmet|Private future helmet/);
});

test('compact recipe names cannot reintroduce unapproved recipes', async t => {
  const f = fixture(t);
  const compact = { 'PendingRecipe:ApprovedHelm': 'Approved compact label',
    'PendingRecipe:UnreleasedHelmet': 'Private future helmet', 'RuinsHint12-SubBoss': 'Existing boss' };
  f.api.setDataManager(compactManager({ 'names/en.json': compact }, { installed: true }));
  const names = await f.api.ensureNamesForLanguage('en', { network: false });
  assert.equal(names['PendingRecipe:ApprovedHelm'], compact['PendingRecipe:ApprovedHelm']);
  assert.equal(names['RuinsHint12-SubBoss'], 'Existing boss');
  assert.doesNotMatch(JSON.stringify(names), /UnreleasedHelmet|Private future helmet/);
  assert.equal(compact['PendingRecipe:UnreleasedHelmet'], 'Private future helmet', 'Downloaded objects are not mutated');
});

test('same-version offline caches are filtered after a recipe leaves the approved catalogue', async t => {
  const f = fixture(t);
  const language = f.writeLanguage('en', { [nimrodKey]: 'Existing boss' });
  const stat = fs.statSync(language);
  encryption.writeEncryptedJSON(path.join(f.appPaths.CACHE_DIR, 'en-names.json'), {
    version: f.api.CACHE_VERSION, sourceVersion: `${stat.size}:${stat.mtimeMs}`, locale: 'en',
    names: { 'PendingRecipe:ApprovedHelm': 'Former recipe', 'PendingRecipe:UnreleasedHelmet': 'Private name' },
  });
  f.control.catalog.items = [];
  const names = await f.api.ensureNamesForLanguage('en', { network: false });
  assert.deepEqual(plain(names), { [blessedTag]: 'Blessed Meeting' });
  assert.equal(f.requests.length, 0);
});

test('derived fallback names invalidate when an equal-length language source changes', async t => {
  const f = fixture(t);
  f.writeLanguage('fr', { [nimrodKey]: 'Old Cat' });
  const first = await f.api.ensureNamesForLanguage('fr', { network: false });
  assert.equal(first['RuinsHint12-SubBoss'], 'Old Cat');
  const cachePath = path.join(f.appPaths.CACHE_DIR, 'fr-names.json');
  const before = encryption.readEncryptedJSON(cachePath);
  f.writeLanguage('fr', { [nimrodKey]: 'New Fox' });
  const second = await f.api.ensureNamesForLanguage('fr', { network: false });
  assert.equal(second['RuinsHint12-SubBoss'], 'New Fox');
  const after = encryption.readEncryptedJSON(cachePath);
  assert.notEqual(after.sourceVersion, before.sourceVersion);
  assert.equal(after.names['RuinsHint12-SubBoss'], 'New Fox');
  assert.equal((await f.load().ensureNamesForLanguage('fr', { network: false }))['RuinsHint12-SubBoss'], 'New Fox');
  assert.equal(f.requests.length, 0);
});

test('network:false returns cached compact data or fallback names without starting downloads', async t => {
  const f = fixture(t);
  const cached = { 'RuinsHint12-SubBoss': 'Cached compact name' };
  const manager = compactManager({ 'names/fr.json': cached, 'locations/fr.json': {} }, { installed: true });
  f.api.setDataManager(manager);
  assert.deepEqual(plain(await f.api.ensureNamesForLanguage('fr', { network: false })), { ...cached, [blessedTag]: 'Rencontre Bénie' });
  assert.deepEqual(manager.downloaded, []);

  f.api.setDataManager(null);
  f.writeLanguage('en', { [nimrodKey]: 'Cached fallback name' });
  await f.api.ensureNamesForLanguage('en', { network: false });
  const restarted = f.load();
  assert.equal((await restarted.ensureNamesForLanguage('en', { network: false }))['RuinsHint12-SubBoss'], 'Cached fallback name');
  assert.deepEqual(plain(await restarted.ensureNamesForLanguage('de', { network: false })), { [blessedTag]: 'Gesegnete Begegnung' });
  assert.equal(f.requests.length, 0);
});

test('unknown locales normalize to English for compact packs and fallback requests', async t => {
  const f = fixture(t);
  const english = { 'RuinsHint12-SubBoss': 'English name' };
  const manager = compactManager({ 'names/en.json': english, 'locations/en.json': { location: 'English location' } });
  f.api.setDataManager(manager);
  assert.deepEqual(plain(await f.api.ensureNamesForLanguage('../invalid')), { ...english, [blessedTag]: 'Blessed Meeting' });
  assert.deepEqual(manager.downloaded.sort(), ['locations/en.json', 'names/en.json']);
  assert.equal(f.api.loadLanguageData('unknown').location, 'English location');
  assert.equal(f.requests.length, 0);

  f.api.setDataManager(null);
  assert.equal(await f.api.downloadLanguage('unsupported'), true);
  assert.equal(f.requests.length, 1);
  assert.match(f.requests[0].url, /\/Languages_en\.json$/);
  assert.equal(f.api.loadLanguageData('unsupported')[nimrodKey], 'Downloaded name');
  assert.deepEqual(fs.readdirSync(f.appPaths.LANG_DIR).sort(), ['en-http.json', 'en.json']);
});

test('fallback revalidation uses HTTP validators and refreshes derived names after an update', async t => {
  const f = fixture(t);
  assert.equal((await f.api.ensureNamesForLanguage('fr'))['RuinsHint12-SubBoss'], 'Downloaded name');
  await f.api.ensureNamesForLanguage('fr');
  assert.equal(f.requests.length, 1);
  f.control.now += 24 * 60 * 60 * 1000;
  f.control.response = { status: 304, headers: {}, data: '' };
  assert.equal((await f.api.ensureNamesForLanguage('fr'))['RuinsHint12-SubBoss'], 'Downloaded name');
  assert.equal(f.requests[1].options.headers['If-None-Match'], '"initial"');
  f.control.now += 24 * 60 * 60 * 1000;
  f.control.response = { status: 200, headers: { etag: '"updated"' }, data: JSON.stringify({ [nimrodKey]: 'Updated localized name' }) };
  assert.equal((await f.api.ensureNamesForLanguage('fr'))['RuinsHint12-SubBoss'], 'Updated localized name');
  assert.equal(f.requests.length, 3);
  assert.ok(f.requests.every(request => request.url.endsWith('/Languages_fr.json')));
});

test('new locale variants fetch the matching full dictionary when the compact feed lacks a pack', async t => {
  const f = fixture(t);
  const { protectedUrl } = require('../src/modules/gameDataAccess');
  const { sourcePaths } = require('../scripts/pipeline-paths');
  f.api.setDataManager(compactManager({ 'names/en.json': {} }));
  for (const [language, code, offlineLabel] of [
    ['zh-Hant-TW', 'tc', '蒙福相會'],
    ['th-TH', 'th', 'จุดนัดพบเพื่อรับพร'],
    ['uk-UA', 'uk', 'Благословенна зустріч'],
    ['zh-CN', 'zh', '受祝福的会面'],
  ]) {
    const names = await f.api.ensureNamesForLanguage(language);
    const filename = `Languages_${code}.json`;
    assert.equal(names[blessedTag], offlineLabel);
    assert.equal(names['RuinsHint12-SubBoss'], 'Downloaded name');
    assert.equal(f.requests.at(-1).url.split('/').pop(), filename);
    assert.ok(protectedUrl(f.requests.at(-1).url));
    assert.deepEqual(sourcePaths(filename), [`Languages/${filename}`, filename]);
  }
  assert.equal(f.requests.length, 4);
});

test('Blessed Meeting derives from its game localization key and corrects older compact names', async t => {
  const f = fixture(t);
  for (const [locale, label] of [['en', 'Blessed Meeting'], ['fr', 'Rencontre Bénie'], ['ja', '祝福された出会い']]) {
    assert.equal(f.api.deriveNames({ [blessedKey]: label }, locale)[blessedTag], label);
  }
  const previous = { [blessedTag]: 'God and Ghost upgrade', 'RuinsHint12-SubBoss': 'Existing localized boss' };
  f.api.setDataManager(compactManager({ 'names/fr.json': previous }, { installed: true }));
  const updated = await f.api.ensureNamesForLanguage('fr', { network: false });
  assert.equal(updated[blessedTag], 'Rencontre Bénie');
  assert.equal(updated['RuinsHint12-SubBoss'], previous['RuinsHint12-SubBoss']);
  assert.equal(previous[blessedTag], 'God and Ghost upgrade', 'Downloaded objects are not mutated');
  f.writeLanguage('fr', { [blessedKey]: 'Updated translated meeting' });
  assert.equal((await f.api.ensureNamesForLanguage('fr', { network: false }))[blessedTag], 'Updated translated meeting');
  assert.deepEqual(f.requests, [], 'An old compact feed does not cause extra network requests');
});

test('previous derived-name caches rebuild using the corrected Blessed Meeting mapping', async t => {
  const f = fixture(t);
  const language = f.writeLanguage('en', { [blessedKey]: 'Blessed Meeting' });
  const stat = fs.statSync(language);
  encryption.writeEncryptedJSON(path.join(f.appPaths.CACHE_DIR, 'en-names.json'), {
    version: 4, sourceVersion: `${stat.size}:${stat.mtimeMs}`, locale: 'en', names: { [blessedTag]: 'Old label' },
  });
  assert.equal((await f.api.ensureNamesForLanguage('en', { network: false }))[blessedTag], 'Blessed Meeting');
  assert.equal(encryption.readEncryptedJSON(path.join(f.appPaths.CACHE_DIR, 'en-names.json')).version, f.api.CACHE_VERSION);
});
