const fs = require('node:fs');
const path = require('node:path');
const { randomInt, randomUUID } = require('node:crypto');
const { readEncryptedJSON, writeEncryptedJSON } = require('./fileEncryption');
const { eventParams, CLIENT_ID, validateBatch } = require('../../firebase/analytics/events');

class UsageAnalytics {
  constructor({ enabled, directory, version, os = process.platform, send, now = Date.now, isActive = () => false }) {
    Object.assign(this, { enabled, version, os, send, now, isActive });
    this.file = path.join(directory, 'usage-queue.json');
    this.sessionId = Math.floor(now() / 1000);
    this.queue = [];
    this.batch = null;
    this.engagement = 0;
    this.sending = null;
    this.nextSend = 0;
    this.failures = 0;
    this.stopped = false;
    if (!enabled) return;
    let saved;
    try { saved = readEncryptedJSON(this.file); } catch { /* Corrupt cache. */ }
    this.clientId = CLIENT_ID.test(saved?.clientId || '') ? saved.clientId : `${randomInt(1, 2 ** 48)}.${this.sessionId}`;
    this.queue = (Array.isArray(saved?.queue) ? saved.queue : []).filter(e => this.valid(e)).slice(-200);
    // Preserve batch ID across uncertain delivery/restarts, so server retries deduplicate.
    if (validateBatch(saved?.batch, now())) this.batch = saved.batch;
  }

  valid(event) {
    return !!validateBatch({ client_id: this.clientId, batch_id: '00000000-0000-4000-8000-000000000000',
      app_version: this.version, os: this.os, events: [event] }, this.now());
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      writeEncryptedJSON(temp, { clientId: this.clientId, queue: this.queue, batch: this.batch });
      fs.renameSync(temp, this.file);
    } catch { /* Telemetry must not stop the overlay, including read-only portable installs. */ }
  }

  start() {
    if (!this.enabled || this.timer) return;
    this.lastSample = this.now();
    this.lastHeartbeat = this.now();
    this.track('app_launch');
    this.timer = setInterval(() => {
      this.sample();
      if (this.now() - this.lastHeartbeat >= 300_000) {
        this.track('app_running');
        this.lastHeartbeat = this.now();
      }
      void this.flush();
    }, 10_000);
    this.timer.unref?.();
    void this.flush();
  }

  sample() {
    const now = this.now(), elapsed = Math.max(0, Math.min(10_000, now - (this.lastSample ?? now)));
    if (this.isActive()) this.engagement = Math.min(300_000, this.engagement + elapsed);
    this.lastSample = now;
  }

  track(name, input = {}) {
    if (!this.enabled || this.stopped) return false;
    const params = eventParams(name, input);
    if (!params) return false;
    this.sample();
    this.queue.push({ name, params, timestamp: this.now(), session_id: this.sessionId, engagement_time_msec: this.engagement });
    this.engagement = 0;
    this.queue = this.queue.filter(e => this.valid(e)).slice(-200);
    this.save();
    return true;
  }

  flush() {
    if (!this.enabled || this.sending || this.now() < this.nextSend) return this.sending || Promise.resolve();
    if (this.batch && !validateBatch(this.batch, this.now())) this.batch = null;
    this.queue = this.queue.filter(e => this.valid(e));
    if (!this.batch && this.queue.length) {
      this.batch = { client_id: this.clientId, batch_id: randomUUID(), app_version: this.version, os: this.os,
        events: this.queue.splice(0, 25) };
      this.save();
    }
    if (!this.batch) return Promise.resolve();
    const pending = this.batch;
    this.sending = Promise.resolve().then(() => this.send(pending)).then(() => {
      this.batch = null;
      this.failures = 0;
      this.nextSend = this.now() + 60_000;
      this.save();
    }).catch(error => {
      // Invalid payloads cannot become valid by retrying. Retry transient failures only.
      if (error?.code === 'functions/invalid-argument') this.batch = null;
      this.failures++;
      this.nextSend = this.now() + Math.min(30 * 60_000, 60_000 * 2 ** Math.min(this.failures - 1, 5));
      this.save();
    }).finally(() => { this.sending = null; });
    return this.sending;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.track('app_exit');
    this.stopped = true;
    // Durable queue is delivered on next launch; quit never waits on the network.
  }
}
module.exports = { UsageAnalytics };
