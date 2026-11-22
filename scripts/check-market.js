// Isolated renderer + real preload smoke check. All market IPC is mocked; no game,
// credentials, live listings or user settings are touched. --packaged uses app.asar.
'use strict';

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
    env, encoding: 'utf8', windowsHide: true, timeout: 90000,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, ipcMain, session, protocol } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const packaged = process.argv.includes('--packaged');
const source = packaged ? path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar', 'src') : path.join(root, 'src');
const output = path.join(root, 'output', `market-check-${packaged ? 'packaged-' : ''}${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-background-networking');
protocol.registerSchemesAsPrivileged([{ scheme: 'overkot-map-tiles', privileges: { standard: true, secure: true } }]);
const iconFor = name => require('../src/data/tempers.json').tempers.find(row => row.name === name)?.icon;
const catalogue = [
  { id: 'windfall', slug: 'windfall', name: 'Windfall', category: 'weapons', maxQuantity: 6, acceptedQuantityMax: 1, attributeType: 'weapon', tradeable: true, canBeShiny: true, possibleTempers: [
    { unique_name: 'AspectAttackSpeed', displayName: 'Swift Strike', icon: iconFor('Swift Strike') },
    { unique_name: 'AspectHeavyAttack', displayName: 'Full Force', icon: iconFor('Full Force') },
    { unique_name: 'AspectDamageAtFullHealth', displayName: 'Hale and Hearty', icon: iconFor('Hale and Hearty') },
    { unique_name: 'AspectDamageWithNoSidearm', displayName: 'Unencumbered', icon: iconFor('Unencumbered') },
  ] },
  { id: 'thread', slug: 'moonsteel-thread', name: 'Moonsteel Thread', category: 'resource', maxQuantity: 999, acceptedQuantityMax: 999, tradeable: true },
  { id: 'mote', slug: 'courage-mote', name: 'Courage Mote', category: 'mote', maxQuantity: 6, acceptedQuantityMax: 1, attributeType: 'mote', tradeable: true },
  { id: 'rune', slug: 'courage-rune', name: 'Courage Rune', category: 'rune', maxQuantity: 6, acceptedQuantityMax: 1, attributeType: 'rune', tradeable: true },
];
const inventory = {
  available: true, playerName: 'TestEnvoy', summary: { inventoryAvailable: true, unmatchedEntries: 2 },
  rows: [
    { key: 'weapon-1', itemId: 'windfall', name: 'Windfall', category: 'weapons', quantity: 2, availableQuantity: 2, maxQuantity: 6, canList: true, warnings: [], attributes: { weapon: { quality: 'WORN', moonsteel: true, tempers: ['AspectAttackSpeed'] } } },
    { key: 'thread-1', itemId: 'thread', name: 'Moonsteel Thread', category: 'resource', quantity: 84, availableQuantity: 80, listedQuantity: 4, maxQuantity: 999, canList: true, warnings: [], attributes: {} },
    { key: 'mote-1', itemId: 'mote', name: 'Courage Mote', category: 'mote', quantity: 1, availableQuantity: 0, equippedQuantity: 1, maxQuantity: 6, canList: false, warnings: ['Installed in your weapon.'], attributes: { mote: { virtue: 'COURAGE', upgradeLevel: 3, gripType: 'SwordSkill' } } },
    { key: 'weapon-2', itemId: 'windfall', name: 'Windfall', category: 'weapons', quantity: 1, availableQuantity: 1, maxQuantity: 6, canList: true, warnings: [], attributes: { weapon: { quality: 'LEGENDARY', moonsteel: false, tempers: ['AspectAttackSpeed', 'AspectAttackSpeed', 'AspectHeavyAttack', 'AspectHeavyAttack', 'AspectDamageAtFullHealth', 'AspectDamageAtFullHealth', 'AspectDamageWithNoSidearm', 'AspectDamageWithNoSidearm'] } } },
  ],
};
const account = { id: 'test-account', displayHandle: 'TestEnvoy', platform: 'PC', inGameVerified: true, restrictionState: 'NONE' };
let state = { authenticated: false, user: null, sessionPersistent: false, catalogue: [], inventory, listings: [], trading: {} };
const clone = value => JSON.parse(JSON.stringify(value));
const calls = [];
const errors = [];
let win;
let loginReadFailure = false;
let browseFailure = false;
let advancedEmpty = false;
const publicListing = (id = 'offer-1', item = catalogue[0]) => ({
  id, itemId: item.id, item, type: 'OFFER', status: 'ACTIVE', quantity: 1, platform: 'PC',
  terms: { priceAmount: 25, priceUnit: 'Arcs', termsNote: 'Ready for a trade at the Nightfold.' },
  quality: 'WORN', moonsteel: true, tempers: item.id === 'windfall' ? ['AspectAttackSpeed'] : [], seller: { userId: 'seller', handle: 'OtherEnvoy', inGame: true },
});
const ownListing = () => ({ ...publicListing('mine-1', catalogue[1]), quantity: 4, quality: null, moonsteel: false, seller: undefined });
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(check, label) {
  for (let attempt = 0; attempt < 160; attempt++) { if (await check()) return; await pause(25); }
  throw new Error('Timed out: ' + label);
}
const evaluate = sourceText => win.webContents.executeJavaScript(sourceText, true);
const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const textOf = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent`);
const count = selector => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
const input = (selector, value, event = 'input') => evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); element.value = ${JSON.stringify(value)}; element.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); })()`);
function push() { win.webContents.send('market:changed', clone(state)); }
async function capture(name) {
  win.showInactive();
  win.webContents.invalidate();
  await pause(180);
  let picture;
  await until(async () => { picture = await win.webContents.capturePage(); return !picture.isEmpty(); }, 'Screenshot is painted');
  fs.writeFileSync(path.join(output, name + '.png'), picture.toPNG());
}
async function fits() {
  const dimensions = await evaluate(`({width:innerWidth,body:document.body.scrollWidth,main:document.querySelector('main').scrollWidth,nav:document.querySelector('.market-nav').scrollWidth,pane:document.querySelector('.listing-pane').clientWidth,paneScroll:document.querySelector('.listing-pane').scrollWidth})`);
  assert(dimensions.body <= dimensions.width, JSON.stringify(dimensions));
  assert(dimensions.nav <= dimensions.width, JSON.stringify(dimensions));
  assert(dimensions.paneScroll <= dimensions.pane + 1, JSON.stringify(dimensions));
}

ipcMain.on('get-i18n', event => { event.returnValue = { translations: { en: require('../langs/en.json') }, languages: [] }; });
ipcMain.handle('get-state', () => ({ config: { theme: 'dark-mint' } }));
ipcMain.handle('market:state', () => clone(state));
ipcMain.handle('market:refresh', () => { calls.push({ action: 'refresh' }); return { ok: true, state: clone(state) }; });
ipcMain.handle('market:avakot-login', (_event, options) => {
  calls.push({ action: 'avakot-login', remember: options.remember });
  state = { ...state, signIn: { pending: true, userCode: 'ABCD-1234', error: '' } }; push();
  return { ok: true, state: clone(state) };
});
ipcMain.handle('market:avakot-cancel', () => {
  calls.push({ action: 'avakot-cancel' });
  state = { ...state, signIn: { pending: false, userCode: '', error: '' } }; push();
  return { ok: true, state: clone(state) };
});
ipcMain.handle('market:login', (_event, credentials) => {
  assert.equal(credentials.email, 'envoy@example.com');
  assert.equal(credentials.password, 'test-password');
  assert.equal(credentials.remember, true);
  calls.push({ action: 'login' });
  state = { ...state, authenticated: true, user: account, sessionPersistent: true, listings: [ownListing()] };
  push();
  if (loginReadFailure) return { ok: false, error: 'APP_ACCESS_REQUIRED', message: 'The market server needs the Overkot integration update.' };
  return { ok: true, state: clone(state) };
});
ipcMain.handle('market:logout', () => {
  calls.push({ action: 'logout' });
  state = { ...state, authenticated: false, user: null, listings: [] };
  push();
  return { ok: true, state: clone(state) };
});
ipcMain.handle('market:browse', async (_event, query) => {
  calls.push({ action: 'browse', query });
  if (browseFailure) return { ok: false, error: 'NETWORK_ERROR', message: 'Offline fixture. Try again.' };
  const item = catalogue.find(item => item.slug === query.slug) || catalogue[0];
  // Intentionally finish older requests last to catch stale-result replacement.
  if (query.sort === 'lowest') await pause(250);
  const id = query.page === 2 ? 'offer-2' : query.sort === 'highest' ? 'highest-offer' : 'offer-1';
  const listing = publicListing(id, item);
  if (query.sort === 'lowest') listing.seller.handle = 'STALE RESULT';
  if (query.sort === 'highest') listing.seller.handle = 'HigherPriceEnvoy';
  if (query.view === 'requests') listing.type = 'REQUEST';
  if (query.advanced) return { ok: true, listings: advancedEmpty ? [] : [listing], meta: { count: advancedEmpty ? 0 : 1, limit: 50 } };
  return { ok: true, listings: [listing], meta: { total: 2, page: query.page, hasNextPage: query.page === 1,
    ...(!query.slug && query.page === 1 ? { nextCursor: 'fixture-next-cursor' } : {}) } };
});
ipcMain.handle('market:copy-contact', (_event, id) => { calls.push({ action: 'contact', id }); return { ok: true }; });
ipcMain.handle('market:website', (_event, section) => { calls.push({ action: 'website', section }); return { ok: true }; });
ipcMain.handle('market:create', (_event, draft) => {
  assert.equal(draft.rowKey, 'weapon-1');
  assert.equal(draft.quantity, 1);
  assert.equal(draft.priceAmount, undefined);
  assert.equal(draft.termsNote, undefined);
  assert.equal(draft.acceptedItems.length, 6);
  assert.deepEqual(draft.acceptedItems[0], { type: 'ARCS', amount: 38 });
  assert.deepEqual(draft.acceptedItems[1], { type: 'ITEM', itemId: 'thread', quantity: 25 });
  assert.deepEqual(draft.acceptedItems[2], { type: 'ITEM', itemId: 'windfall', weapon: { quality: 'MILITARY', moonsteel: true, tempers: [], tempersAny: true } });
  assert.deepEqual(draft.acceptedItems[3], { type: 'ITEM', itemId: 'mote', mote: { virtue: 'SPIRIT', upgradeLevel: 3, gripType: 'SwordSkill' } });
  assert.deepEqual(draft.acceptedItems[4], { type: 'ITEM', itemId: 'rune', rune: { upgradeLevel: 2 } });
  calls.push({ action: 'create', draft });
  state.listings.push({ ...publicListing('created-1'), terms: { ...publicListing().terms, ...mockTerms(draft.acceptedItems) } });
  state.inventory.rows[0].availableQuantity--;
  push();
  return { ok: true, state: clone(state) };
});
ipcMain.handle('market:update', (_event, draft) => {
  calls.push({ action: 'update', draft });
  const listing = state.listings.find(listing => listing.id === draft.id);
  assert(listing, 'Only owned listing is modified');
  if (draft.status) listing.status = draft.status;
  if (draft.quantity) listing.quantity = draft.quantity;
  if (Object.hasOwn(draft, 'acceptedItems')) Object.assign(listing.terms, mockTerms(draft.acceptedItems));
  push();
  return { ok: true, state: clone(state) };
});

// Match the website's flat read projection after nested slot payloads are saved.
function mockTerms(entries) {
  const acceptedItems = entries.map(entry => {
    if (entry.type === 'ARCS') return { ...entry };
    const item = catalogue.find(item => item.id === entry.itemId);
    const flat = { type: 'ITEM', itemId: entry.itemId, itemName: item?.name, itemSlug: item?.slug };
    if (entry.quantity != null) flat.quantity = entry.quantity;
    if (entry.weapon) Object.assign(flat, entry.weapon);
    if (entry.mote) Object.assign(flat, { moteVirtue: entry.mote.virtue, moteUpgradeLevel: entry.mote.upgradeLevel, moteGripType: entry.mote.gripType });
    if (entry.rune) flat.runeUpgradeLevel = entry.rune.upgradeLevel;
    return flat;
  });
  return { acceptedItems, priceAmount: entries.length === 1 && entries[0].type === 'ARCS' ? entries[0].amount : null, priceUnit: entries.length === 1 && entries[0].type === 'ARCS' ? 'arcs' : null };
}

app.whenReady().then(async () => {
  const { createTemperIconHandler } = require('../src/modules/temperIconProtocol');
  const files = Object.fromEntries(catalogue[0].possibleTempers.map(temper => [temper.icon, {}]));
  session.defaultSession.protocol.registerFileProtocol('overkot-map-tiles', createTemperIconHandler({
    manifest: { files }, cachedPath: () => null, checkForUpdates: async () => {},
    ensureAsset: async key => Object.hasOwn(files, key) ? path.join(root, 'assets/overkot.png') : null,
  }));
  // Even fixture mistakes cannot make network requests during this check.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
  win = new BrowserWindow({ width: 960, height: 720, frame: false, show: false,
    webPreferences: { preload: path.join(source, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3 && /Uncaught|Error invoking|ReferenceError|TypeError/.test(message)) errors.push(message); });
  win.webContents.on('render-process-gone', (_event, details) => errors.push(details.reason));
  await win.loadFile(path.join(source, 'renderer', 'market.html'));
  await until(async () => await count('#browse-results .listing-card') === 1, 'signed-out public browsing');
  await until(() => calls.some(call => call.action === 'refresh'), 'Opening market restores stored session');
  assert.equal(await evaluate(`document.querySelector('#account-dialog').open`), false, 'Browsing does not prompt for sign-in');
  assert((await textOf('#connection-status')).includes('Browsing public listings'));
  assert.equal(await count('.catalogue-pane, #catalogue-results, #catalogue-search'), 0, 'No catalogue sidebar is rendered');
  assert.equal(await evaluate(`document.querySelector('.listing-pane').getBoundingClientRect().width >= innerWidth - 1`), true, 'Browse fills the window width');
  await capture('00-default-any');
  state.catalogue = catalogue; push();
  await until(async () => await count('#browse-temper-options input') === 4, 'public catalogue supplies trait filters');
  assert.equal(calls.find(call => call.action === 'browse').query.advanced, undefined, 'Initial browsing uses recent listings');
  assert.equal(calls.find(call => call.action === 'browse').query.sort, 'recent');
  assert.equal(await evaluate(`document.querySelector('[data-browse-kind="any"]').getAttribute('aria-pressed')`), 'true', 'Any is selected on first open');
  assert.equal(await evaluate(`document.querySelector('.browse-advanced').getBoundingClientRect().top < document.querySelector('#browse-results').getBoundingClientRect().top`), true, 'Advanced controls are above results');
  await click('[data-browse-kind="weapons"]');
  await until(() => calls.some(call => call.query?.advanced), 'Weapons opens advanced search');
  await input('#browse-query', 'Windfall');
  await input('#browse-quality-min', 'MILITARY', 'change');
  await input('#browse-quality-max', 'LEGENDARY', 'change');
  await input('#browse-moonsteel', 'true', 'change');
  await input('#browse-grip', 'SwordSkill', 'change');
  await click('#browse-advanced-form button[type="submit"]');
  await until(() => calls.some(call => call.query?.advanced?.qualityMin === 'MILITARY'), 'Weapon traits are applied');
  assert.deepEqual(calls.filter(call => call.query?.advanced).at(-1).query.advanced, {
    q: 'Windfall', qualityMin: 'MILITARY', qualityMax: 'LEGENDARY', moonsteel: 'true', weaponGripType: 'SwordSkill', tempers: [], temperMatch: 'all',
  });
  await click('[data-browse-kind="tempers"]');
  assert((await textOf('#browse-advanced-hint')).includes('traits on the listed weapon'));
  await click('#browse-temper-options input[value="AspectAttackSpeed"]');
  await click('#browse-temper-options input[value="AspectHeavyAttack"]');
  await input('#browse-temper-match', 'any', 'change');
  await click('#browse-advanced-form button[type="submit"]');
  await until(() => calls.some(call => call.query?.advanced?.tempers.length === 2), 'Selected tempers are applied');
  assert.equal(calls.filter(call => call.query?.advanced).at(-1).query.advanced.temperMatch, 'any');
  assert.equal(await evaluate(`document.querySelector('#browse-more').hidden`), true, 'Bounded advanced search has no unsupported pagination');
  assert.equal(await evaluate(`document.querySelector('#browse-limit').hidden`), false, 'Advanced search always discloses its result limit');
  await capture('00-advanced-tempers');
  win.setSize(620, 580);
  await until(() => evaluate('innerWidth === 620'), 'Minimum-width advanced filters');
  await evaluate(`document.querySelector('.listing-pane').scrollTop = 0`);
  await fits(); await capture('00-advanced-tempers-620');
  await evaluate(`document.querySelector('#browse-results').scrollIntoView({block:'start'})`);
  assert.equal(await evaluate(`(() => { const pane = document.querySelector('.listing-pane'); const bounds = pane.getBoundingClientRect(); const results = document.querySelector('#browse-results').getBoundingClientRect(); return pane.scrollTop > 0 && results.bottom > bounds.top && results.top < bounds.bottom; })()`), true, 'Expanded filters keep listings reachable by scrolling');
  await capture('00-advanced-results-620');
  win.setSize(960, 720);
  await until(() => evaluate('innerWidth === 960'), 'Restore default market width');
  await evaluate(`document.querySelector('.listing-pane').scrollTop = 0`);
  await input('#browse-view', 'requests', 'change');
  advancedEmpty = true;
  await input('#browse-availability', 'in-game', 'change');
  await until(async () => (await textOf('#browse-results')).includes('No matches in this search'), 'Bounded empty advanced results');
  assert((await textOf('#browse-limit')).includes('first 50 search matches'));
  assert((await textOf('#browse-results')).includes('choose Anyone'));
  advancedEmpty = false;
  await click('[data-browse-kind="any"]');
  await until(() => !calls.filter(call => call.action === 'browse').at(-1).query.advanced, 'Reset returns to newest recent listings');
  assert.equal(await evaluate(`document.querySelector('#browse-sort').value`), 'recent');
  const anyQuery = calls.filter(call => call.action === 'browse').at(-1).query;
  assert.deepEqual(anyQuery, { view: 'requests', sort: 'recent', availability: 'in-game', page: 1 }, 'Any removes weapon, item, category, and cursor filters while preserving side and availability');
  assert.equal(await evaluate(`document.querySelector('[data-browse-kind="any"]').getAttribute('aria-pressed') === 'true' && document.querySelector('#browse-advanced-form').hidden`), true);
  assert.deepEqual(await evaluate(`['browse-query','browse-quality-min','browse-quality-max','browse-moonsteel','browse-grip','browse-temper-search'].map(id => document.getElementById(id).value)`), ['', '', '', '', '', '']);
  assert.equal(await count('#browse-temper-options input:checked'), 0);
  await input('#browse-view', 'offers', 'change');
  await input('#browse-availability', 'any', 'change');
  await until(async () => await count('#browse-results .listing-card') === 1, 'Any recent results load');
  await click('#browse-more');
  await until(async () => await count('#browse-results .listing-card') === 2, 'Recent cursor page loads');
  assert.equal(calls.filter(call => call.action === 'browse').at(-1).query.cursor, 'fixture-next-cursor');
  await click('[data-browse-kind="any"]');
  assert.deepEqual(calls.filter(call => call.action === 'browse').at(-1).query, { view: 'offers', sort: 'recent', availability: 'any', page: 1 }, 'Any resets an existing pagination cursor');
  await until(async () => (await textOf('#browse-title')) === 'Recent listings', 'return to public recent listings');
  assert.equal(calls.filter(call => call.action === 'browse').at(-1).query.slug, undefined, 'Recent browsing has no catalogue item selection');
  browseFailure = true;
  await input('#browse-availability', 'available', 'change');
  await until(async () => (await textOf('#browse-results')).includes('Could not load listings'), 'public network failure');
  assert.equal(await evaluate(`document.querySelector('#account-dialog').open`), false);
  browseFailure = false;
  await click('#browse-results .primary-button');
  await until(async () => await count('#browse-results .listing-card') === 1, 'public browse retry');
  await capture('00-public-browse');
  await click('#browse-results .listing-card button');
  assert(calls.some(call => call.action === 'contact'), 'Logged-out users can copy a public whisper');
  await click('#tab-inventory');
  assert((await textOf('#inventory-gate')).includes('Sign in'));
  assert.equal(await count('.inventory-list-item:enabled'), 0, 'Publishing remains unavailable while signed out');
  await click('#tab-mine');
  assert((await textOf('#mine-results')).includes('Sign in'));
  await click('#tab-browse');
  state.catalogue = []; push();
  assert.equal(calls.some(call => ['login', 'avakot-login', 'create', 'update'].includes(call.action)), false);
  await click('#account-button');
  await capture('00-signin');
  assert.equal(await evaluate(`document.querySelector('#email-login').open`), false, 'Avakot sign-in is the primary option');
  await click('#avakot-login');
  await until(async () => (await textOf('#avakot-code')) === 'ABCD-1234', 'Browser confirmation code');
  assert.equal(await evaluate(`document.querySelector('#login-email').disabled && document.querySelector('#login-password').disabled && document.querySelector('#email-login').hidden`), true);
  await capture('00-browser-pending');
  await click('#avakot-cancel');
  await until(() => evaluate(`document.querySelector('#avakot-pending').hidden && !document.querySelector('#avakot-login').disabled`), 'Cancellation restores sign-in');
  state.signIn = { pending: false, error: 'Sign-in expired. Start again from the Market window.' }; push();
  await until(async () => (await textOf('#avakot-error')).includes('expired'), 'Browser error remains visible');
  await click('#avakot-login');
  await until(() => evaluate(`!document.querySelector('#avakot-pending').hidden`), 'Retry browser sign-in');
  state = { ...state, authenticated: true, user: account, signIn: { pending: false, error: '' } }; push();
  await until(() => evaluate(`!document.querySelector('#account-dialog').open`), 'Browser completion closes dialog');
  assert((await textOf('#account-name')).includes('TestEnvoy'));
  await click('#account-button'); await click('#logout');
  await until(() => evaluate(`!document.querySelector('#login-form').hidden`), 'Browser session signs out');
  await click('#account-button');
  await click('#email-login summary');
  await input('#login-email', 'envoy@example.com');
  await input('#login-password', 'test-password');
  await click('#login-submit');
  await until(async () => await count('#browse-results .listing-card') === 1, 'login loads browsing');
  assert.equal(await evaluate(`document.querySelector('#login-password').value`), '');
  assert((await textOf('#browse-results')).includes('Unknown temper'), 'Browsing can finish before the catalogue/languages');
  const browseRequestsBeforeCatalogue = calls.filter(call => call.action === 'browse').length;
  state.catalogue = catalogue; push();
  await until(async () => (await textOf('#browse-results')).includes('Swift Strike'), 'Late catalogue definitions update cached browse cards');
  assert.equal(calls.filter(call => call.action === 'browse').length, browseRequestsBeforeCatalogue, 'Display data refresh does not fetch listings again');
  assert.equal(await textOf('#inventory-category option[value="mote"]'), 'Totems');
  assert.equal(await textOf('#inventory-category option[value="resource"]'), 'Resources');
  assert.equal(await textOf('#inventory-category option[value="weapons"]'), 'Weapons');
  assert.equal(await evaluate(`document.querySelector('#browse-results .temper-details').open`), false, 'Temper names start collapsed');
  await until(() => evaluate(`Array.from(document.querySelectorAll('#browse-results summary .market-temper-icon img')).some(img => img.naturalWidth > 0)`), 'streamed temper artwork paints');
  assert((await textOf('#browse-results .temper-names')).includes('Swift Strike'), 'Internal temper IDs resolve through the item catalogue');
  assert(!(await textOf('#browse-results')).includes('AspectAttackSpeed'), 'No internal aspect IDs are displayed');
  await capture('01-browse');
  await click('#browse-more');
  await until(async () => await count('#browse-results .listing-card') === 2, 'pagination');
  await click('#browse-results .listing-card button');
  assert(calls.some(call => call.action === 'contact'), 'Whisper uses clipboard bridge');
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true}))`);
  assert.equal(await evaluate(`document.activeElement.id`), 'browse-query', 'Find shortcut focuses the top listing search');
  await input('#browse-query', 'Windfall');
  await click('#browse-advanced-form button[type="submit"]');
  await until(() => calls.some(call => call.query?.advanced?.q === 'Windfall'), 'Top listing search applies');
  await input('#browse-sort', 'lowest', 'change');
  await input('#browse-sort', 'highest', 'change');
  await until(async () => (await textOf('#browse-results')).includes('HigherPriceEnvoy'), 'latest browse result');
  await pause(300);
  assert(!(await textOf('#browse-results')).includes('STALE RESULT'), 'Older response is ignored');

  await click('#tab-inventory');
  assert(await evaluate(`(() => { const icon = document.querySelector('#panel-inventory .search-icon').getBoundingClientRect(); const field = document.querySelector('#inventory-search').getBoundingClientRect(); return Math.abs(icon.y + icon.height / 2 - field.y - field.height / 2) < .5; })()`), 'Inventory search icon is vertically centred');
  assert.equal(await count('.inventory-card'), 4);
  assert.equal(await count('.inventory-card button:disabled'), 1, 'Equipped item cannot be listed');
  assert.equal(await evaluate(`document.querySelector('#inventory-grouped').checked`), false, 'Grouping starts off');
  assert.equal(await count('.inventory-group'), 0);
  const firstWeapon = '.inventory-card[data-row-key="weapon-1"]';
  const legendaryWeapon = '.inventory-card[data-row-key="weapon-2"]';
  assert.equal(await count(legendaryWeapon + ' .temper-details > summary .market-temper-icon'), 8, 'All eight tempers remain individually visible');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(legendaryWeapon)}).getBoundingClientRect().height < 190`), true, 'Eight tempers fit a compact card');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('${firstWeapon} .craftwork-tier')).color !== getComputedStyle(document.querySelector('${legendaryWeapon} .craftwork-tier')).color`), true, 'Craftwork tiers have distinct colours');
  await capture('02-inventory-grid');
  await click(firstWeapon + ' .temper-details > summary');
  await until(() => evaluate(`document.querySelector('${firstWeapon} .temper-details').open`), 'Temper names expand');
  assert((await textOf(firstWeapon + ' .temper-names')).includes('Swift Strike'));
  state.inventory.rows[0].listedQuantity = 1; push();
  await until(async () => (await textOf(firstWeapon)).includes('1 listed'), 'Inventory update is rendered');
  assert.equal(await evaluate(`document.querySelector('${firstWeapon} .temper-details').open`), true, 'Inventory refresh preserves expanded temper names');
  await input('#inventory-search', 'Swift Strike');
  assert.equal(await count('.inventory-card'), 2, 'Inventory search uses resolved temper names');
  await input('#inventory-search', '');
  await click('#inventory-grouped');
  assert.equal(await count('.inventory-group'), 3, 'Same item variants share one group');
  assert.equal(await count('.inventory-group[data-item-id="windfall"] .inventory-card'), 2);
  assert.equal(await evaluate(`document.querySelector('.inventory-group[data-item-id="windfall"]').open`), false, 'Groups start collapsed');
  await click('.inventory-group[data-item-id="windfall"] > summary');
  await until(() => evaluate(`document.querySelector('.inventory-group[data-item-id="windfall"]').open`), 'Item group expands');
  await capture('02b-inventory-grouped');
  await click('#inventory-list');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.inventory-group[data-item-id="windfall"] .inventory-group-items')).display`), 'flex', 'Grouped variants follow list layout');
  state.inventory.rows.push({ ...clone(state.inventory.rows[0]), key: 'same-name-other-id', itemId: 'another-windfall' }); push();
  await until(async () => await count('.inventory-group') === 4, 'Matching names with different item IDs stay separate');
  assert.equal(await evaluate(`document.querySelector('.inventory-group[data-item-id="windfall"]').open`), true, 'Updates preserve expanded groups');
  await input('#inventory-sort', 'quantity', 'change');
  assert.equal(await evaluate(`document.querySelector('.inventory-group').dataset.itemId`), 'thread', 'Group sorting uses total quantity');
  await input('#inventory-search', 'Windfall');
  assert.equal(await count('.inventory-group'), 2, 'Search filters grouped items');
  state.inventory.rows.pop(); state.inventory.rows[0].listedQuantity = 0; push();
  await until(async () => await count('.inventory-group') === 1, 'Removed item group disappears');
  await input('#inventory-search', '');
  await input('#inventory-sort', 'name', 'change');
  await click('#inventory-grouped');
  assert.equal(await count('.inventory-group'), 0, 'Grouping can be turned off');
  await click('#inventory-list');
  assert.equal(await count('.inventory-results.list-view'), 1);
  await input('#inventory-search', 'windfall');
  assert.equal(await count('.inventory-card'), 2);
  await click(firstWeapon + ' .inventory-list-item');
  assert.equal(await evaluate(`document.querySelector('#composer-dialog').open`), true);
  assert.equal(await evaluate(`document.querySelector('#composer-quantity').value`), '1');
  assert((await textOf('#composer-item')).includes('Moonsteel'), 'Variant preview is prefilled');
  assert.equal(await count('#composer-note'), 0, 'No free-text trade note');
  assert.equal(await count('.trade-slot'), 6, 'Exactly six accepted trade slots');
  const slot = index => click(`.trade-slot[data-slot="${index}"]`);
  const chooseTradeItem = async (index, search) => {
    await slot(index); await input('#trade-search', search); await click('.trade-search-result');
  };
  const doneWithSlot = () => click('#trade-editor-done');
  await slot(0); await click('#trade-mode-arcs'); await input('#trade-arcs-amount', '38'); await doneWithSlot();
  await chooseTradeItem(1, 'Moonsteel Thread');
  assert.equal(await evaluate(`document.querySelector('#trade-mode-arcs').disabled`), true, 'Only one Arcs slot');
  await input('#trade-item-quantity', '25'); await doneWithSlot();
  await chooseTradeItem(2, 'Windfall');
  assert.equal(await evaluate(`document.querySelector('#composer-submit').disabled`), true, 'Accepted weapon needs a quality');
  await input('#trade-weapon-quality', 'MILITARY', 'change');
  await input('#trade-temper-select', 'AspectAttackSpeed', 'change');
  assert.equal(await evaluate(`document.querySelector('#composer-submit').disabled`), false, 'Specific temper satisfies quality requirement');
  await click('#trade-any-tempers'); await click('#trade-weapon-moonsteel'); await doneWithSlot();
  await chooseTradeItem(3, 'Courage Mote');
  assert.equal(await count('#trade-item-quantity'), 0, 'Nonstackable items use one slot per copy');
  await input('#trade-mote-virtue', 'SPIRIT', 'change'); await input('#trade-mote-level', '3', 'change'); await input('#trade-mote-grip', 'SwordSkill', 'change'); await doneWithSlot();
  await chooseTradeItem(4, 'Courage Rune'); await input('#trade-rune-level', '2', 'change'); await doneWithSlot();
  await chooseTradeItem(5, 'Moonsteel Thread'); await input('#trade-item-quantity', '2'); await doneWithSlot();
  await capture('03-composer');
  win.setSize(620, 580);
  await fits(); await capture('03b-composer-620');
  await slot(3); await capture('03c-slot-editor-620'); await doneWithSlot();
  win.setSize(960, 720);
  state.inventory.rows[0].availableQuantity = 0;
  push();
  await until(() => evaluate(`document.querySelector('#composer-submit').disabled`), 'Inventory change blocks stale draft');
  state.inventory.rows[0].availableQuantity = 2;
  push();
  await until(async () => !(await evaluate(`document.querySelector('#composer-submit').disabled`)), 'Fresh inventory restores draft');
  await click('#composer-submit');
  await until(async () => await count('#mine-results .listing-card') === 2, 'Created listing is shown');
  await until(async () => !(await evaluate(`document.querySelector('#composer-dialog').open`)), 'Create composer closes');
  assert(calls.some(call => call.action === 'create'));
  const createdTerms = state.listings.find(listing => listing.id === 'created-1').terms;
  createdTerms.acceptedItems[1].itemName = 'InternalResourceName'; createdTerms.termsNote = 'Canonical label refresh'; push();
  await until(async () => (await textOf('#mine-results')).includes('Canonical label refresh'), 'Accepted item snapshot refresh is rendered');
  assert((await textOf('#mine-results')).includes('Moonsteel Thread'), 'Accepted item uses resolved catalogue name');
  assert(!(await textOf('#mine-results')).includes('InternalResourceName'), 'Accepted trade labels prefer catalogue names to raw snapshots');
  await click('#mine-results .listing-card button');
  await slot(0); await input('#trade-arcs-amount', '45'); await doneWithSlot();
  await click('#composer-submit');
  await until(async () => (await textOf('#mine-results')).toLowerCase().includes('45 arcs'), 'Edited price');
  await until(async () => !(await evaluate(`document.querySelector('#composer-dialog').open`)), 'Edit composer closes');
  await click('#mine-results .listing-card .listing-actions button:nth-child(2)');
  await until(async () => (await textOf('#mine-results .listing-card')).includes('Paused'), 'Pause listing');
  await click('#mine-results .listing-card .listing-actions button:nth-child(2)');
  await until(async () => (await textOf('#mine-results .listing-card')).includes('Active'), 'Resume listing');
  await click('#mine-results .listing-card .listing-actions button:nth-child(3)');
  await click('#confirm-close');
  await until(async () => await count('#mine-results .listing-card') === 1, 'Close listing removes active card');
  assert(calls.some(call => call.action === 'update' && call.draft.status === 'CLOSED'));
  await capture('04-my-listings');
  const updatesBeforeNoop = calls.filter(call => call.action === 'update').length;
  await click('#mine-results .listing-card button');
  await click('#composer-submit');
  await until(async () => !(await evaluate(`document.querySelector('#composer-dialog').open`)), 'No-op editor closes');
  assert.equal(calls.filter(call => call.action === 'update').length, updatesBeforeNoop, 'Unchanged editor does not mutate the listing');
  state.listings.find(listing => listing.id === 'created-1').terms.acceptedItems[2].moonsteel = null;
  state.trading.arcsTradeDisabled = true;
  push();
  await until(async () => !(await evaluate(`document.querySelector('#market-notice').hidden`)), 'Arcs maintenance notice');
  await click('#mine-results .listing-card button');
  await slot(0);
  assert.equal(await evaluate(`document.querySelector('#trade-arcs-amount').disabled`), true);
  await doneWithSlot();
  await input('#composer-quantity', '2');
  await click('#composer-submit');
  await until(async () => !(await evaluate(`document.querySelector('#composer-dialog').open`)), 'Quantity-only editor closes');
  const quantityUpdate = calls.filter(call => call.action === 'update').at(-1).draft;
  assert.deepEqual(quantityUpdate, { id: 'created-1', quantity: 2 }, 'An edit preserves unchanged trade slots, including disabled Arcs');
  state.trading.arcsTradeDisabled = false;
  push();
  await click('#mine-results .listing-card button');
  await slot(1); await input('#trade-item-quantity', '27'); await doneWithSlot();
  await click('#composer-submit');
  await until(async () => !(await evaluate(`document.querySelector('#composer-dialog').open`)), 'Mixed trade editor closes');
  const changedTerms = calls.filter(call => call.action === 'update').at(-1).draft.acceptedItems;
  assert.equal(changedTerms.length, 6);
  assert.equal(changedTerms[1].quantity, 27);
  assert.deepEqual(changedTerms[2].weapon, { quality: 'MILITARY', moonsteel: null, tempers: [], tempersAny: true }, 'Untouched flat weapon traits, including unspecified Moonsteel, survive mixed-slot editing');
  assert.deepEqual(changedTerms[3].mote, { virtue: 'SPIRIT', upgradeLevel: 3, gripType: 'SwordSkill' }, 'Untouched mote traits survive');
  assert.deepEqual(changedTerms[4].rune, { upgradeLevel: 2 }, 'Untouched rune traits survive');
  await click('#mine-results .listing-card button');
  for (let index = 0; index < 6; index++) { await slot(index); await click('#trade-mode-clear'); }
  assert((await textOf('#composer-preview')).includes('Open to offers'));
  await click('#composer-submit');
  await until(async () => !(await evaluate(`document.querySelector('#composer-dialog').open`)), 'Cleared trade editor closes');
  assert.deepEqual(calls.filter(call => call.action === 'update').at(-1).draft.acceptedItems, [], 'Clearing slots explicitly removes all accepted terms');

  await click('#tab-inventory');
  await input('#inventory-search', '');
  await click('#inventory-grid');
  win.setSize(620, 580);
  await fits();
  await capture('05-inventory-620');
  await click('#tab-browse');
  await until(async () => await count('#browse-results .listing-card') > 0, 'Narrow browse loads');
  await fits();
  await capture('06-browse-620');
  win.webContents.send('theme-changed', { theme: 'classic' });
  await until(() => evaluate(`document.documentElement.dataset.theme === 'classic'`), 'Default theme applies');
  await capture('07-classic-620');
  state.user.inGameVerified = false;
  push();
  await click('#tab-inventory');
  await until(async () => (await textOf('#inventory-gate')).includes('Verify your Envoy'), 'Verification gate');
  assert.equal(await count('.inventory-card button:enabled'), 0);
  state.user.inGameVerified = true;
  state.catalogue[0].name = '<img src=x onerror="window.marketInjected=true">';
  push();
  await click('#tab-browse');
  assert.equal(await evaluate('window.marketInjected === true'), false, 'Market text cannot inject HTML');
  await click('#account-button');
  await click('#logout');
  await until(async () => (await textOf('#account-name')) === 'Sign in', 'Logout');
  await click('#tab-browse');
  await until(async () => await count('#browse-results .listing-card') > 0, 'public browsing continues after sign-out');
  loginReadFailure = true;
  await click('#account-button');
  await input('#login-email', 'envoy@example.com');
  await input('#login-password', 'test-password');
  await click('#login-submit');
  await until(async () => (await textOf('#toast')).includes('server needs the Overkot integration update'), 'Post-login data error remains visible');
  assert.equal(await evaluate('document.getElementById("account-dialog").open'), false);
  assert.equal(errors.length, 0, errors.join('\n'));
  const report = { ok: true, packaged, checks: ['real preload', 'startup refresh', 'sign in/out', 'browse', 'pagination', 'whisper', 'advanced listing search', 'canonical category names', 'centred inventory search icon', 'resolved temper names/icons', 'eight-temper compact cards', 'craftwork colours', 'temper expansion survives refresh', 'grouping default off', 'item ID grouping', 'group totals/sorting/search', 'grouped grid/list layouts', 'group expansion survives refresh', 'stale responses', 'inventory layouts/search', 'equipped item gate', 'six trade slots', 'single Arcs slot', 'resource quantities', 'accepted weapon/mote/rune traits', 'specific/any tempers', 'inventory change gate', 'create/edit/pause/resume/close', 'no-op edit', 'preserve unchanged/disabled terms', 'preserve flat traits and unspecified Moonsteel', 'clear trade terms', 'verification gate', 'DOM injection', '620px composer/editor layout', 'default theme'], calls: calls.length, screenshots: output };
  report.checks.push('Avakot browser sign-in', 'approval code', 'cancel/retry/complete', 'email fallback');
  report.checks.push('signed-out browsing/catalogue/whisper', 'public network retry', 'signed-out write gates', 'browsing after sign-out');
  report.checks.push('default recent ordering', 'top advanced controls', 'weapon traits', 'temper all/any filters', 'advanced reset and bounded results');
  report.checks.push('Any defaults to recent all-category listings', 'Any clears stale traits/items/cursor and preserves side/availability');
  report.checks.push('advanced limit and availability disclosure');
  report.checks.push('full-width browsing without sidebar', '620px expanded filters and scrollable results', 'Find shortcut uses top search');
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  win.destroy();
  app.quit();
}).catch(async error => {
  console.error(error.stack);
  fs.writeFileSync(path.join(output, 'failure-calls.json'), JSON.stringify(calls, null, 2));
  if (win && !win.isDestroyed()) {
    try { fs.writeFileSync(path.join(output, 'failure.txt'), await win.webContents.executeJavaScript('document.body.innerText')); } catch { /* Renderer failure is already recorded. */ }
  }
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(1);
});
