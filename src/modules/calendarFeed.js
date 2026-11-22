'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { brotliDecompress } = require('node:zlib');
const { promisify } = require('node:util');
const axios = require('axios');
const { validateCalendar } = require('./calendarData');

const unzip = promisify(brotliDecompress);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const FEED_URL = require('./serviceConfig').services.calendarManifest;
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const LIMIT = 1024 * 1024;

function validateManifest(value) {
  if (!value || value.schema !== 1 || !/^[a-f0-9]{64}$/.test(value.sha256)
      || !/^objects\/[a-f0-9]{64}\.json\.br$/.test(value.url)
      || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > LIMIT
      || !Number.isSafeInteger(value.downloadBytes) || value.downloadBytes < 1 || value.downloadBytes > LIMIT) throw new Error('Invalid calendar manifest');
  return value;
}

class CalendarFeed {
  constructor({ cacheDir, bundledData = null, getDataManager, url = FEED_URL, http = axios, now = Date.now, log = () => {} }) {
    const parsed = url ? new URL(url) : null;
    if (parsed && parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))) throw new Error('Calendar feed requires HTTPS');
    this.url = url; this.http = http; this.now = now; this.log = log;
    this.filename = path.join(cacheDir, 'calendar.json');
    this.data = bundledData ? validateCalendar(bundledData) : null;
    this.getDataManager = getDataManager;
    this.state = { nextCheck: 0, etag: null, data: null, sha256: null, url };
    this.pending = null;
    try {
      const saved = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
      if (saved.url === url && saved.data && hash(JSON.stringify(saved.data)) === saved.sha256) {
        this.data = validateCalendar(saved.data);
        this.state = { ...this.state, ...saved, nextCheck: Math.min(Number(saved.nextCheck) || 0, now() + CHECK_INTERVAL) };
      } else if (saved.url === url && !saved.data) {
        this.state.nextCheck = Math.min(Number(saved.nextCheck) || 0, now() + CHECK_INTERVAL);
      }
    } catch { /* Downloaded cache is optional on first launch. */ }
  }
  refresh() {
    if (this.pending) return this.pending;
    if (this.getDataManager) {
      this.pending = this.refreshFromManager().finally(() => { this.pending = null; });
      return this.pending;
    }
    if (!this.url || this.now() < this.state.nextCheck) return Promise.resolve(false);
    this.pending = this.check().finally(() => { this.pending = null; });
    return this.pending;
  }
  async refreshFromManager() {
    try {
      const manager = this.getDataManager();
      await manager.checkForUpdates();
      await manager.ensureAsset('calendar/calendar.json');
      const next = manager.readJSON('calendar/calendar.json');
      if (!next) return false;
      validateCalendar(next);
      const changed = JSON.stringify(next) !== JSON.stringify(this.data);
      this.data = next;
      return changed;
    } catch (error) { this.log(`Calendar update unavailable: ${error.message}`); return false; }
  }
  async check() {
    let changed = false;
    try {
      const response = await this.http.get(this.url, {
        timeout: 10000, maxRedirects: 0, maxContentLength: 4096,
        headers: this.state.etag ? { 'If-None-Match': this.state.etag } : {},
        validateStatus: status => status === 200 || status === 304,
      });
      if (response.status !== 304) {
        const manifest = validateManifest(response.data);
        if (hash(JSON.stringify(this.data)) !== manifest.sha256) {
          const download = await this.http.get(new URL(manifest.url, this.url).href, {
            timeout: 15000, maxRedirects: 0, responseType: 'arraybuffer',
            maxContentLength: manifest.downloadBytes, decompress: false, headers: { 'Accept-Encoding': 'identity' },
          });
          const wire = Buffer.from(download.data);
          if (wire.length !== manifest.downloadBytes || hash(wire) !== manifest.url.slice(8, 72)) throw new Error('Calendar download hash mismatch');
          const bytes = await unzip(wire, { maxOutputLength: manifest.bytes });
          if (bytes.length !== manifest.bytes || hash(bytes) !== manifest.sha256) throw new Error('Calendar content hash mismatch');
          const data = validateCalendar(JSON.parse(bytes.toString('utf8')));
          this.data = data;
          changed = true;
        }
        this.state.etag = response.headers?.etag || null;
        this.state.data = this.data;
        this.state.sha256 = hash(JSON.stringify(this.data));
      }
      this.state.nextCheck = this.now() + CHECK_INTERVAL;
    } catch (error) {
      // No deployed feed, offline, corrupt downloads: retain the last good copy.
      this.state.nextCheck = this.now() + CHECK_INTERVAL;
      this.log(`Calendar update unavailable; using local calendar: ${error.message}`);
    }
    try {
      await fs.promises.mkdir(path.dirname(this.filename), { recursive: true });
      const temp = `${this.filename}.${process.pid}.tmp`;
      await fs.promises.writeFile(temp, JSON.stringify(this.state));
      await fs.promises.rename(temp, this.filename);
    } catch (error) { this.log(`Calendar cache could not be saved: ${error.message}`); }
    return changed;
  }
}

module.exports = { CalendarFeed, FEED_URL, CHECK_INTERVAL, validateManifest };
