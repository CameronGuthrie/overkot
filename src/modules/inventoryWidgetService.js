'use strict';

const { EventEmitter } = require('node:events');

/** Projects inventory inside main; renderer windows receive only widget data. */
class InventoryWidgetService extends EventEmitter {
  constructor({ id, model, getSession, getNames = () => ({}), now = Date.now }) {
    super();
    Object.assign(this, { id, model, getSession, getNames, now });
    this.sessionEpoch = 0;
    this.previous = null;
    this.snapshot = null;
  }

  update(force = false) {
    const session = this.getSession();
    if (session !== this.session) { this.session = session; this.sessionEpoch++; }
    const valid = session && !session.isNonceExpired();
    const inventory = valid ? session.getRawInventory() : null;
    const status = !valid ? 'connect' : !inventory ? 'waiting' : session.isInventoryCached() ? 'cached' : 'live';
    const names = this.getNames();
    const savedAt = inventory ? session.getInventorySavedAt?.() ?? session.getLastSuccessfulPollAt?.() : null;
    const updatedAt = Number.isFinite(savedAt) && savedAt > 0 ? savedAt : null;
    const context = { status, updatedAt, now: this.now(), names, sessionEpoch: this.sessionEpoch,
      accountId: valid ? session.accountId : null };
    this.context = context;
    if (!force && this.previous && this.previous.inventory === inventory && this.previous.status === status
      && this.previous.names === names && this.previous.updatedAt === updatedAt
      && this.previous.sessionEpoch === this.sessionEpoch && this.previous.accountId === context.accountId) return;
    this.previous = { inventory, ...context };
    const projection = this.model.read(inventory, context);
    this.snapshot = { ...projection, status, updatedAt };
    this.emit('changed', this.snapshot);
  }

  getSnapshot() { this.update(); return this.snapshot; }

  action(action) {
    if (action !== 'reset' || typeof this.model.action !== 'function') throw new Error('Unsupported widget action');
    this.update();
    this.model.action(action, this.context);
    this.update(true);
    return this.snapshot;
  }
}

module.exports = { InventoryWidgetService };
