'use strict';

// Build the market's actual frontend from its moving preview branch. The
// desktop-specific code stays here so upstream layout and feature changes are
// picked up without maintaining a second copy of the market application.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { parseEnv } = require('node:util');
const { imageUrl: protectedImageUrl } = require('../src/modules/gameDataImages');

const ROOT = path.resolve(__dirname, '..');
const BUILD_ROOT = path.join(ROOT, '.build');
const ADAPTER_ROOT = path.join(__dirname, 'market-ui');
const DEFAULT_REPOSITORY = path.resolve(ROOT, '..', '..', 'avakot-market');
const BRANCH = 'new-redesign-preview';
const REF = `refs/remotes/origin/${BRANCH}`;
const REMOTE = 'https://github.com/CameronGuthrie/avakot-market.git';

function readMarketUiMode({ env = process.env, envFile = path.join(ROOT, '.env.local') } = {}) {
  let value = env.OVERKOT_MARKET_UI;
  if (value === undefined) {
    try { value = parseEnv(fs.readFileSync(envFile, 'utf8')).OVERKOT_MARKET_UI; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not read the Market build configuration.'); }
  }
  value = value || 'auto';
  if (!['auto', 'enabled', 'disabled'].includes(value)) throw new Error('OVERKOT_MARKET_UI must be auto, enabled or disabled.');
  return value;
}

function buildCommunityMarketUi(outDir) {
  outDir = generatedPath(outDir);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.cpSync(path.join(__dirname, 'market-ui-community'), outDir, { recursive: true });
  const metadata = { schema: 1, mode: 'community', included: false };
  fs.writeFileSync(path.join(outDir, 'market-source.json'), JSON.stringify(metadata, null, 2) + '\n');
  console.log('[market-ui] Included the community Market shell; no private repository or credentials are required.');
  return { outDir, source: null, metadata };
}

function git(repository, args) {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

function generatedPath(value) {
  const resolved = path.resolve(value);
  const relative = path.relative(BUILD_ROOT, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Market build paths must be inside App/.build.');
  }
  return resolved;
}

function replaceOnce(source, anchor, replacement, description) {
  const matches = typeof anchor === 'string' ? source.split(anchor).length - 1
    : [...source.matchAll(new RegExp(anchor.source, anchor.flags.includes('g') ? anchor.flags : `${anchor.flags}g`))].length;
  if (matches !== 1) throw new Error(`Market preview changed: expected one ${description}, found ${matches}. Review the desktop adapter.`);
  return source.replace(anchor, replacement);
}

function adaptMarketCatalogue(source) {
  source = source.replaceAll('\r\n', '\n');
  const replacement = 'import { imageUrlForPath } from "../overkot/gameImages";\nexport { imageUrlForPath };';
  if (source.includes(replacement)) return source;
  // Isolate the desktop-normalized cache from prior public-CDN entries and the
  // website's own image namespace. Preserve upstream schema version increments.
  source = replaceOnce(source, /const CACHE_KEY = "avakot:marketCatalogue:(v\d+)";/g,
    'const CACHE_KEY = "overkot:marketCatalogue:protected-art-v1:$1";', 'catalogue cache key');
  return replaceOnce(source,
    /^export function imageUrlForPath\(imagePath: string \| null \| undefined\): string \| null \{[\s\S]*?^\}/gm,
    replacement, 'catalogue image helper');
}

function adaptGameImageLiterals(source) {
  return source.replace(/https:\/\/dap1x6lmnonv6\.cloudfront\.net\/SF\/Interface\/Graphics\/[A-Za-z0-9_./-]+\.(?:png|webp)/g,
    value => protectedImageUrl(value) || value);
}

function adaptApp(source) {
  source = source.replaceAll('\r\n', '\n');
  source = replaceOnce(source, 'import Login from "./pages/Login.svelte";',
    'import Login from "./overkot/DesktopLogin.svelte";', 'login component import');
  source = replaceOnce(source, 'import AvakotLogin from "./pages/AvakotLogin.svelte";',
    'import AvakotLogin from "./overkot/DesktopLogin.svelte";', 'Avakot login component import');
  source = replaceOnce(source, 'import DesktopSignin from "./pages/DesktopSignin.svelte";',
    'import DesktopSignin from "./overkot/DesktopLogin.svelte";', 'desktop sign-in component import');
  for (const name of ['Signup', 'VerifyEmail', 'ForgotPassword', 'ResetPassword', 'AccountLink', 'DiscordCallback']) {
    source = replaceOnce(source, `import ${name} from "./pages/${name}.svelte";`,
      `import ${name} from "./overkot/ExternalAccount.svelte";`, `${name} browser account component import`);
  }
  source = replaceOnce(source, '  let motdDismissed = false;',
    '  import Inventory from "./overkot/Inventory.svelte";\n  import DesktopTitlebar from "./overkot/DesktopTitlebar.svelte";\n  import { desktopState, mountDesktopBridge, openAccountSettings } from "./overkot/desktop";\n\n  let motdDismissed = false;', 'application state anchor');
  source = replaceOnce(source, '  onMount(() => {\n    auth.check();',
    '  onMount(mountDesktopBridge);\n\n  onMount(() => {\n    auth.check();', 'authentication initialization');
  source = replaceOnce(source, '      <nav class="sidebar-primary" aria-label="Primary">',
    `      <nav class="sidebar-primary" aria-label="Primary">
        <a
            href="/overkot-inventory"
            class:active={currentPath === "/overkot-inventory"}
            aria-current={currentPath === "/overkot-inventory" ? "page" : undefined}
            title="Sell from inventory"
            aria-label="Sell from inventory"
        ><i class="fa-solid fa-box-open" aria-hidden="true"></i><span class="nav-label">Sell from inventory</span></a>`, 'primary sidebar navigation');
  for (const [className, label] of [['top-link', 'login'], ['top-link primary', 'signup']]) {
    source = replaceOnce(source, `<a class="${className}" href="/${label}">{$t("header.${label}")}</a>`,
      `<button type="button" class="${className} desktop-account-action" on:click={openAccountSettings}>{$t("header.${label}")}</button>`, `${label} account action`);
  }
  source = replaceOnce(source, '          <button type="button" class="top-link desktop-account-action" on:click={openAccountSettings}>{$t("header.login")}</button>\n          <button type="button" class="top-link primary desktop-account-action" on:click={openAccountSettings}>{$t("header.signup")}</button>',
    `          {#if $desktopState.accountConnection?.signedIn}
            <button type="button" class="top-link desktop-account-action" on:click={openAccountSettings} title="Manage your avakot.dev connection in Overkot">{$desktopState.accountConnection.account?.displayName || "avakot.dev connected"}</button>
          {:else}
            <button type="button" class="top-link desktop-account-action" on:click={openAccountSettings}>{$t("header.login")}</button>
            <button type="button" class="top-link primary desktop-account-action" on:click={openAccountSettings}>{$t("header.signup")}</button>
          {/if}`, 'Overkot account connection controls');
  source = replaceOnce(source, '<div class="page-wrapper">', '<DesktopTitlebar />\n<div class="page-wrapper">', 'application shell');
  source = replaceOnce(source, '{#if !isDashboard && $isAuthenticated && !$publicConfig.tradingDisabled}',
    '{#if !isDashboard && currentPath !== "/overkot-inventory" && $isAuthenticated && !$publicConfig.tradingDisabled}', 'floating create action');
  return replaceOnce(source, '      <Route path="/"><AdvancedSearch /></Route>',
    '      <Route path="/overkot-inventory"><Inventory /></Route>\n      <Route path="/"><AdvancedSearch /></Route>', 'home route');
}

function adaptIndex(source) {
  source = source.replaceAll('\r\n', '\n');
  source = replaceOnce(source, /\s*<script id="market-analytics">[\s\S]*?<\/script>/,
    '', 'website analytics script');
  return replaceOnce(source, /\s*<link rel="manifest"[^>]*\/>/, '', 'website PWA manifest');
}

function adaptSettings(source) {
  source = source.replaceAll('\r\n', '\n');
  // OAuth must stay in the browser. Retain the rest of the shared Settings
  // page, but replace this action instead of exposing an OAuth URL or callback.
  const action = /  const linkDiscord = async \(\) => \{\n[\s\S]*?\n  \};(?=\n\n  const unlinkDiscord = async \(\) => \{)/;
  const original = source.match(action)?.[0] || '';
  replaceOnce(original, '      const res = await apiFetch("/v1/auth/discord/link");',
    '', 'Discord account connection request');
  return replaceOnce(source, action, `  const linkDiscord = async () => {
    discordMessageType = "info";
    discordMessage = "Finish connecting Discord in your browser, then return here.";
    window.open("https://avakot.market/settings", "_blank", "noopener,noreferrer");
  };`, 'Discord account connection action');
}

function adaptAccountMenu(source) {
  source = source.replaceAll('\r\n', '\n');
  source = replaceOnce(source, '  import { onMount, tick } from "svelte";',
    '  import { onMount, tick } from "svelte";\n  import { openAccountSettings } from "../overkot/desktop";', 'account menu lifecycle import');
  source = replaceOnce(source, '      await onSignOut();', '      await openAccountSettings();', 'account menu sign-out action');
  source = replaceOnce(source, '{$t("header.signout")}', 'Account connection', 'account menu connection label');
  return replaceOnce(source, '{$t("header.signoutFailed")}', 'Overkot Settings could not be opened.', 'account menu connection error');
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function lockFingerprint(file) {
  return fingerprint(JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))));
}

// A checkout's node_modules can be reused read-only when its lock agrees with
// the archived branch and npm's installed-package lock agrees with that lock.
function dependenciesMatch(frontend, lock) {
  try {
    if (lockFingerprint(path.join(frontend, 'package-lock.json')) !== fingerprint(JSON.stringify(lock))) return false;
    const installed = JSON.parse(fs.readFileSync(path.join(frontend, 'node_modules', '.package-lock.json'), 'utf8'));
    for (const [name, entry] of Object.entries(installed.packages || {})) {
      if (lock.packages?.[name]?.version !== entry.version) return false;
    }
    for (const [name, entry] of Object.entries(lock.packages || {})) {
      if (!name || entry.optional || (entry.os && !entry.os.includes(process.platform))) continue;
      if (installed.packages?.[name]?.version !== entry.version) return false;
    }
    const direct = lock.packages?.[''] || {};
    return Object.keys({ ...direct.dependencies, ...direct.devDependencies }).every(name =>
      fs.existsSync(path.join(frontend, 'node_modules', name, 'package.json')));
  } catch { return false; }
}

function prepareRepository(repository, fetch, sourceCommit = process.env.OVERKOT_MARKET_SOURCE_COMMIT || '') {
  if (sourceCommit && !/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Invalid pinned Market source commit.');
  const explicit = !!repository || !!process.env.OVERKOT_MARKET_REPOSITORY;
  repository = path.resolve(repository || process.env.OVERKOT_MARKET_REPOSITORY || DEFAULT_REPOSITORY);
  if (!fs.existsSync(repository)) {
    if (explicit) throw new Error(`Market repository not found: ${repository}`);
    repository = generatedPath(path.join(BUILD_ROOT, 'market-repository'));
    if (!fs.existsSync(path.join(repository, 'HEAD'))) {
      fs.mkdirSync(repository, { recursive: true });
      execFileSync('git', ['init', '--bare', repository], { stdio: 'pipe', windowsHide: true });
      git(repository, ['remote', 'add', 'origin', REMOTE]);
    }
  }
  if (fetch && !sourceCommit) {
    console.log(`[market-ui] Updating origin/${BRANCH}...`);
    git(repository, ['fetch', '--no-tags', 'origin', `+refs/heads/${BRANCH}:${REF}`]);
  }
  // Release CI checks out one resolved preview commit for all platforms. Local
  // builds keep following the branch unless a specific commit is requested.
  const commit = git(repository, ['rev-parse', '--verify', `${sourceCommit || REF}^{commit}`]);
  if (sourceCommit && commit !== sourceCommit) throw new Error('Pinned Market source commit does not match the checkout.');
  return { repository, commit };
}

function prepareDependencies(repository, sourceFrontend) {
  const lockFile = path.join(sourceFrontend, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  const localFrontend = path.join(repository, 'frontend');
  let dependencyRoot;
  if (dependenciesMatch(localFrontend, lock)) {
    dependencyRoot = localFrontend;
  } else {
    dependencyRoot = generatedPath(path.join(BUILD_ROOT, 'market-dependencies', lockFingerprint(lockFile)));
    fs.mkdirSync(dependencyRoot, { recursive: true });
    for (const filename of ['package.json', 'package-lock.json']) {
      fs.copyFileSync(path.join(sourceFrontend, filename), path.join(dependencyRoot, filename));
    }
    if (!dependenciesMatch(dependencyRoot, lock)) {
      console.log('[market-ui] Installing isolated frontend build dependencies...');
      // npm's JS entry avoids cmd.exe argument quoting and works on Windows.
      const npmCandidates = [process.env.npm_execpath,
        path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')];
      try {
        const executable = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['npm'], {
          encoding: 'utf8', windowsHide: true,
        }).trim().split(/\r?\n/)[0];
        npmCandidates.push(fs.realpathSync(executable));
      } catch {}
      const npmCli = npmCandidates.find(candidate => candidate && /npm-cli\.js$/.test(candidate) && fs.existsSync(candidate));
      if (!npmCli) throw new Error('Cannot locate npm. Run this build using npm run market:build.');
      execFileSync(process.execPath, [npmCli, 'ci', '--no-audit', '--no-fund'], {
        cwd: dependencyRoot, stdio: 'inherit', windowsHide: true,
      });
    }
  }
  fs.symlinkSync(path.join(dependencyRoot, 'node_modules'), path.join(sourceFrontend, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  return dependencyRoot;
}

async function importDependency(root, name) {
  const directory = path.join(root, 'node_modules', name);
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  let entry = metadata.exports?.['.']?.import || metadata.module || metadata.main;
  if (typeof entry === 'object') entry = entry.default;
  if (typeof entry !== 'string') throw new Error(`Cannot locate the market build dependency ${name}.`);
  return import(pathToFileURL(path.join(directory, entry)).href);
}

async function buildMarketUi({ repoDir, outDir = path.join(BUILD_ROOT, 'market-ui'), fetch = true,
  sourceCommit = process.env.OVERKOT_MARKET_SOURCE_COMMIT || '', mode = readMarketUiMode(), defaultRepository = DEFAULT_REPOSITORY } = {}) {
  outDir = generatedPath(outDir);
  if (!['auto', 'enabled', 'disabled'].includes(mode)) throw new Error('Market UI mode must be auto, enabled or disabled.');
  const sourceRepository = path.resolve(repoDir || process.env.OVERKOT_MARKET_REPOSITORY || defaultRepository);
  const sourceRequired = mode === 'enabled' || !!repoDir || !!process.env.OVERKOT_MARKET_REPOSITORY || !!sourceCommit;
  if (mode === 'disabled' || (mode === 'auto' && !sourceRequired)) return buildCommunityMarketUi(outDir);
  if (!fs.existsSync(sourceRepository)) throw new Error('The optional Market checkout is unavailable. Use OVERKOT_MARKET_UI=disabled for a standalone source build.');
  const { repository, commit } = prepareRepository(sourceRepository, fetch, sourceCommit);
  const source = generatedPath(path.join(BUILD_ROOT, 'market-source'));
  const archive = generatedPath(path.join(BUILD_ROOT, 'market-source.tar'));
  fs.rmSync(source, { recursive: true, force: true });
  fs.mkdirSync(source, { recursive: true });
  try {
    const archivePaths = ['frontend'];
    // Newer website revisions share artwork validation outside frontend/.
    // Include that exact pinned source without copying backend code or secrets.
    try { git(repository, ['cat-file', '-e', `${commit}:src/shared/gameImages.ts`]); archivePaths.push('src/shared/gameImages.ts'); } catch {}
    git(repository, ['archive', '--format=tar', `--output=${archive}`, commit, ...archivePaths]);
    execFileSync('tar', ['-xf', archive, '-C', source], { stdio: 'pipe', windowsHide: true });
  } finally { fs.rmSync(archive, { force: true }); }
  const frontend = path.join(source, 'frontend');
  const appFile = path.join(frontend, 'src', 'App.svelte');
  const indexFile = path.join(frontend, 'index.html');
  const settingsFile = path.join(frontend, 'src', 'pages', 'Settings.svelte');
  const accountMenuFile = path.join(frontend, 'src', 'components', 'AccountMenu.svelte');
  const catalogueFile = path.join(frontend, 'src', 'lib', 'marketCatalogue.ts');
  fs.writeFileSync(appFile, adaptApp(fs.readFileSync(appFile, 'utf8')));
  fs.writeFileSync(indexFile, adaptIndex(fs.readFileSync(indexFile, 'utf8')));
  fs.writeFileSync(settingsFile, adaptSettings(fs.readFileSync(settingsFile, 'utf8')));
  fs.writeFileSync(accountMenuFile, adaptAccountMenu(fs.readFileSync(accountMenuFile, 'utf8')));
  fs.writeFileSync(catalogueFile, adaptMarketCatalogue(fs.readFileSync(catalogueFile, 'utf8')));
  for (const component of ['TradeSlotsEditor.svelte', 'TradeTermsSummary.svelte']) {
    const file = path.join(frontend, 'src', 'components', component);
    if (fs.existsSync(file)) fs.writeFileSync(file, adaptGameImageLiterals(fs.readFileSync(file, 'utf8')));
  }
  fs.copyFileSync(path.join(ADAPTER_ROOT, 'api.ts'), path.join(frontend, 'src', 'lib', 'api.ts'));
  fs.cpSync(ADAPTER_ROOT, path.join(frontend, 'src', 'overkot'), { recursive: true });
  const dependencies = prepareDependencies(repository, frontend);
  const [{ build }, { svelte }, preprocessModule] = await Promise.all([
    importDependency(dependencies, 'vite'),
    importDependency(dependencies, '@sveltejs/vite-plugin-svelte'),
    importDependency(dependencies, 'svelte-preprocess'),
  ]);
  await build({
    root: frontend,
    configFile: false,
    // Electron owns updates and image caching. Do not install the site's PWA
    // worker or analytics in the overlay's dedicated local origin.
    plugins: [svelte({ preprocess: preprocessModule.default(), experimental: { disableSvelteResolveWarnings: true } })],
    base: '/',
    define: { 'import.meta.env.VITE_IMAGES_BASE_URL': JSON.stringify('overkot-game-data://images') },
    build: { outDir, emptyOutDir: true, target: 'chrome144', chunkSizeWarningLimit: 800 },
  });
  const metadata = { schema: 1, repository: REMOTE, branch: BRANCH, ref: REF, commit,
    dependencyLockHash: lockFingerprint(path.join(frontend, 'package-lock.json')) };
  fs.writeFileSync(path.join(outDir, 'market-source.json'), JSON.stringify(metadata, null, 2) + '\n');
  console.log(`[market-ui] Built ${BRANCH} (${commit.slice(0, 12)}) at ${outDir}`);
  return { outDir, source, metadata };
}

module.exports = { buildMarketUi, ensureMarketUi: buildMarketUi, readMarketUiMode, buildCommunityMarketUi, adaptMarketCatalogue, adaptGameImageLiterals, adaptApp, adaptIndex, adaptSettings, adaptAccountMenu, dependenciesMatch, prepareRepository, BRANCH, REF };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--no-fetch')) throw new Error('Usage: node scripts/build-market-ui.js [--no-fetch]');
  buildMarketUi({ fetch: !args.includes('--no-fetch') }).catch(error => {
    console.error('[market-ui]', error.message);
    process.exitCode = 1;
  });
}
