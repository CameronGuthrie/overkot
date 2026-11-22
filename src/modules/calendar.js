'use strict';

const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { ANCESTORS, OPTIONAL, dateNumber, dateAt, unlockMask } = require('./calendarData');

// DynamicGodsAndGhostEncounter._questResources, in the game's candidate order.
const QUESTS = {
  'Garren Rood': '/SF/Types/Quests/TCDemoQuest',
  Bromius: '/SF/Types/Quests/OmenBeastQuests/BromiusQuest',
  Orengall: '/SF/Types/Quests/OmenBeastQuests/TheOmenOrengall',
  Tuvalkane: '/SF/Types/Quests/AncestorProgression/TuvalkaneProgression/ProgressionQuests/AncestorTuvalkaneDiscoveryQuest',
  Verminia: '/SF/Types/Quests/AncestorProgression/VerminiaProgression/AncestorVerminiaDiscoveryQuest',
  Orlick: '/SF/Types/Quests/AncestorProgression/OrlickProgression/OrlickDiscoveryQuest',
};

function questComplete(quest) {
  // Completed can be an encoded progress string even for unfinished quests.
  const date = quest?.CompletionDate?.$date;
  const timestamp = typeof date === 'object' ? date?.$numberLong : date;
  return quest?.Completed === true || (Number.isFinite(Number(timestamp)) && Number(timestamp) > 0);
}
function inventoryUnlocks(inventory) {
  const known = !!inventory && (Array.isArray(inventory.Quests) || Array.isArray(inventory.Ancestors));
  const quests = Array.isArray(inventory?.Quests) ? inventory.Quests : [];
  const residents = Array.isArray(inventory?.Ancestors) ? inventory.Ancestors : [];
  return Object.fromEntries(OPTIONAL.map(name => {
    const quest = quests.find(row => row.ItemType === QUESTS[name]);
    const resident = residents.find(row => row.ItemType === `/SF/Types/Game/Ancestors/${name}/${name}Ancestor`);
    // An explicit quest record is authoritative; use resident ranks when the
    // inventory omits that quest. Rank -1 is a locked, pre-created resident.
    const unlocked = quest ? questComplete(quest) : !!resident && Number.isInteger(resident.Rank) && resident.Rank >= 0;
    return [name, known ? unlocked : null];
  }));
}

class CalendarService extends EventEmitter {
  constructor({ config, feed, now = Date.now }) {
    super();
    this.config = config;
    this.feed = feed;
    this.now = now;
    this.inventory = null;
    this.account = null;
    this.source = 'missing';
    this.automatic = inventoryUnlocks(null);
  }
  updateInventory(inventory, accountId, cached = false) {
    const account = accountId ? createHash('sha256').update(accountId).digest('hex') : null;
    const source = inventory ? (cached ? 'cached' : 'live') : 'missing';
    if (this.inventory === inventory && this.account === account && this.source === source) return;
    const previous = JSON.stringify(this.getSettings());
    this.inventory = inventory;
    this.account = account;
    this.source = source;
    this.automatic = inventoryUnlocks(inventory);
    if (JSON.stringify(this.getSettings()) !== previous) this.emit('changed');
  }
  getOverrides() {
    const saved = this.config.get('calendarAncestors', {});
    // Overrides belong to the account that selected them, never another login.
    if (!saved || saved.account !== this.account) return {};
    return Object.fromEntries(OPTIONAL.filter(name => typeof saved.overrides?.[name] === 'boolean').map(name => [name, saved.overrides[name]]));
  }
  getSettings() {
    const overrides = this.getOverrides();
    return {
      source: this.source, customized: Object.keys(overrides).length > 0,
      ancestors: ANCESTORS.map((name, index) => ({ name, always: index < 2,
        automatic: index < 2 ? true : this.automatic[name],
        unlocked: index < 2 ? true : overrides[name] ?? this.automatic[name],
        overridden: Object.hasOwn(overrides, name),
      })),
    };
  }
  setAncestor(name, unlocked) {
    if (!OPTIONAL.includes(name) || typeof unlocked !== 'boolean') throw new Error('Invalid ancestor selection');
    const overrides = this.getOverrides();
    overrides[name] = unlocked;
    this.config.set('calendarAncestors', { account: this.account, overrides });
    this.emit('changed');
    return this.getSettings();
  }
  reset() {
    this.config.set('calendarAncestors', { account: this.account, overrides: {} });
    this.emit('changed');
    return this.getSettings();
  }
  refresh() {
    // The feed itself deduplicates requests and applies its persisted cooldown.
    return this.feed.refresh().then(changed => { if (changed) this.emit('changed'); });
  }
  getDay(date) {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    date = date || today;
    const day = dateNumber(date);
    const data = this.feed.data;
    const settings = this.getSettings();
    if (!data) return { date, today, firstDate: date, lastDate: date, ancestor: null, encounterAvailable: false,
      inventoryReady: settings.ancestors.every(row => row.unlocked !== null), offers: null, source: settings.source, customized: settings.customized };
    const mask = unlockMask(settings.ancestors.filter(row => row.unlocked === true).map(row => row.name));
    const ready = settings.ancestors.every(row => row.unlocked !== null);
    const encounter = data.encounters.days[day - dateNumber(data.encounters.from)];
    const offers = data.zenith.days[day - dateNumber(data.zenith.from)];
    return {
      date, today,
      firstDate: [data.zenith.from, data.encounters.from].sort()[0],
      lastDate: [dateAt(data.zenith.from, data.zenith.days.length - 1), dateAt(data.encounters.from, data.encounters.days.length - 1)].sort().at(-1),
      ancestor: ready && encounter ? ANCESTORS[Number(encounter[mask])] : null,
      encounterAvailable: !!encounter, inventoryReady: ready,
      offers: offers ? offers.map(index => ({ name: data.weapons[index][0], price: data.weapons[index][1] })) : null,
      source: settings.source, customized: settings.customized,
    };
  }
}

module.exports = { CalendarService, inventoryUnlocks, questComplete, QUESTS };
