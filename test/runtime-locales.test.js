const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyRuntimeLocales } = require('../scripts/verify-runtime-locales');
const { copyInterfaceLanguages } = require('../scripts/build');

test('the desktop build stages the dictionaries and flags named in the pinned translation repository', t => {
  const source = path.join(__dirname, '../langs');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-interface-'));
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
  copyInterfaceLanguages(source, stage);
  const manifest = JSON.parse(fs.readFileSync(path.join(source, '_languages.json'), 'utf8'));
  const expected = ['_languages.json', ...manifest.map(({ code }) => code + '.json')];
  const flags = [...new Set(manifest.map(({ flag }) => flag))].sort();
  assert.deepEqual(fs.readdirSync(stage).sort(), [...expected, 'flags'].sort());
  assert.deepEqual(fs.readdirSync(path.join(stage, 'flags')).sort(), flags);
  for (const file of [...expected, ...flags.map(flag => path.join('flags', flag))]) {
    assert.deepEqual(fs.readFileSync(path.join(stage, file)), fs.readFileSync(path.join(source, file)), file);
  }
});

function fixture(t, files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-locales-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'locales'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, 'locales', name + '.pak'), content);
  return directory;
}

test('language pruning must retain English fallback even with other languages present', t => {
  const directory = fixture(t, { fr: 'pack', de: 'pack' });
  assert.throws(() => verifyRuntimeLocales(directory, ['fr', 'de']), /en-US, en-GB/);
});

test('bare app English codes cannot stand in for real Chromium locale packs', t => {
  const directory = fixture(t, { en: 'pack', 'en-US': 'pack', 'en-GB': '' });
  assert.throws(() => verifyRuntimeLocales(directory), /en-GB/);
});

test('all configured runtime locales must exist and have content', t => {
  const directory = fixture(t, { 'en-US': 'pack', 'en-GB': 'pack', fr: 'pack' });
  assert.deepEqual(verifyRuntimeLocales(directory, ['fr', 'en-US']), ['en-US', 'en-GB', 'fr']);
  assert.throws(() => verifyRuntimeLocales(directory, ['de']), /de/);
});

function macFixture(t, files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-mac-locales-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const framework = path.join(directory, 'Overkot.app', 'Contents', 'Frameworks', 'Electron Framework.framework', 'Resources');
  for (const [name, content] of Object.entries(files)) {
    const locale = path.join(framework, `${name}.lproj`);
    fs.mkdirSync(locale, { recursive: true });
    fs.writeFileSync(path.join(locale, 'locale.pak'), content);
  }
  return directory;
}

test('macOS verifies framework locale packs using Apple locale names', t => {
  const directory = macFixture(t, { en: 'pack', en_GB: 'pack', pt_BR: 'pack', zh_CN: 'pack' });
  assert.deepEqual(verifyRuntimeLocales(directory, ['pt-BR', 'zh_CN'], { platform: 'darwin' }), ['en', 'en_GB', 'pt_BR', 'zh_CN']);
  assert.throws(() => verifyRuntimeLocales(directory, ['zh-TW'], { platform: 'darwin' }), /zh_TW/);
});

test('macOS empty app locale markers do not mask missing framework strings', t => {
  const directory = macFixture(t, { en: 'pack', en_GB: '' });
  const marker = path.join(directory, 'Overkot.app', 'Contents', 'Resources', 'en_GB.lproj');
  fs.mkdirSync(marker, { recursive: true });
  fs.writeFileSync(path.join(marker, 'locale.pak'), 'unrelated app resource');
  assert.throws(() => verifyRuntimeLocales(directory, [], { platform: 'darwin' }), /en_GB/);
});
