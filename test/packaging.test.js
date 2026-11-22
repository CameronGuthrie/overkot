process.env.OVERKOT_SERVICES_FILE = '';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { parseOptions, createConfig, writeChecksums, prepareLinuxInstallHook, betaVersion, linuxTestVersion, packagedMetadata, copyAssets } = require('../scripts/build');
const pkg = require('../package.json');
const { STABLE_CHANNEL, TITLE_TRACKER_BETA_CHANNEL } = require('../src/modules/buildChannel');

const windows = { platform: 'win32', arch: 'x64' };
const linux = { platform: 'linux', arch: 'x64' };
const appleSilicon = { platform: 'darwin', arch: 'arm64' };

test('only the official stable Windows packaging configuration points at the release feed', () => {
  const project = path.resolve(__dirname, '..');
  const profile = path.join(project, 'config/official-services.json');
  const { releases } = JSON.parse(fs.readFileSync(profile, 'utf8'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OVERKOT_')));
  env.OVERKOT_SERVICES_FILE = profile;
  const inspect = (...flags) => JSON.parse(execFileSync(process.execPath, ['scripts/build.js', '--inspect-config', ...flags],
    { cwd: project, env, encoding: 'utf8' })).config;
  assert.deepEqual(inspect('--win').publish, { provider: 'generic', url: releases, channel: 'latest' });
  for (const flags of [['--win', '--portable', '--beta'], ['--linux'], ['--mac']]) {
    assert.equal(inspect(...flags).publish, null);
  }
});

test('package staging skips legacy temper images and includes application artwork', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-stage-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(path.join(source, 'tempers'), { recursive: true });
  fs.writeFileSync(path.join(source, 'tempers', 'Braced.webp'), 'temper');
  fs.writeFileSync(path.join(source, 'overkot.png'), 'logo');
  const destination = path.join(root, 'staged');
  copyAssets(source, destination);
  assert.deepEqual(fs.readdirSync(destination), ['overkot.png']);
  assert.ok(pkg.build.files.includes('!assets/tempers/**'));
});

test('stable and beta bundling reject invalid title data instead of dropping the release catalog', async () => {
  const { bundle } = require('../scripts/bundle');
  for (const channel of [STABLE_CHANNEL, TITLE_TRACKER_BETA_CHANNEL]) {
    await assert.rejects(bundle({ channel, titleCatalog: { schema: 1, titles: [] } }), /Invalid title catalog/);
  }
});

test('default builds select packages for their host and keep Windows artifact names stable', () => {
  const win = parseOptions([], windows);
  assert.deepEqual(win.targets, ['nsis']);
  assert.equal(createConfig(pkg, win).artifactName, 'overkot-setup-${version}.${ext}');
  assert.equal(createConfig(pkg, parseOptions(['--portable'], windows)).artifactName, 'overkot-portable-${version}.${ext}');
  const fast = createConfig(pkg, parseOptions(['--portable', '--fast'], windows));
  assert.equal(fast.artifactName, 'overkot-portable-${version}-fast.${ext}');
  assert.equal(fast.portable.useZip, true);
  assert.deepEqual(parseOptions([], linux).targets, ['AppImage', 'deb', 'rpm', 'pacman']);
  assert.deepEqual(parseOptions([], appleSilicon).targets, ['dmg', 'zip']);
  assert.equal(parseOptions([], appleSilicon).arch, 'arm64');
  assert.equal(parseOptions(['--x64'], appleSilicon).arch, 'x64');
  for (const host of [windows, linux, appleSilicon]) assert.deepEqual(parseOptions(['--dir'], host).targets, ['dir']);
});

test('Windows app, installer and uninstaller use the same generated icon and high-DPI artwork', () => {
  const config = createConfig(pkg, parseOptions([], windows));
  const assets = path.resolve(__dirname, '../assets');
  assert.equal(config.win.icon, path.join(assets, 'overkot.ico'));
  assert.equal(config.nsis.installerIcon, config.win.icon);
  assert.equal(config.nsis.uninstallerIcon, config.win.icon);
  assert.equal(config.nsis.installerHeader, path.join(assets, 'installer-header.bmp'));
  assert.equal(config.nsis.installerSidebar, path.join(assets, 'installer-sidebar.bmp'));
  assert.equal(config.nsis.uninstallerSidebar, config.nsis.installerSidebar);
  assert.match(fs.readFileSync(config.nsis.include, 'utf8'), /^ManifestDPIAware true$/m);
});

test('unsupported combinations fail before preparing or downloading anything', () => {
  assert.throws(() => parseOptions(['--linux'], windows), /linux host/);
  assert.throws(() => parseOptions(['--mac'], linux), /darwin host/);
  assert.throws(() => parseOptions(['--portable'], linux), /win32 host/);
  assert.throws(() => parseOptions(['--mac', '--linux'], windows), /one platform/);
  assert.throws(() => parseOptions(['--x64', '--arm64'], appleSilicon), /one architecture/);
  assert.throws(() => parseOptions(['--arm64'], linux), /currently support x64/);
  assert.throws(() => parseOptions(['--portable', '--dir'], windows), /cannot be combined/);
  assert.throws(() => parseOptions(['--fast'], windows), /portable builds/);
  assert.throws(() => parseOptions(['--adhoc'], linux), /macOS test builds/);
  assert.throws(() => parseOptions(['--unknown'], windows), /Unknown build option/);
  assert.equal(parseOptions(['--linux', '--inspect-config'], windows).platform, 'linux');
  assert.equal(parseOptions(['--mac', '--prepare-only'], windows).platform, 'darwin');
  assert.throws(() => parseOptions(['--skip-scanner'], linux), /require their native helper/);
  assert.equal(parseOptions(['--linux', '--prepare-only', '--skip-scanner'], windows).skipScanner, true);
});

test('the local title tracker beta can build only a Windows portable or unpacked app', () => {
  const portable = parseOptions(['--win', '--portable', '--beta'], windows);
  assert.equal(portable.beta, true);
  assert.deepEqual(portable.targets, ['portable']);
  assert.deepEqual(parseOptions(['--win', '--dir', '--beta'], windows).targets, ['dir']);
  for (const args of [['--beta'], ['--win', '--beta'], ['--linux', '--portable', '--beta'], ['--mac', '--dir', '--beta']]) {
    assert.throws(() => parseOptions(args, windows), /local-only.*installer builds are disabled/);
  }
});

test('beta packaging isolates output and identity and removes updater publication configuration', async () => {
  const options = parseOptions(['--win', '--portable', '--beta'], windows);
  const beta = createConfig(pkg, options);
  assert.equal(beta.directories.app, path.resolve(__dirname, '../.build/beta/app'));
  assert.equal(beta.directories.output, path.resolve(__dirname, '../dist-beta/title-tracker'));
  assert.equal(beta.appId, 'com.overkot.app.beta.title-tracker');
  assert.equal(beta.publish, null);
  assert.equal(beta.nsis, undefined);
  assert.deepEqual(beta.win.target, ['portable']);
  assert.equal(beta.artifactName, 'overkot-title-tracker-beta-${version}.${ext}');
  assert.equal(beta.extraMetadata.version, betaVersion(pkg.version));
  assert.equal(createConfig(pkg, parseOptions([], windows)).publish, null);
  assert.equal(createConfig(pkg, parseOptions([], windows)).appId, pkg.build.appId);
  assert.equal(createConfig(pkg, parseOptions(['--portable', '--fast', '--beta'], windows)).portable.useZip, true);
  const { validateConfiguration } = require('app-builder-lib/out/util/config/config');
  const { DebugLogger } = require('builder-util');
  await validateConfiguration(beta, new DebugLogger(false));
});

test('beta manifest versions are local prereleases without mutating the public package', () => {
  const original = JSON.stringify(pkg);
  const stable = packagedMetadata(pkg);
  const beta = packagedMetadata(pkg, { beta: true });
  assert.equal(stable.version, pkg.version);
  assert.equal(stable.name, pkg.name);
  assert.equal(beta.version, `${pkg.version}-beta.title-tracker.1`);
  assert.equal(beta.name, 'overkot-title-tracker-beta');
  assert.equal(beta.build, undefined);
  assert.equal(beta.scripts, undefined);
  assert.deepEqual(beta.dependencies, {});
  assert.equal(betaVersion('0.0.13-preview.2'), '0.0.13-beta.title-tracker.1');
  assert.throws(() => betaVersion('invalid'), /Invalid package version/);
  assert.equal(JSON.stringify(pkg), original);
});

test('Debian-only builds select DEB without unrelated package formats', () => {
  assert.deepEqual(parseOptions(['--deb'], linux).targets, ['deb']);
  const preview = parseOptions(['--linux', '--deb', '--inspect-config'], windows);
  assert.equal(preview.platform, 'linux');
  assert.deepEqual(preview.targets, ['deb']);
  assert.equal(createConfig(pkg, preview).publish, null);
  assert.throws(() => parseOptions(['--deb'], windows), /linux host/);
  for (const args of [['--win', '--deb'], ['--mac', '--deb'], ['--deb', '--dir'], ['--deb', '--portable']]) {
    assert.throws(() => parseOptions(args, linux), /--deb requires/);
  }
});

test('local Linux dock builds allow only the requested test formats and isolate their output', async () => {
  const { validateConfiguration } = require('app-builder-lib/out/util/config/config');
  const { DebugLogger } = require('builder-util');
  for (const target of ['--portable', '--pacman', '--dir']) {
    const options = parseOptions(['--linux', target, '--linux-test'], linux);
    const config = createConfig(pkg, options);
    assert.equal(options.linuxTest, true);
    assert.equal(config.directories.app, path.resolve(__dirname, '../.build/linux-dock/app'));
    assert.equal(config.directories.output, path.resolve(__dirname, '../dist-beta/linux-dock'));
    assert.equal(config.publish, null);
    assert.equal(config.appId, pkg.build.appId);
    assert.equal(config.extraMetadata.version, `${pkg.version}-preview.linux-dock.1`);
    assert.deepEqual(config.linux.target, options.targets);
    assert.deepEqual(config.extraResources[0].filter, ['overkot-session-scanner', 'overkot-overlay-window', 'overkot-position-reader', 'overkot-position-reader-core', 'overkot-position-reader-NOTICES.txt']);
    await validateConfiguration(config, new DebugLogger(false));
  }
  for (const args of [['--linux-test'], ['--linux', '--linux-test'], ['--linux', '--deb', '--linux-test'],
    ['--win', '--portable', '--linux-test'], ['--mac', '--dir', '--linux-test'], ['--win', '--portable', '--beta', '--linux-test']]) {
    assert.throws(() => parseOptions(args, linux), /--linux-test is local-only/);
  }
  const inspection = parseOptions(['--linux', '--portable', '--linux-test', '--inspect-config'], windows);
  assert.equal(createConfig(pkg, inspection).publish, null);
});

test('Linux dock test metadata preserves the installed app identity without changing the public source version', () => {
  const original = JSON.stringify(pkg);
  const metadata = packagedMetadata(pkg, { linuxTest: true });
  assert.equal(metadata.name, pkg.name);
  assert.equal(metadata.version, `${pkg.version}-preview.linux-dock.1`);
  assert.deepEqual(metadata.dependencies, {});
  assert.equal(linuxTestVersion('0.0.13-preview.2'), '0.0.13-preview.linux-dock.1');
  assert.throws(() => linuxTestVersion('invalid'), /Invalid package version/);
  assert.equal(JSON.stringify(pkg), original);
});

test('Arch-only builds select Pacman without portable or unrelated package formats', () => {
  assert.deepEqual(parseOptions(['--pacman'], linux).targets, ['pacman']);
  const preview = parseOptions(['--linux', '--pacman', '--inspect-config'], windows);
  assert.equal(preview.platform, 'linux');
  assert.deepEqual(preview.targets, ['pacman']);
  assert.equal(createConfig(pkg, preview).publish, null);
  assert.throws(() => parseOptions(['--pacman'], windows), /linux host/);
  for (const args of [['--win', '--pacman'], ['--mac', '--pacman'], ['--pacman', '--dir'], ['--pacman', '--portable'], ['--pacman', '--deb']]) {
    assert.throws(() => parseOptions(args, linux), /--pacman requires/);
  }
});

test('Linux portable builds select only AppImage and retain the native helper and sandbox', () => {
  const options = parseOptions(['--linux', '--portable'], linux);
  assert.equal(options.platform, 'linux');
  assert.deepEqual(options.targets, ['AppImage']);
  const config = createConfig(pkg, options);
  assert.equal(config.artifactName, 'overkot-${version}-linux-${arch}.${ext}');
  assert.equal(config.publish, null);
  assert.equal(config.portable, undefined);
  assert.deepEqual(config.extraResources[0].filter, ['overkot-session-scanner', 'overkot-overlay-window', 'overkot-position-reader', 'overkot-position-reader-core', 'overkot-position-reader-NOTICES.txt']);
  assert.deepEqual(config.appImage.executableArgs, ['--']);
  assert.deepEqual(parseOptions(['--linux', '--portable', '--inspect-config'], windows).targets, ['AppImage']);
  assert.throws(() => parseOptions(['--linux', '--portable'], windows), /linux host/);
  assert.throws(() => parseOptions(['--linux', '--portable', '--fast'], linux), /portable builds/);
  assert.throws(() => parseOptions(['--linux', '--portable', '--dir'], linux), /cannot be combined/);
  assert.throws(() => parseOptions(['--mac', '--portable'], appleSilicon), /Windows or Linux/);
});

test('release AppImage filenames match electron-builder architecture expansion', () => {
  require('electron-builder');
  const { PlatformPackager } = require('app-builder-lib/out/platformPackager');
  const { Arch } = require('builder-util');
  const { packageNames } = require('../scripts/release-artifacts');
  const releaseVersion = '0.0.12-beta.5';
  const config = createConfig(pkg, parseOptions(['--linux', '--portable'], linux));
  const packager = {
    config, platformSpecificBuildOptions: config.linux,
    appInfo: { name: pkg.name, version: releaseVersion, productName: 'Overkot', productFilename: 'Overkot' },
    platform: { buildConfigurationKey: 'linux' },
    artifactPatternConfig: PlatformPackager.prototype.artifactPatternConfig,
    computeArtifactName: PlatformPackager.prototype.computeArtifactName,
    expandMacro: PlatformPackager.prototype.expandMacro,
  };
  const filename = PlatformPackager.prototype.expandArtifactNamePattern.call(packager, { ...config.linux, ...config.appImage }, 'AppImage', Arch.x64);
  assert.equal(filename, `overkot-${releaseVersion}-linux-x86_64.AppImage`);
  assert.equal(filename, packageNames(`v${releaseVersion}`).linuxAppImage);
});

test('Windows scanner and updater resources stay out of Linux and macOS packages', () => {
  const win = createConfig(pkg, parseOptions([], windows));
  assert.equal(win.extraResources.length, 1);
  assert.deepEqual(win.extraResources[0].filter, ['*.exe']);
  assert.ok(win.nsis.include.endsWith('installer.nsh'));
  assert.equal(win.publish, null);
  for (const host of [linux, appleSilicon]) {
    const config = createConfig(pkg, parseOptions([], host));
    if (host.platform === 'linux') {
      assert.equal(config.extraResources.length, 1);
      assert.deepEqual(config.extraResources[0].filter, ['overkot-session-scanner', 'overkot-overlay-window', 'overkot-position-reader', 'overkot-position-reader-core', 'overkot-position-reader-NOTICES.txt']);
      assert.equal(config.extraResources[0].to, 'bin');
      assert.equal(path.basename(config.extraResources[0].from), 'bin');
    } else assert.deepEqual(config.extraResources, []);
    assert.equal(config.win, undefined);
    assert.equal(config.nsis, undefined);
    assert.equal(config.publish, null);
    assert.ok(config.files.includes('!bin/**'));
  }
});

test('Debian and Arch install hooks configure only the two native game readers and retain builder defaults', t => {
  const config = createConfig(pkg, parseOptions([], linux));
  assert.ok(config.deb.depends.includes('libcap2-bin'));
  assert.equal(path.basename(config.deb.afterInstall), 'linux-after-install.sh');
  assert.ok(config.pacman.depends.includes('libcap'));
  assert.equal(config.pacman.afterInstall, config.deb.afterInstall);
  const upgradeHook = path.resolve(__dirname, '../scripts/pacman-after-upgrade.sh');
  assert.deepEqual(config.pacman.fpm, ['--after-upgrade', upgradeHook]);
  assert.match(fs.readFileSync(upgradeHook, 'utf8'), /^post_install "\$@"$/m);
  for (const format of ['linux', 'rpm', 'appImage']) assert.equal(config[format].afterInstall, undefined);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-install-hook-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const hook = fs.readFileSync(prepareLinuxInstallHook(path.join(directory, 'postinst')), 'utf8');
  const builderRoot = path.dirname(require.resolve('app-builder-lib/package.json'));
  const defaultHook = fs.readFileSync(path.join(builderRoot, 'templates/linux/after-install.tpl'), 'utf8').trimEnd().replaceAll('\r\n', '\n');
  assert.ok(hook.startsWith(defaultHook + '\n\n'));
  const custom = hook.slice(defaultHook.length);
  assert.match(custom, /for scanner in '\/opt\/Overkot\/resources\/bin\/overkot-session-scanner' '\/opt\/Overkot\/resources\/bin\/overkot-position-reader' '\/opt\/Overkot\/resources\/bin\/overkot-position-reader-core'; do/);
  assert.match(custom, /chown root:root "\$scanner"/);
  assert.match(custom, /chmod 0755 "\$scanner"/);
  assert.match(custom, /stat -c '%u:%g' "\$scanner_path"/);
  assert.match(custom, /0\$scanner_mode & 022/);
  assert.match(custom, /\/usr\/sbin\/setcap/);
  assert.match(custom, /\/usr\/bin\/setcap/);
  assert.match(custom, /"\$setcap_binary" cap_sys_ptrace=ep "\$scanner"/);
  assert.match(custom, /if \[ "\$scanner" = '\/opt\/Overkot\/resources\/bin\/overkot-position-reader-core' \]; then/);
  assert.match(custom, /scanner_capabilities=\$\("\$getcap_binary" "\$scanner"\)/);
  assert.match(custom, /"\$setcap_binary" -r "\$scanner"/);
  assert.equal((custom.match(/cap_sys_ptrace=ep/g) || []).length, 1);
  assert.doesNotMatch(custom, /sysctl|chmod [467][0-7]{3}|setcap.*(?:chrome|electron)/);
  assert.doesNotMatch(hook, /\r/);
});

test('macOS retains native locales and only opts into ad-hoc test signing explicitly', () => {
  const config = createConfig(pkg, parseOptions([], appleSilicon));
  assert.equal(config.mac.identity, undefined);
  assert.equal(config.mac.hardenedRuntime, undefined);
  assert.equal(config.mac.notarize, undefined);
  for (const locale of ['en', 'en_GB', 'pt_BR', 'zh_CN', 'zh_TW']) assert.ok(config.mac.electronLanguages.includes(locale));
  assert.ok(!config.mac.electronLanguages.includes('en-US'));
  const adhoc = createConfig(pkg, parseOptions(['--adhoc'], appleSilicon));
  assert.equal(adhoc.mac.identity, '-');
  assert.equal(adhoc.mac.hardenedRuntime, false);
  assert.equal(adhoc.mac.notarize, false);
});

test('AppImage desktop launcher preserves Electron sandbox defaults', async () => {
  const AppImageTarget = require('app-builder-lib/out/targets/appimage/AppImageTarget').default;
  const { LinuxTargetHelper } = require('app-builder-lib/out/targets/LinuxTargetHelper');
  const config = createConfig(pkg, parseOptions([], linux));
  const packager = {
    config,
    platformSpecificBuildOptions: config.linux,
    appInfo: { productName: 'Overkot', buildVersion: pkg.version, description: pkg.description },
    executableName: 'overkot',
    fileAssociations: [],
  };
  const target = new AppImageTarget(null, packager, new LinuxTargetHelper(packager), '/unused');
  const desktopEntry = await target.desktopEntry.value;
  assert.match(desktopEntry, /^Exec=AppRun -- %U$/m);
  assert.doesNotMatch(desktopEntry, /--no-sandbox|--enable-sandbox/);
  for (const host of [windows, appleSilicon]) assert.equal(createConfig(pkg, parseOptions([], host)).appImage, undefined);
});

test('all native build configurations satisfy the installed electron-builder schema', async () => {
  const { validateConfiguration } = require('app-builder-lib/out/util/config/config');
  const { DebugLogger } = require('builder-util');
  for (const host of [windows, linux, appleSilicon]) {
    await validateConfiguration(createConfig(pkg, parseOptions([], host)), new DebugLogger(false));
  }
  await validateConfiguration(createConfig(pkg, parseOptions(['--adhoc'], appleSilicon)), new DebugLogger(false));
  await validateConfiguration(createConfig(pkg, parseOptions(['--linux', '--portable'], linux)), new DebugLogger(false));
  await validateConfiguration(createConfig(pkg, parseOptions(['--linux', '--pacman'], linux)), new DebugLogger(false));
});

test('Linux package metadata meets FPM requirements without a fabricated author email', async () => {
  const FpmTarget = require('app-builder-lib/out/targets/FpmTarget').default;
  const config = createConfig(pkg, parseOptions([], linux));
  for (const target of ['deb', 'rpm', 'pacman']) {
    const metadata = await FpmTarget.prototype.computeFpmMetaInfoOptions.call({
      options: { ...config.linux, ...config[target] },
      packager: { appInfo: { computePackageUrl: async () => pkg.homepage, linuxPackageName: pkg.name } },
    });
    assert.equal(metadata.maintainer, 'Overkot');
    assert.equal(metadata.url, pkg.homepage);
  }
  assert.ok(config.pacman.artifactName.endsWith('.pkg.tar.xz'));
  assert.equal(config.pacman.compression, 'xz');
  assert.ok(!config.pacman.depends.includes('http-parser'));
});

test('checksums use builder-returned filenames for every package format', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-artifacts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filenames = ['setup.exe', 'app.AppImage', 'app.deb', 'app.rpm', 'app.pkg.tar.xz', 'app.dmg', 'app.zip'];
  const artifacts = filenames.map(filename => {
    const file = path.join(directory, filename);
    fs.writeFileSync(file, filename);
    return file;
  });
  writeChecksums(artifacts);
  for (const [index, artifact] of artifacts.entries()) {
    const hash = crypto.createHash('sha256').update(filenames[index]).digest('hex');
    assert.equal(fs.readFileSync(`${artifact}.sha256`, 'utf8'), `${hash}  ${filenames[index]}\n`);
  }
});
