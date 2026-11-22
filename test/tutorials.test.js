'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tutorials = require('../src/modules/tutorials');
const widgetIcons = require('../src/renderer/widget-icons');

test('every dock feature has a tutorial, including beta titles and the separate market window', () => {
  const window = { i18n: { languages: [], translations: {}, titleTrackerEnabled: true } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/shared-constants.js'), 'utf8'), { window });
  for (const id of [...window.ALL_WIDGET_IDS, 'market']) {
    const tour = tutorials.getTutorial(id, { interactionHotkey: 'Ctrl+Alt+O' });
    assert.equal(tour.id, id);
    assert.ok(tour.steps.length >= 2);
    assert.match(tour.steps[0].tip, /Ctrl \+ Alt \+ O/);
    assert.ok(tour.steps.every(step => step.title && step.body && step.tip));
  }
  assert.equal(tutorials.getTutorial('removed-widget'), null);
  assert.equal(tutorials.getTutorial('__proto__'), null);
});

test('completion merges independently and accepts only known own boolean flags', () => {
  const completed = Object.assign(Object.create({ calendar: true }), { app: true, boss: 'true', wiki: false, unknown: true });
  assert.deepEqual(tutorials.normalizeTutorialCompleted(completed), { app: true });
  assert.equal(tutorials.isTutorialComplete(completed, 'calendar'), false);
  assert.equal(tutorials.isTutorialComplete(completed, 'app'), true);
  const boss = tutorials.completeTutorial(completed, 'boss');
  const clock = tutorials.completeTutorial(boss, 'clock');
  assert.deepEqual(clock, { app: true, boss: true, clock: true });
  assert.equal(completed.boss, 'true', 'Normalizing never mutates an existing profile');
  assert.deepEqual(tutorials.completeTutorial(clock, 'removed-widget'), clock);
  for (const invalid of [null, [], true, 'app']) assert.deepEqual(tutorials.normalizeTutorialCompleted(invalid), {});
});

test('the app tour uses current independent focus and visibility chords', () => {
  const tour = tutorials.getTutorial('app', { interactionHotkey: 'Alt+F3', overlayVisibilityHotkey: 'Ctrl+Shift+H' });
  assert.match(tour.steps[1].body, /Alt \+ F3/);
  assert.match(tour.steps[4].body, /Ctrl \+ Shift \+ H/);
  assert.doesNotMatch(tour.steps[4].body, /Alt \+ F3/);
  assert.match(tutorials.getTutorial('app').steps[1].body, /Shift \+ F1/);
});

function renderer({ id = 'app', state = Promise.resolve({ config: {} }), complete = async () => true, setEnabled = async () => true } = {}) {
  const elements = new Map(), events = new Map(), calls = [];
  let changed;
  const node = (tagName = 'div') => {
    const element = { tagName, attributes: {}, dataset: {}, children: [], hidden: false, disabled: false,
    textContent: '', className: '', focused: false, handlers: new Map(),
    setAttribute(key, value) { this.attributes[key] = value; if (key === 'class') this.className = value; },
    appendChild(child) { this.children.push(child); return child; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    focus() { this.focused = true; },
    addEventListener(event, callback) { this.handlers.set(event, callback); },
    };
    element.classList = { add(...tokens) { element.setAttribute('class', [...new Set([...element.className.split(/\s+/).filter(Boolean), ...tokens])].join(' ')); } };
    return element;
  };
  const select = selector => { if (!elements.has(selector)) elements.set(selector, node()); return elements.get(selector); };
  const context = vm.createContext({ URLSearchParams, console: { error() {} }, OverkotTutorials: tutorials,
    OverkotTheme: { apply() {} }, document: {
      querySelector: select, createElement: node, createElementNS: (_namespace, tagName) => node(tagName),
      addEventListener: (event, callback) => events.set(event, callback),
    },
    window: { WidgetIcons: widgetIcons, location: { search: `?tour=${id}` }, api: {
      getState: () => state, onConfigChanged: callback => { changed = callback; },
      completeTutorial: async tourId => { calls.push(['complete', tourId]); return complete(tourId); },
      setTutorialsEnabled: async enabled => { calls.push(['enabled', enabled]); return setEnabled(enabled); },
      windowClose: () => calls.push(['close']), openWidgets: () => calls.push(['widgets']),
    } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/tutorial.js'), 'utf8'), context);
  return { element: select, calls, changed: value => changed(value),
    initialize: () => events.get('DOMContentLoaded')(),
    click: selector => select(selector).handlers.get('click')(),
    run: code => vm.runInContext(code, context),
    key: key => events.get('keydown')({ key, preventDefault() {}, stopPropagation() {} }),
  };
}

test('widget tours render the real shared icon API and retain palette and motion hooks', async () => {
  assert.equal(widgetIcons.paths, undefined, 'Exercise the current public API without the retired paths map');
  for (const id of Object.keys(tutorials.WIDGET_TUTORIALS)) {
    const ui = renderer({ id });
    await ui.initialize();
    const emblem = ui.element('#tutorial-visual').children[0];
    assert.ok(emblem, `${id} renders its tutorial`);
    const svg = emblem.children[0];
    assert.equal(svg.attributes['data-widget-icon'], id, `${id} uses its shared catalogue icon`);
    assert.ok(svg.className.split(/\s+/).includes('overkot-icon'), `${id} retains semantic colour and motion selectors`);
    assert.ok(svg.className.split(/\s+/).includes('tutorial-symbol'), `${id} retains tutorial sizing`);
    ui.changed({ interactionHotkey: 'Ctrl+F9' });
    assert.equal(ui.element('#tutorial-visual').children[0].children[0].attributes['data-widget-icon'], id, `${id} also survives live config updates`);
  }
});

test('tour navigation keeps progress and can return to an earlier step without saving', async () => {
  const ui = renderer();
  await ui.initialize();
  assert.equal(ui.element('#tutorial-progress').textContent, '1 / 6');
  assert.equal(ui.element('#tutorial-back').disabled, true);
  ui.click('#tutorial-next');
  assert.match(ui.element('#tutorial-body').textContent, /Shift \+ F1/);
  ui.click('#tutorial-next');
  assert.equal(ui.element('#tutorial-action').textContent, 'Choose widgets');
  ui.click('#tutorial-action');
  ui.click('#tutorial-back');
  assert.equal(ui.element('#tutorial-progress').textContent, '2 / 6');
  assert.deepEqual(ui.calls, [['widgets']], 'Trying a feature or going Back does not finish the tour');
  assert.equal(ui.element('#tutorial-step-title').focused, true);
});

test('new config received while loading stays authoritative for the displayed shortcut', async () => {
  let resolve;
  const ui = renderer({ state: new Promise(done => { resolve = done; }) });
  const initializing = ui.initialize();
  ui.changed({ interactionHotkey: 'Ctrl+F9' });
  resolve({ config: { interactionHotkey: 'Shift+F1' } });
  await initializing;
  ui.click('#tutorial-next');
  assert.match(ui.element('#tutorial-body').textContent, /Ctrl \+ F9/);
});

test('completion failure stays visible and retry completes only the current widget', async () => {
  let succeed = false;
  const ui = renderer({ id: 'clock', complete: async () => succeed });
  await ui.initialize();
  ui.click('#tutorial-next'); ui.click('#tutorial-next');
  assert.equal(ui.element('#tutorial-next').textContent, 'Done');
  await ui.run('finishTutorial()');
  assert.equal(ui.element('#tutorial-error').hidden, false);
  assert.equal(ui.element('#tutorial-next').disabled, false);
  assert.deepEqual(ui.calls, [['complete', 'clock']]);
  succeed = true;
  await ui.run('finishTutorial()');
  assert.deepEqual(ui.calls, [['complete', 'clock'], ['complete', 'clock'], ['close']]);
});

test('double completion clicks save once and close only after persistence succeeds', async () => {
  let resolve;
  const ui = renderer({ complete: () => new Promise(done => { resolve = done; }) });
  await ui.initialize();
  const finish = ui.run('finishTutorial()');
  await ui.run('finishTutorial()');
  assert.deepEqual(ui.calls, [['complete', 'app']]);
  assert.equal(ui.element('#tutorial-next').disabled, true);
  resolve(true);
  await finish;
  assert.deepEqual(ui.calls, [['complete', 'app'], ['close']]);
});

test('Skip and Escape both remember the dismissed tour instead of showing it again', async () => {
  for (const method of ['skip', 'escape']) {
    const ui = renderer({ id: 'wiki' });
    await ui.initialize();
    if (method === 'skip') ui.click('#tutorial-skip');
    else ui.key('Escape');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(ui.calls, [['complete', 'wiki'], ['close']]);
  }
});

test('every app and widget tour can disable all tours without marking incomplete tours complete', async () => {
  for (const id of tutorials.TUTORIAL_IDS) {
    const ui = renderer({ id });
    await ui.initialize();
    ui.click('#tutorial-disable-all');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(ui.calls, [['enabled', false], ['close']], id + ' saves the global opt-out before closing');
  }
});

test('disable all waits for persistence, prevents duplicate saves and recovers from failure', async () => {
  let resolve;
  const ui = renderer({ setEnabled: () => new Promise(done => { resolve = done; }) });
  await ui.initialize();
  const first = ui.run('disableAllTutorials()');
  await ui.run('disableAllTutorials()');
  assert.deepEqual(ui.calls, [['enabled', false]]);
  assert.equal(ui.element('#tutorial-disable-all').disabled, true);
  resolve(false); await first;
  assert.equal(ui.element('#tutorial-error').hidden, false);
  assert.equal(ui.element('#tutorial-disable-all').disabled, false);
  assert.equal(ui.element('#tutorial-next').disabled, false);
  const retry = ui.run('disableAllTutorials()');
  resolve(true); await retry;
  assert.deepEqual(ui.calls, [['enabled', false], ['enabled', false], ['close']]);
});

test('tutorial preference IPC accepts only Settings/tour boolean edits and keeps failed saves atomic', () => {
  const handlers = new Map(), calls = [];
  const settingsWindow = {}, tutorialWindow = { _tutorialId: 'clock', isDestroyed: () => false, close: () => calls.push(['close']) };
  let canSave = true;
  const profile = { tutorialsEnabled: true, tutorialCompleted: { app: true } };
  const pending = new Set(['clock']);
  const context = vm.createContext({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    BrowserWindow: { fromWebContents: sender => sender }, settingsWindow, tutorialWindow,
    config: { get: (key, fallback) => profile[key] ?? fallback, set(key, value) {
      if (!canSave) return false;
      profile[key] = value; return true;
    } },
    completeTutorial: tutorials.completeTutorial, pendingWidgetTutorials: pending,
    broadcastDockConfig: () => calls.push(['broadcast']),
  });
  const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  const start = main.indexOf("ipcMain.handle('tutorial:complete'");
  vm.runInContext(main.slice(start, main.indexOf('// ─── Settings window', start)), context);
  const change = handlers.get('tutorial:set-enabled');
  assert.equal(change({ sender: {} }, false), false);
  for (const invalid of ['false', null, 0, {}]) assert.equal(change({ sender: settingsWindow }, invalid), false);
  assert.equal(profile.tutorialsEnabled, true); assert.equal(pending.size, 1); assert.deepEqual(calls, []);
  canSave = false;
  assert.equal(change({ sender: settingsWindow }, false), false);
  assert.equal(handlers.get('tutorial:complete')({ sender: tutorialWindow }, 'clock'), false);
  assert.deepEqual(profile.tutorialCompleted, { app: true }); assert.equal(pending.size, 1); assert.deepEqual(calls, []);
  canSave = true;
  assert.equal(change({ sender: settingsWindow }, false), true);
  assert.equal(profile.tutorialsEnabled, false); assert.equal(pending.size, 0);
  assert.deepEqual(profile.tutorialCompleted, { app: true }); assert.deepEqual(calls, [['broadcast'], ['close']]);
  assert.equal(change({ sender: settingsWindow }, true), true);
  assert.equal(profile.tutorialsEnabled, true);
  assert.equal(handlers.get('tutorial:complete')({ sender: tutorialWindow }, 'clock'), true);
  assert.deepEqual(profile.tutorialCompleted, { app: true, clock: true });
});
