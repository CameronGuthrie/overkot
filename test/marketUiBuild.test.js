'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { execFileSync } = require('node:child_process');
const { adaptApp, adaptIndex, adaptSettings, adaptAccountMenu, adaptMarketCatalogue, adaptGameImageLiterals, dependenciesMatch, prepareRepository, buildMarketUi, readMarketUiMode, BRANCH } = require('../scripts/build-market-ui');

test('desktop adapts older and current catalogue helpers without double-prefixing artwork', () => {
  for (const body of ['if (!imagePath) return null; return imagePath;', 'return gameImageUrl(imagePath, IMAGES_BASE_URL);']) {
    const source = `const CACHE_KEY = "avakot:marketCatalogue:v19";\nexport function imageUrlForPath(imagePath: string | null | undefined): string | null {\n${body}\n}\n`;
    const result = adaptMarketCatalogue(source);
    assert.match(result, /overkot\/gameImages/);
    assert.match(result, /overkot:marketCatalogue:protected-art-v1:v19/);
    assert.equal(adaptMarketCatalogue(result), result);
  }
  assert.throws(() => adaptMarketCatalogue('const CACHE_KEY = "avakot:marketCatalogue:v20";\nexport const imageUrlForPath = () => null;'), /catalogue image helper/);
  const source = stripTypeScriptTypes(fs.readFileSync(path.join(__dirname, '../scripts/market-ui/gameImages.ts'), 'utf8')).replace('export function', 'function');
  const context = vm.createContext({}); vm.runInContext(source, context);
  const assetPath = '/SF/Interface/Graphics/StoreItems/Art.png';
  assert.equal(adaptGameImageLiterals(`const icon = "https://dap1x6lmnonv6.cloudfront.net${assetPath}";`),
    `const icon = "overkot-game-data://images${assetPath}";`);
  for (const value of [assetPath, assetPath.slice(1), 'overkot-game-data://images' + assetPath, '/api/v1/data-assets' + assetPath,
    'https://dap1x6lmnonv6.cloudfront.net' + assetPath, 'https://avakot.market/api/v1/data-assets' + assetPath]) {
    assert.equal(context.imageUrlForPath(value), 'overkot-game-data://images' + assetPath);
  }
  for (const value of ['https://evil.test' + assetPath, '/SF/Interface/Graphics/../Secret.png', assetPath + '?token=x']) assert.equal(context.imageUrlForPath(value), null);
});

test('a standalone community build needs no private checkout or integration secret', async t => {
  const base = path.resolve(__dirname, '..', '.build');
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'community-ui-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const missing = path.join(directory, 'not-a-checkout');
  assert.equal(readMarketUiMode({ env: {}, envFile: path.join(directory, 'no-env') }), 'auto');
  assert.throws(() => readMarketUiMode({ env: { OVERKOT_MARKET_UI: 'invalid' } }), /auto, enabled or disabled/);
  const result = await buildMarketUi({ mode: 'auto', outDir: path.join(directory, 'ui'), defaultRepository: directory });
  assert.equal(result.metadata.included, false);
  assert.match(fs.readFileSync(path.join(result.outDir, 'index.html'), 'utf8'), /Open Market website/);
  await assert.rejects(buildMarketUi({ mode: 'enabled', outDir: path.join(directory, 'required'), defaultRepository: missing }), /optional Market checkout is unavailable/);
  const disabled = await buildMarketUi({ mode: 'disabled', repoDir: missing, outDir: path.join(directory, 'disabled') });
  assert.equal(disabled.metadata.included, false);
});

const shell = [
  '<script>',
  'import Login from "./pages/Login.svelte";',
  'import AvakotLogin from "./pages/AvakotLogin.svelte";',
  'import DesktopSignin from "./pages/DesktopSignin.svelte";',
  ...['Signup', 'VerifyEmail', 'ForgotPassword', 'ResetPassword', 'AccountLink', 'DiscordCallback'].map(name => `import ${name} from "./pages/${name}.svelte";`),
  '  let motdDismissed = false;',
  '  onMount(() => {',
  '    auth.check();',
  '  });',
  '</script>',
  '<div class="page-wrapper">',
  '          <a class="top-link" href="/login">{$t("header.login")}</a>',
  '          <a class="top-link primary" href="/signup">{$t("header.signup")}</a>',
  '      <nav class="sidebar-primary" aria-label="Primary">',
  '        <a href="/existing">Existing upstream navigation</a>',
  '      </nav>',
  '      <Route path="/"><AdvancedSearch /></Route>',
  '</div>',
  '{#if !isDashboard && $isAuthenticated && !$publicConfig.tradingDisabled}<button class="create-fab">Create</button>{/if}',
].join('\n');

test('desktop adaptation retains upstream UI and keeps inventory selling discoverable with either line ending', () => {
  for (const source of [shell, shell.replaceAll('\n', '\r\n')]) {
    const result = adaptApp(source);
    assert.match(result, /Existing upstream navigation/);
    assert.doesNotMatch(result, /\$desktopState\.authenticated|\$desktopState\.canTrade|\$desktopState\.inventory\?\.available/);
    assert.match(result, /aria-label="Sell from inventory"/);
    assert.match(result, /<Route path="\/overkot-inventory"><Inventory \/><\/Route>/);
    assert.match(result, /<DesktopTitlebar \/>/);
    assert.match(result, /currentPath !== "\/overkot-inventory" && \$isAuthenticated/);
    assert.match(result, /onMount\(mountDesktopBridge\)/);
    assert.match(result, /import Login from "\.\/overkot\/DesktopLogin\.svelte"/);
    assert.match(result, /import DesktopSignin from "\.\/overkot\/DesktopLogin\.svelte"/);
    assert.match(result, /import Signup from "\.\/overkot\/ExternalAccount\.svelte"/);
    assert.match(result, /import AccountLink from "\.\/overkot\/ExternalAccount\.svelte"/);
    assert.match(result, /\{#if \$desktopState\.accountConnection\?\.signedIn\}/);
    assert.match(result, /on:click=\{openAccountSettings\}>\{\$t\("header.login"\)\}/);
    assert.match(result, /on:click=\{openAccountSettings\}>\{\$t\("header.signup"\)\}/);
    assert.doesNotMatch(result, /href="\/(?:login|signup)"/);
  }
});

test('upstream shell changes fail explicitly instead of silently omitting desktop integration', () => {
  assert.throws(() => adaptApp(shell.replace('auth.check();', 'auth.initialize();')), /authentication initialization/);
  assert.throws(() => adaptApp(shell + '\n<div class="page-wrapper">'), /application shell, found 2/);
  assert.throws(() => adaptApp(shell.replace('href="/signup"', 'href="/join"')), /signup account action/);
});

function desktopHarness(initialState = {}) {
  const listeners = new Map();
  const calls = { authChecks: 0, settings: 0 };
  let onChanged;
  let settingsResult = { ok: true };
  class Element {
    constructor(link) { this.link = link; }
    closest() { return this.link; }
  }
  const bridge = {
    getState: async () => initialState,
    onChanged: listener => { onChanged = listener; return () => { onChanged = null; }; },
    openAccountSettings: async () => { calls.settings++; return settingsResult; },
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'market-ui', 'desktop.ts'), 'utf8');
  const javascript = stripTypeScriptTypes(source).replace(/^import .*;\s*$/gm, '')
    .replace(/^export /gm, '');
  const context = {
    Element, URL, Error,
    location: { origin: 'http://127.0.0.1:1234', href: 'http://127.0.0.1:1234/' },
    document: {
      addEventListener: (name, listener) => listeners.set(name, listener),
      removeEventListener: (name, listener) => { if (listeners.get(name) === listener) listeners.delete(name); },
    },
    window: { overkotMarket: bridge },
    writable: value => ({ value, set(next) { this.value = next; }, update(fn) { this.value = fn(this.value); } }),
    auth: { check: async () => { calls.authChecks++; } },
  };
  vm.runInNewContext(`${javascript}\nthis.desktop = { desktopState, mountDesktopBridge, openAccountSettings };`, context);
  return {
    ...context.desktop, calls, listeners,
    emit: state => onChanged?.(state),
    setSettingsResult: result => { settingsResult = result; },
    click: href => {
      const event = {
        target: new Element({ href: new URL(href, context.location.href).href }),
        prevented: false, stopped: false,
        preventDefault() { this.prevented = true; },
        stopImmediatePropagation() { this.stopped = true; },
      };
      listeners.get('click')?.(event);
      return event;
    },
  };
}

test('embedded account links open Overkot Connections before the Market router handles them', async () => {
  const desktop = desktopHarness();
  const dispose = desktop.mountDesktopBridge();
  await Promise.resolve();
  for (const href of ['/login', '/signup?next=/settings', '/avakot-login?connect=1', '/account-sign-in', '/overkot-signin']) {
    const click = desktop.click(href);
    assert.equal(click.prevented, true, href);
    assert.equal(click.stopped, true, href);
  }
  assert.equal(desktop.calls.settings, 5);
  for (const href of ['https://avakot.market/login', '/settings', '/overkot-inventory', '/login-other']) {
    assert.equal(desktop.click(href).prevented, false, href);
  }
  assert.equal(desktop.calls.settings, 5);
  dispose();
  assert.equal(desktop.listeners.has('click'), false);
});

test('Overkot account connection changes recheck the real Market session without inventing authentication', async () => {
  const desktop = desktopHarness({ authenticated: false, accountConnection: { signedIn: false } });
  const dispose = desktop.mountDesktopBridge();
  await Promise.resolve();
  desktop.emit({ authenticated: false, accountConnection: { signedIn: true } });
  assert.equal(desktop.calls.authChecks, 1);
  assert.equal(desktop.desktopState.value.authenticated, false);
  desktop.emit({ authenticated: false, accountConnection: { signedIn: true, busy: true } });
  assert.equal(desktop.calls.authChecks, 1);
  desktop.emit({ authenticated: true, user: { id: 'market-user' }, accountConnection: { signedIn: true } });
  assert.equal(desktop.calls.authChecks, 2);
  desktop.emit({ authenticated: false, accountConnection: { signedIn: false } });
  assert.equal(desktop.calls.authChecks, 3);
  dispose();
});

test('a failed Settings action preserves the public connection state and exposes its error', async () => {
  const desktop = desktopHarness({ accountConnection: { signedIn: true } });
  const dispose = desktop.mountDesktopBridge();
  await Promise.resolve();
  desktop.setSettingsResult({ ok: false, message: 'Settings unavailable' });
  await desktop.openAccountSettings();
  assert.equal(desktop.desktopState.value.accountConnection.signedIn, true);
  assert.equal(desktop.desktopState.value.accountConnection.error, 'Settings unavailable');
  dispose();
});

test('desktop HTML removes website analytics and PWA without replacing the upstream entry point', () => {
  const source = '<html><head><script id="market-analytics">loadAnalytics();</script><link rel="manifest" href="/site.webmanifest" /></head><body><script type="module" src="/src/main.ts"></script></body></html>';
  const result = adaptIndex(source);
  assert.doesNotMatch(result, /loadAnalytics|rel="manifest"/);
  assert.match(result, /src="\/src\/main.ts"/);
});

const settings = [
  '  const loadDiscordStatus = async () => { return "keep status reads"; };',
  '  const linkDiscord = async () => {',
  '    try {',
  '      const res = await apiFetch("/v1/auth/discord/link");',
  '      if (res.ok) { window.open("oauthUrl"); }',
  '    } catch {}',
  '  };',
  '',
  '  const unlinkDiscord = async () => {',
  '    return "keep account controls";',
  '  };',
].join('\n');

test('Discord connection moves to a fixed browser destination and retains other shared Settings controls', () => {
  for (const source of [settings, settings.replaceAll('\n', '\r\n')]) {
    const result = adaptSettings(source);
    assert.match(result, /window\.open\("https:\/\/avakot\.market\/settings", "_blank", "noopener,noreferrer"\)/);
    assert.doesNotMatch(result, /discord\/link|oauthUrl/);
    assert.match(result, /keep status reads/);
    assert.match(result, /keep account controls/);
  }
});

test('Discord connection changes upstream require an explicit adapter update', () => {
  assert.throws(() => adaptSettings(settings.replace('/v1/auth/discord/link', '/v2/auth/discord/link')), /Discord account connection request/);
  assert.throws(() => adaptSettings(settings.replace('const linkDiscord =', 'const connectDiscord =')), /Discord account connection request/);
});

test('embedded account menu manages the central Overkot connection instead of signing out separately', () => {
  const source = [
    '  import { onMount, tick } from "svelte";',
    '  const signOut = async () => {',
    '    try {',
    '      await onSignOut();',
    '      close();',
    '    } catch { signOutFailed = true; }',
    '  };',
    '<button class="dropdown-signout" on:click={signOut}>{$t("header.signout")}</button>',
    '<p>{$t("header.signoutFailed")}</p>',
    '<a href="/settings">Shared Market Settings</a>',
  ].join('\n');
  for (const input of [source, source.replaceAll('\n', '\r\n')]) {
    const result = adaptAccountMenu(input);
    assert.match(result, /import \{ openAccountSettings \} from "\.\.\/overkot\/desktop"/);
    assert.match(result, /await openAccountSettings\(\)/);
    assert.match(result, />Account connection<\/button>/);
    assert.doesNotMatch(result, /await onSignOut|header.signout/);
    assert.match(result, /Shared Market Settings/);
  }
  assert.throws(() => adaptAccountMenu(source.replace('await onSignOut();', 'await account.signOut();')), /account menu sign-out action/);
});

test('dependency reuse requires the archived lock and installed package versions to agree', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-market-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lock = { packages: { '': { devDependencies: { vite: '^5' } }, 'node_modules/vite': { version: '5.4.21' } } };
  fs.mkdirSync(path.join(root, 'node_modules', 'vite'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'vite', 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock, null, 2));
  fs.writeFileSync(path.join(root, 'node_modules', '.package-lock.json'), JSON.stringify({ packages: { 'node_modules/vite': { version: '5.4.21' } } }));
  assert.equal(dependenciesMatch(root, lock), true);
  fs.writeFileSync(path.join(root, 'node_modules', '.package-lock.json'), JSON.stringify({ packages: { 'node_modules/vite': { version: '5.4.20' } } }));
  assert.equal(dependenciesMatch(root, lock), false);
});

test('tracking follows fetched preview commits while preserving the source checkout and its edits', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-market-tracking-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'origin');
  const checkout = path.join(root, 'checkout');
  fs.mkdirSync(remote);
  const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8', stdio: 'pipe', windowsHide: true,
  }).trim();
  git(remote, 'init', '-b', BRANCH);
  git(remote, 'config', 'user.name', 'Overkot Test');
  git(remote, 'config', 'user.email', 'test@overkot.local');
  fs.writeFileSync(path.join(remote, 'ui.txt'), 'first');
  git(remote, 'add', 'ui.txt');
  git(remote, 'commit', '-m', 'First preview');
  execFileSync('git', ['clone', remote, checkout], { stdio: 'pipe', windowsHide: true });
  const first = prepareRepository(checkout, true).commit;
  fs.writeFileSync(path.join(checkout, 'ui.txt'), 'local unsaved edit');
  fs.writeFileSync(path.join(remote, 'ui.txt'), 'next upstream preview');
  git(remote, 'add', 'ui.txt');
  git(remote, 'commit', '-m', 'Next preview');
  const next = prepareRepository(checkout, true).commit;
  assert.notEqual(next, first);
  assert.equal(next, git(remote, 'rev-parse', 'HEAD'));
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), first);
  assert.equal(fs.readFileSync(path.join(checkout, 'ui.txt'), 'utf8'), 'local unsaved edit');
  // A release keeps the resolved source even after upstream moves or access
  // goes away; all package builds can use the same detached source checkout.
  git(checkout, 'remote', 'set-url', 'origin', path.join(root, 'unavailable'));
  assert.equal(prepareRepository(checkout, true, first).commit, first);
  assert.throws(() => prepareRepository(checkout, true, 'new-redesign-preview'), /Invalid pinned Market source commit/);
  assert.throws(() => prepareRepository(checkout, true, 'f'.repeat(40)), /Command failed/);
  const previousPin = process.env.OVERKOT_MARKET_SOURCE_COMMIT;
  try {
    process.env.OVERKOT_MARKET_SOURCE_COMMIT = next;
    assert.equal(prepareRepository(checkout, true).commit, next);
  } finally {
    if (previousPin === undefined) delete process.env.OVERKOT_MARKET_SOURCE_COMMIT;
    else process.env.OVERKOT_MARKET_SOURCE_COMMIT = previousPin;
  }
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), first);
  assert.equal(fs.readFileSync(path.join(checkout, 'ui.txt'), 'utf8'), 'local unsaved edit');
});
