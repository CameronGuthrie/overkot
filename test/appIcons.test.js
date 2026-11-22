'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { FRAME_SIZES, ICO_FILES, BITMAPS, icoFrames, bitmapSize, validateAppIcons } = require('../scripts/build-app-icons');
const assets = path.resolve(__dirname, '../assets');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-icon-test-')), directory = path.join(root, 'assets');
  fs.mkdirSync(directory);
  for (const name of ['overkot.png', 'app-icons.json', 'SF_TIMERS_LOGO.png', ...ICO_FILES, ...Object.keys(BITMAPS)]) {
    fs.copyFileSync(path.join(assets, name), path.join(directory, name));
  }
  t.after(() => {
    // This is the exact unique test directory created above, never an input path.
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, directory };
}

function rehash(directory, name) {
  const filename = path.join(directory, 'app-icons.json'), manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
  manifest.outputs[name].sha256 = hash(fs.readFileSync(path.join(directory, name)));
  fs.writeFileSync(filename, JSON.stringify(manifest));
}

test('every app icon comes from the current high-resolution master and has Windows DPI frames', () => {
  const summary = validateAppIcons();
  assert.equal(summary.source.width, summary.source.height); assert(summary.source.width >= 512);
  assert.deepEqual(summary.sizes, [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]);
  const primary = fs.readFileSync(path.join(assets, 'overkot.ico'));
  for (const name of ICO_FILES) {
    const bytes = fs.readFileSync(path.join(assets, name));
    assert(bytes.equals(primary), name + ' is the same multi-resolution logo');
    assert.deepEqual(icoFrames(bytes), FRAME_SIZES);
  }
  assert(fs.readFileSync(path.join(assets, 'SF_TIMERS_LOGO.png')).equals(fs.readFileSync(path.join(assets, 'overkot.png'))));
});

test('installer bitmaps preserve the NSIS aspect ratios at four times normal resolution', () => {
  const header = bitmapSize(fs.readFileSync(path.join(assets, 'installer-header.bmp')));
  const sidebar = bitmapSize(fs.readFileSync(path.join(assets, 'installer-sidebar.bmp')));
  assert.deepEqual(header, { width: 600, height: 228 });
  assert.deepEqual(sidebar, { width: 656, height: 1256 });
  assert.equal(header.width / header.height, 150 / 57);
  assert.equal(sidebar.width / sidebar.height, 164 / 314);
});

test('a changed master fails build validation until generated assets are refreshed', t => {
  const { root, directory } = fixture(t);
  fs.appendFileSync(path.join(directory, 'overkot.png'), Buffer.from([0]));
  assert.throws(() => validateAppIcons({ root }), /stale.*Regenerate app branding/);
});

test('tampered or missing generated artwork cannot be used by a build', t => {
  const { root, directory } = fixture(t);
  const target = path.join(directory, 'installer-header.bmp');
  fs.appendFileSync(target, Buffer.from([0]));
  assert.throws(() => validateAppIcons({ root }), /stale: installer-header.bmp/);
  fs.unlinkSync(target);
  assert.throws(() => validateAppIcons({ root }), /Missing app branding asset.*Regenerate/);
});

test('an ICO missing a native DPI frame is rejected even if its manifest hash matches', t => {
  const { root, directory } = fixture(t), target = path.join(directory, 'overkot.ico');
  const bytes = fs.readFileSync(target); bytes.writeUInt16LE(bytes.readUInt16LE(4) - 1, 4);
  fs.writeFileSync(target, bytes); rehash(directory, 'overkot.ico');
  assert.throws(() => validateAppIcons({ root }), /lacks DPI sizes/);
});

test('wrong installer bitmap dimensions are rejected even if their manifest hash matches', t => {
  const { root, directory } = fixture(t), target = path.join(directory, 'installer-header.bmp');
  const bytes = fs.readFileSync(target); bytes.writeInt32LE(601, 18);
  fs.writeFileSync(target, bytes); rehash(directory, 'installer-header.bmp');
  assert.throws(() => validateAppIcons({ root }), /wrong size/);
});
