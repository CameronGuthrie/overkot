'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { migrateWidgetConfiguration: migrate, PLAYER_WIDGETS } = require('../src/modules/widgetMigration');

test('new daily defaults are enabled but closed, with independently validated automatic triggers', () => {
  const data = migrate({});
  assert.deepEqual(data.widgetVisibility, { daily: true });
  assert.deepEqual(data.widgetOpen, { daily: false });
  assert.equal(data.dailyAutoLogin, true); assert.equal(data.dailyAutoReset, true); assert.equal(data.dailyBriefVersion, 1);
  assert.deepEqual(migrate(data), data);
  const invalid = migrate({ dailyAutoLogin: 'false', dailyAutoReset: 0 });
  assert.equal(invalid.dailyAutoLogin, true); assert.equal(invalid.dailyAutoReset, true);
  const disabled = migrate({ dailyAutoLogin: false, dailyAutoReset: false });
  assert.equal(disabled.dailyAutoLogin, false); assert.equal(disabled.dailyAutoReset, false);
});

test('daily opt-out and manual open choices survive subsequent migration', () => {
  const optedOut = migrate({ widgetVisibility: { daily: false }, widgetOpen: { daily: true } });
  assert.equal(optedOut.widgetVisibility.daily, false); assert.equal(optedOut.widgetOpen.daily, true);
  assert.deepEqual(migrate(optedOut), optedOut);
  const intentionallyAbsent = migrate({ dailyBriefVersion: 1, widgetVisibility: {}, widgetOpen: {} });
  assert.deepEqual(intentionallyAbsent.widgetVisibility, {}); assert.deepEqual(intentionallyAbsent.widgetOpen, {});
});

test('five inventory views become one Player and preserve affirmative visibility and open choices', () => {
  const data = migrate({ widgetVisibility: { boss: true, 'storage-capacity': false, 'session-gains': true },
    moduleVisibility: { 'account-wallet': true }, widgetOpen: { 'storage-capacity': false, 'active-boons': true },
    widgetCollapsed: { 'active-boons': true }, widgetDocked: { 'active-boons': false } });
  assert.deepEqual(data.widgetVisibility, { boss: true, player: true, daily: true });
  assert.deepEqual(data.moduleVisibility, { player: true });
  assert.deepEqual(data.widgetOpen, { player: true, daily: false });
  assert.deepEqual(data.widgetCollapsed, { player: false });
  assert.deepEqual(data.widgetDocked, { player: false });
  for (const key of ['widgetVisibility', 'moduleVisibility', 'widgetOpen', 'widgetDocked', 'widgetCollapsed']) {
    for (const id of PLAYER_WIDGETS) assert.equal(Object.hasOwn(data[key], id), false);
  }
  assert.deepEqual(migrate(data), data);
});

test('explicit replacement choices take precedence over old panels', () => {
  const data = migrate({ widgetVisibility: { player: false, 'session-gains': true, daily: false, calendar: true },
    widgetOpen: { player: false, 'active-boons': true, daily: false, calendar: true },
    widgetCollapsed: { player: true, 'account-wallet': false },
    widgetDocked: { player: false, 'equipment-progress': true } });
  assert.deepEqual(data.widgetVisibility, { player: false, daily: false });
  assert.deepEqual(data.widgetOpen, { player: false, daily: false });
  assert.deepEqual(data.widgetCollapsed, { player: true }); assert.deepEqual(data.widgetDocked, { player: false });
  const falseOnly = migrate({ widgetVisibility: { 'session-gains': false }, widgetOpen: { 'session-gains': false } });
  assert.equal(falseOnly.widgetVisibility.player, false); assert.equal(falseOnly.widgetOpen.player, false);
});

test('older module-only visibility remains effective without overruling explicit widget choices', () => {
  const data = migrate({ moduleVisibility: { 'session-gains': true, calendar: false } });
  assert.deepEqual(data.widgetVisibility, { player: true, daily: false });
  assert.deepEqual(data.moduleVisibility, { player: true, daily: false });
  const explicit = migrate({ widgetVisibility: { player: false, daily: true }, moduleVisibility: { 'session-gains': true, calendar: false } });
  assert.deepEqual(explicit.widgetVisibility, { player: false, daily: true });
});

test('calendar settings migrate to Daily without losing existing replacement bounds', () => {
  const oldBounds = { x: -250, y: 20, width: 350, height: 400 };
  const newBounds = { x: 40, y: 30, width: 410, height: 500 };
  const data = migrate({ widgetVisibility: { calendar: false }, widgetOpen: { calendar: true },
    widgetDocked: { calendar: false }, widgetCollapsed: { calendar: true },
    widgetBounds_calendar: oldBounds, widgetBounds_daily: newBounds });
  assert.equal(data.widgetVisibility.daily, false); assert.equal(data.widgetOpen.daily, true);
  assert.equal(data.widgetDocked.daily, false); assert.equal(data.widgetCollapsed.daily, true);
  assert.equal(data.widgetBounds_daily, newBounds); assert.equal(Object.hasOwn(data, 'widgetBounds_calendar'), false);
  assert.deepEqual(migrate({ widgetBounds_calendar: oldBounds }).widgetBounds_daily, oldBounds);
});

test('combined Player bounds and floating preference follow the previously open panel', () => {
  const walletBounds = { x: 30, width: 320 }, sessionBounds = { x: 500, width: 390 };
  const data = migrate({ dockWidgetOrder: ['account-wallet', 'session-gains'], widgetOpen: { 'session-gains': true },
    widgetDocked: { 'account-wallet': true, 'session-gains': false },
    'widgetBounds_account-wallet': walletBounds, 'widgetBounds_session-gains': sessionBounds });
  assert.equal(data.widgetBounds_player, sessionBounds); assert.equal(data.widgetDocked.player, false);
  assert.equal(Object.hasOwn(data, 'widgetBounds_account-wallet'), false); assert.equal(Object.hasOwn(data, 'widgetBounds_session-gains'), false);
  const explicit = migrate({ widgetBounds_player: walletBounds, 'widgetBounds_session-gains': sessionBounds });
  assert.equal(explicit.widgetBounds_player, walletBounds);
});

test('dock order and grid layouts deduplicate replacement IDs while retaining unrelated structure', () => {
  const input = { dockWidgetOrder: ['wiki', 'session-gains', 'calendar', 'player', 'account-wallet', ' daily ', 'wiki', null],
    gridLayout: { selected: 3, columns: [{ widgets: [], width: 200 },
      { widgets: ['boss', 'session-gains', 'calendar'], width: 250 },
      { widgets: ['player', 'clock', 'player'], width: 350 },
      { widgets: ['daily', 'account-wallet'], width: 410 }] } };
  const data = migrate(input);
  assert.deepEqual(data.dockWidgetOrder, ['wiki', 'player', 'daily']);
  assert.deepEqual(data.gridLayout, { selected: 3, columns: [{ widgets: [], width: 200 },
    { widgets: ['boss'], width: 250 }, { widgets: ['player', 'clock'], width: 350 }, { widgets: ['daily'], width: 410 }] });
  assert.deepEqual(migrate({ gridLayout: { columns: [{ widgets: ['session-gains'] }, { widgets: ['account-wallet'] }] } }).gridLayout.columns,
    [{ widgets: ['player'] }, { widgets: [] }]);
  assert.deepEqual(migrate(data), data);
  assert.equal(input.gridLayout.columns[1].widgets.includes('session-gains'), true, 'input structures are not mutated');
});

test('retired tutorial markers are removed without marking replacement tours complete', () => {
  const data = migrate({ tutorialCompleted: { app: true, calendar: true, 'session-gains': true, boss: true } });
  assert.deepEqual(data.tutorialCompleted, { app: true, boss: true });
  assert.equal(Object.hasOwn(data.tutorialCompleted, 'player'), false); assert.equal(Object.hasOwn(data.tutorialCompleted, 'daily'), false);
  assert.doesNotThrow(() => migrate({ widgetVisibility: [], widgetOpen: null, gridLayout: { columns: [null, {}] } }));
});
