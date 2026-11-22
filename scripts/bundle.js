/**
 * bundle.js — esbuild bundling step for production builds.
 *
 * Bundles the main process code (main.js + all modules) into a single file,
 * tree-shaking unused Firebase SDK code and eliminating node_modules from the ASAR.
 *
 * Before bundling:  node_modules in ASAR ≈ 19.5 MB (Firebase alone ≈ 15 MB)
 * After bundling:   node_modules = 0 MB (everything inlined + tree-shaken)
 *
 * Usage:  node scripts/bundle.js
 * Output: .build/bundled/src/  (drop-in replacement for src/)
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const { STABLE_CHANNEL, TITLE_TRACKER_BETA_CHANNEL } = require('../src/modules/buildChannel');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const OUT_DIR = path.join(ROOT, '.build', 'bundled', 'src');

// ─── Helpers ──────────────────────────────────────────────

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ─── esbuild plugin: fix __dirname paths for bundled modules ─
// When modules from src/modules/ are bundled into src/main.js,
// __dirname changes from src/modules/ to src/. This plugin adjusts
// known relative path patterns so they resolve correctly post-bundle.
const fixBundledPathsPlugin = {
  name: 'fix-bundled-paths',
  setup(build) {
    // localization.js: __dirname is src/modules/ → src/ after bundling
    // path.join(__dirname, '..', '..', 'langs') → path.join(__dirname, '..', 'langs')
    build.onLoad({ filter: /[/\\]localization\.js$/ }, async (args) => {
      let contents = fs.readFileSync(args.path, 'utf-8');
      contents = contents.replace(
        "path.join(__dirname, '..', '..', 'langs')",
        "path.join(__dirname, '..', 'langs')"
      );
      return { contents, loader: 'js' };
    });

    // timerDurations.js: dynamic require(path.join(...)) → static require
    build.onLoad({ filter: /[/\\]timerDurations\.js$/ }, async (args) => {
      let contents = fs.readFileSync(args.path, 'utf-8');
      contents = contents.replace(
        "require(path.join(__dirname, '..', 'data', 'timerDurations.json'))",
        "require('../data/timerDurations.json')"
      );
      return { contents, loader: 'js' };
    });

    // memoryScanner.js: __dirname path only used in dev mode (IS_PACKAGED=false),
    // but fix it anyway for consistency
    build.onLoad({ filter: /[/\\]memoryScanner\.js$/ }, async (args) => {
      let contents = fs.readFileSync(args.path, 'utf-8');
      contents = contents.replace(
        "path.join(__dirname, '..', '..', 'assets', 'bin', 'hostservice.exe')",
        "path.join(__dirname, '..', 'assets', 'bin', 'hostservice.exe')"
      );
      contents = contents.replace(
        "path.join(__dirname, '..', '..', '.build', 'bin', 'overkot-session-scanner')",
        "path.join(__dirname, '..', 'bin', 'overkot-session-scanner')"
      );
      return { contents, loader: 'js' };
    });
  }
};

// ─── Main ─────────────────────────────────────────────────

async function bundle({ outDir = OUT_DIR, channel = STABLE_CHANNEL, packageMetadata, titleCatalog = null } = {}) {
  if (![STABLE_CHANNEL, TITLE_TRACKER_BETA_CHANNEL].includes(channel)) throw new Error(`Unknown build channel: ${channel}`);
  titleCatalog = require('../src/modules/epithetsData').validateTitleCatalog(titleCatalog
    ?? require('./build-title-data').loadTitleCatalogSnapshot().catalog);
  // Validate the embedded catalogue before esbuild can inline it. A hand-edited
  // snapshot or a stale availability review must fail the local build too.
  const availabilityBytes = fs.readFileSync(path.join(__dirname, 'data/collection-availability.json'));
  const collectionCatalog = require('../src/modules/collectionCatalog').getCollectionCatalog();
  if (require('./overlay-feed/source').hash(availabilityBytes) !== collectionCatalog.source.availabilitySha256) {
    throw new Error('Regenerate the collection catalogue after changing its obtainable-item allowlist.');
  }
  require('./build-collection-data').validateCatalogAvailability(collectionCatalog, JSON.parse(availabilityBytes));
  outDir = path.resolve(outDir);
  const buildRoot = path.join(ROOT, '.build') + path.sep;
  if (!outDir.startsWith(buildRoot)) throw new Error('Bundle output must be inside App/.build');
  // Build the shared frontend from the tracked redesign branch on every build.
  // The desktop adapters live here; the market repository remains untouched.
  await require('./build-market-ui').buildMarketUi();
  const startTime = Date.now();
  console.log('[bundle] Starting esbuild bundling...');

  // Clean output directory
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });

  // 1. Bundle main process (main.js + all modules + node_modules → single file)
  const mainResult = await esbuild.build({
    entryPoints: [path.join(SRC_DIR, 'main.js')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: path.join(outDir, 'main.js'),
    external: ['electron'],
    define: { __OVERKOT_BUILD_CHANNEL__: JSON.stringify(channel),
      __OVERKOT_SERVICES__: JSON.stringify(require('../src/modules/serviceConfig').services),
      __OVERKOT_TITLE_CATALOG__: JSON.stringify(titleCatalog) },
    plugins: [fixBundledPathsPlugin, {
      name: 'runtime-package-metadata',
      setup(build) {
        // CURRENT_VERSION imports the source manifest. Use the staged metadata
        // for that import, so a local beta reports its actual prerelease version.
        build.onLoad({ filter: /[/\\]package\.json$/ }, args => {
          if (!packageMetadata || path.resolve(args.path) !== path.join(ROOT, 'package.json')) return null;
          return { contents: JSON.stringify(packageMetadata), loader: 'json' };
        });
      },
    }],
    treeShaking: true,
    minifySyntax: true,
    minifyWhitespace: true,
    minifyIdentifiers: true,
    metafile: true,
    logLevel: 'warning',
  });

  // 2. Bundle isolated overlay and market preloads (only depend on electron).
  for (const name of ['preload.js', 'market-preload.js', 'moonsteel-alert-preload.js']) await esbuild.build({
    entryPoints: [path.join(SRC_DIR, name)],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: path.join(outDir, name),
    external: ['electron'],
    treeShaking: true,
    minify: true,
    logLevel: 'warning',
  });
  fs.cpSync(path.join(ROOT, '.build', 'market-ui'), path.join(outDir, '..', 'market-ui'), { recursive: true });

  // 3. Minify browser scripts without renaming globals shared by script tags.
  const rendererSrc = path.join(SRC_DIR, 'renderer');
  if (fs.existsSync(rendererSrc)) {
    const rendererOut = path.join(outDir, 'renderer');
    copyDirSync(rendererSrc, rendererOut);
    for (const entry of fs.readdirSync(rendererOut, { withFileTypes: true })) {
      const extension = path.extname(entry.name);
      if (!entry.isFile() || !['.js', '.css'].includes(extension)) continue;
      const file = path.join(rendererOut, entry.name);
      const result = await esbuild.transform(fs.readFileSync(file, 'utf8'), {
        loader: extension.slice(1), target: 'chrome120',
        minifySyntax: true, minifyWhitespace: true, minifyIdentifiers: false,
      });
      fs.writeFileSync(file, result.code);
    }
  }

  // These browser-safe modules are shared by main-process validation and script
  // tags. Other Node modules remain bundled into main.js.
  for (const filename of ['trackerPreferences.js', 'tutorials.js', 'dungeonExploration.js', 'playerMarkerMotion.js', 'mapAppearance.js', 'appearance.js', 'widgetSizing.js', 'moonsteelAlertSettings.js', 'gameDataImages.js', 'overlayShortcuts.js']) {
    const source = path.join(SRC_DIR, 'modules', filename);
    const output = path.join(outDir, 'modules', filename);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const result = await esbuild.transform(fs.readFileSync(source, 'utf8'), {
      loader: 'js', target: 'chrome120', minifySyntax: true, minifyWhitespace: true, minifyIdentifiers: false,
    });
    fs.writeFileSync(output, result.code);
  }

  // Title data is embedded above so the tracker works on first launch offline.
  // Other game catalogues, calendars and map data use the overlay feed.

  // 5. Report sizes
  const mainSize = fs.statSync(path.join(outDir, 'main.js')).size;
  const preloadSize = fs.statSync(path.join(outDir, 'preload.js')).size;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`[bundle] main.js:    ${(mainSize / 1024).toFixed(1)} KB`);
  console.log(`[bundle] preload.js: ${(preloadSize / 1024).toFixed(1)} KB`);

  // Show what was bundled (top packages by size)
  if (mainResult.metafile) {
    const inputs = mainResult.metafile.inputs;
    const packageSizes = {};
    for (const [file, info] of Object.entries(inputs)) {
      const match = file.match(/node_modules[/\\](@[^/\\]+[/\\][^/\\]+|[^/\\]+)/);
      if (match) {
        const pkg = match[1];
        packageSizes[pkg] = (packageSizes[pkg] || 0) + info.bytes;
      }
    }
    const sorted = Object.entries(packageSizes).sort((a, b) => b[1] - a[1]);
    console.log('[bundle] Bundled packages (top 10):');
    for (const [pkg, size] of sorted.slice(0, 10)) {
      console.log(`         ${(size / 1024).toFixed(1)} KB  ${pkg}`);
    }
  }

  console.log(`[bundle] Done in ${elapsed}s`);
}

module.exports = { bundle };
if (require.main === module) bundle().catch(err => {
  console.error('[bundle] FATAL:', err.message);
  process.exit(1);
});
