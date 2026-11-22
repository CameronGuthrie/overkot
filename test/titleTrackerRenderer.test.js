'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeTitleTrackerPreferences: normalize } = require('../src/modules/trackerPreferences');

const copy = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const snapshot = { status: 'live', unreadableChallenges: 0, rows: [
  { id: 'alpha', name: 'Accomplished', description: 'Finish adventures', count: 1000, target: 1000, completed: true },
  { id: 'bravo', name: 'Beast Hunter', description: 'Defeat beasts', count: 25, target: 100, completed: false },
  { id: 'charlie', name: 'Collector', description: 'Find relics', count: 0, target: 50, completed: false },
] };
const translations = { titleSearch: 'Search titles', titleFilter: 'Filter titles', titleHideCompleted: 'Hide completed', titleHideIncomplete: 'Hide incomplete',
  titleSaveFailed: 'Could not save preferences', titleRetry: 'Retry', titleUnpin: 'Unpin', titlePin: 'Pin', titleCount: '{count} / {target}',
  titleCompleted: 'Completed', titleConnect: 'Connect to Soulframe', titleDataWaiting: 'Waiting for title data', titleWaiting: 'Waiting for inventory',
  titleSummary: '{completed}/{total} titles completed', titleCached: 'Cached inventory', titleUnreadable: '{count} records unreadable',
  titlePinned: 'Pinned', titleAll: 'Other titles', titleNoMatches: 'No titles match', titleLoadError: 'Could not load titles',
  titlePinnedOnly: 'Pinned only', titlePinnedOnlyHint: 'Hide filters and unpinned titles',
  titleShowFilters: 'Show filters and all titles',
  titleNoPinned: 'No pinned titles. Turn off Pinned only to choose titles.' };

// The same small DOM surface used by temperTrackerPreferences.test.js, extended
// with title article/button selectors and style to inspect the actual renderer.
function fixture({ preferences, state, deferState = false, deferSnapshot = false, save } = {}) {
  const saves = [], stateLoad = deferred(), snapshotLoad = deferred(), listeners = new Map(), snapshots = new Set();
  let unsubscribed = 0, resized = 0;
  const document = { activeElement: null };
  function node(tag) {
    const handlers = new Map();
    const element = { tagName: tag, className: '', dataset: {}, style: {}, children: [], attributes: {}, value: '', textContent: '', scrollTop: 0, hidden: false,
      classList: { contains(name) { return element.className.split(' ').includes(name); }, add(name) { element.className += ' ' + name; } },
      append(...children) { element.children.push(...children); },
      replaceChildren(...children) { element.children = children; },
      setAttribute(name, value) { element.attributes[name] = value; },
      addEventListener(type, handler) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(handler); },
      dispatch(type) { for (const handler of handlers.get(type) || []) handler({ target: element }); },
      click() { element.dispatch('click'); }, focus() { document.activeElement = element; },
      querySelectorAll(selector) {
        const matches = item => selector.startsWith('.') ? item.classList.contains(selector.slice(1))
          : selector === '[data-title-id]' ? item.dataset.titleId !== undefined : false;
        const descendants = element.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
        return selector === '*' ? descendants : descendants.filter(matches);
      },
      querySelector(selector) { return element.querySelectorAll(selector)[0] || null; },
    };
    return element;
  }
  document.createElement = node;
  const window = { addEventListener(type, handler) { listeners.set(type, handler); }, removeEventListener(type, handler) { if (listeners.get(type) === handler) listeners.delete(type); } };
  window.api = {
    getState: () => deferState ? stateLoad.promise : Promise.resolve(state || { config: { titleTrackerPreferences: normalize() } }),
    getTitleTracker: () => deferSnapshot ? snapshotLoad.promise : Promise.resolve(snapshot),
    onTitleTrackerChanged: callback => {
      snapshots.add(callback);
      return () => { snapshots.delete(callback); unsubscribed++; };
    },
    saveConfig: patch => { saves.push(copy(patch)); return save ? save(patch) : Promise.resolve(true); },
  };
  const context = vm.createContext({ window, document, TRANSLATIONS: { en: translations, fr: { titlePin: 'Épingler', titleUnpin: 'Désépingler', titleShowFilters: 'Afficher les filtres et tous les titres' } }, console });
  for (const filename of ['src/modules/trackerPreferences.js', 'src/renderer/title-tracker.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', filename), 'utf8'), context);
  const element = node('div');
  const widget = window.TitleTrackerWidget.mount(element, { api: window.api, preferences, onResize: () => { resized++; } });
  const find = cls => element.querySelector('.' + cls);
  const pins = () => element.querySelectorAll('.title-pin');
  const pin = id => pins().find(button => button.dataset.titleId === id);
  const filter = status => element.querySelectorAll('.title-filter').find(button => button.dataset.hide === status);
  return { widget, element, document, saves, stateLoad, snapshotLoad, find, pins, pin, filter, listeners, snapshots,
    mode: () => find('title-view-toggle-compact') || find('title-view-toggle'),
    rows: () => element.querySelectorAll('.title-row'),
    ids: () => element.querySelectorAll('.title-row').map(row => row.dataset.titleId),
    search(value) { find('title-search').value = value; find('title-search').dispatch('input'); },
    update(value) { for (const callback of [...snapshots]) callback(value); },
    get unsubscribed() { return unsubscribed; }, get resized() { return resized; },
  };
}

test('title rows display names, accessible progress totals and proportionate bars', async () => {
  const f = fixture({ preferences: normalize() }); await tick();
  assert.deepEqual(f.ids(), ['alpha', 'bravo', 'charlie']);
  const progress = f.rows()[1].querySelector('.title-progress');
  assert.equal(progress.attributes.role, 'progressbar');
  assert.equal(progress.attributes['aria-label'], 'Beast Hunter');
  assert.equal(progress.attributes['aria-valuemin'], '0'); assert.equal(progress.attributes['aria-valuemax'], '100');
  assert.equal(progress.attributes['aria-valuenow'], '25'); assert.equal(progress.attributes['aria-valuetext'], '25 / 100');
  assert.equal(progress.querySelector('.title-progress-fill').style.width, '25%');
  assert.equal(progress.querySelector('.title-progress-count').textContent, '25 / 100');
  assert.equal(f.rows()[0].querySelector('.title-progress-count').textContent, '1,000 / 1,000');
  assert.equal(f.find('title-summary').textContent, '1/3 titles completed');
  assert.equal(f.find('title-search').maxLength, 300);
  assert.equal(f.pin('bravo').querySelector('.title-icon-pin').attributes['aria-hidden'], 'true');
  assert.equal(f.pin('bravo').attributes['aria-label'], 'Pin Beast Hunter');
  assert.equal(f.saves.length, 0); f.widget.destroy();
});

test('multiple pins move to the top and unpinning returns a row to catalogue order', async () => {
  const f = fixture({ preferences: normalize() }); await tick();
  f.pin('charlie').click(); await tick();
  assert.deepEqual(f.ids(), ['charlie', 'alpha', 'bravo']);
  f.pin('bravo').click(); await tick();
  assert.deepEqual(f.ids(), ['bravo', 'charlie', 'alpha']);
  assert.equal(f.pin('bravo').attributes['aria-pressed'], 'true');
  assert.equal(f.pin('charlie').attributes['aria-pressed'], 'true');
  assert.deepEqual(f.saves.at(-1).titleTrackerPreferences.pinned, ['charlie', 'bravo']);
  assert.deepEqual(f.element.querySelectorAll('.title-section-label').map(label => label.textContent), ['Pinned (2)', 'Other titles (1)']);
  f.pin('bravo').click(); await tick();
  assert.deepEqual(f.ids(), ['charlie', 'alpha', 'bravo']);
  assert.deepEqual(f.saves.at(-1).titleTrackerPreferences.pinned, ['charlie']);
  assert.equal(f.pin('bravo').attributes['aria-pressed'], 'false');
  f.pin('charlie').click(); await tick();
  assert.deepEqual(f.ids(), ['alpha', 'bravo', 'charlie']);
  assert.equal(f.element.querySelectorAll('.title-section-label').length, 0);
  f.widget.destroy();
});

test('completed/incomplete filters apply to pinned titles and name/description search', async () => {
  const f = fixture({ preferences: normalize({ pinned: ['alpha', 'bravo'] }) }); await tick();
  f.filter('completed').click(); await tick();
  assert.deepEqual(f.ids(), ['bravo', 'charlie']);
  assert.equal(f.filter('completed').attributes['aria-pressed'], 'true');
  f.search(' RELICS '); await tick(); assert.deepEqual(f.ids(), ['charlie']);
  f.search('Hunter'); await tick(); assert.deepEqual(f.ids(), ['bravo']);
  f.filter('incomplete').click(); await tick(); assert.deepEqual(f.ids(), []);
  assert.equal(f.find('title-empty').textContent, 'No titles match');
  f.search(''); f.filter('completed').click(); await tick(); assert.deepEqual(f.ids(), ['alpha']);
  f.filter('incomplete').click(); await tick();
  assert.deepEqual(f.saves.at(-1).titleTrackerPreferences, normalize({ pinned: ['alpha', 'bravo'] }));
  f.widget.destroy();
});

test('pinned-only toggle hides controls and unpinned rows while preserving and bypassing saved filters', async () => {
  const preferences = normalize({ pinned: ['alpha', 'bravo'], showCompleted: false, showIncomplete: false, search: 'relics' });
  const f = fixture({ preferences }); await tick();
  const toggle = f.find('title-view-toggle');
  assert.ok(toggle.querySelector('.title-icon-eye'));
  assert.equal(toggle.attributes['aria-label'], translations.titlePinnedOnlyHint);
  assert.equal(toggle.attributes['aria-pressed'], 'false');
  assert.equal(f.find('title-controls').querySelector('.title-view-toggle'), null);
  assert.equal(f.find('title-toolbar').querySelector('.title-view-toggle'), toggle);
  assert.deepEqual(f.ids(), []);
  f.find('title-scroll').scrollTop = 120;
  toggle.focus(); toggle.click(); await tick();
  assert.deepEqual(f.ids(), ['alpha', 'bravo'], 'Hidden completion states and unmatched search must not hide any pins');
  assert.equal(f.find('title-controls').hidden, true);
  assert.equal(f.find('title-toolbar').hidden, true);
  assert.equal(f.find('title-summary').hidden, true);
  assert.equal(f.element.querySelectorAll('.title-section-label').length, 0);
  assert.equal(f.element.querySelectorAll('.title-view-toggle-compact').length, 1);
  const compactToggle = f.mode();
  assert.equal(f.rows()[0].querySelector('.title-row-head').querySelector('.title-view-toggle-compact'), compactToggle);
  assert.ok(compactToggle.querySelector('.title-icon-eye-off'));
  assert.equal(compactToggle.attributes['aria-label'], translations.titleShowFilters);
  assert.equal(compactToggle.title, translations.titleShowFilters);
  assert.equal(compactToggle.attributes['aria-pressed'], 'true');
  assert.equal(toggle.attributes['aria-pressed'], 'true');
  assert.ok(toggle.querySelector('.title-icon-eye-off'));
  assert.equal(f.find('title-search').value, 'relics');
  assert.equal(f.find('title-scroll').scrollTop, 0);
  assert.equal(f.document.activeElement, compactToggle);
  assert.deepEqual(f.saves.at(-1).titleTrackerPreferences, normalize({ ...preferences, pinnedOnly: true }));
  f.find('title-scroll').scrollTop = 120;
  compactToggle.click(); await tick();
  assert.deepEqual(f.ids(), []);
  assert.equal(f.find('title-controls').hidden, false);
  assert.equal(f.find('title-toolbar').hidden, false);
  assert.equal(f.find('title-summary').hidden, false);
  assert.equal(f.find('title-view-toggle-compact'), null);
  assert.equal(f.document.activeElement, toggle);
  assert.equal(toggle.attributes['aria-pressed'], 'false');
  assert.ok(toggle.querySelector('.title-icon-eye'));
  assert.equal(f.find('title-scroll').scrollTop, 0);
  assert.equal(f.filter('completed').attributes['aria-pressed'], 'true');
  assert.equal(f.filter('incomplete').attributes['aria-pressed'], 'true');
  assert.deepEqual(f.saves.at(-1).titleTrackerPreferences, preferences);
  f.widget.destroy();
});

test('pinned-only view restores on remount with hidden filters intact and no extra save', async () => {
  const preferences = normalize({ pinned: ['alpha', 'bravo'], showCompleted: false, search: 'relics' });
  const f = fixture({ preferences }); await tick();
  f.find('title-view-toggle').click(); await tick();
  const saved = f.saves.at(-1).titleTrackerPreferences; f.widget.destroy();
  const restored = fixture({ state: { config: { titleTrackerPreferences: saved } } }); await tick();
  assert.deepEqual(restored.ids(), ['alpha', 'bravo']);
  assert.equal(restored.mode().attributes['aria-pressed'], 'true');
  assert.equal(restored.find('title-toolbar').hidden, true);
  assert.equal(restored.find('title-summary').hidden, true);
  assert.equal(restored.find('title-controls').hidden, true);
  assert.equal(restored.find('title-search').value, 'relics');
  assert.equal(restored.saves.length, 0);
  restored.mode().click(); await tick();
  assert.deepEqual(restored.ids(), ['charlie']);
  assert.deepEqual(restored.saves.at(-1).titleTrackerPreferences, preferences);
  restored.widget.destroy();
});

test('pinned-only empty state keeps its toggle available and unpinning moves focus to it', async () => {
  const f = fixture({ preferences: normalize({ pinnedOnly: true, pinned: ['bravo'] }) }); await tick();
  f.pin('bravo').focus(); f.pin('bravo').click(); await tick();
  assert.deepEqual(f.ids(), []);
  assert.equal(f.find('title-empty').textContent, translations.titleNoPinned);
  assert.equal(f.find('title-controls').hidden, true);
  assert.equal(f.find('title-toolbar').hidden, false);
  assert.equal(f.document.activeElement, f.find('title-view-toggle'));
  assert.equal(f.saves.at(-1).titleTrackerPreferences.pinnedOnly, true);
  assert.deepEqual(f.saves.at(-1).titleTrackerPreferences.pinned, []);
  f.find('title-view-toggle').click(); await tick();
  assert.deepEqual(f.ids(), ['alpha', 'bravo', 'charlie']);
  f.widget.destroy();
  const stale = fixture({ preferences: normalize({ pinnedOnly: true, pinned: ['unknown-title'] }) }); await tick();
  assert.deepEqual(stale.ids(), []);
  assert.equal(stale.find('title-empty').textContent, translations.titleNoPinned);
  assert.equal(stale.find('title-toolbar').hidden, false);
  assert.equal(stale.saves.length, 0, 'A title absent from the current catalog must not discard its saved pin');
  stale.widget.destroy();
});

test('compact mode control retains focus after inventory, language and pin changes and falls back on disconnect', async () => {
  const f = fixture({ preferences: normalize({ pinnedOnly: true, pinned: ['alpha', 'bravo'] }) }); await tick();
  const initial = f.mode(); initial.focus();
  f.update({ ...snapshot, rows: snapshot.rows.map(row => ({ ...row, count: row.count + 1 })) });
  assert.notEqual(f.mode(), initial);
  assert.equal(f.document.activeElement, f.mode());
  f.widget.setLanguage('fr');
  assert.equal(f.document.activeElement, f.mode());
  assert.equal(f.mode().attributes['aria-label'], 'Afficher les filtres et tous les titres');
  f.pin('alpha').focus(); f.pin('alpha').click(); await tick();
  assert.deepEqual(f.ids(), ['bravo']);
  assert.equal(f.find('title-toolbar').hidden, true);
  assert.equal(f.document.activeElement, f.mode());
  assert.equal(f.rows()[0].querySelector('.title-row-head').querySelector('.title-view-toggle-compact'), f.mode());
  f.update({ ...snapshot, status: 'connect' });
  assert.deepEqual(f.ids(), []);
  assert.equal(f.find('title-toolbar').hidden, false);
  assert.equal(f.find('title-summary').hidden, false);
  assert.equal(f.find('title-summary').textContent, translations.titleConnect);
  assert.equal(f.find('title-view-toggle-compact'), null);
  assert.equal(f.document.activeElement, f.mode());
  f.update(snapshot);
  assert.equal(f.find('title-toolbar').hidden, true);
  assert.equal(f.document.activeElement, f.mode());
  f.widget.destroy();
});

test('compact view hides noncritical notices and restores notices and headers in the full view', async () => {
  const f = fixture({ preferences: normalize({ pinnedOnly: true, pinned: ['bravo'] }) }); await tick();
  assert.equal(f.find('title-summary').hidden, true);
  assert.equal(f.element.querySelectorAll('.title-section-label').length, 0);
  f.update({ ...snapshot, status: 'cached', unreadableChallenges: 2 });
  assert.equal(f.find('title-summary').hidden, true);
  assert.equal(f.find('title-summary').textContent, '');
  assert.equal(f.find('title-toolbar').hidden, true);
  assert.equal(f.element.querySelectorAll('.title-section-label').length, 0);
  f.update({ ...snapshot, status: 'cached' });
  assert.equal(f.find('title-summary').textContent, '');
  f.update({ ...snapshot, unreadableChallenges: 1 });
  assert.equal(f.find('title-summary').textContent, '');
  assert.equal(f.find('title-summary').hidden, true);
  f.update(snapshot);
  assert.equal(f.find('title-summary').hidden, true);
  f.mode().click(); await tick();
  assert.equal(f.find('title-summary').hidden, false);
  assert.equal(f.find('title-summary').textContent, '1/3 titles completed');
  assert.equal(f.find('title-toolbar').hidden, false);
  assert.deepEqual(f.element.querySelectorAll('.title-section-label').map(label => label.textContent), ['Pinned (1)', 'Other titles (2)']);
  f.update({ ...snapshot, status: 'cached', unreadableChallenges: 2 });
  assert.equal(f.find('title-summary').textContent, '1/3 titles completed · Cached inventory · 2 records unreadable');
  f.widget.destroy();
});

test('an early pinned-only toggle merges with late saved pins and filters', async () => {
  const f = fixture({ deferState: true }); await tick();
  f.find('title-view-toggle').click();
  assert.equal(f.saves.length, 0);
  const saved = normalize({ pinned: ['alpha', 'charlie'], showCompleted: false, search: 'beasts' });
  f.stateLoad.resolve({ config: { titleTrackerPreferences: saved } }); await tick();
  assert.deepEqual(f.ids(), ['alpha', 'charlie']);
  assert.equal(f.find('title-controls').hidden, true);
  assert.deepEqual(f.saves[0].titleTrackerPreferences, normalize({ ...saved, pinnedOnly: true }));
  f.widget.destroy();
});

test('saved pins, hide controls and search restore on remount', async () => {
  const f = fixture({ preferences: normalize() }); await tick();
  f.pin('bravo').click(); await tick(); f.pin('charlie').click(); await tick();
  f.filter('completed').click(); await tick(); f.search('beasts'); await tick();
  const saved = f.saves.at(-1).titleTrackerPreferences; f.widget.destroy();
  const restored = fixture({ state: { config: { titleTrackerPreferences: saved } } }); await tick();
  assert.deepEqual(restored.ids(), ['bravo']);
  assert.equal(restored.pin('bravo').attributes['aria-pressed'], 'true');
  assert.equal(restored.filter('completed').attributes['aria-pressed'], 'true');
  assert.equal(restored.find('title-search').value, 'beasts'); assert.equal(restored.saves.length, 0);
  restored.search(''); await tick(); assert.deepEqual(restored.ids(), ['bravo', 'charlie']);
  assert.deepEqual(restored.saves.at(-1).titleTrackerPreferences.pinned, ['bravo', 'charlie']);
  restored.widget.destroy();
});

test('early changes merge into late configuration without losing existing pins and untouched filters', async () => {
  const f = fixture({ deferState: true }); await tick();
  f.pin('bravo').click(); f.filter('incomplete').click(); f.search('Hunter');
  assert.equal(f.saves.length, 0, 'Do not save default settings before hydration');
  f.stateLoad.resolve({ config: { titleTrackerPreferences: normalize({ showCompleted: false, pinned: ['alpha', 'charlie'], search: 'old' }) } }); await tick();
  assert.deepEqual(f.saves[0].titleTrackerPreferences, { showCompleted: false, showIncomplete: false, pinnedOnly: false, pinned: ['alpha', 'charlie', 'bravo'], search: 'Hunter' });
  assert.equal(f.find('title-search').value, 'Hunter'); assert.deepEqual(f.ids(), []);
  f.widget.destroy();
});

test('an initial state response cannot replace a newer host configuration', async () => {
  const f = fixture({ deferState: true }); await tick();
  f.widget.setPreferences(normalize({ pinned: ['charlie'], search: 'relics' }));
  f.stateLoad.resolve({ config: { titleTrackerPreferences: normalize({ pinned: ['alpha'], search: 'adventures' }) } }); await tick();
  assert.deepEqual(f.ids(), ['charlie']); assert.equal(f.find('title-search').value, 'relics');
  assert.equal(f.saves.length, 0); f.widget.destroy();
});

test('a newer pushed snapshot wins over a stale initial snapshot or initial request failure', async () => {
  for (const fails of [false, true]) {
    const f = fixture({ preferences: normalize(), deferSnapshot: true });
    const pushed = { ...snapshot, status: 'cached', rows: [{ ...snapshot.rows[1], count: 75 }] };
    f.update(pushed);
    if (fails) f.snapshotLoad.reject(new Error('Temporary request failure')); else f.snapshotLoad.resolve(snapshot);
    await tick();
    assert.deepEqual(f.ids(), ['bravo']);
    assert.equal(f.find('title-progress-count').textContent, '75 / 100');
    assert.equal(f.find('title-summary').textContent, '0/1 titles completed · Cached inventory');
    f.widget.destroy();
  }
});

test('rapid changes save serially and pending config echoes do not undo local choices', async () => {
  const writes = [], f = fixture({ preferences: normalize(), save: () => { const write = deferred(); writes.push(write); return write.promise; } });
  await tick(); f.pin('charlie').click(); f.pin('bravo').click(); f.filter('completed').click(); f.search('beasts');
  f.widget.setPreferences(normalize());
  assert.deepEqual(f.ids(), ['bravo']); assert.equal(f.saves.length, 1);
  writes[0].resolve(true); await tick();
  assert.equal(f.saves.length, 2);
  assert.deepEqual(f.saves[1].titleTrackerPreferences, { showCompleted: false, showIncomplete: true, pinnedOnly: false, pinned: ['charlie', 'bravo'], search: 'beasts' });
  writes[1].resolve(true); await tick();
  f.widget.setPreferences(f.saves[1].titleTrackerPreferences); await tick();
  assert.equal(f.saves.length, 2); f.widget.destroy();
});

test('pin focus follows a reordered row, survives inventory updates and uses translated labels', async () => {
  const f = fixture({ preferences: normalize() }); await tick();
  f.pin('charlie').focus(); f.pin('charlie').click(); await tick();
  assert.equal(f.document.activeElement, f.pin('charlie'));
  assert.equal(f.pin('charlie').attributes['aria-label'], 'Unpin Collector');
  f.find('title-scroll').scrollTop = 120;
  f.update({ ...snapshot, rows: snapshot.rows.map(row => ({ ...row, count: row.count + 1 })) });
  assert.equal(f.document.activeElement, f.pin('charlie'));
  assert.equal(f.find('title-scroll').scrollTop, 120);
  f.widget.setLanguage('fr');
  assert.equal(f.pin('charlie').attributes['aria-label'], 'Désépingler Collector');
  assert.equal(f.pin('bravo').attributes['aria-label'], 'Épingler Beast Hunter');
  f.widget.destroy();
});

test('disconnect and waiting states clear account data without clearing saved preferences', async () => {
  const f = fixture({ preferences: normalize({ pinned: ['bravo'], search: 'beasts' }) }); await tick();
  for (const [status, message] of [['connect', 'Connect to Soulframe'], ['data', 'Waiting for title data'], ['waiting', 'Waiting for inventory']]) {
    f.update({ ...snapshot, status });
    assert.deepEqual(f.ids(), []); assert.equal(f.find('title-controls').hidden, true);
    assert.equal(f.find('title-summary').textContent, message);
  }
  f.update({ ...snapshot, status: 'cached', unreadableChallenges: 2 });
  assert.deepEqual(f.ids(), ['bravo']); assert.equal(f.find('title-controls').hidden, false);
  assert.equal(f.pin('bravo').attributes['aria-pressed'], 'true');
  assert.equal(f.find('title-summary').textContent, '1/3 titles completed · Cached inventory · 2 records unreadable');
  assert.equal(f.saves.length, 0); f.widget.destroy();
});

test('failed saves retain intent, expose Retry, and persist current preferences on retry', async () => {
  let fail = true;
  const f = fixture({ preferences: normalize(), save: () => fail ? Promise.resolve(false) : Promise.resolve(true) }); await tick();
  f.pin('charlie').click(); await tick();
  assert.equal(f.find('title-save-error').hidden, false); assert.equal(f.find('title-save-message').textContent, 'Could not save preferences');
  f.widget.setPreferences(normalize()); assert.equal(f.pin('charlie').attributes['aria-pressed'], 'true');
  fail = false; f.find('title-retry').click(); await tick();
  assert.equal(f.find('title-save-error').hidden, true);
  assert.deepEqual(f.saves.at(-1).titleTrackerPreferences.pinned, ['charlie']); f.widget.destroy();
});

test('destroy removes listeners once and ignores late configuration and snapshot resolutions', async () => {
  const f = fixture({ deferState: true, deferSnapshot: true });
  f.widget.destroy(); f.widget.destroy();
  f.stateLoad.resolve({ config: { titleTrackerPreferences: normalize({ search: 'beasts' }) } });
  f.snapshotLoad.resolve(snapshot); await tick();
  assert.equal(f.unsubscribed, 1); assert.equal(f.listeners.has('unload'), false); assert.equal(f.snapshots.size, 0);
  assert.equal(f.find('title-search').value, ''); assert.deepEqual(f.ids(), []); assert.equal(f.saves.length, 0);
});
