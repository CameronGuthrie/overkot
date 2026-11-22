'use strict';

const { EventEmitter } = require('node:events');
const { forecast } = require('./weatherCycle');

// Shares the clock's public world-state request, persisted offset and cooldown.
// Weather itself is computed from server time; no dated calendar is bundled.
class WeatherForecast extends EventEmitter {
  constructor({ clock, predict = forecast, log = () => {} }) {
    super();
    this.clock = clock;
    this.predict = predict;
    this.log = log;
    this.cached = null;
    this.predictedAt = null;
  }

  async refresh() {
    // The clock broadcasts corrections through main's shared notification.
    await this.clock.refresh();
  }

  snapshot() {
    const sample = this.clock.snapshot();
    try {
      if (!Number.isFinite(sample.time)) throw new Error('Invalid weather clock');
      if (!this.cached || sample.time < this.cached.current.start || sample.time >= this.cached.current.end) {
        this.cached = this.predict(sample.time);
        this.predictedAt = sample.time;
      }
      return { ...sample, ...this.cached, fetchedAt: this.predictedAt,
        status: sample.syncedAt === null ? 'estimated' : 'ready' };
    } catch (error) {
      this.cached = null;
      this.log(`Weather prediction unavailable: ${error.message}`);
      return { ...sample, status: 'unavailable', current: null, upcoming: [] };
    }
  }
}

module.exports = { WeatherForecast };
