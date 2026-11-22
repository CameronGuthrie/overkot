'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');
const URL = 'https://api.soulframe.com/cdn/worldState.php';
const DAY_MS = 86400000;
const RETRY_MS = 3600000;

function serverTime(response) {
  const time = response.data?.Time;
  const date = Date.parse(response.headers?.date);
  const age = Number(response.headers?.age ?? 0);
  if (response.status !== 200 || !Number.isFinite(time) || time < 1700000000 || time > 4102444800
      || !Number.isFinite(date) || !Number.isFinite(age) || age < 0 || age > 300) throw new Error('Invalid world-state clock');
  // This endpoint caches the JSON Time for 45 seconds while HTTP Date is
  // current. Age applies to Time; adding it to Date would count it twice.
  const agedTime = (time + age) * 1000;
  if (Math.abs(agedTime - date) > 5000) throw new Error('Inconsistent world-state timestamps');
  return Math.max(date, agedTime) + 500; // Timestamp resolution is one second.
}

class WorldClock extends EventEmitter {
  constructor({ cacheDir, http = axios, now = Date.now, monotonic = () => performance.now(), log = () => {} }) {
    super();
    this.http = http; this.now = now; this.monotonic = monotonic; this.log = log;
    this.filename = path.join(cacheDir, 'world-clock.json');
    this.state = { offset: 0, syncedAt: null, nextCheck: 0 };
    try {
      const saved = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
      if (saved.schema === 1 && Number.isFinite(saved.offset) && Math.abs(saved.offset) < DAY_MS * 365
          && Number.isFinite(saved.nextCheck) && (saved.syncedAt === null || Number.isFinite(saved.syncedAt))) {
        this.state = { offset: saved.offset, syncedAt: saved.syncedAt, nextCheck: Math.min(saved.nextCheck, now() + DAY_MS) };
      }
    } catch { /* A local prediction works before the first successful sync. */ }
    this.baseTime = now() + this.state.offset;
    this.baseMono = monotonic();
    this.pending = null;
  }
  time() { return this.baseTime + this.monotonic() - this.baseMono; }
  snapshot() {
    return { time: this.time(), syncedAt: this.state.syncedAt, nextCheck: this.state.nextCheck };
  }
  refresh() {
    if (this.pending) return this.pending;
    if (this.now() < this.state.nextCheck) return Promise.resolve(false);
    this.pending = this.check().finally(() => { this.pending = null; });
    return this.pending;
  }
  async check() {
    let changed = false;
    try {
      const started = this.monotonic();
      const response = await this.http.get(URL, { timeout: 10000, maxRedirects: 0, maxContentLength: 1024 * 1024,
        headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
      const elapsed = this.monotonic() - started;
      const time = serverTime(response) + elapsed / 2;
      this.state = { offset: time - this.now(), syncedAt: this.now(), nextCheck: this.now() + DAY_MS };
      this.baseTime = time; this.baseMono = this.monotonic();
      changed = true;
    } catch (error) {
      this.state.nextCheck = this.now() + RETRY_MS;
      this.log(`World clock sync unavailable: ${error.message}`);
    }
    try {
      await fs.promises.mkdir(path.dirname(this.filename), { recursive: true });
      const temporary = `${this.filename}.${process.pid}.tmp`;
      await fs.promises.writeFile(temporary, JSON.stringify({ schema: 1, ...this.state }));
      await fs.promises.rename(temporary, this.filename);
    } catch (error) { this.log(`World clock cache unavailable: ${error.message}`); }
    this.emit('changed');
    return changed;
  }
}
module.exports = { WorldClock, serverTime, URL, DAY_MS, RETRY_MS };
