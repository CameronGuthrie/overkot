'use strict';

// The app only reads this feed. AWS credentials and source imports belong to
// local authoring tools and are never used by the installed application.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const axios = require('axios');

const { services } = require('./serviceConfig');
const FEED_URL = services.epithets || (services.dataOrigin && `${services.dataOrigin}/protected/files/epithets.json`);
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const MAX_BYTES = 1024 * 1024;
const MAX_TITLES = 1024;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit = 200) => typeof value === 'string' && value.length > 0 && value.length <= limit;
const titleId = value => text(value) && /^FlavourItems\.[A-Za-z0-9_]+$/.test(value);
const itemPath = value => text(value) && /^\/SF\/Types\/Items\/Titles\/[A-Za-z0-9_]+$/.test(value);
const challengeName = value => text(value) && /^[A-Za-z0-9_]+$/.test(value);
const challengePath = value => text(value) && /^\/SF\/Types\/Challenges\/Titles\/[A-Za-z0-9_]+$/.test(value);
const target = value => Number.isSafeInteger(value) && value > 0;

function validTitleCatalog(value) {
  return plain(value) && value.schema === 1 && Array.isArray(value.titles)
    && value.titles.length > 0 && value.titles.length <= MAX_TITLES
    && new Set(value.titles.map(row => row?.id)).size === value.titles.length
    && new Set(value.titles.map(row => row?.itemType)).size === value.titles.length
    && value.titles.every(row => plain(row) && titleId(row.id) && text(row.name)
      && typeof row.description === 'string' && row.description.length <= 4000
      && itemPath(row.itemType) && challengeName(row.challengeName) && challengePath(row.challengePath)
      && row.challengePath.split('/').pop() === row.challengeName
      && (row.legacyName === null || challengeName(row.legacyName)) && target(row.target));
}

/** Reduce the S3 pipeline's epithets.json to the fields needed by the widget. */
function projectEpithets(value) {
  if (!plain(value) || !Object.keys(value).length || Object.keys(value).length > MAX_TITLES) {
    throw new Error('Invalid epithets data');
  }
  const titles = [];
  for (const [id, row] of Object.entries(value)) {
    if (!titleId(id) || !plain(row) || row.internalId !== id || !itemPath(row.itemType)
      || row.itemType.split('/').pop() !== id.slice('FlavourItems.'.length) || !text(row.value)
      || !plain(row.challenge) || typeof row.challenge.enabled !== 'boolean') throw new Error('Invalid epithet entry');
    const challenge = row.challenge;
    // Disabled, unreleased challenges must not look like attainable progress.
    if (!challenge.enabled) continue;
    if (!challengeName(challenge.name) || !challengePath(challenge.path)
      || challenge.path.split('/').pop() !== challenge.name
      || (challenge.legacyName != null && !challengeName(challenge.legacyName))
      || !target(challenge.requiredCount) || typeof challenge.text !== 'string' || challenge.text.length > 4000) {
      throw new Error('Invalid epithet challenge');
    }
    titles.push({ id, name: row.value.trim(), description: challenge.text.trim(), itemType: row.itemType,
      challengeName: challenge.name, challengePath: challenge.path, legacyName: challenge.legacyName ?? null,
      target: challenge.requiredCount });
  }
  const catalog = { schema: 1, titles };
  if (!validTitleCatalog(catalog)) throw new Error('Invalid title catalog');
  return catalog;
}

function validateTitleCatalog(value) {
  const catalog = value?.schema === 1 ? value : projectEpithets(value);
  if (!validTitleCatalog(catalog)) throw new Error('Invalid title catalog');
  // Copy only validated fields, so raw source fields cannot reach the renderer.
  return { schema: 1, titles: catalog.titles.map(row => ({ id: row.id, name: row.name,
    description: row.description, itemType: row.itemType, challengeName: row.challengeName,
    challengePath: row.challengePath, legacyName: row.legacyName, target: row.target })) };
}

// Every packaged build injects a verified compact snapshot. Source development
// uses the checked-in snapshot, so opening the widget never needs AWS access.
function getBundledTitleCatalog() {
  const value = typeof __OVERKOT_TITLE_CATALOG__ === 'undefined' ? require('../data/title-catalog.json') : __OVERKOT_TITLE_CATALOG__;
  return value == null ? null : validateTitleCatalog(value);
}

class EpithetsData {
  constructor({ cacheDir, rootDir = cacheDir, bundledData = null, url = FEED_URL, http = axios, now = Date.now, log = () => {} }) {
    const parsed = url ? new URL(url) : null;
    if (parsed && (parsed.username || parsed.password || (parsed.protocol !== 'https:'
      && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))))) {
      throw new Error('Epithets feed requires HTTPS (or localhost for testing)');
    }
    this.url = parsed?.href || ''; this.http = http; this.now = now; this.log = log;
    this.filename = path.join(rootDir, 'epithets.json');
    this.data = bundledData == null ? null : validateTitleCatalog(bundledData);
    this.state = { url: this.url, nextCheck: 0, etag: null, data: null, sha256: null };
    this.pending = null;
    try {
      const stat = fs.statSync(this.filename);
      if (stat.size > MAX_BYTES) throw new Error('Epithets cache too large');
      const saved = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
      if (saved.url === this.url && saved.data && /^[a-f0-9]{64}$/.test(saved.sha256)
        && hash(saved.data) === saved.sha256) {
        this.data = validateTitleCatalog(saved.data);
        this.state = { ...this.state, data: this.data, sha256: hash(this.data),
          etag: typeof saved.etag === 'string' && saved.etag.length <= 1024 ? saved.etag : null,
          nextCheck: Math.min(Number(saved.nextCheck) || 0, now() + CHECK_INTERVAL) };
      } else if (saved.url === this.url && saved.data === null) {
        this.state.nextCheck = Math.min(Number(saved.nextCheck) || 0, now() + CHECK_INTERVAL);
      }
    } catch { /* First launch or invalid cache: keep the bundled snapshot. */ }
  }
  initialize() { return Promise.resolve(this.getCatalog()); }
  getCatalog() { return this.data; }
  refresh({ force = false } = {}) {
    if (!this.url) return Promise.resolve(false);
    if (this.pending) return this.pending;
    if (!force && this.now() < this.state.nextCheck) return Promise.resolve(false);
    this.pending = this.check().finally(() => { this.pending = null; });
    return this.pending;
  }
  async check() {
    let changed = false;
    try {
      const response = await this.http.get(this.url, { timeout: 15000, maxRedirects: 0,
        maxContentLength: MAX_BYTES, responseType: 'arraybuffer',
        headers: this.state.etag && this.state.data ? { 'If-None-Match': this.state.etag } : {},
        validateStatus: status => status === 200 || status === 304 });
      if (response.status === 304) {
        if (!this.state.data) throw new Error('Epithets response has no cached catalog');
      } else if (response.status === 200) {
        const bytes = Buffer.from(response.data);
        if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('Epithets download too large');
        const data = validateTitleCatalog(JSON.parse(bytes.toString('utf8')));
        changed = JSON.stringify(data) !== JSON.stringify(this.data);
        this.data = data;
        this.state.data = data;
        this.state.sha256 = hash(data);
        this.state.etag = typeof response.headers?.etag === 'string' && response.headers.etag.length <= 1024
          ? response.headers.etag : null;
      } else throw new Error('Unexpected epithets response');
    } catch (error) {
      this.log(`Epithets update unavailable; retaining the last catalog: ${error.message}`);
    }
    this.state.nextCheck = this.now() + CHECK_INTERVAL;
    try {
      await fs.promises.mkdir(path.dirname(this.filename), { recursive: true });
      const temp = `${this.filename}.${process.pid}.tmp`;
      await fs.promises.writeFile(temp, JSON.stringify(this.state));
      await fs.promises.rename(temp, this.filename);
    } catch (error) { this.log(`Epithets cache could not be saved: ${error.message}`); }
    return changed;
  }
}

module.exports = { EpithetsData, FEED_URL, CHECK_INTERVAL, MAX_BYTES, projectEpithets,
  validTitleCatalog, validateTitleCatalog, getBundledTitleCatalog };
