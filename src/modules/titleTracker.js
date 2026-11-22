'use strict';

const { EventEmitter } = require('node:events');
const { validateTitleCatalog } = require('./epithetsData');
let catalog = { schema: 1, titles: [] };
const key = value => value.toLowerCase().replace('/sf/storeitems/', '/sf/');

function setTitleCatalog(value) {
  let next;
  try { next = validateTitleCatalog(value); } catch { return false; }
  if (JSON.stringify(next) === JSON.stringify(catalog)) return false;
  catalog = next;
  return true;
}

function inventoryTitles(inventory, data = catalog) {
  const rows = new Map(data.titles.map(title => [title.id, { ...title, count: 0, completed: false, owned: false }]));
  const challengeRows = new Map(), itemRows = new Map();
  for (const row of rows.values()) {
    itemRows.set(key(row.itemType), row);
    for (const name of [row.challengeName, row.challengePath, row.legacyName].filter(Boolean)) {
      challengeRows.set(key(name), row);
    }
    if (row.legacyName) challengeRows.set(key('/SF/Types/Challenges/Titles/' + row.legacyName), row);
  }
  let unreadableChallenges = inventory?.ChallengeProgress != null && !Array.isArray(inventory.ChallengeProgress) ? 1 : 0;
  for (const challenge of Array.isArray(inventory?.ChallengeProgress) ? inventory.ChallengeProgress : []) {
    if (!challenge || typeof challenge.Name !== 'string' || !challenge.Name || challenge.Name.length > 200) {
      unreadableChallenges++;
      continue;
    }
    const row = challengeRows.get(key(challenge.Name));
    if (!row) continue; // Non-title challenges and unknown new titles are not guessed.
    const count = challenge.Progress;
    const validCount = Number.isSafeInteger(count) && count >= 0;
    const validComplete = challenge.Complete === undefined || typeof challenge.Complete === 'boolean';
    if (!validCount || !validComplete) unreadableChallenges++;
    // Some completed legacy records report 1, even when the target was 500.
    if (challenge.Complete === true) {
      row.completed = true;
      row.count = row.target;
    } else if (validCount) {
      // ChallengeProgress is a total. Duplicates and legacy aliases never add.
      row.count = Math.max(row.count, Math.min(row.target, count));
      if (row.count === row.target) row.completed = true;
    }
  }
  for (const item of Array.isArray(inventory?.FlavourItems) ? inventory.FlavourItems : []) {
    if (typeof item?.ItemType !== 'string' || item.ItemType.length > 200) continue;
    const row = itemRows.get(key(item.ItemType));
    if (row) { row.owned = true; row.completed = true; row.count = row.target; }
  }
  return { unreadableChallenges, rows: [...rows.values()]
    .sort((a, b) => a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id, 'en')) };
}

class TitleTracker extends EventEmitter {
  constructor({ getSession }) {
    super(); this.getSession = getSession;
    this.previous = null; this.session = null; this.status = null; this.lastValue = '';
    this.snapshot = { status: 'connect', ...inventoryTitles(null) };
  }
  update() {
    const session = this.getSession();
    const valid = session && !session.isNonceExpired();
    const raw = valid ? session.getRawInventory() : null;
    const status = !valid ? 'connect' : !raw ? 'waiting' : !catalog.titles.length ? 'data'
      : session.isInventoryCached() ? 'cached' : 'live';
    const sameCatalog = catalog === this.previousCatalog;
    if (raw === this.previous && session === this.session && status === this.status && sameCatalog) return;
    const tally = raw === this.previous && session === this.session && sameCatalog ? this.snapshot : inventoryTitles(raw);
    this.previousCatalog = catalog;
    this.previous = raw; this.session = session; this.status = status;
    this.snapshot = { status, unreadableChallenges: tally.unreadableChallenges, rows: tally.rows };
    const value = JSON.stringify(this.snapshot);
    if (value !== this.lastValue) { this.lastValue = value; this.emit('changed', this.snapshot); }
  }
  getSnapshot() { this.update(); return this.snapshot; }
}

module.exports = { TitleTracker, inventoryTitles, setTitleCatalog };
