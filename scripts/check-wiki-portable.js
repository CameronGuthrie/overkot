// Launch the delivered portable normally, including NSIS extraction into TEMP.
// No test bootstrap, unpacked runtime, or app.isPackaged override is used.
// Add --market after the executable path to check Market/Connections instead.
// Add --titles to check Title Tracker in a normal stable build with no network.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { fileURLToPath } = require('node:url');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const marketCheck = process.argv.includes('--market');
const titlesCheck = process.argv.includes('--titles');
assert.ok(!(marketCheck && titlesCheck), 'Choose one portable check mode.');
const portable = path.resolve(process.argv[2] || path.join(root, 'dist-beta', 'title-tracker',
  'overkot-title-tracker-beta-0.0.13-beta.title-tracker.1.exe'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await check();
    if (value) return value;
    await pause(100);
  }
  throw new Error('Timed out: ' + label);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP connection timed out')), 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('CDP target closed'));
    }
    pending.clear();
  });
  return {
    close: () => socket.close(),
    evaluate(expression) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('CDP evaluation timed out'));
        }, 15000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {
          expression, awaitPromise: true, returnByValue: true,
        } }));
      }).then(result => {
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
      });
    },
  };
}

async function main() {
  assert.equal(process.platform, 'win32', 'This check requires the Windows portable.');
  assert.ok(fs.statSync(portable).isFile(), 'Portable executable exists');
  const outputRoot = path.join(root, 'output');
  fs.mkdirSync(outputRoot, { recursive: true });
  const out = fs.mkdtempSync(path.join(outputRoot, marketCheck ? 'market-portable-' : titlesCheck ? 'titles-portable-' : 'wiki-portable-'));
  const local = path.join(out, 'local');
  const roaming = path.join(out, 'roaming');
  const profile = path.join(out, 'electron-profile');
  fs.mkdirSync(roaming, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });
  // ConfigStore and its encrypted files use only this disposable directory.
  // Preserve TEMP exactly as supplied by Windows: its 8.3 alias caused the bug.
  process.env.LOCALAPPDATA = local;
  process.env.APPDATA = roaming;
  const { ConfigStore } = require('../src/modules/config');
  const config = new ConfigStore();
  const log = path.join(out, 'empty-EE.log');
  fs.writeFileSync(log, '');
  config.setMany({ clickThrough: false, hideWhenGameClosed: false,
    automaticUpdates: false, enableAlertSound: false, eeLogPath: log,
    showOnlyWhenGameFocused: false,
    tutorialCompleted: { app: true, wiki: true, market: true, 'title-tracker': true },
    widgetVisibility: marketCheck ? { market: true } : titlesCheck ? {} : { wiki: true },
    widgetOpen: marketCheck || titlesCheck ? {} : { wiki: true },
    widgetDocked: { wiki: false, 'title-tracker': true }, dockParadigmVersion: 1,
  });
  const port = await freePort();
  const summary = { ok: false, portable, sha256: crypto.createHash('sha256')
    .update(fs.readFileSync(portable)).digest('hex'), temp: process.env.TEMP,
    normalPortableLaunch: true, out, controls: [] };
  const launchEnv = { ...process.env };
  delete launchEnv.ELECTRON_RUN_AS_NODE;
  if (titlesCheck) {
    // The released app must use its bundled catalog, without the local beta
    // switch, AWS tooling, saved game credentials or a successful HTTP fetch.
    delete launchEnv.OVERKOT_BUILD_CHANNEL;
    delete launchEnv.AWS_PROFILE;
    delete launchEnv.AWS_ACCESS_KEY_ID;
    delete launchEnv.AWS_SECRET_ACCESS_KEY;
    delete launchEnv.AWS_SESSION_TOKEN;
    launchEnv.HTTP_PROXY = 'http://127.0.0.1:1';
    launchEnv.HTTPS_PROXY = 'http://127.0.0.1:1';
    launchEnv.ALL_PROXY = 'http://127.0.0.1:1';
    launchEnv.NO_PROXY = '127.0.0.1,localhost';
  }
  const child = spawn(portable, [`--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
    cwd: root, env: launchEnv, windowsHide: false,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let launchError;
  child.once('error', error => { launchError = error; });
  // Drain Electron diagnostics without exposing unrelated runtime logs.
  child.stderr.resume();
  const exited = new Promise(resolve => child.once('exit', resolve));
  const clients = [];
  let mainClient;
  async function targets() {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error('Portable exited early: ' + child.exitCode);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
      return await response.json();
    } catch { return []; }
  }
  async function clientFor(pattern, label) {
    const target = await until(async () => (await targets()).find(item => pattern.test(item.url)), label, 45000);
    const client = await connect(target);
    clients.push(client);
    return { target, client };
  }
  try {
    const mainTarget = await clientFor(/\/index\.html$/, 'portable main window');
    mainClient = mainTarget.client;
    summary.mainURL = mainTarget.target.url;
    if (titlesCheck) {
      await until(() => mainClient.evaluate('!!window.api?.getTitleTracker'), 'main preload ready');
      const filename = fileURLToPath(mainTarget.target.url);
      const archiveEnd = filename.toLowerCase().indexOf('.asar' + path.sep);
      assert.ok(archiveEnd !== -1, 'The normally launched portable is using app.asar');
      const archive = filename.slice(0, archiveEnd + '.asar'.length);
      const { extractFile } = require('@electron/asar');
      const channel = JSON.parse(extractFile(archive, 'src/build-channel.json').toString('utf8'));
      assert.equal(channel.channel, 'stable', 'This is the normal release channel');
      assert.equal(channel.titleTrackerEnabled, true);
      assert.equal(channel.localOnly, false);
      summary.buildChannel = channel;
      assert.equal(await mainClient.evaluate('window.i18n.titleTrackerEnabled'), true);
      await mainClient.evaluate('window.api.openWidgets()');
      const { client: picker } = await clientFor(/\/widgets-window\.html$/, 'packaged Widgets picker');
      await until(() => picker.evaluate('!!document.querySelector("input[data-widget=title-tracker]") && !document.querySelector("input[data-widget=title-tracker]").disabled'), 'Title Tracker card ready');
      assert.equal(await picker.evaluate('document.querySelector("input[data-widget=title-tracker]").checked'), false);
      await picker.evaluate('document.querySelector("input[data-widget=title-tracker]").click()');
      await until(() => mainClient.evaluate('!!document.querySelector(".dock-widget-button[data-widget=title-tracker]")'), 'Title Tracker appears in dock');
      assert.match(await mainClient.evaluate('document.querySelector(".dock-widget-button[data-widget=title-tracker]").getAttribute("aria-label")'), /Title Tracker/i);
      summary.controls.push('enable Title Tracker from Widgets picker');
      await mainClient.evaluate('document.querySelector(".dock-widget-button[data-widget=title-tracker]").click()');
      const { target, client: titles } = await clientFor(/\/widget-host\.html\?widget=title-tracker$/, 'packaged Title Tracker widget');
      await until(() => titles.evaluate('document.body?.dataset.widget === "title-tracker" && !!document.querySelector(".title-summary")'), 'Title Tracker renderer ready');
      summary.titleURL = target.url;
      const snapshot = await titles.evaluate('window.api.getTitleTracker()');
      const expected = require('../src/modules/epithetsData').getBundledTitleCatalog();
      assert.ok(expected.titles.length > 0, 'A checked-in release catalog exists');
      assert.ok(['connect', 'waiting'].includes(snapshot.status),
        'The isolated profile has no inventory; a running game may still be detected');
      assert.deepEqual(snapshot.rows.map(row => row.id).sort(), expected.titles.map(row => row.id).sort(),
        'Normal portable loads the complete bundled catalog while network requests fail');
      for (const row of snapshot.rows) {
        const title = expected.titles.find(item => item.id === row.id);
        assert.equal(row.name, title.name);
        assert.equal(row.target, title.target);
        assert.equal(row.count, 0);
        assert.equal(row.completed, false);
      }
      assert.match(await titles.evaluate('document.querySelector(".title-summary").textContent'), /Connect to Soulframe|Waiting for your title progress/i);
      assert.equal(await titles.evaluate('typeof require'), 'undefined');
      summary.catalogTitles = snapshot.rows.length;
      summary.controls.push('open stable Title Tracker with offline bundled catalog');
      await mainClient.evaluate('document.querySelector(".dock-widget-button[data-widget=title-tracker]").click()');
      // Hidden panels deliberately retain their renderer and input state.
      await until(() => mainClient.evaluate('window.api.getState().then(state => state.config.widgetOpen["title-tracker"] === false && document.querySelector(".dock-widget-button[data-widget=title-tracker]").getAttribute("aria-pressed") === "false")'), 'hide Title Tracker from dock');
      summary.controls.push('hide Title Tracker from dock');
      await picker.evaluate('document.querySelector("input[data-widget=title-tracker]").click()');
      await until(() => mainClient.evaluate('!document.querySelector(".dock-widget-button[data-widget=title-tracker]")'), 'remove Title Tracker from dock');
      await until(async () => !(await targets()).some(item => item.id === target.id), 'disabled Title Tracker window closes');
      summary.controls.push('disable Title Tracker from Widgets picker');
      summary.ok = true;
      return;
    }
    if (marketCheck) {
      await until(() => mainClient.evaluate('!!window.api?.openMarket'), 'main preload ready');
      await mainClient.evaluate('window.api.openMarket()');
      const { target, client: market } = await clientFor(/^overkot-market:\/\/app\//, 'packaged Market window');
      summary.marketURL = target.url;
      await until(() => market.evaluate('document.querySelectorAll(".account-area .desktop-account-action").length === 2'), 'packaged account actions');
      const state = await market.evaluate('window.overkotMarket.getState()');
      assert.equal(state.authenticated, false);
      assert.equal(state.accountConnection.signedIn, false);
      assert.equal(await market.evaluate('typeof require'), 'undefined');
      const inventoryLink = JSON.stringify('a[href="/overkot-inventory"]');
      assert.equal(await market.evaluate(`!!document.querySelector(${inventoryLink})`), true);
      await market.evaluate('document.querySelector(".desktop-account-action:not(.primary)").click()');
      const settingsTarget = await clientFor(/\/settings\.html(?:\?|$)/, 'packaged Connections settings');
      const settings = settingsTarget.client;
      await until(() => settings.evaluate('document.querySelector("#tab-connections")?.getAttribute("aria-selected") === "true" && !document.querySelector("#panel-connections").hidden'), 'Connections selected');
      assert.equal(await settings.evaluate('!!document.querySelector("#btn-avakot-account-login")'), true);
      summary.controls.push('Login opens Connections');
      await settings.evaluate('document.querySelector("#tab-appearance").click()');
      await market.evaluate('document.querySelector(".desktop-account-action.primary").click()');
      await until(() => settings.evaluate('!document.querySelector("#panel-connections").hidden'), 'Sign up reuses Connections');
      assert.equal((await targets()).filter(item => /\/settings\.html(?:\?|$)/.test(item.url)).length, 1);
      summary.controls.push('Sign up reuses Connections');
      await market.evaluate(`document.querySelector(${inventoryLink}).click()`);
      await until(() => market.evaluate('location.pathname === "/overkot-inventory" && !!document.querySelector("iframe.inventory")?.contentDocument?.querySelector("#inventory-gate button")'), 'packaged inventory view');
      assert.equal(await market.evaluate('document.querySelector("iframe.inventory").contentDocument.querySelector("#account-dialog").open'), false);
      await settings.evaluate('document.querySelector("#tab-appearance").click()');
      await market.evaluate('document.querySelector("iframe.inventory").contentDocument.querySelector("#inventory-gate button").click()');
      await until(() => settings.evaluate('!document.querySelector("#panel-connections").hidden'), 'inventory sign-in opens Connections');
      summary.controls.push('Sell from inventory and sign-in CTA');
      await market.evaluate('window.overkotMarket.close()');
      await until(async () => !(await targets()).some(item => item.id === target.id), 'packaged Market close');
      summary.controls.push('close');
      summary.ok = true;
      return;
    }
    const { client: widget } = await clientFor(/\/widget-host\.html\?widget=wiki$/, 'wiki widget');
    await until(() => widget.evaluate('document.body?.dataset.widget === "wiki" && !!document.getElementById("wiki-search-input")'), 'wiki input handlers ready');
    async function search(query) {
      await widget.evaluate(`(() => {
        const input = document.getElementById('wiki-search-input');
        input.value = ${JSON.stringify(query)};
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      })()`);
    }
    await search('vetch');
    const { target, client: chrome } = await clientFor(/\/wiki-window\.html$/, 'wiki toolbar');
    summary.actualChromeURL = target.url;
    await until(async () => {
      try { return await chrome.evaluate('!!window.wikiChrome && document.readyState === "complete"'); }
      catch (error) {
        if (/Execution context was destroyed|Cannot find context/.test(error.message)) return false;
        throw error;
      }
    }, 'wiki toolbar bridge ready');
    async function state() {
      const value = await chrome.evaluate('window.wikiChrome.getState()');
      assert.notEqual(value.error, 'Wiki window is unavailable.',
        'Portable toolbar IPC rejected its actual local URL: ' + summary.actualChromeURL);
      return value;
    }
    summary.initialState = await state();
    async function settled(matches, label) {
      return until(async () => {
        const value = await state();
        if (value.loading || !value.url || !matches(value.url)) return false;
        assert.equal(value.error, '', 'Live wiki page loaded: ' + label);
        return value;
      }, 'settled live wiki page: ' + label, 45000);
    }
    // MediaWiki may redirect a search to the article's canonical URL.
    const first = (await settled(() => true, 'vetch')).url;
    await search('Bromius');
    const second = (await settled(url => url !== first, 'Bromius')).url;
    summary.searchURLs = [first, second];
    async function action(name) {
      assert.equal(await chrome.evaluate(`window.wikiChrome.action(${JSON.stringify(name)})`), true,
        'Portable toolbar accepted ' + name);
      summary.controls.push(name);
    }
    await action('back');
    await settled(url => url === first, 'back to first search');
    await action('forward');
    await settled(url => url === second, 'forward to second search');
    await action('reload');
    await settled(url => url === second, 'reload second search');
    // The real external-browser action is covered by check-wiki-controls.js;
    // this portable check leaves the user's default browser alone.
    await chrome.evaluate('document.getElementById("wiki-close").click()');
    await until(async () => !(await targets()).some(item => item.id === target.id), 'toolbar close');
    summary.controls.push('close');
    summary.ok = true;
  } catch (error) {
    summary.error = error.stack;
  } finally {
    if (mainClient) await mainClient.evaluate('window.api.windowClose()').catch(() => {});
    for (const client of clients) client.close();
    const stopped = await Promise.race([exited.then(() => true), pause(10000).then(() => false)]);
    if (!stopped && child.pid) {
      // Only terminate the process tree launched by this fixture.
      const kill = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      await new Promise(resolve => { kill.once('exit', resolve); kill.once('error', resolve); });
      await Promise.race([exited, pause(5000)]);
      summary.forcedCleanup = true;
    }
    summary.launcherExitCode = child.exitCode;
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify(summary));
    process.exitCode = summary.ok ? 0 : 1;
  }
  process.exitCode = summary.ok ? 0 : 1;
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
