const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LogWatcher } = require('../src/modules/logWatcher');

const first = 'a'.repeat(24), second = 'bc'.repeat(12);
const login = (name, id) => `123.456 Sys [Info]: Logged in ${name} (${id})\r\n`;

function fixture(t, text = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-login-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'EE.log');
  fs.writeFileSync(file, text);
  t.mock.method(LogWatcher, 'candidatePaths', () => [file]);
  const watcher = new LogWatcher();
  watcher._poll();
  return { watcher, file, append: data => fs.appendFileSync(file, data) };
}

test('only complete session records identify the current player', t => {
  const { watcher, append } = fixture(t, login('First', first).repeat(20));
  assert.equal(watcher.extractAccountId(), first);
  append('Game [Info]: Logging in as Second player\n');
  assert.equal(watcher.currentLogin(), null);
  append(`Game [Info]: a message quoting Logged in First (${first})\nAccountId: ${first}\n`);
  assert.equal(watcher.extractAccountId(), '');
  append('Game [Info]: Logged in Second player\n');
  assert.equal(watcher.currentLogin(), null);
  append(login('Second player', second.toUpperCase()));
  assert.deepEqual(watcher.currentLogin(), { name: 'Second player', accountId: second });
  append('Game [Info]: quoting QUIT :Logged out of game\n');
  assert.equal(watcher.extractAccountId(), second);
  for (const logout of ['Script [Info]: MainMenu.lua: Main menu - LogOut()', 'QUIT :Logged out of game']) {
    append(logout + '\n');
    watcher._poll();
    assert.equal(watcher.consumeLogoutSignal(), true);
    assert.equal(watcher.consumeLoginSignal(), false);
    assert.equal(watcher.extractAccountId(), '');
    append(login('Second player', second));
    assert.equal(watcher.extractAccountId(), second);
  }
});

test('record and chunk boundaries cannot turn a quoted login into a session', t => {
  const { watcher, file, append } = fixture(t, login('First', first));
  const bare = `Logged in Second (${second})\n`;
  const suffix = bare + 'x'.repeat(65536 - bare.length - 1) + '\n';
  fs.writeFileSync(file, login('First', first) + 'quoted ' + suffix);
  assert.equal(watcher.extractAccountId(), first);
  fs.writeFileSync(file, '123.456 Sys [Info]: ' + suffix);
  assert.equal(watcher.extractAccountId(), second);
  watcher._poll(); watcher._poll(); watcher.consumeLoginSignal();
  append('Script [Info]: MainMenu.lua: Main menu - Log');
  watcher._poll();
  assert.equal(watcher.currentLogin(), null);
  assert.equal(watcher.consumeLogoutSignal(), false);
  append('Out()\r\n');
  watcher._poll();
  assert.equal(watcher.consumeLogoutSignal(), true);
  assert.equal(watcher.currentLogin(), null);
  append(`Sys [Info]: Logged in First (${first.slice(0, 10)}`);
  watcher._poll();
  assert.equal(watcher.currentLogin(), null);
  append(`${first.slice(10)})\r\n`);
  watcher._poll();
  assert.equal(watcher.consumeLoginSignal(), true);
  assert.equal(watcher.extractAccountId(), first);
});

test('replacements, truncation and log age cannot restore a previous account', t => {
  const { watcher, file, append } = fixture(t, login('First', first));
  const modified = fs.statSync(file).mtimeMs;
  assert.equal(watcher.currentLogin(modified).accountId, first);
  assert.equal(watcher.currentLogin(modified + 1), null);
  fs.renameSync(file, file + '.old');
  assert.equal(watcher.currentLogin(), null);
  fs.writeFileSync(file, 'no session here\n'.repeat(100));
  assert.equal(watcher.currentLogin(), null);
  append(login('Second', second));
  assert.equal(watcher.extractAccountId(), second);
  fs.writeFileSync(file, 'other unrelated data\n'.repeat(200));
  assert.equal(watcher.currentLogin(), null);
});

test('process checkpoint requires a new login even if the historical login is already cached', t => {
  const { watcher, append } = fixture(t, login('Old', first));
  assert.equal(watcher.currentLogin().accountId, first);
  const checkpoint = watcher.loginCheckpoint();
  assert.equal(watcher.currentLogin(0, checkpoint), null);
  append('Unrelated activity from the game\n');
  assert.equal(watcher.currentLogin().accountId, first);
  assert.equal(watcher.currentLogin(0, checkpoint), null);
  append(login('New', second));
  assert.equal(watcher.currentLogin(0, checkpoint).accountId, second);
  const reattach = watcher.loginCheckpoint();
  assert.equal(watcher.currentLogin(0, reattach), null);
  assert.equal(watcher.currentLogin(0, checkpoint).accountId, second);
  append('Sys [Info]: Logged in First (');
  const partial = watcher.loginCheckpoint();
  append(first + ')\n');
  assert.equal(watcher.currentLogin().accountId, first);
  assert.equal(watcher.currentLogin(0, partial), null);
});

test('checkpointed lookup stays closed on truncation until a confirmed login is appended', t => {
  const old = login('Old', first);
  const { watcher, file, append } = fixture(t, old + 'old activity\n'.repeat(100));
  const checkpoint = watcher.loginCheckpoint();
  fs.truncateSync(file, old.length);
  assert.equal(watcher.currentLogin(0, checkpoint), null);
  append('First unrelated record after truncation\n');
  assert.equal(watcher.currentLogin(0, checkpoint), null);
  append(login('New', second));
  assert.equal(watcher.currentLogin(0, checkpoint).accountId, second);
});

test('a newly created log can confirm a login when the log was absent at attachment', t => {
  const { watcher, file } = fixture(t);
  fs.unlinkSync(file);
  // Give attachment and creation distinct timestamps regardless of filesystem clock resolution.
  t.mock.method(Date, 'now', () => 1000);
  const checkpoint = watcher.loginCheckpoint();
  assert.equal(watcher.currentLogin(0, checkpoint), null);
  fs.writeFileSync(file, login('New', second));
  assert.equal(watcher.currentLogin(0, checkpoint).accountId, second);
});

test('a checkpoint cannot trust an archived replacement or a file that was unreadable at attach', t => {
  const { watcher, file, append } = fixture(t, login('Initial', first));
  fs.writeFileSync(file + '.archive', login('Archived', second));
  const attachedAt = fs.statSync(file + '.archive').birthtimeMs + 1000;
  t.mock.method(Date, 'now', () => attachedAt);
  const checkpoint = watcher.loginCheckpoint();
  fs.renameSync(file, file + '.old');
  fs.renameSync(file + '.archive', file);
  assert.equal(watcher.currentLogin(0, checkpoint), null);
  const denyRead = t.mock.method(fs, 'accessSync', () => { throw Object.assign(new Error('Denied'), { code: 'EACCES' }); });
  const inaccessible = watcher.loginCheckpoint();
  denyRead.mock.restore();
  assert.equal(watcher.currentLogin(0, inaccessible), null);
  append(login('New', first));
  assert.equal(watcher.currentLogin(0, checkpoint).accountId, first);
  assert.equal(watcher.currentLogin(0, inaccessible).accountId, first);
});
