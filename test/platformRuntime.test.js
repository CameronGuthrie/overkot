'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadModule(filename, overrides, globals = {}) {
  const context = { module: { exports: {} }, process, console, ...globals,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : require(name) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/modules', filename), 'utf8'), context);
  return context.module.exports;
}

test('application data follows Windows, XDG and macOS native directories', () => {
  const created = [];
  const { resolveAppDirectory, APP_DIR } = loadModule('appPaths.js', {
    fs: { mkdirSync: directory => created.push(directory) },
    os: { platform: () => 'darwin', homedir: () => '/Users/envoy' },
  }, { process: { env: {} } });
  assert.equal(APP_DIR, '/Users/envoy/Library/Application Support/Overkot');
  assert.equal(created[0], APP_DIR);
  assert.equal(resolveAppDirectory({ platform: 'win32', home: 'C:\\Users\\envoy', env: {} }),
    'C:\\Users\\envoy\\AppData\\Local\\Overkot');
  assert.equal(resolveAppDirectory({ platform: 'win32', home: 'C:\\Users\\envoy', env: { LOCALAPPDATA: 'D:\\Profile' } }),
    'D:\\Profile\\Overkot');
  assert.equal(resolveAppDirectory({ platform: 'linux', home: '/home/envoy', env: { XDG_DATA_HOME: '/data/envoy' } }),
    '/data/envoy/Overkot');
  for (const value of ['', 'relative/data', undefined]) {
    assert.equal(resolveAppDirectory({ platform: 'linux', home: '/home/envoy', env: { XDG_DATA_HOME: value } }),
      '/home/envoy/.local/share/Overkot');
  }
});

function detectorFixture(platform, { files = {}, statuses = {}, output = '', procMissing = false, uid = 1000,
  helperOutput, helperError } = {}) {
  const commands = [];
  const helpers = [];
  const { ProcessDetector } = loadModule('processDetector.js', {
    os: { platform: () => platform },
    fs: {
      readdirSync: () => { if (procMissing) throw new Error('missing /proc'); return Object.keys(files); },
      readFileSync: filename => {
        const pid = filename.split('/')[2];
        if (!filename.endsWith('/status')) return files[pid];
        if (Object.hasOwn(statuses, pid)) {
          if (statuses[pid] === null) throw new Error('unreadable status');
          return statuses[pid];
        }
        return `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
      },
    },
    child_process: {
      exec: (command, options, done) => { commands.push(command); done(null, { stdout: output }); },
      execFile: (file, args, options, done) => {
        if (helperOutput === undefined && !helperError) throw new Error('Unexpected helper launch');
        helpers.push({ file, args, options });
        done(helperError, { stdout: helperOutput });
      },
      spawn: () => { throw new Error('Unexpected process launch'); },
    },
    util: { promisify: fn => (...args) => new Promise((resolve, reject) =>
      fn(...args, (error, value) => error ? reject(error) : resolve(value))) },
  }, { process: { getuid: uid === null ? undefined : () => uid, kill: process.kill } });
  return { detector: new ProcessDetector(), commands, helpers };
}

test('Linux discovers the truncated Wine game process name and ignores launchers', async () => {
  const { detector, commands } = detectorFixture('linux', {
    files: { 12: 'SoulframeLauncher', 1234: 'Soulframe.x64.e\n' },
  });
  assert.equal(await detector.findProcess(), 1234);
  assert.equal(commands.length, 0);
});

test('Linux ps fallback matches executable names without confusing launchers with the game', async () => {
  const { detector, commands } = detectorFixture('linux', {
    procMissing: true, output: '12 1000 SoulframeLauncher\n123 1001 Soulframe.x64.exe\n1234 1000 /games/Soulframe.x64.exe\n',
  });
  assert.equal(await detector.findProcess(), 1234);
  assert.deepEqual(commands, ['ps -eo pid,uid,comm --no-headers']);
});

test('Linux ignores other-user or unreadable games and selects the current user game', async () => {
  const { detector } = detectorFixture('linux', {
    files: { 12: 'Soulframe.x64.e', 13: 'Soulframe.x64.e', 14: 'Soulframe.x64.e', 15: 'Soulframe.x64.e', 1234: 'Soulframe.x64.e' },
    statuses: { 12: 'Uid:\t1001\t1001\t1001\t1001\n', 13: 'Uid:\t1000\t1001\t1000\t1000\n',
      14: null, 15: 'Name:\tSoulframe.x64.e\n' },
  });
  assert.equal(await detector.findProcess(), 1234);
});

test('Linux does not select a process without a usable current-user identity', async () => {
  for (const uid of [null, -1, NaN]) {
    const { detector, commands } = detectorFixture('linux', { uid, files: { 1234: 'Soulframe.x64.e' } });
    assert.equal(await detector.findProcess(), 0);
    assert.deepEqual(commands, []);
  }
});

test('Windows process discovery retains its tasklist behavior', async () => {
  const { detector, commands } = detectorFixture('win32', { output: '"Soulframe.x64.exe","1234","Console","1","100 K"' });
  assert.equal(await detector.findProcess(), 1234);
  assert.match(commands[0], /^tasklist /);
});

test('returning game focus discovers Soulframe and uses a hidden, bounded native helper', async () => {
  const { detector, commands, helpers } = detectorFixture('win32', {
    output: '"Soulframe.x64.exe","1234","Console","1","100 K"', helperOutput: '1\r\n',
  });
  assert.equal(await detector.focusGameWindow(), true);
  assert.equal(commands.length, 1);
  assert.equal(helpers.length, 1);
  const { file, args, options } = helpers[0];
  assert.equal(file, 'powershell.exe');
  assert.equal(options.windowsHide, true);
  assert.equal(options.timeout, 3000);
  assert.equal(args[args.indexOf('-WindowStyle') + 1], 'Hidden');
  const script = args[args.indexOf('-Command') + 1];
  assert.match(script, /Get-Process -Id 1234/);
  assert.match(script, /ProcessName -ine 'Soulframe\.x64'/);
  assert.match(script, /owner != expectedPid/);
  assert.match(script, /IsIconic\(window\)/);
  assert.match(script, /ShowWindowAsync\(window, 9\)/);
  assert.match(script, /SetForegroundWindow\(window\)/);
  assert.match(script, /GetWindowThreadProcessId\(GetForegroundWindow\(\), out owner\)/);
});

test('returning game focus does not launch helpers without a valid discovered game PID', async () => {
  const { detector, helpers } = detectorFixture('win32', { helperOutput: '1' });
  assert.equal(await detector.focusGameWindow(), false);
  for (const gamePid of [0, -1, 1.5, NaN, Infinity, 0x100000000, '1234']) {
    detector.findProcess = async () => gamePid;
    assert.equal(await detector.focusGameWindow(), false);
  }
  assert.equal(helpers.length, 0);
});

test('returning game focus handles missing windows, denied focus, and helper failures', async () => {
  for (const helperOutput of ['0', '', 'True', '1\n0']) {
    const { detector } = detectorFixture('win32', { helperOutput });
    detector.findProcess = async () => 1234;
    assert.equal(await detector.focusGameWindow(), false);
  }
  const { detector } = detectorFixture('win32', { helperError: new Error('helper timed out') });
  detector.findProcess = async () => 1234;
  assert.equal(await detector.focusGameWindow(), false);
  detector.findProcess = async () => { throw new Error('discovery failed'); };
  assert.equal(await detector.focusGameWindow(), false);
});

test('returning game focus is unavailable on non-Windows platforms', async () => {
  for (const platform of ['linux', 'darwin']) {
    const { detector, commands, helpers } = detectorFixture(platform);
    assert.equal(await detector.focusGameWindow(), false);
    assert.equal(commands.length, 0);
    assert.equal(helpers.length, 0);
  }
});

test('returning game focus cancels before or during discovery without launching a helper', async () => {
  const { detector, commands, helpers } = detectorFixture('win32', { helperOutput: '1' });
  const before = new AbortController();
  before.abort();
  assert.equal(await detector.focusGameWindow({ signal: before.signal }), false);
  assert.equal(commands.length, 0);
  const during = new AbortController();
  detector.findProcess = async () => { during.abort(); return 1234; };
  assert.equal(await detector.focusGameWindow({ signal: during.signal }), false);
  assert.equal(helpers.length, 0);
});

test('returning game focus forwards cancellation to the native child process', async () => {
  const { detector, helpers } = detectorFixture('win32', { helperOutput: '1' });
  const controller = new AbortController();
  detector.findProcess = async () => 1234;
  assert.equal(await detector.focusGameWindow({ signal: controller.signal }), true);
  assert.equal(helpers[0].options.signal, controller.signal);
});

test('macOS does not wait indefinitely for an unsupported game process or launch PowerShell', async () => {
  const { detector, commands } = detectorFixture('darwin');
  assert.equal(await detector.findProcess(), 0);
  assert.equal(await detector.waitForProcess(), 0);
  detector.startForegroundMonitor();
  assert.equal(await detector.isProcessForeground(1234), true);
  assert.equal(commands.length, 0);
});
