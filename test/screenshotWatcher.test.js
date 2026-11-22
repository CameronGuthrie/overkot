'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createGamePathResolver } = require('../src/modules/gamePaths');
const { createScreenshotWatcher, readJpegComment, parseMetadata } = require('../src/modules/screenshotWatcher');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const metadata = '/SF/Levels/Procs/MidrathProc/Level Z: /SF/Levels/MidrathRedux P: -446, -41, 33 H:-146 Log: synthetic';
function jpeg(comment = metadata) {
  const text = Buffer.from(comment), length = Buffer.alloc(2);
  length.writeUInt16BE(text.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xfe]), length, text, Buffer.from([0xff, 0xd9])]);
}
function fixture(t, options = {}) {
  const tempRoot = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(tempRoot, 'overkot-screenshots-'));
  const config = { screenshotDir: directory }, handlers = new Map(), watchers = [], results = [], reads = [];
  const resolver = createGamePathResolver({ getConfig: () => config, home: directory, env: {} });
  const fsImpl = { ...fs,
    readFileSync(filename) { reads.push(filename); return fs.readFileSync(filename); },
    watch(dir, handler) {
      handlers.set(dir, handler);
      const watcher = new EventEmitter();
      watcher.closed = false; watcher.close = () => { watcher.closed = true; };
      watchers.push(watcher); return watcher;
    },
    ...options.fsImpl,
  };
  const watcher = createScreenshotWatcher({ resolver, fsImpl, settleDelayMs: 15, timeoutMs: 2000, maxAttempts: 2, ...options, fsImpl });
  watcher.onResult(value => results.push(value));
  t.after(() => {
    watcher.stopWatching();
    assert.equal(path.dirname(directory), tempRoot);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const create = (name, bytes = jpeg(), dir = directory) => { const filename = path.join(dir, name); fs.writeFileSync(filename, bytes); return filename; };
  const notify = (name, dir = directory) => handlers.get(dir)?.('rename', name);
  return { directory, config, resolver, watcher, fsImpl, watchers, results, reads, create, notify };
}

test('JPEG location parser rejects malformed, incomplete or unrelated metadata', t => {
  const f = fixture(t);
  const valid = f.create('Soulframe1.jpg');
  assert.equal(readJpegComment(valid), metadata);
  assert.deepEqual(parseMetadata(metadata), { zone: '/SF/Levels/MidrathRedux', position: { x: -446, y: -41, z: 33 }, heading: -146, isOverworld: true });
  for (const invalid of [null, '', 'Z: /SF/Levels/MidrathRedux P: 1, 2, 3 H:4',
    metadata.replace('33', 'NaN'), metadata.replace('-446', '1e999'), metadata.replace(' H:-146', ''),
    metadata.replace('Z: /SF/Levels/MidrathRedux', 'Z: family-photo')]) assert.equal(parseMetadata(invalid), null);
  assert.equal(readJpegComment(f.create('Soulframe2.jpg', jpeg().subarray(0, -2))), null);
  assert.equal(readJpegComment(f.create('Soulframe3.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0, 0, 0xff, 0xd9]))), null);
  assert.equal(readJpegComment(f.create('Soulframe4.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0xff, 0xff, 0xff, 0xd9]))), null);
});

test('missing screenshot folders produce Settings guidance without creating a directory', t => {
  const f = fixture(t);
  f.config.screenshotDir = path.join(f.directory, 'missing');
  const result = f.watcher.startWatching();
  assert.equal(result.status, 'error'); assert.match(result.message, /Settings/);
  assert.equal(fs.existsSync(f.config.screenshotDir), false); assert.equal(f.watchers.length, 0);
});

test('only a new valid game capture is consumed; existing and unrelated images stay intact', async t => {
  const f = fixture(t);
  const old = f.create('Soulframe999.jpg'), unrelated = f.create('Holiday.jpg');
  assert.equal(f.watcher.startWatching().status, 'watching');
  f.notify('Soulframe999.jpg'); f.notify('Holiday.jpg');
  const fresh = f.create('Soulframe1.jpg'); // Numbering can restart; lexicographic baselines are unsafe.
  f.notify('Soulframe1.jpg'); f.notify('Soulframe1.jpg');
  await wait(60);
  assert.equal(f.results.length, 1); assert.equal(f.results[0].status, 'found');
  assert.equal(fs.existsSync(fresh), false);
  assert.equal(fs.existsSync(old), true); assert.equal(fs.existsSync(unrelated), true);
  assert.ok(f.reads.every(filename => filename === fresh));
  assert.ok(f.watchers.every(watcher => watcher.closed));
});

test('new images without valid game metadata are kept and do not complete the request', async t => {
  const f = fixture(t);
  f.watcher.startWatching();
  const invalid = f.create('Soulframe1.jpg', jpeg('A family photo'));
  f.notify('Soulframe1.jpg'); await wait(80);
  assert.equal(fs.existsSync(invalid), true); assert.deepEqual(f.results, []);
  f.create('Soulframe2.jpg'); f.notify('Soulframe2.jpg'); await wait(60);
  assert.equal(f.results[0].status, 'found');
});

test('incomplete captures are retried and retained until JPEG writing is complete', async t => {
  const f = fixture(t, { maxAttempts: 5 });
  f.watcher.startWatching();
  const filename = f.create('Soulframe1.jpg', jpeg().subarray(0, -2));
  f.notify('Soulframe1.jpg'); await wait(25);
  assert.equal(fs.existsSync(filename), true); assert.deepEqual(f.results, []);
  fs.writeFileSync(filename, jpeg()); await wait(70);
  assert.equal(f.results.length, 1); assert.equal(f.results[0].status, 'found');
});

test('stopping cancels pending file callbacks, deletion and notifications', async t => {
  const f = fixture(t);
  f.watcher.startWatching();
  const filename = f.create('Soulframe1.jpg'); f.notify('Soulframe1.jpg');
  f.watcher.stopWatching(); await wait(60);
  assert.equal(fs.existsSync(filename), true); assert.deepEqual(f.results, []); assert.deepEqual(f.reads, []);
});

test('a new watching session cannot revive callbacks from the previous session', async t => {
  const f = fixture(t);
  f.watcher.startWatching();
  const filename = f.create('Soulframe1.jpg'); f.notify('Soulframe1.jpg');
  f.watcher.startWatching(); // The prior pending file is now part of the existing-image baseline.
  await wait(60);
  assert.equal(fs.existsSync(filename), true); assert.deepEqual(f.results, []);
});

test('changing the configured folder cancels pending callbacks even before root reconfiguration', async t => {
  const f = fixture(t);
  f.watcher.startWatching();
  const filename = f.create('Soulframe1.jpg'); f.notify('Soulframe1.jpg');
  const next = path.join(f.directory, 'other'); fs.mkdirSync(next);
  f.config.screenshotDir = next;
  await wait(60);
  assert.equal(fs.existsSync(filename), true); assert.deepEqual(f.results, []); assert.deepEqual(f.reads, []);
  assert.ok(f.watchers.every(watcher => watcher.closed));
});

test('folder reconfiguration clears old location and watches only the new selected directory', async t => {
  const f = fixture(t);
  f.watcher.startWatching(); f.create('Soulframe1.jpg'); f.notify('Soulframe1.jpg'); await wait(60);
  assert.equal(f.watcher.getLastLocation().status, 'found');
  const next = path.join(f.directory, 'other'); fs.mkdirSync(next); f.config.screenshotDir = next;
  f.watcher.setResolver(f.resolver); assert.equal(f.watcher.getLastLocation(), null);
  f.watcher.startWatching(); const newImage = f.create('Soulframe2.jpg', jpeg(), next); f.notify('Soulframe2.jpg', next); await wait(60);
  assert.equal(f.results.length, 2); assert.equal(fs.existsSync(newImage), false);
});

test('a changed file is not deleted after parsing the earlier contents', async t => {
  const f = fixture(t);
  const read = f.fsImpl.readFileSync;
  f.fsImpl.readFileSync = filename => {
    const bytes = read(filename);
    fs.writeFileSync(filename, Buffer.from('replacement photo'));
    return bytes;
  };
  f.watcher.startWatching(); const filename = f.create('Soulframe1.jpg'); f.notify('Soulframe1.jpg'); await wait(60);
  assert.equal(fs.readFileSync(filename, 'utf8'), 'replacement photo'); assert.deepEqual(f.results, []);
});

test('watch failures close attached watchers and report Settings guidance', t => {
  const f = fixture(t);
  f.watcher.startWatching(); f.watchers[0].emit('error', new Error('access denied'));
  assert.equal(f.results[0].status, 'error'); assert.match(f.results[0].message, /Settings/);
  assert.ok(f.watchers.every(watcher => watcher.closed));
});

test('real filesystem notifications consume a newly created capture in the selected temp directory', async t => {
  const f = fixture(t);
  const watcher = createScreenshotWatcher({ resolver: f.resolver, settleDelayMs: 20, timeoutMs: 1000 });
  t.after(() => watcher.stopWatching());
  const result = new Promise(resolve => watcher.onResult(resolve));
  assert.equal(watcher.startWatching().status, 'watching');
  const filename = f.create('Soulframe42.jpg');
  assert.equal((await result).status, 'found');
  assert.equal(fs.existsSync(filename), false);
});
