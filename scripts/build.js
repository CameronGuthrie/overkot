const { services } = require('../src/modules/serviceConfig');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { toMacLocale } = require('./verify-runtime-locales');
const { findRelease } = require('../src/modules/releaseNotes');
const { HELPER_NAME } = require('./build-linux-scanner');
const { HELPER_NAME: OVERLAY_HELPER_NAME } = require('./build-linux-overlay');
const { HELPER_NAME: POSITION_HELPER_NAME, CORE_NAME: POSITION_CORE_NAME, NOTICES_NAME: POSITION_NOTICES_NAME } = require('./build-linux-position-reader');
const { STABLE_CHANNEL, TITLE_TRACKER_BETA_CHANNEL } = require('../src/modules/buildChannel');

const ROOT = path.resolve(__dirname, '..');
const STAGE = path.join(ROOT, '.build', 'app');
const BETA_STAGE = path.join(ROOT, '.build', 'beta', 'app');
const BETA_OUTPUT = path.join(ROOT, 'dist-beta', 'title-tracker');
const LINUX_TEST_STAGE = path.join(ROOT, '.build', 'linux-dock', 'app');
const LINUX_TEST_OUTPUT = path.join(ROOT, 'dist-beta', 'linux-dock');

const PLATFORMS = { '--win': 'win32', '--linux': 'linux', '--mac': 'darwin' };
const DEFAULT_TARGETS = { win32: ['nsis'], linux: ['AppImage', 'deb', 'rpm', 'pacman'], darwin: ['dmg', 'zip'] };

function parseOptions(args, host = { platform: process.platform, arch: process.arch }) {
  const allowed = new Set([...Object.keys(PLATFORMS), '--x64', '--arm64', '--adhoc', '--inspect-config', '--bundle', '--skip-obfuscation', '--portable', '--deb', '--pacman', '--dir', '--prepare-only', '--skip-scanner', '--fast', '--beta', '--linux-test']);
  for (const arg of args) if (!allowed.has(arg)) throw new Error(`Unknown build option: ${arg}`);
  const platforms = Object.keys(PLATFORMS).filter(flag => args.includes(flag));
  if (platforms.length > 1) throw new Error('Choose one platform per build: --win, --linux or --mac.');
  const platform = platforms.length ? PLATFORMS[platforms[0]] : args.includes('--portable') ? 'win32' : args.includes('--deb') || args.includes('--pacman') ? 'linux' : host.platform;
  if (!DEFAULT_TARGETS[platform]) throw new Error(`Unsupported build platform: ${platform}`);
  if (args.includes('--x64') && args.includes('--arm64')) throw new Error('Choose one architecture per build: --x64 or --arm64.');
  const arch = args.includes('--arm64') ? 'arm64' : args.includes('--x64') ? 'x64' : platform === 'darwin' && host.platform === 'darwin' ? host.arch : 'x64';
  if (!['x64', 'arm64'].includes(arch) || (platform !== 'darwin' && arch !== 'x64')) {
    throw new Error('Windows and Linux packages currently support x64; macOS supports x64 and arm64.');
  }
  if (args.includes('--portable') && (!['win32', 'linux'].includes(platform) || args.includes('--dir'))) throw new Error('--portable requires a Windows or Linux build and cannot be combined with --dir.');
  if (args.includes('--deb') && (platform !== 'linux' || args.includes('--dir') || args.includes('--portable'))) throw new Error('--deb requires a Linux build and cannot be combined with --dir or --portable.');
  if (args.includes('--pacman') && (platform !== 'linux' || args.includes('--dir') || args.includes('--portable') || args.includes('--deb'))) throw new Error('--pacman requires a Linux build and cannot be combined with --dir, --portable or --deb.');
  const targets = args.includes('--dir') ? ['dir'] : args.includes('--portable') ? [platform === 'linux' ? 'AppImage' : 'portable'] : args.includes('--deb') ? ['deb'] : args.includes('--pacman') ? ['pacman'] : [...DEFAULT_TARGETS[platform]];
  const options = {
    platform, arch, targets,
    fast: args.includes('--fast'),
    adhoc: args.includes('--adhoc'),
    inspectConfig: args.includes('--inspect-config'),
    prepareOnly: args.includes('--prepare-only'),
    skipScanner: args.includes('--skip-scanner'),
    beta: args.includes('--beta'),
    linuxTest: args.includes('--linux-test'),
  };
  if (options.beta && (platform !== 'win32' || !['portable', 'dir'].includes(targets[0]))) {
    throw new Error('--beta is local-only and requires a Windows portable build or --dir inspection; installer builds are disabled.');
  }
  if (options.linuxTest && (options.beta || platform !== 'linux' || targets.length !== 1 || !['AppImage', 'pacman', 'dir'].includes(targets[0]))) {
    throw new Error('--linux-test is local-only and requires a Linux --portable, --pacman or --dir build.');
  }
  if (options.fast && (targets[0] !== 'portable' || options.prepareOnly)) throw new Error('--fast is for portable builds: npm run build:portable:fast');
  if (options.adhoc && platform !== 'darwin') throw new Error('--adhoc is only available for macOS test builds.');
  if (platform === 'linux' && options.skipScanner && !options.prepareOnly && !options.inspectConfig) {
    throw new Error('--skip-scanner is only available with --prepare-only for Linux; Linux packages require their native helper.');
  }
  if (!options.inspectConfig && !options.prepareOnly && platform !== host.platform) {
    throw new Error(`Build ${platform} packages on a ${platform} host (or use the platform build workflow). Use --inspect-config to preview configuration on ${host.platform}.`);
  }
  return options;
}

function betaVersion(version) {
  const family = require('semver').parse(version);
  if (!family) throw new Error(`Invalid package version: ${version}`);
  return `${family.major}.${family.minor}.${family.patch}-beta.title-tracker.1`;
}

function linuxTestVersion(version) {
  const family = require('semver').parse(version);
  if (!family) throw new Error(`Invalid package version: ${version}`);
  return `${family.major}.${family.minor}.${family.patch}-preview.linux-dock.1`;
}

function packagedMetadata(pkg, { beta = false, linuxTest = false } = {}) {
  const { build, scripts, dependencies, devDependencies, ...metadata } = pkg;
  return { ...metadata, ...(beta ? { name: 'overkot-title-tracker-beta', version: betaVersion(pkg.version) } : {}),
    ...(linuxTest ? { version: linuxTestVersion(pkg.version) } : {}), dependencies: {} };
}

function stageFor(options) { return options.beta ? BETA_STAGE : options.linuxTest ? LINUX_TEST_STAGE : STAGE; }

function createConfig(pkg, options, stage = stageFor(options)) {
  const { win, nsis, portable, linux, appImage, deb, rpm, pacman, mac, ...common } = pkg.build;
  const languages = require('../langs/_languages.json');
  const electronLanguages = languages.flatMap(({ code, electronLocales }) => electronLocales || [code]);
  const config = {
    ...common,
    electronLanguages,
    directories: { app: stage, output: options.beta ? BETA_OUTPUT : options.linuxTest ? LINUX_TEST_OUTPUT : path.join(ROOT, 'dist') },
    files: ['**/*', '!bin/**', '!node_modules/**'],
    extraResources: [],
    afterPack: path.join(__dirname, options.platform === 'linux' ? 'prepare-linux-launcher.js' : 'verify-runtime-locales.js'),
  };
  // Linux packages use manual updates and macOS is still experimental;
  // neither platform must consume the Windows updater configuration.
  const { releases } = services;
  config.publish = options.platform === 'win32' && releases ? { provider: 'generic', url: releases, channel: 'latest' } : null;
  if (options.platform === 'win32') {
    config.win = { ...win, icon: path.join(ROOT, win.icon) };
    config.nsis = { ...nsis, include: path.join(ROOT, nsis.include) };
    for (const field of ['installerIcon', 'uninstallerIcon', 'installerHeader', 'installerSidebar', 'uninstallerSidebar']) {
      if (nsis[field]) config.nsis[field] = path.join(ROOT, nsis[field]);
    }
    config.extraResources = [{ from: path.join(stage, 'bin'), to: 'bin', filter: ['*.exe'] }];
    if (options.targets[0] === 'portable') {
      config.artifactName = options.fast ? 'overkot-portable-${version}-fast.${ext}' : 'overkot-portable-${version}.${ext}';
    }
    if (portable || options.fast) config.portable = { ...portable, ...(options.fast ? { useZip: true } : {}) };
    if (options.fast) config.compression = 'normal';
  } else if (options.platform === 'linux') {
    config.linux = { ...linux, icon: path.join(ROOT, linux.icon) };
    // Builder 26 falls back to --no-sandbox even for an empty argument array.
    // A plain end-of-options delimiter keeps Electron's sandbox defaults.
    config.appImage = appImage;
    config.deb = { ...deb, afterInstall: path.join(ROOT, '.build', 'linux-after-install.sh') };
    config.rpm = rpm;
    config.pacman = { ...pacman, afterInstall: path.join(ROOT, '.build', 'linux-after-install.sh'),
      fpm: [...(pacman.fpm || []), '--after-upgrade', path.join(__dirname, 'pacman-after-upgrade.sh')] };
    config.artifactName = linux.artifactName;
    config.extraResources = [{ from: path.join(stage, 'bin'), to: 'bin', filter: [HELPER_NAME, OVERLAY_HELPER_NAME, POSITION_HELPER_NAME, POSITION_CORE_NAME, POSITION_NOTICES_NAME] }];
  } else {
    config.mac = {
      ...mac,
      icon: path.join(ROOT, mac.icon),
      // Chromium's macOS bundles use en.lproj and underscores for regions.
      electronLanguages: electronLanguages.map(toMacLocale),
      // Local/CI test builds must opt in. Normal builds retain certificate
      // discovery and hardened runtime for Developer ID signing/notarization.
      ...(options.adhoc ? { identity: '-', notarize: false, hardenedRuntime: false } : {}),
    };
    config.artifactName = mac.artifactName;
  }
  if (options.beta) {
    config.appId = 'com.overkot.app.beta.title-tracker';
    config.publish = null;
    config.artifactName = options.fast
      ? 'overkot-title-tracker-beta-${version}-fast.${ext}'
      : 'overkot-title-tracker-beta-${version}.${ext}';
    config.extraMetadata = { name: 'overkot-title-tracker-beta', version: betaVersion(pkg.version) };
    config.win.target = options.targets;
    delete config.nsis;
  }
  if (options.linuxTest) {
    config.publish = null;
    config.extraMetadata = { version: linuxTestVersion(pkg.version) };
    config.linux.target = options.targets;
  }
  return config;
}

function copyAssets(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    filter: file => {
      const relative = path.relative(source, file).replaceAll('\\', '/');
      return !/^(?:fonts|new-icons|bin|map-tiles|map-json|map-icons|tempers)(?:\/|$)/.test(relative)
        && !/^(?:installer-(?:header|sidebar)\.bmp|app-icons\.json)$/.test(relative) && !relative.endsWith('.gitkeep');
    },
  });
}

function minifyJson(directory) {
  let saved = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) saved += minifyJson(file);
    else if (entry.name.endsWith('.json')) {
      const raw = fs.readFileSync(file, 'utf8');
      const compact = JSON.stringify(JSON.parse(raw));
      saved += Buffer.byteLength(raw) - Buffer.byteLength(compact);
      fs.writeFileSync(file, compact);
    }
  }
  return saved;
}

function copyInterfaceLanguages(source, destination) {
  const manifest = '_languages.json';
  const languages = JSON.parse(fs.readFileSync(path.join(source, manifest), 'utf8'));
  fs.mkdirSync(path.join(destination, 'flags'), { recursive: true });
  const dictionaries = languages.map(({ code }) => `${code}.json`);
  const flags = new Set(languages.map(({ flag }) => path.join('flags', flag)));
  for (const filename of [manifest, ...dictionaries, ...flags]) {
    fs.copyFileSync(path.join(source, filename), path.join(destination, filename));
  }
}

async function prepare({ skipScanner = false, platform = process.platform, beta = false, linuxTest = false } = {}) {
  await require('./build-app-icons').validateAppIcons({ root: ROOT });
  console.log('[build] Verified app icons match the source PNG and include all Windows sizes');
  if (beta && platform !== 'win32') throw new Error('The local title tracker beta only supports Windows.');
  if (linuxTest && (platform !== 'linux' || beta)) throw new Error('The local Linux dock test build only supports Linux.');
  const stage = stageFor({ beta, linuxTest });
  if (platform === 'win32' && !skipScanner && process.platform !== 'win32') {
    throw new Error('The Windows scanner must be compiled on Windows. Use --skip-scanner only to stage an existing scanner for inspection.');
  }
  if (platform === 'linux' && !skipScanner && process.platform !== 'linux') {
    throw new Error('The Linux scanner must be compiled on Linux. Use --prepare-only --skip-scanner only to inspect app assets without the helper.');
  }
  // Only this fixed, generated directory is replaced. Source, package.json,
  // assets and language packs remain readable even if packaging is interrupted.
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const metadata = packagedMetadata(pkg, { beta, linuxTest });
  const channel = beta ? TITLE_TRACKER_BETA_CHANNEL : STABLE_CHANNEL;
  const titleData = beta ? await require('./build-title-data').loadBetaTitleCatalog()
    : require('./build-title-data').loadTitleCatalogSnapshot();
  console.log(`[build] Verified ${titleData.catalog.titles.length} titles from ${beta ? 'S3' : 'checked-in'} build ${titleData.source.buildId}`);
  await require('./bundle').bundle({ outDir: path.join(stage, 'src'), channel, packageMetadata: metadata,
    titleCatalog: titleData.catalog });
  copyAssets(path.join(ROOT, 'assets'), path.join(stage, 'assets'));
  copyInterfaceLanguages(path.join(ROOT, 'langs'), path.join(stage, 'langs'));
  for (const filename of ['changelog.json', 'LICENSE']) fs.copyFileSync(path.join(ROOT, filename), path.join(stage, filename));
  fs.writeFileSync(path.join(stage, 'src', 'build-channel.json'), JSON.stringify({
    schema: 1, channel, titleTrackerEnabled: true, localOnly: beta || linuxTest, automaticAppUpdates: !!services.releases && !beta && !linuxTest && platform === 'win32',
    titleDataSource: titleData.source,
  }) + '\n');

  if (platform === 'win32') {
    const scannerDir = path.join(stage, 'bin');
    fs.mkdirSync(scannerDir, { recursive: true });
    if (process.platform === 'win32') {
      const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
      execFileSync(compiler, ['/nologo', '/optimize+', '/target:exe', '/reference:System.Windows.Forms.dll',
        '/out:' + path.join(scannerDir, 'overkot-mouse-shortcuts.exe'), path.join(ROOT, 'native', 'mouse-shortcuts.cs')],
        { stdio: 'inherit', windowsHide: true });
    }
    if (!skipScanner) {
      execFileSync(process.execPath, [path.join(__dirname, 'build-scanner.js'), '--output-dir', scannerDir], {
        cwd: ROOT, stdio: 'inherit', windowsHide: true,
      });
      execFileSync(process.execPath, [path.join(__dirname, 'build-position-reader.js'), '--output-dir', scannerDir], {
        cwd: ROOT, stdio: 'inherit', windowsHide: true,
      });
    } else {
      fs.copyFileSync(path.join(ROOT, 'assets', 'bin', 'hostservice.exe'), path.join(scannerDir, 'hostservice.exe'));
      const positionReader = [path.join(ROOT, '.build', 'bin', 'overkot-position-reader.exe'),
        path.join(ROOT, 'assets', 'bin', 'overkot-position-reader.exe')].find(filename => fs.existsSync(filename));
      if (!positionReader) throw new Error('No existing player position reader to stage. Run npm run build:position-reader on Windows before using --skip-scanner.');
      fs.copyFileSync(positionReader, path.join(scannerDir, 'overkot-position-reader.exe'));
    }
  } else if (platform === 'linux') {
    const scannerDir = path.join(stage, 'bin');
    fs.mkdirSync(scannerDir, { recursive: true });
    if (!skipScanner) {
      execFileSync(process.execPath, [path.join(__dirname, 'build-linux-scanner.js'), '--output-dir', scannerDir], {
        cwd: ROOT, stdio: 'inherit',
      });
      execFileSync(process.execPath, [path.join(__dirname, 'build-linux-overlay.js'), '--output-dir', scannerDir], {
        cwd: ROOT, stdio: 'inherit',
      });
      execFileSync(process.execPath, [path.join(__dirname, 'build-linux-position-reader.js'), '--output-dir', scannerDir], {
        cwd: ROOT, stdio: 'inherit',
      });
    }
    prepareLinuxInstallHook();
  }

  // All runtime dependencies are in the bundle. Keep the packaged manifest
  // separate from development tooling and its dependency declarations.
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(metadata, null, 2) + '\n');
  const saved = minifyJson(stage);
  console.log(`[build] Staged ${channel} app at ${stage}; JSON reduced by ${(saved / 1024).toFixed(1)} KB`);
  return { pkg, stage };
}

function prepareLinuxInstallHook(output = path.join(ROOT, '.build', 'linux-after-install.sh')) {
  const builderRoot = path.dirname(require.resolve('app-builder-lib/package.json'));
  const defaultHook = fs.readFileSync(path.join(builderRoot, 'templates', 'linux', 'after-install.tpl'), 'utf8');
  const scannerHook = fs.readFileSync(path.join(__dirname, 'linux-after-install.sh'), 'utf8');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${defaultHook.trimEnd()}\n\n${scannerHook.trimEnd()}\n`.replaceAll('\r\n', '\n'));
  return output;
}

async function main(args = process.argv.slice(2)) {
  const started = performance.now();
  const options = parseOptions(args);
  // Installed Linux assets must be readable by the desktop user even when the
  // build host uses a restrictive umask (including Arch container defaults).
  if (options.platform === 'linux' && !options.inspectConfig) process.umask(0o022);
  if (options.inspectConfig) {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const config = createConfig(pkg, options);
    const { validateConfiguration } = require('app-builder-lib/out/util/config/config');
    const { DebugLogger } = require('builder-util');
    await validateConfiguration(config, new DebugLogger(false));
    console.log(JSON.stringify({ ...options, publish: 'never', config }, null, 2));
    return;
  }
  const { pkg, stage } = await prepare(options);
  console.log(`[build] Preparation completed in ${((performance.now() - started) / 1000).toFixed(1)}s`);
  if (options.prepareOnly) return;

  const { build, Platform, Arch } = require('electron-builder');
  const config = createConfig(pkg, options, stage);
  // A separate config avoids electron-builder merging the development file
  // and extraResources arrays back into this isolated staging configuration.
  const configPath = path.join(ROOT, '.build', options.beta ? 'beta' : options.linuxTest ? 'linux-dock' : '', 'electron-builder.cjs');
  fs.writeFileSync(configPath, `module.exports = ${JSON.stringify(config, null, 2)};\n`
    // npmRebuild:false alone still scans the parent node_modules tree.
    + 'module.exports.beforeBuild = async () => false;\n');
  // The install wizard embeds this release family's notes, so it works offline.
  const changelog = JSON.parse(fs.readFileSync(path.join(ROOT, 'changelog.json'), 'utf8'));
  const release = findRelease(changelog, pkg.version);
  if (!release) throw new Error(`Missing changelog for ${pkg.version}`);
  const notes = [`Overkot ${pkg.version}`, '', ...release.changes.map(change => `- ${change}`)].join('\r\n');
  fs.writeFileSync(path.join(ROOT, '.build', 'release-notes.txt'), notes + '\r\n');
  const packagingStarted = performance.now();
  const packagingLabel = options.targets[0] === 'dir' ? 'Unpacked app' : options.fast ? 'Fast portable (ZIP compression)' : `${options.platform} ${options.arch} ${options.targets.join(', ')} packaging`;
  console.log(`[build] ${packagingLabel} started`);
  const progress = setInterval(() => {
    console.log(`[build] ${packagingLabel}: ${((performance.now() - packagingStarted) / 1000).toFixed(0)}s elapsed`);
  }, 15000);
  progress.unref();
  let artifacts;
  try {
    const platform = { win32: Platform.WINDOWS, linux: Platform.LINUX, darwin: Platform.MAC }[options.platform];
    artifacts = await build({
      projectDir: ROOT,
      targets: platform.createTarget(options.targets, Arch[options.arch]),
      publish: 'never',
      config: configPath,
    });
  } finally {
    clearInterval(progress);
  }
  if (options.targets[0] !== 'dir') writeChecksums(artifacts);
  console.log(`[build] Packaging completed in ${((performance.now() - packagingStarted) / 1000).toFixed(1)}s; total ${((performance.now() - started) / 1000).toFixed(1)}s`);
}

function writeChecksums(artifacts) {
  for (const artifact of new Set(artifacts)) {
    const hash = require('node:crypto').createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
    fs.writeFileSync(`${artifact}.sha256`, `${hash}  ${path.basename(artifact)}\n`);
  }
}

module.exports = { main, prepare, parseOptions, createConfig, writeChecksums, prepareLinuxInstallHook, betaVersion, linuxTestVersion, packagedMetadata, copyAssets, copyInterfaceLanguages };
if (require.main === module) main().catch(error => {
  console.error('[build]', error.message);
  process.exitCode = 1;
});
