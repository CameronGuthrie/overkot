// Combines the specifically reviewed legacy baseline with the public v2 rules.
// This command writes local files only. It never connects to Firebase.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const [baseline, canonical, destination, cutoff] = process.argv.slice(2);
assert.ok(baseline && canonical && destination && cutoff,
  'Expected private baseline directory, canonical firebase directory, output directory and ISO UTC cutoff');
assert.match(cutoff, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
const deadline = Date.parse(cutoff);
assert.ok(Number.isFinite(deadline) && deadline <= Date.now() + 2 * 60 * 60_000,
  'Choose a UTC deadline within the next two hours, or a past time to rehearse expiry');
const read = (directory, name) => fs.readFileSync(path.join(directory, name), 'utf8');
const normalize = text => text.replace(/\r\n/g, '\n').trim();
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const oldFirestore = normalize(read(baseline, 'firestore.rules'));
const oldDatabase = JSON.parse(read(baseline, 'database.rules.json'));
assert.equal(digest(oldFirestore), 'b57e2bea62bf9b300d6bdcf994a7c7602623ea20910b6494647d2e341d3a0689',
  'The active Firestore rules changed. Review them before building an overlap.');
assert.equal(digest(JSON.stringify(oldDatabase)), '68cae26cfa40ff1eaf105ef210a760e3c605a90d5c5bed637b5444f3d8508388',
  'The active Realtime Database rules changed. Review them before building an overlap.');
const legacyRules = oldFirestore.replace(/\/\/[^\n]*/g, '');
let permissions = 0;
const timedRules = legacyRules.replace(/(\ballow\s+[a-z, ]+\s*:\s*if\s+)([^;]+);/g, (_, prefix, expression) => {
  permissions++;
  return prefix + 'request.time.toMillis() < ' + deadline + ' && (' + expression.trim() + ');';
});
assert.equal(permissions, 17);
const strictRules = normalize(read(canonical, 'firestore.rules'));
const match = /service cloud\.firestore \{\s*(match \/databases\/\{database\}\/documents\/groupFinder\/v2 \{[\s\S]+\})\s*\}$/.exec(strictRules);
assert.ok(match, 'Unexpected canonical Firestore structure');
const overlapFirestore = timedRules.slice(0, timedRules.lastIndexOf('}')) + '\n  ' + match[1] + '\n}\n';

const strictDatabase = JSON.parse(read(canonical, 'database.rules.json'));
assert.deepEqual(Object.keys(strictDatabase.rules), ['groupFinder']);
const oldPresence = oldDatabase.rules.presence.$playerId;
oldPresence['.write'] = 'now < ' + deadline + ' && (' + oldPresence['.write'] + ')';
oldPresence.online['.read'] = 'now < ' + deadline + ' && (' + oldPresence.online['.read'] + ')';
const overlapDatabase = { rules: { ...oldDatabase.rules, ...strictDatabase.rules } };
assert.notEqual(path.resolve(destination), path.resolve(baseline));
assert.notEqual(path.resolve(destination), path.resolve(canonical));
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(path.join(destination, 'firestore.rules'), overlapFirestore);
fs.writeFileSync(path.join(destination, 'database.rules.json'), JSON.stringify(overlapDatabase, null, 2) + '\n');
for (const file of ['firebase.json', 'firestore.indexes.json']) fs.copyFileSync(path.join(canonical, file), path.join(destination, file));
console.log('Legacy authorization expires at ' + cutoff + '. Output: ' + path.resolve(destination));
