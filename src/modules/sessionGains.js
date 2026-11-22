'use strict';

// Compare complete observations of physical stacks. These are net inventory
// changes: purchases, crafting, trades and consumption also affect the result.
const STACK_SECTIONS = Object.freeze(['MiscItems', 'Consumables']);
const CURRENCY_FIELDS = Object.freeze(['RegularCredits', 'PremiumCredits']);
const CHANNELS = [...STACK_SECTIONS, ...CURRENCY_FIELDS];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 8640000000000000 ? value : null;

function count(value) {
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function stackObservation(inventory, section) {
  if (!Array.isArray(inventory?.[section])) return null;
  const totals = new Map();
  for (const entry of inventory[section]) {
    const type = entry?.ItemType;
    const quantity = count(entry?.ItemCount);
    if (!record(entry) || typeof type !== 'string' || !type.trim() || type.length > 1024
      || /[\x00-\x1f\x7f]/.test(type) || quantity === null) return null;
    const next = (totals.get(type) || 0) + quantity;
    if (!Number.isSafeInteger(next)) return null;
    totals.set(type, next);
  }
  return totals;
}

function label(type, names) {
  const translated = record(names) && Object.hasOwn(names, type) ? names[type] : null;
  if (typeof translated === 'string' && translated.trim()) return translated;
  if (type === 'RegularCredits') return 'Dracs';
  if (type === 'PremiumCredits') return 'Arcs';
  return (type.split('/').filter(Boolean).at(-1) || type)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
}

function createSessionGainsModel() {
  let identity = null, baselineAt = null, observedAt = null, resetAt = null;
  let baselines = new Map(), observations = new Map();
  let lastWithheld = [];

  function clear() {
    baselineAt = null; observedAt = null;
    baselines = new Map(); observations = new Map();
    lastWithheld = [];
  }

  function read(value, context = {}) {
    const status = ['connect', 'waiting', 'cached', 'live'].includes(context.status) ? context.status : 'connect';
    const nextIdentity = JSON.stringify([context.accountId ?? null, context.sessionEpoch ?? null]);
    if (nextIdentity !== identity) { clear(); resetAt = null; identity = nextIdentity; }
    if (status === 'connect' || status === 'waiting') { clear(); resetAt = null; }
    const inventory = record(value?.inventory) && !STACK_SECTIONS.some(key => Object.hasOwn(value, key))
      ? value.inventory : value;
    const at = timestamp(context.updatedAt) || timestamp(context.now) || Date.now();
    let withheldSections = [];
    const current = new Map();
    if (status === 'live' && record(inventory) && (observedAt === null || at >= observedAt)) {
      if (baselineAt === null) baselineAt = at;
      observedAt = at;
      for (const section of CHANNELS) {
        const quantity = CURRENCY_FIELDS.includes(section) ? count(inventory[section]) : null;
        const observation = STACK_SECTIONS.includes(section) ? stackObservation(inventory, section)
          : quantity === null ? null : new Map([[section, quantity]]);
        if (observation === null) { withheldSections.push(section); continue; }
        if (!baselines.has(section)) {
          baselines.set(section, { counts: new Map(observation), at });
        }
        observations.set(section, { counts: observation, at });
        current.set(section, observations.get(section));
      }
      observations = new Map(current);
      lastWithheld = [...withheldSections];
    } else if (status === 'live' && record(inventory)) {
      // An older response cannot roll back totals or change the baseline.
      for (const [section, observation] of observations) current.set(section, observation);
      withheldSections = [...lastWithheld];
    } else if (status === 'cached') {
      for (const [section, observation] of observations) current.set(section, observation);
      withheldSections = [...lastWithheld];
    } else if (status === 'live') {
      withheldSections.push(...CHANNELS);
      observations = new Map(); lastWithheld = [...withheldSections];
    }

    const rows = [];
    for (const [section, observation] of current) {
      const baseline = baselines.get(section);
      const hours = Math.max(0, observation.at - baseline.at) / 3600000;
      for (const type of new Set([...baseline.counts.keys(), ...observation.counts.keys()])) {
        const before = baseline.counts.get(type) || 0, after = observation.counts.get(type) || 0;
        const net = after - before;
        rows.push({ id: `${section}:${type}`, itemType: type, section,
          category: section === 'MiscItems' ? 'resource' : section === 'Consumables' ? 'consumable' : 'currency',
          name: label(type, context.names), baseline: before, current: after, net,
          perHour: hours > 0 ? net / hours : null, baselineAt: baseline.at, observedAt: observation.at });
      }
    }
    rows.sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const seededSections = [...current.keys()].filter(section => baselines.get(section).at !== baselineAt);
    return { status, rows, baselineAt, observedAt, resetAt,
      elapsedHours: baselineAt !== null && observedAt !== null ? Math.max(0, observedAt - baselineAt) / 3600000 : 0,
      tracking: status === 'live' && baselineAt !== null, withheldSections, seededSections };
  }

  function action(value, context = {}) {
    if (value !== 'reset') return { ok: false, reason: 'unknown-action' };
    clear(); resetAt = timestamp(context.now) || Date.now();
    return { ok: true };
  }

  return { read, action };
}

module.exports = { createSessionGainsModel, stackObservation, STACK_SECTIONS, CURRENCY_FIELDS };
