/* Pure inventory formatting shared by the data viewer and snapshot name lookup. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.InventoryFormat = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const normalize = value => String(value ?? '').trim().toLowerCase().replace(/^\/sf\/storeitems\//, '/sf/');
  const text = value => typeof value === 'string' && value.trim() ? value.trim() : '';
  const number = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 20 });
  const compare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  const FIELD_LABELS = {
    AccountId: 'Account ID', ItemId: 'Item ID', ItemType: 'Item type', ItemCount: 'Quantity',
    PlayerLevel: 'Player level', CurrentLoadOutIds: 'Equipped loadouts', LoadOutPresets: 'Loadouts',
    Melee: 'Melee weapons', LongGuns: 'Bows & ranged weapons', Suits: 'Pacts & souls',
    FlavourItems: 'Titles & adornments', KubrowPets: 'Wolf companions',
    RawUpgrades: 'Upgrade materials & progress', Upgrades: 'Runes, totems & upgrades',
    ChallengeProgress: 'Challenge progress', XPInfo: 'Item experience',
    WeaponSkins: 'Weapon cosmetics', SkillTrees: 'Skill trees', BonusAttributes: 'Bonus attributes',
    AspectFingerprint: 'Temper details', UpgradeFingerprint: 'Upgrade details',
    PremiumCredits: 'Premium currency', Credits: 'Currency', RestDate: 'Rest date',
    Temperment: 'Temperament', XP: 'XP', ID: 'ID',
  };
  const QUALITY = {
    IQ_WORN: 'Stock', IQ_MILITARY: 'Military', IQ_OFFICER: 'Officer',
    IQ_NOBLE: 'Noble', IQ_MASTERWORK: 'Sovereign', IQ_LEGENDARY: 'Legendary',
  };

  function humanize(value) {
    const original = String(value ?? '').trim();
    if (!original) return 'Unnamed';
    if (own(FIELD_LABELS, original)) return FIELD_LABELS[original];
    if (own(QUALITY, original)) return QUALITY[original];
    const leaf = original.split(/[\\/]/).filter(Boolean).pop() || original;
    const result = leaf.replace(/^\$(?:number)?/, '')
      .replace(/^(?:IQ|AT|AP|TEMPERMENT|TEMPERAMENT)_/, '')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/([a-z\d])([A-Z])/g, '$1 $2')
      .replace(/[_#.-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!result) return original;
    if (/^[A-Z\d ]+$/.test(result) && result.length > 3) {
      return result.toLowerCase().replace(/\b\w/g, character => character.toUpperCase());
    }
    return result[0].toUpperCase() + result.slice(1);
  }

  function parseStructured(value) {
    if (typeof value !== 'string' || value.length > 1024 * 1024 || !/^[\s]*[\[{]/.test(value)) return value;
    try {
      const parsed = JSON.parse(value);
      return parsed !== null && typeof parsed === 'object' ? parsed : value;
    } catch { return value; }
  }

  function valueKind(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (plain(value)) {
      const keys = Object.keys(value);
      if (keys.length === 1 && own(value, '$oid')) return 'reference';
      if (keys.length === 1 && own(value, '$date')) return 'date';
      if (keys.length === 1 && own(value, '$numberLong')) return 'number';
      return 'object';
    }
    return typeof value;
  }

  function nameIndex(names) {
    const index = new Map();
    const rows = names instanceof Map ? names.entries() : Object.entries(names || {});
    for (const [reference, label] of rows) if (text(label)) index.set(normalize(reference), label.trim());
    return index;
  }

  function resolveWithIndex(reference, index) {
    const key = plain(reference) && own(reference, '$oid') ? reference.$oid : reference;
    if (typeof key !== 'string') return formatPrimitive(key);
    let found = index.get(normalize(key));
    const visited = new Set([normalize(key)]);
    while (found && index.has(normalize(found)) && !visited.has(normalize(found))) {
      visited.add(normalize(found));
      found = index.get(normalize(found));
    }
    return found ? (/^\/SF\//i.test(found) ? humanize(found) : found) : (/^[a-f\d]{24}$/i.test(key) ? key : humanize(key));
  }

  function resolveName(reference, names = {}) {
    return resolveWithIndex(reference, nameIndex(names));
  }

  function formatPrimitive(value, names = {}) {
    const kind = valueKind(value);
    if (kind === 'date') {
      const raw = plain(value.$date) && own(value.$date, '$numberLong') ? value.$date.$numberLong : value.$date;
      if (raw == null || raw === '') return formatPrimitive(raw);
      const milliseconds = typeof raw === 'string' && /^-?\d+$/.test(raw) ? Number(raw) : raw;
      const date = new Date(milliseconds);
      return Number.isFinite(date.getTime()) ? date.toISOString().replace('T', ' ').replace(/\.000Z$/, ' UTC').replace(/Z$/, ' UTC') : String(raw);
    }
    if (kind === 'reference') {
      const label = nameIndex(names).get(normalize(value.$oid));
      return label || String(value.$oid);
    }
    if (plain(value) && kind === 'number') {
      try { return BigInt(value.$numberLong).toLocaleString('en-GB'); } catch { return String(value.$numberLong); }
    }
    if (value === null) return 'None';
    if (value === undefined) return 'Not set';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'number') return Number.isFinite(value) ? number.format(value) : String(value);
    if (typeof value === 'string') {
      if (!value) return '(empty)';
      const index = nameIndex(names);
      if (index.has(normalize(value)) || /^\/SF\//i.test(value)) return resolveWithIndex(value, index);
      if (own(QUALITY, value) || /^(?:IQ|AT|AP|TEMPERMENT|TEMPERAMENT)_/.test(value)) return humanize(value);
      return value;
    }
    if (Array.isArray(value)) return `${number.format(value.length)} ${value.length === 1 ? 'entry' : 'entries'}`;
    return `${number.format(Object.keys(value).length)} fields`;
  }

  function itemLabel(value, fallback, index) {
    if (plain(value)) {
      const candidates = [value.DisplayName, value.displayName, value.CustomName, value.Name, value.name,
        value.n, value.Details?.Name, value.ItemType, value.itemType, value.Type, value.path];
      for (const candidate of candidates) if (text(candidate)) {
        return index.has(normalize(candidate)) || /^\/SF\//i.test(candidate)
          || /^[A-Za-z\d]+(?:Challenge|Mod)$/.test(candidate) ? resolveWithIndex(candidate, index) : candidate;
      }
      if (valueKind(value) === 'reference') return resolveWithIndex(value, index);
    }
    if (typeof value === 'string') return /^\/SF\//i.test(value) || index.has(normalize(value)) ? resolveWithIndex(value, index) : value || '(empty)';
    return humanize(fallback);
  }

  function subtitle(value, names) {
    if (!plain(value) || valueKind(value) !== 'object') return formatPrimitive(value, names);
    const pieces = [];
    if (value.ItemCount != null) pieces.push(`× ${formatPrimitive(value.ItemCount)}`);
    if (text(value.Quality)) pieces.push(humanize(value.Quality));
    if (value.Level != null) pieces.push(`Level ${formatPrimitive(value.Level)}`);
    if (value.XP != null) pieces.push(`XP ${formatPrimitive(value.XP)}`);
    if (value.Progress != null) pieces.push(`Progress ${formatPrimitive(value.Progress)}`);
    if (value.Complete === true) pieces.push('Complete');
    return pieces.join(' · ') || `${number.format(Object.keys(value).length)} fields`;
  }

  function walk(value, visitor) {
    const pending = [{ value, key: '' }];
    const visited = new WeakSet();
    while (pending.length) {
      const current = pending.pop();
      if (visitor(current.value, current.key) === false) continue;
      const decoded = parseStructured(current.value);
      if (decoded !== null && typeof decoded === 'object') {
        if (visited.has(decoded)) continue;
        visited.add(decoded);
        for (const [key, child] of Object.entries(decoded)) pending.push({ value: child, key });
      }
    }
  }

  function searchText(value, index) {
    const parts = [];
    walk(value, (child, key) => {
      if (key) {
        parts.push(key, humanize(key));
        if (index.has(normalize(key))) parts.push(resolveWithIndex(key, index));
      }
      if (child === null || typeof child !== 'object') {
        const raw = String(child ?? 'null');
        parts.push(raw);
        if (typeof child === 'string') {
          if (index.has(normalize(child)) || /^\/SF\//i.test(child)) parts.push(resolveWithIndex(child, index));
          else if (/^[A-Za-z\d_]+$/.test(child)) parts.push(humanize(child));
        }
      }
    });
    return parts.join(' ').toLocaleLowerCase();
  }

  function pathFor(parent, key, array = false) {
    if (array) return `${parent}[${key}]`;
    return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
  }

  function buildSections(inventory, names = {}) {
    const resolvedNames = collectInventoryNames(inventory, names);
    const index = nameIndex(resolvedNames);
    const sections = [];
    const overview = { key: '$overview', label: 'Overview', entries: [], count: 0 };
    function entry(key, value, path, fallback, field = false) {
      const decoded = parseStructured(value);
      const label = field ? (index.has(normalize(key)) || /^\/SF\//i.test(key) ? resolveWithIndex(key, index) : humanize(key)) : itemLabel(decoded, fallback, index);
      const result = { key, path, label, subtitle: subtitle(decoded, resolvedNames), value, kind: valueKind(decoded) };
      result.searchText = `${label} ${path} ${key} ${result.subtitle} ${searchText(value, index)}`.toLocaleLowerCase();
      return result;
    }
    const rows = plain(inventory) ? Object.entries(inventory) : [['Inventory', inventory]];
    for (const [key, raw] of rows) {
      const value = parseStructured(raw);
      const kind = valueKind(value);
      if (kind !== 'array' && kind !== 'object') {
        overview.entries.push(entry(key, raw, pathFor('$', key), key, true));
        continue;
      }
      const section = { key, label: humanize(key), entries: [], count: 0, value: raw };
      for (const [childKey, child] of Object.entries(value)) {
        section.entries.push(entry(childKey, child, pathFor(pathFor('$', key), childKey, kind === 'array'),
          kind === 'array' ? `Entry ${Number(childKey) + 1}` : childKey, kind !== 'array'));
      }
      section.entries.sort((a, b) => compare(a.label, b.label) || compare(a.path, b.path));
      section.count = section.entries.length;
      sections.push(section);
    }
    if (overview.entries.length) {
      overview.entries.sort((a, b) => compare(a.label, b.label));
      overview.count = overview.entries.length;
      sections.push(overview);
    }
    sections.sort((a, b) => a.key === '$overview' ? -1 : b.key === '$overview' ? 1 : compare(a.label, b.label));
    return sections;
  }

  function filterSections(sections, query = '') {
    const terms = String(query).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return sections;
    return sections.map(section => {
      const header = `${section.key} ${section.label}`.toLocaleLowerCase();
      const entries = section.entries.filter(row => terms.every(term => `${header} ${row.searchText}`.includes(term)));
      return { ...section, entries, matchedCount: entries.length };
    }).filter(section => section.entries.length || terms.every(term => `${section.key} ${section.label}`.toLocaleLowerCase().includes(term)));
  }

  function inferLanguageNames(references, index) {
    const candidates = new Map();
    const engineSuffix = /(?:rangedmeleeweapon|meleeweapon|weapon|consumable)$/;
    function add(stem, reference, namespace) {
      if (!stem) return;
      if (!candidates.has(stem)) candidates.set(stem, []);
      candidates.get(stem).push({ reference, namespace });
    }
    for (const reference of index.keys()) {
      const match = reference.match(/^\/sf\/language\/([^/]+)\/(?:.*\/)?([^/]+)$/);
      if (!match) continue;
      const [, namespace, leaf] = match;
      // Descriptions, requirements, UI messages and arbitrary translation keys
      // are not item names, even when part of their key resembles an item.
      if (!leaf.endsWith('name') && !(namespace === 'titles' && leaf.endsWith('title'))) continue;
      const stem = leaf.replace(/name$/, '');
      add(stem, reference, namespace);
      const short = stem.replace(engineSuffix, '');
      if (short !== stem) add(short, reference, namespace);
    }
    for (const reference of references) {
      if (index.has(normalize(reference)) || !/^\/SF\//i.test(reference) || /^\/SF\/Language\//i.test(reference)) continue;
      const segments = normalize(reference).split('/').filter(Boolean);
      const leaf = segments.pop();
      const crafted = leaf.replace(/(?:recipeitem|blueprint|recipe)$/, '');
      const recipeAlias = index.get(`pendingrecipe:${crafted}`);
      if (recipeAlias) {
        index.set(normalize(reference), resolveWithIndex(`PendingRecipe:${crafted}`, index));
        continue;
      }
      const namespace = new Set(segments.filter(segment => !['sf', 'types', 'items', 'storeitems'].includes(segment))
        .map(segment => segment === 'armor' ? 'armour' : segment));
      const stems = [crafted, crafted.replace(engineSuffix, '')];
      for (const stem of new Set(stems)) {
        const rows = candidates.get(stem) || [];
        const inNamespace = rows.filter(row => namespace.has(row.namespace));
        const matching = inNamespace.length ? inNamespace : rows;
        const labels = new Set(matching.map(row => resolveWithIndex(row.reference, index)));
        if (labels.size !== 1) continue;
        index.set(normalize(reference), [...labels][0]);
        break;
      }
    }
  }

  function collectInventoryNames(inventory, ...catalogs) {
    const index = new Map();
    const references = new Set();
    const owned = [];
    const put = (reference, label) => { if (text(reference) && text(label)) index.set(normalize(reference), label.trim()); };
    for (const catalog of catalogs) {
      walk(catalog, (value, key) => {
        // A shared temper tag can mean different things on different weapons.
        // A flat map must not turn one weapon's override into a global name.
        if (key === 'weaponAliases' || key === 'weaponTempers') return false;
        if (typeof value === 'string' && key) put(key, value);
        if (!plain(value)) return;
        const label = text(value.displayName) || text(value.value) || text(value.name);
        if (label) {
          if (key && !/^\d+$/.test(key)) put(key, label);
          for (const field of ['id', 'internalId', 'itemType', 'ItemType', 'path', 'storeItem', 'langKey']) put(value[field], label);
          for (const field of ['challengeName', 'challengePath', 'legacyName']) put(value[field], `${label} challenge`);
          if (plain(value.challenge)) {
            for (const field of ['name', 'path', 'legacyName']) put(value.challenge[field], `${label} challenge`);
          }
        }
      });
    }
    walk(inventory, (value, key) => {
      if (key) references.add(key);
      if (typeof value === 'string') references.add(value);
      if (plain(value) && plain(value.ItemId) && text(value.ItemId.$oid) && valueKind(value) === 'object') owned.push(value);
    });
    inferLanguageNames(references, index);
    for (const row of owned) {
      const label = itemLabel(row, '', index);
      if (label !== 'Unnamed') put(row.ItemId.$oid, label);
    }
    const result = Object.create(null);
    for (const reference of references) {
      if (index.has(normalize(reference))) result[reference] = resolveWithIndex(reference, index);
    }
    return result;
  }

  return { humanize, resolveName, formatPrimitive, valueKind, parseStructured, buildSections, filterSections, collectInventoryNames };
});
