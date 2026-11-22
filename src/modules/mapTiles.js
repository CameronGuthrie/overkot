const fs = require('node:fs');
const path = require('node:path');
const { LOCALES, POI_FILES } = require('./dataUpdates');

const CENTER_FIRST_TILES = Array.from({ length: 196 }, (_, index) => index).sort((a, b) => {
  const distance = index => Math.hypot(Math.floor(index / 14) - 6.5, index % 14 - 6.5);
  return distance(a) - distance(b) || a - b;
});

// Preserve old ZIP caches as a fallback; new releases use individual hashed tiles.
class MapTileManager {
  constructor({ app, bundledTilesDir, dataManager, log = () => {} }) {
    this.app = app;
    this.bundledTilesDir = bundledTilesDir;
    this.dataManager = dataManager;
    this.log = log;
    this.legacyDir = null;
    this.warmupPromise = null;
    this.warmed = new Set();
    this.warmedVersion = null;
    this.warmupStopped = false;
  }

  async initialize() {
    try {
      const root = path.join(this.app.getPath('userData'), 'map-tiles');
      const meta = JSON.parse(await fs.promises.readFile(path.join(root, 'current.json'), 'utf8'));
      if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(meta.version || '')) {
        this.legacyDir = path.join(root, 'versions', meta.version);
      }
    } catch {}
    return this.getInfo();
  }

  getInfo() { return this.dataManager.getInfo(); }

  async getTilePath(tileName) {
    if (!/^(?:0|[1-9]\d{0,2})\.webp$/.test(tileName) || parseInt(tileName, 10) >= 196) return null;
    const key = `map-tiles/${tileName}`;
    const filename = await this.dataManager.ensureAsset(key);
    if (filename && filename !== this.dataManager.bundledPath(key)) return filename;
    if (this.legacyDir && !this.dataManager.manifest) {
      const legacy = path.join(this.legacyDir, tileName);
      if (fs.existsSync(legacy)) return legacy;
    }
    return filename || null;
  }

  checkForUpdates(options) { return this.dataManager.checkForUpdates(options); }

  // One background request at a time leaves the other slots for visible assets.
  warmCache({ language = 'en' } = {}) {
    if (this.warmupPromise) return this.warmupPromise;
    const manifest = this.dataManager.manifest;
    if (this.warmedVersion !== manifest?.version) {
      this.warmed.clear();
      this.warmedVersion = manifest?.version;
    }
    const locale = LOCALES.includes(language) ? language : 'en';
    const cacheKey = `${manifest?.version}:${locale}`;
    if (this.warmupStopped || !manifest || this.warmed.has(cacheKey)) {
      return Promise.resolve({ complete: this.warmed.has(cacheKey), updated: false, cached: 0, failed: [] });
    }
    const keys = [
      ...Object.keys(manifest.files).filter(key => key.startsWith('map-icons/')).sort(),
      ...POI_FILES.map(name => `map-json/${name}.json`),
      `locations/${locale}.json`,
      ...CENTER_FIRST_TILES.map(index => `map-tiles/${index}.webp`),
      ...Object.keys(manifest.files).filter(key => key.startsWith('temper-icons/')).sort(),
    ].filter(key => manifest.files[key]);
    this.warmupPromise = (async () => {
      let cached = 0, updated = false, consecutiveFailures = 0;
      const failed = [];
      for (const key of keys) {
        if (this.warmupStopped) break;
        const previousHash = this.dataManager.state.files[key]?.sha256;
        const wasCurrent = this.dataManager.isCurrentAsset(key, this.dataManager.cachedPath(key));
        try {
          const filename = await this.dataManager.ensureAsset(key);
          if (!this.dataManager.isCurrentAsset(key, filename)) throw new Error('Current asset unavailable');
          cached++;
          updated ||= !wasCurrent || previousHash !== this.dataManager.state.files[key]?.sha256;
          consecutiveFailures = 0;
        } catch {
          failed.push(key);
          // An offline launch must not fan out into hundreds of timed-out requests.
          if (++consecutiveFailures >= 3) break;
        }
      }
      const complete = cached === keys.length && this.dataManager.manifest?.version === manifest.version;
      if (complete) this.warmed.add(cacheKey);
      if (failed.length) this.log(`Map cache warmup paused after ${failed.length} unavailable asset(s)`);
      return { complete, updated, cached, failed };
    })().finally(() => { this.warmupPromise = null; });
    return this.warmupPromise;
  }

  stopWarmup() { this.warmupStopped = true; }
}

module.exports = { MapTileManager };
