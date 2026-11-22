'use strict';

const DAY_MS = 86400000;
// Bit order matches the pipeline's six optional ancestors. Moose is Dale Seer.
const ANCESTORS = ['Zenith', 'Dale Seer', 'Garren Rood', 'Bromius', 'Orengall', 'Tuvalkane', 'Verminia', 'Orlick'];
const OPTIONAL = ANCESTORS.slice(2);

function dateNumber(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid calendar date');
  const value = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== date) throw new Error('Invalid calendar date');
  return value / DAY_MS;
}
function dateAt(from, offset) { return new Date((dateNumber(from) + offset) * DAY_MS).toISOString().slice(0, 10); }
function displayName(name) {
  const short = String(name || '').split('/').pop().replace(/BoonNpc$/, '');
  return ({ Moose: 'Dale Seer', GarrenRood: 'Garren Rood' })[short] || short;
}
function unlockMask(names) {
  return OPTIONAL.reduce((mask, name, index) => mask | (names.includes(name) ? 1 << index : 0), 0);
}
function validateCalendar(data) {
  if (!data || data.schema !== 1 || !Array.isArray(data.weapons) || data.weapons.length > 1000) throw new Error('Unsupported calendar data');
  for (const weapon of data.weapons) {
    if (!Array.isArray(weapon) || weapon.length !== 2 || typeof weapon[0] !== 'string' || !weapon[0].trim() || weapon[0].length > 160 || !Number.isFinite(weapon[1]) || weapon[1] < 0) throw new Error('Invalid calendar offer');
  }
  for (const section of ['zenith', 'encounters']) {
    const schedule = data[section];
    dateNumber(schedule?.from);
    if (!Array.isArray(schedule.days) || !schedule.days.length || schedule.days.length > 730) throw new Error('Invalid calendar range');
    for (const day of schedule.days) {
      if (section === 'zenith') {
        if (!Array.isArray(day) || !day.length || day.length > 12 || day.some(index => !Number.isInteger(index) || !data.weapons[index])) throw new Error('Invalid daily offers');
      } else {
        if (typeof day !== 'string' || !/^[0-7]{64}$/.test(day)) throw new Error('Invalid encounter variations');
        for (let mask = 0; mask < 64; mask++) {
          const ancestor = Number(day[mask]);
          if (ancestor >= 2 && !(mask & (1 << (ancestor - 2)))) throw new Error('Encounter selects a locked ancestor');
        }
      }
    }
  }
  return data;
}

// Strip raw resources, RNG diagnostics and duplicate strings before shipping.
function projectCalendar(zenith, index, variations) {
  const data = { schema: 1, weapons: [], zenith: { from: zenith.from_utc, days: [] }, encounters: { from: index.from_utc, days: [] } };
  const weapons = new Map();
  if (!Array.isArray(zenith.rotations) || zenith.rotations.length !== zenith.days) throw new Error('Incomplete Zenith calendar');
  zenith.rotations.forEach((row, offset) => {
    if (row.date_utc !== dateAt(zenith.from_utc, offset)) throw new Error('Zenith dates must be consecutive UTC days');
    data.zenith.days.push(row.offers.map(offer => {
      const value = [offer.name, offer.premium_price];
      const key = JSON.stringify(value);
      if (!weapons.has(key)) { weapons.set(key, data.weapons.length); data.weapons.push(value); }
      return weapons.get(key);
    }));
  });
  if (index.variation_count !== 64 || index.variations?.length !== 64 || variations.length !== 64 || index.days < 1 || index.days > 730) throw new Error('All 64 ancestor variations are required');
  const rows = Array.from({ length: index.days }, () => Array(64));
  const masks = new Set();
  index.variations.forEach((entry, position) => {
    const names = entry.unlocked_ancestors.map(displayName);
    if (names.some(name => !ANCESTORS.includes(name)) || !names.includes('Zenith') || !names.includes('Dale Seer')) throw new Error('Unexpected ancestor pool');
    const mask = unlockMask(names);
    if (masks.has(mask)) throw new Error('Duplicate ancestor variation');
    masks.add(mask);
    const variation = variations[position];
    if (variation.from_utc !== index.from_utc || variation.rotations?.length !== index.days) throw new Error('Encounter date ranges must match the index');
    variation.rotations.forEach((row, offset) => {
      if (row.date_utc !== dateAt(index.from_utc, offset)) throw new Error('Encounter dates must be consecutive UTC days');
      const name = displayName(row.selected?.internal_name);
      if (!names.includes(name)) throw new Error('Encounter selects an ancestor outside its pool');
      rows[offset][mask] = String(ANCESTORS.indexOf(name));
    });
  });
  data.encounters.days = rows.map(row => row.join(''));
  return validateCalendar(data);
}

module.exports = { ANCESTORS, OPTIONAL, DAY_MS, dateNumber, dateAt, unlockMask, projectCalendar, validateCalendar };
