// Static, content-addressed game data. Network access stays in the main process.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { brotliDecompress } = require('node:zlib');
const axios = require('axios');

const decompress = promisify(brotliDecompress);
const { services } = require('./serviceConfig');
const { isTemperIconKey } = require('./gameDataImages');
const { validTemperCatalog } = require('./catalogData');
const MANIFEST_URL = services.dataOrigin && `${services.dataOrigin}/protected/overlay/v2/manifest.json`;
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const POI_FILES = ['faction_enclaves', 'world_trees', 'avakot_spawns', 'sap_trees',
  'vadagar_pools', 'ode_organs', 'boss_encounters', 'named_locations', 'dungeon_entrances'];
const { SUPPORTED_LOCALES: LOCALES } = require('./gameLocales');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const validHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const storedObject = entry => entry.local || entry;
const validKey = (key) => /^map-tiles\/(?:0|[1-9]\d?)\.webp$/.test(key)
  || /^map-tiles\/1(?:[0-8]\d|9[0-5])\.webp$/.test(key)
  || POI_FILES.some(name => key === `map-json/${name}.json`)
  || LOCALES.some(locale => key === `names/${locale}.json` || key === `locations/${locale}.json`)
  || LOCALES.some(locale => key === `tempers/${locale}.json`)
  || LOCALES.some(locale => key === `wolf-training/${locale}.json`)
  || key === 'dungeons/index.json'
  || /^dungeons\/[A-Za-z0-9_-]{1,80}\/(?:rooms|layouts)\.json$/.test(key)
  || isTemperIconKey(key)
  || /^map-icons\/(?:AlcasChildrenFactionIcon|ChampionFaction|SilentRoseFactionIcon|EntranceDown|MapLocationComplete|Tree|Pickup|Vendor|Stag|Tower|SubBossBarTopper)\.png$/.test(key)
  || key === 'build-export/catalog.json' || key === 'calendar/calendar.json'
  || key === 'timers/durations.json';

function validateEntry(key, entry) {
  if (!validKey(key) || !entry || !validHash(entry.sha256)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > MAX_FILE_BYTES
      || !Number.isSafeInteger(entry.downloadBytes) || entry.downloadBytes < 1 || entry.downloadBytes > MAX_FILE_BYTES
      || !['identity', 'br'].includes(entry.encoding)
      || (/\.(webp|png)$/.test(key) ? entry.url !== `objects/${entry.sha256}.${key.split('.').pop()}`
        : typeof entry.url !== 'string' || !/^objects\/[a-f0-9]{64}\.json\.br$/.test(entry.url))
      || entry.encoding !== (/\.(webp|png)$/.test(key) ? 'identity' : 'br') || entry.local !== undefined) {
    throw new Error(`Invalid data entry: ${key}`);
  }
  return entry;
}

function installedEntry(key, entry) {
  if (entry?.local === undefined) return validateEntry(key, entry);
  const { local, ...source } = entry;
  validateEntry(key, source);
  // A damaged thumbnail descriptor affects only this asset. Fall back to
  // verifying its source so that another locale or map remains usable.
  if (!isTemperIconKey(key) || !validHash(local?.sha256) || local.sha256 === source.sha256
      || !Number.isSafeInteger(local.bytes) || local.bytes < pngSignature.length || local.bytes >= source.bytes) return source;
  return { ...source, local: { sha256: local.sha256, bytes: local.bytes } };
}

function validateManifest(manifest) {
  if (!manifest || ![1, 2].includes(manifest.schema) || !validHash(manifest.version)
      || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)
      || Object.keys(manifest.files).length > 512) throw new Error('Unsupported data manifest');
  for (const [key, entry] of Object.entries(manifest.files)) validateEntry(key, entry);
  // A tile release must remain compatible with the renderer's 14 x 14 map.
  for (let i = 0; i < 196; i++) {
    if (!manifest.files[`map-tiles/${i}.webp`]) throw new Error(`Missing tile ${i}`);
  }
  return manifest;
}

async function atomicJSON(filename, value) {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  const temp = `${filename}.${process.pid}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(value));
  await fsp.rename(temp, filename);
}

class DataUpdateManager {
  constructor({ rootDir, bundledRoot, allowBundled = false, manifestUrl = MANIFEST_URL, http = axios,
    now = Date.now, log = () => {}, compactTemperIcon = null }) {
    const url = manifestUrl ? new URL(manifestUrl) : null;
    if (url && url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
      throw new Error('Data feed requires HTTPS (or localhost for testing)');
    }
    this.rootDir = rootDir;
    this.bundledRoot = bundledRoot;
    this.allowBundled = allowBundled;
    this.manifestUrl = url?.href || '';
    this.http = http;
    this.now = now;
    this.log = log;
    this.compactTemperIcon = compactTemperIcon;
    this.manifest = null;
    this.state = { url: this.manifestUrl, files: {} };
    this.verified = new Map();
    this.pending = new Map();
    this.sources = new Map();
    this.keepOriginal = new Set();
    this.retryAfter = new Map();
    this.matches = new Map();
    this.active = 0;
    this.waiters = [];
    this.writePromise = Promise.resolve();
    this.installWrites = Promise.resolve();
    this.initializing = null;
    this.checkPromise = null;
    this.missingObjectCheckAfter = 0;
  }

  initialize() {
    if (!this.initializing) {
      this.initializing = this.initializeCache().finally(() => { this.initializing = null; });
    }
    return this.initializing;
  }

  async initializeCache() {
    await fsp.mkdir(path.join(this.rootDir, 'objects'), { recursive: true });
    try {
      const state = JSON.parse(await fsp.readFile(path.join(this.rootDir, 'state.json'), 'utf8'));
      const migrate = MANIFEST_URL && [`${services.dataOrigin}/overlay/v1/manifest.json`, MANIFEST_URL.replace('/protected/', '/')].includes(state.url)
        && this.manifestUrl === MANIFEST_URL;
      if ((state.url === this.manifestUrl || migrate) && state.files && typeof state.files === 'object') {
        for (const [key, entry] of Object.entries(state.files)) state.files[key] = installedEntry(key, entry);
        if (state.manifest) validateManifest(state.manifest);
        if (migrate) {
          // Keep already verified maps usable offline across the feed upgrade.
          // The new endpoint must get its own first unconditional manifest read.
          state.url = this.manifestUrl;
          delete state.etag;
          delete state.nextCheck;
        }
        this.state = state;
        this.manifest = state.manifest || null;
        if (migrate) await atomicJSON(path.join(this.rootDir, 'state.json'), state);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.log(`Ignoring invalid data cache: ${error.message}`);
    }
    // A crash or superseded request can leave an unreferenced object. Only
    // unlink known generated filenames inside our cache, before downloads start.
    if (this.pending.size || this.checkPromise) return this.getInfo();
    await this.retireUnusedTemperIcons();
    const referenced = new Set(Object.values(this.state.files).map(entry => storedObject(entry).sha256));
    const objectsDir = path.join(this.rootDir, 'objects');
    for (const entry of await fsp.readdir(objectsDir, { withFileTypes: true })) {
      if (entry.isFile() && (/^[a-f0-9]{64}\.[a-f0-9]{12}\.tmp$/.test(entry.name)
          || (validHash(entry.name) && !referenced.has(entry.name)))) {
        await fsp.unlink(path.join(objectsDir, entry.name)).catch(() => {});
      }
    }
    return this.getInfo();
  }

  async retireUnusedTemperIcons() {
    if (!this.manifest) return;
    const retired = new Set(Object.keys(this.state.files).filter(key => isTemperIconKey(key) && !this.manifest.files[key]));
    if (!retired.size) return;
    // An offline locale can still refer to an older icon after a feed rotation.
    // Require at least one installed current catalogue and verify all saved locales.
    let hasCurrentCatalog = false;
    for (const [key, entry] of Object.entries(this.state.files)) {
      if (!key.startsWith('tempers/')) continue;
      const catalog = this.readJSON(key);
      if (!validTemperCatalog(catalog) || !catalog.tempers.every(row => isTemperIconKey(row.icon))) return;
      for (const row of catalog.tempers) retired.delete(row.icon);
      if (this.manifest.files[key]?.sha256 === entry.sha256) hasCurrentCatalog = true;
    }
    if (!hasCurrentCatalog || !retired.size) return;
    const files = { ...this.state.files };
    for (const key of retired) delete files[key];
    await atomicJSON(path.join(this.rootDir, 'state.json'), { ...this.state, files });
    this.state.files = files;
  }

  getInfo() {
    return { version: this.manifest?.version || null, source: this.manifest ? 'remote' : 'unavailable', tileCount: 196,
      unavailable: this.manifest?.unavailable || {}, warnings: this.manifest?.warnings || {} };
  }

  objectPath(entry) {
    return path.join(this.rootDir, 'objects', entry.sha256);
  }

  bundledPath(key) {
    if (!this.allowBundled || !this.bundledRoot) return null;
    if (!validKey(key)) return null;
    if (key.startsWith('map-')) return path.join(this.bundledRoot, 'assets', ...key.split('/'));
    if (key === 'timers/durations.json') return path.join(this.bundledRoot, 'src', 'data', 'timerDurations.json');
    return null;
  }

  verifiedPath(entry) {
    const filename = this.objectPath(entry);
    try {
      const stat = fs.statSync(filename);
      if (stat.size !== entry.bytes) return null;
      const signature = `${stat.size}:${stat.mtimeMs}`;
      if (this.verified.get(filename) === signature) return filename;
      if (hash(fs.readFileSync(filename)) === entry.sha256) {
        this.verified.set(filename, signature);
        return filename;
      }
    } catch {}
    return null;
  }

  cachedPath(key) {
    if (!validKey(key)) return null;
    const entry = this.state.files[key];
    const cached = entry && this.verifiedPath(storedObject(entry));
    if (cached) return cached;
    const bundled = this.bundledPath(key);
    return bundled && fs.existsSync(bundled) ? bundled : null;
  }

  readJSON(key) {
    try {
      const filename = this.cachedPath(key);
      return filename ? JSON.parse(fs.readFileSync(filename, 'utf8')) : null;
    } catch { return null; }
  }

  isCurrentAsset(key, filename) {
    const expected = this.manifest?.files[key]?.sha256;
    if (!filename || !expected) return false;
    const current = this.state.files[key];
    if (current?.sha256 === expected && filename === this.objectPath(storedObject(current))) return true;
    if (filename !== this.bundledPath(key)) return false;
    try {
      const stat = fs.statSync(filename);
      return this.matches.get(key) === `${filename}:${stat.size}:${stat.mtimeMs}:${expected}`;
    } catch { return false; }
  }

  persist() {
    // Capture at execution time so concurrent asset finishes cannot overwrite newer state.
    this.writePromise = this.writePromise.catch(() => {}).then(() => atomicJSON(path.join(this.rootDir, 'state.json'), this.state));
    return this.writePromise;
  }

  checkForUpdates({ force = false } = {}) {
    if (this.initializing) return this.initializing.then(() => this.checkForUpdates({ force }));
    if (!this.manifestUrl) return Promise.resolve({ updated: false, info: this.getInfo() });
    if (this.checkPromise) return this.checkPromise;
    if (!force && Number.isFinite(this.state.nextCheck) && this.now() < this.state.nextCheck
        && this.state.nextCheck <= this.now() + CHECK_INTERVAL * 1.2) {
      return Promise.resolve({ updated: false, info: this.getInfo() });
    }
    this.checkPromise = this.fetchManifest().finally(() => { this.checkPromise = null; });
    return this.checkPromise;
  }

  async fetchManifest() {
    try {
      const headers = { Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate, br' };
      if (this.manifest && this.state.etag) headers['If-None-Match'] = this.state.etag;
      if (this.manifest && this.state.lastModified) headers['If-Modified-Since'] = this.state.lastModified;
      const response = await this.http.get(this.manifestUrl, {
        // A cold feed instance must read and project the published catalogues.
        headers, responseType: 'json', timeout: 30000, maxContentLength: 1024 * 1024,
        maxRedirects: 0, validateStatus: status => status === 200 || status === 304,
      });
      const previousVersion = this.manifest?.version;
      if (response.status !== 304) {
        const next = validateManifest(response.data);
        this.manifest = next;
        this.state.manifest = next;
        this.state.etag = response.headers?.etag;
        this.state.lastModified = response.headers?.['last-modified'];
      } else if (!this.manifest) throw new Error('304 without a cached manifest');
      this.state.failures = 0;
      this.state.nextCheck = this.now() + CHECK_INTERVAL;
      await this.persist();
      return { updated: previousVersion !== this.manifest?.version, info: this.getInfo() };
    } catch (error) {
      this.state.failures = Math.min((this.state.failures || 0) + 1, 6);
      this.state.nextCheck = this.now() + Math.min(CHECK_INTERVAL, 15 * 60 * 1000 * 2 ** (this.state.failures - 1));
      await this.persist().catch(() => {});
      this.log(`Data check failed; keeping local data: ${error.message}`);
      return { updated: false, error: error.message, info: this.getInfo() };
    }
  }

  async refreshCachedAssets(extraKeys = []) {
    // A manual check retries failed requests and refreshes assets already used
    // by this installation. Unseen map tiles stay on demand.
    const failedKeys = [...this.retryAfter.keys()].map(key => key.split(':')[0]);
    const keys = [...new Set([
      ...[...Object.keys(this.state.files), ...failedKeys].filter(key => this.manifest?.files[key]),
      ...extraKeys,
    ])];
    this.retryAfter.clear();
    const before = new Map(keys.map(key => [key, this.state.files[key]?.sha256]));
    const paths = await Promise.all(keys.map(key => this.ensureAsset(key)));
    const failed = keys.filter((key, i) => !this.isCurrentAsset(key, paths[i]));
    return { failed, updated: keys.some(key => !failed.includes(key) && before.get(key) !== this.state.files[key]?.sha256) };
  }

  ensureAsset(key) {
    if (this.initializing) return this.initializing.then(() => this.ensureAsset(key));
    if (!validKey(key)) return Promise.reject(new Error('Unknown data asset'));
    const entry = this.manifest?.files[key];
    if (!entry) return Promise.resolve(this.cachedPath(key));
    const requestKey = `${key}:${entry.sha256}`;
    if ((this.retryAfter.get(requestKey) || 0) > this.now()) return Promise.resolve(this.cachedPath(key));
    if (this.pending.has(requestKey)) return this.pending.get(requestKey);
    const task = this.installAsset(key, entry).catch(async error => {
      // A client can still hold an older manifest when a new Lambda build goes
      // live. Refresh once, shared across concurrent missing-object requests.
      if (error.response?.status === 404) {
        if (this.now() >= this.missingObjectCheckAfter) {
          this.missingObjectCheckAfter = this.now() + 60000;
          await this.checkForUpdates({ force: true });
        } else if (this.checkPromise) await this.checkPromise;
        const latest = this.manifest?.files[key];
        if (latest && latest.sha256 !== entry.sha256) {
          try { return await this.installAsset(key, latest); } catch {}
        }
      }
      this.retryAfter.set(requestKey, this.now() + 15 * 60 * 1000);
      this.log(`Keeping local ${key}: ${error.message}`);
      return this.cachedPath(key);
    }).finally(() => this.pending.delete(requestKey));
    this.pending.set(requestKey, task);
    return task;
  }

  async readSource(key, entry) {
    // The local source may already exist under a different logical key or
    // have been installed by an older client without thumbnail support.
    try {
      const bytes = await fsp.readFile(this.objectPath(entry));
      if (bytes.length === entry.bytes && hash(bytes) === entry.sha256) return bytes;
    } catch {}
    const response = await this.http.get(new URL(entry.url, this.manifestUrl).href, {
      responseType: 'arraybuffer', timeout: 30000, maxRedirects: 0,
      maxContentLength: entry.downloadBytes, decompress: false,
      headers: { 'Accept-Encoding': 'identity' },
    });
    const wire = Buffer.from(response.data);
    if (wire.length !== entry.downloadBytes) throw new Error('Download size mismatch');
    if (hash(wire) !== entry.url.slice('objects/'.length, 'objects/'.length + 64)) throw new Error('Download hash mismatch');
    const bytes = entry.encoding === 'br' ? await decompress(wire, { maxOutputLength: entry.bytes }) : wire;
    if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error('Content hash mismatch');
    if (key.endsWith('.json')) JSON.parse(bytes.toString('utf8'));
    return bytes;
  }

  async compactSource(bytes, entry) {
    try {
      if (bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
        const png = await this.compactTemperIcon(bytes);
        if (Buffer.isBuffer(png) && png.length < bytes.length && png.subarray(0, pngSignature.length).equals(pngSignature)) {
          return png;
        }
      }
    } catch (error) { this.log(`Keeping original temper icon: ${error.message}`); }
    this.keepOriginal.add(entry.sha256);
    return bytes;
  }

  async installAsset(key, entry) {
    const compact = this.compactTemperIcon && isTemperIconKey(key) && !this.keepOriginal.has(entry.sha256);
    const current = this.state.files[key];
    if (current?.sha256 === entry.sha256 && (current.local || !compact)) {
      const cached = this.verifiedPath(storedObject(current));
      if (cached) return cached;
    }
    const bundled = this.bundledPath(key);
    if (bundled) {
      let stat;
      try { stat = await fsp.stat(bundled); } catch {}
      if (stat?.size === entry.bytes) {
        const signature = `${bundled}:${stat.size}:${stat.mtimeMs}:${entry.sha256}`;
        if (this.matches.get(key) !== signature && hash(await fsp.readFile(bundled)) === entry.sha256) {
          this.matches.set(key, signature);
        }
        if (this.matches.get(key) === signature) {
          if (this.manifest?.files[key]?.sha256 !== entry.sha256) return this.cachedPath(key);
          if (this.state.files[key]) {
            delete this.state.files[key];
            await this.persist();
          }
          return bundled;
        }
      }
    }

    if (this.active >= 3) await new Promise(resolve => this.waiters.push(resolve));
    else this.active++;
    const sourceId = `${entry.sha256}:${entry.bytes}:${entry.url}:${entry.downloadBytes}`;
    let source = this.sources.get(sourceId);
    if (!source) {
      source = { bytes: this.readSource(key, entry), users: 0 };
      this.sources.set(sourceId, source);
    }
    source.users++;
    try {
      const bytes = await source.bytes;
      if (compact) source.thumbnail ||= this.compactSource(bytes, entry);
      const output = compact ? await source.thumbnail : bytes;
      const installed = output === bytes ? entry : { ...entry, local: { sha256: hash(output), bytes: output.length } };
      // Serialize disk commits and retirement. Another key sharing this content
      // can recreate its raw or compact object from the verified bytes it holds.
      const commit = this.installWrites.then(() => this.commitObject(key, installed, output));
      this.installWrites = commit.catch(() => {});
      return await commit;
    } finally {
      if (--source.users === 0) this.sources.delete(sourceId);
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }

  async commitObject(key, installed, bytes) {
    if (this.manifest?.files[key]?.sha256 !== installed.sha256) return this.cachedPath(key);
    const object = storedObject(installed);
    const filename = this.objectPath(object);
    if (!this.verifiedPath(object)) {
      const temp = `${filename}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      try {
        await fsp.writeFile(temp, bytes);
        await fsp.rename(temp, filename);
        this.verified.delete(filename);
      } finally { await fsp.unlink(temp).catch(() => {}); }
    }
    if (this.manifest?.files[key]?.sha256 !== installed.sha256) return this.cachedPath(key);
    const previous = this.state.files[key];
    if (previous?.sha256 === installed.sha256 && storedObject(previous).sha256 === object.sha256) return filename;
    this.state.files[key] = installed;
    try { await this.persist(); }
    catch (error) {
      if (previous) this.state.files[key] = previous;
      else delete this.state.files[key];
      throw error;
    }
    const retired = new Set();
    if (previous) retired.add(storedObject(previous).sha256);
    if (installed.local) retired.add(installed.sha256);
    retired.delete(object.sha256);
    for (const sha256 of retired) {
      if (Object.values(this.state.files).some(item => storedObject(item).sha256 === sha256)) continue;
      const oldFile = this.objectPath({ sha256 });
      await fsp.unlink(oldFile).catch(() => {});
      this.verified.delete(oldFile);
    }
    return filename;
  }
}

module.exports = { DataUpdateManager, MANIFEST_URL, CHECK_INTERVAL, POI_FILES, LOCALES, validateManifest };
