'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../src/renderer');
const source = fs.readFileSync(path.join(root, 'update-window.js'), 'utf8');
const available = { phase: 'available', supported: true, automatic: false, currentVersion: '0.0.14', version: '0.0.15', percent: 0, changes: ['A new feature'] };
function fixture(overrides = {}, initial = available) {
  const nodes = new Map(), events = {}, calls = [];
  let changed;
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { textContent: '', hidden: false, disabled: false, attributes: {}, children: [],
      setAttribute(key, value) { this.attributes[key] = value; },
      removeAttribute(key) { delete this.attributes[key]; if (key === 'value') delete this.value; },
      replaceChildren(...children) { this.children = children; }, append(child) { this.children.push(child); } });
    return nodes.get(selector);
  };
  const api = { getState: async () => ({ config: { language: 'en' }, platformSupport: { platform: 'win32' } }),
    getUpdateState: async () => initial, onUpdateChanged: callback => { changed = callback; return () => calls.push('unsubscribe'); },
    checkAppUpdates: async () => { calls.push('check'); return initial; },
    downloadAppUpdate: async () => { calls.push('download'); return { ...initial, phase: 'ready' }; },
    installAppUpdate: async () => { calls.push('install'); return true; },
    downloadInstaller: () => calls.push('installer'), windowClose: () => calls.push('close'), ...overrides };
  const context = vm.createContext({ document: { querySelector: node, createElement: () => node('element-' + nodes.size),
    addEventListener: (name, callback) => { events[name] = callback; } },
    window: { api, addEventListener: (name, callback) => { events[name] = callback; } },
    TRANSLATIONS: { en: { updateAutomaticPolicy: 'Automatic install is ON' } } });
  vm.runInContext(source, context);
  return { node, api, calls, start: () => events.DOMContentLoaded(), emit: state => changed(state),
    click: id => node('#' + id).onclick(), run: code => vm.runInContext(code, context) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('update view shows the new version, safe release notes and fixed manual policy with the real app artwork', async () => {
  const note = '<img src=x onerror="throw 1">';
  const f = fixture({}, { ...available, automatic: true, changes: [note, null] }); await f.start();
  assert.equal(f.node('#update-heading').textContent, 'Overkot 0.0.15');
  assert.match(f.node('#update-version-path').textContent, /Installed 0\.0\.14.*New 0\.0\.15/);
  assert.match(f.node('#update-policy').textContent, /only when you choose/);
  assert.doesNotMatch(f.node('#update-policy').textContent, /Automatic install is ON/);
  assert.deepEqual(f.node('#update-notes').children.map(child => child.textContent), [note]);
  assert.equal(f.node('#update-download').hidden, false); assert.equal(f.node('#update-install').hidden, true);
  await f.click('update-install');
  assert.deepEqual(f.calls, [], 'Opening an update notice must not download or install');
  const html = fs.readFileSync(path.join(root, 'update-window.html'), 'utf8');
  assert.match(html, /id="update-app-icon" src="\.\.\/\.\.\/assets\/overkot\.png"/);
  assert.match(html, /id="update-progress"[^>]*max="100"/);
});

test('manual download paints real progress and transfer details, ignores double clicks and completes at 100 percent', async () => {
  let finish, downloads = 0;
  const f = fixture({ downloadAppUpdate: () => { downloads++; return new Promise(resolve => { finish = resolve; }); } }); await f.start();
  const pending = f.click('update-download'); f.click('update-download');
  assert.equal(downloads, 1);
  f.emit({ ...available, phase: 'downloading', percent: 37, transferred: 37 * 1024 * 1024, total: 100 * 1024 * 1024, bytesPerSecond: 2 * 1024 * 1024 });
  assert.equal(f.node('#update-progress').value, 37); assert.equal(f.node('#update-percent').textContent, '37%');
  assert.equal(f.node('#update-progress').attributes['aria-valuenow'], '37');
  assert.match(f.node('#update-transfer').textContent, /37\.0 MB of 100\.0 MB.*2\.0 MB\/s/);
  assert.equal(f.node('#update-check').disabled, true);
  f.emit({ ...available, phase: 'ready' }); finish({ ...available, phase: 'ready' }); await pending;
  assert.equal(f.node('#update-progress').value, 100); assert.equal(f.node('#update-install').hidden, false);
  assert.match(f.node('#update-transfer').textContent, /Closing Overkot will not install/);
  assert.equal(f.node('#update-install').disabled, false);
});

test('installation uses an indeterminate preparation stage and can retry a failed handoff without duplicate installs', async () => {
  let finish, installs = 0;
  const f = fixture({ installAppUpdate: () => { installs++; return new Promise(resolve => { finish = resolve; }); } }, { ...available, phase: 'ready' }); await f.start();
  const pending = f.click('update-install'); f.click('update-install');
  assert.equal(installs, 1); assert.equal(f.node('#update-install').disabled, true);
  assert.equal(f.node('#update-progress').value, undefined);
  assert.equal(f.node('#update-progress').attributes['aria-valuenow'], undefined);
  assert.equal(f.node('#update-progress').attributes['aria-valuetext'], 'Preparing installation');
  f.click('close-btn'); assert.deepEqual(f.calls, [], 'An accepted install handoff cannot be canceled by closing its preparation screen');
  finish(false); await pending;
  assert.equal(f.node('#update-progress').value, 100); assert.equal(f.node('#update-install').disabled, false);
  assert.match(f.node('#update-status').textContent, /still ready; try again/);
  f.api.installAppUpdate = async () => { installs++; return true; }; await f.click('update-install');
  assert.equal(installs, 2); assert.equal(f.node('#update-eyebrow').textContent, 'INSTALLING');
});

test('a late initial state cannot replace a newer progress event', async () => {
  let finish;
  const f = fixture({ getUpdateState: () => new Promise(resolve => { finish = resolve; }) });
  const loaded = f.start(); await tick();
  f.emit({ ...available, phase: 'downloading', percent: 63 }); finish(available); await loaded;
  assert.equal(f.node('#update-progress').value, 63); assert.equal(f.node('#update-download').hidden, true);
});

test('an asynchronous installer failure keeps the downloaded update available for install retry', async () => {
  let installs = 0;
  const f = fixture({ installAppUpdate: async () => { installs++; return true; } }, { ...available, phase: 'ready' });
  await f.start(); await f.click('update-install');
  f.emit({ ...available, phase: 'error', errorStage: 'install', percent: 0 });
  assert.equal(f.node('#update-progress').value, 100);
  assert.equal(f.node('#update-progress-label').textContent, 'Ready to retry installation');
  assert.equal(f.node('#update-install').hidden, false); assert.equal(f.node('#update-install').disabled, false);
  assert.equal(f.node('#update-download').hidden, true);
  assert.match(f.node('#update-status').textContent, /still ready; try again/);
  await f.click('update-install'); assert.equal(installs, 2);
  assert.equal(f.node('#update-eyebrow').textContent, 'INSTALLING');
});

test('checking, offline errors and unsupported packages keep honest retry and installer actions', async () => {
  const f = fixture({ checkAppUpdates: async () => { throw new Error('offline'); } }, { ...available, phase: 'current', version: null }); await f.start();
  assert.equal(f.node('#update-progress-card').hidden, true);
  await f.click('update-check'); assert.match(f.node('#update-status').textContent, /Could not complete/);
  assert.equal(f.node('#update-check').disabled, false);
  f.emit({ phase: 'checking', version: null }); assert.equal(f.node('#update-progress').value, undefined);
  f.emit({ phase: 'unsupported', supported: false, version: null, changes: [] });
  assert.equal(f.node('#update-installer').hidden, false); assert.equal(f.node('#update-download').hidden, true);
});

test('the progress treatment respects reduced motion and keeps the app icon contained', () => {
  const css = fs.readFileSync(path.join(root, 'update-window.css'), 'utf8');
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /object-fit:\s*contain/);
});
