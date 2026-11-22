const test = require('node:test');
const assert = require('node:assert/strict');
const { findRelease, mergeChangelog } = require('../src/modules/releaseNotes');
const { releaseChanges } = require('../src/modules/updater');

test('beta, preview and stable builds share family notes without borrowing other versions', () => {
  const release = { version: 'v0.0.12', changes: ['Account linking', 'Calendar', 'Temper tracking'] };
  const data = { versions: [{ version: 'v0.0.13', changes: ['Future'] }, release] };
  for (const version of ['0.0.12-beta.1', 'v0.0.12-beta.2', '0.0.12-rc.1', '0.0.12-preview.wolf-dungeons.3', '0.0.12-preview.world-watch.2', '0.0.12']) {
    assert.equal(findRelease(data, version), release);
    assert.deepEqual(releaseChanges(data, version), release.changes);
  }
  assert.deepEqual(releaseChanges(data, '0.0.11-beta.2'), []);
  assert.deepEqual(releaseChanges(data, 'invalid'), []);
});

test('stable family notes supersede legacy beta notes, with exact fallback for unmerged families', () => {
  const exact = { version: 'v0.0.12-beta.1', changes: ['Legacy'] };
  const data = { versions: [null, { version: 'invalid' }, { version: 'v0.0.12', changes: ['Shared'] }, exact] };
  assert.equal(findRelease(data, '0.0.12-beta.1'), data.versions[2]);
  assert.deepEqual(releaseChanges(data, '0.0.12-beta.2'), ['Shared']);
  assert.equal(findRelease({ versions: {} }, '0.0.12-beta.2'), undefined);
  assert.equal(findRelease({ versions: [exact] }, '0.0.12'), undefined);
  assert.equal(findRelease({ versions: [exact] }, '0.0.12-beta.1'), exact);
  const preview = { version: 'v0.0.12-preview.wolf-dungeons.3', changes: ['Legacy preview'] };
  assert.equal(findRelease({ versions: [preview] }, '0.0.12-preview.wolf-dungeons.3'), preview);
});

test('merging keeps curated bundled family notes and removes all superseded remote previews and betas', () => {
  const curated = { version: 'v0.0.12', changes: ['Wolf Training', 'Dungeon maps', 'World Watch'] };
  const result = mergeChangelog({ versions: [curated] }, { versions: [
    { version: 'v0.0.12-preview.wolf-dungeons.3', changes: ['Old dungeon preview'] },
    { version: 'v0.0.12-preview.world-watch.1', changes: ['Old world preview'] },
    { version: 'v0.0.12-beta.4', changes: ['Old beta'] },
    { version: '0.0.12', changes: ['Old stable notes'] },
  ] });
  assert.deepEqual(result.versions, [curated]);
  assert.deepEqual(releaseChanges(result, '0.0.12-preview.wolf-dungeons.3'), curated.changes);
});

test('newer remote releases remain correctly ordered and consolidate their own prereleases', () => {
  const result = mergeChangelog({ versions: [
    { version: 'v0.0.12', changes: ['Local'] }, { version: 'v0.0.9', changes: ['Historical'] },
  ] }, { versions: [
    { version: 'v0.0.13-preview.1', changes: ['Superseded'] },
    { version: 'v0.0.10', changes: ['Historical remote'] },
    { version: 'v0.0.14-preview.2', changes: ['Future preview'] },
    { version: 'v0.0.13', changes: ['New release'] },
  ] });
  assert.deepEqual(result.versions.map(entry => entry.version), ['v0.0.14-preview.2', 'v0.0.13', 'v0.0.12', 'v0.0.10', 'v0.0.9']);
  assert.deepEqual(releaseChanges(result, '0.0.13-preview.1'), ['New release']);
  assert.deepEqual(releaseChanges(result, '0.0.14-preview.2'), ['Future preview']);
});

test('normalized versions deduplicate v prefixes without mutating changelog inputs', () => {
  const localEntry = Object.freeze({ version: 'v0.0.12', changes: Object.freeze(['Curated']) });
  const remoteEntry = Object.freeze({ version: '0.0.12', changes: Object.freeze(['Remote']) });
  const local = Object.freeze({ versions: Object.freeze([localEntry]) });
  const remote = Object.freeze({ versions: Object.freeze([remoteEntry, Object.freeze({ version: 'v0.0.12+build.2', changes: Object.freeze(['Duplicate build']) })]) });
  const before = JSON.stringify([local, remote]);
  const result = mergeChangelog(local, remote);
  assert.deepEqual(result.versions, [localEntry]);
  assert.equal(JSON.stringify([local, remote]), before);
  assert.notEqual(result.versions, local.versions);
  assert.notEqual(result.versions[0], localEntry);
  assert.notEqual(result.versions[0].changes, localEntry.changes);
  result.versions[0].changes.push('Caller edit');
  assert.deepEqual(localEntry.changes, ['Curated']);
});

test('malformed remote entries cannot break rendering or suppress a valid release', () => {
  const result = mergeChangelog({ versions: [null, { version: 'v0.0.12', changes: 'invalid' }] }, { versions: [
    null, 42, { version: 12, changes: [] }, { version: 'invalid', changes: ['Invalid'] },
    { version: 'v0.0.12', changes: ['Valid', null, {}, 42] },
    { version: 'v0.0.13', changes: null },
  ] });
  assert.deepEqual(result.versions, [{ version: 'v0.0.12', changes: ['Valid'] }]);
  assert.deepEqual(mergeChangelog(null, { versions: {} }), { versions: [] });
  assert.deepEqual(mergeChangelog({ versions: 'invalid' }), { versions: [] });
});
