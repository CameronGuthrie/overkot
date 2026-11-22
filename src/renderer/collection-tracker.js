'use strict';

window.CollectionTrackerWidget = {
  mount(element, { id = 'collection-log', api = window.api, language = 'en', onResize = () => {} } = {}) {
    const labels = window.InventoryWidgetUI.createLabels(language);
    const tr = labels.text;
    const mastery = id === 'mastery-tracker';
    let handle, prefs = {};
    try { prefs = JSON.parse(localStorage.getItem(`overkot:${id}`)) || {}; } catch {}
    let pins = new Set(Array.isArray(prefs.pins) ? prefs.pins.slice(0, 200) : []);
    const node = (tag, cls, text) => { const item = document.createElement(tag); item.className = cls; if (text !== undefined) item.textContent = text; return item; };
    const search = node('input', 'collection-search'); search.type = 'search'; search.maxLength = 200;
    const searchLabel = mastery ? ['inventorySearchEquipment', 'Search equipment'] : ['inventorySearchYourCollection', 'Search your collection'];
    labels.bind(search, 'placeholder', searchLabel); labels.bind(search, 'aria-label', searchLabel);
    search.value = typeof prefs.search === 'string' ? prefs.search.slice(0, 200) : '';
    function select(label, choices, value) {
      const control = node('select', 'collection-select'); labels.bind(control, 'aria-label', label);
      for (const [key, text] of Object.entries(choices)) { const option = node('option', ''); labels.bind(option, 'textContent', text); option.value = key; control.append(option); }
      if (Object.hasOwn(choices, value)) control.value = value;
      return control;
    }
    const category = select(['inventoryCategory', 'Category'], mastery ? { all: ['inventoryAllEquipment', 'All equipment'], melee: ['inventoryMelee', 'Melee'], ranged: ['inventoryRanged', 'Ranged'], sidearm: ['inventorySidearms', 'Sidearms'], pact: ['inventoryPacts', 'Pacts'], weapon: ['inventoryOtherWeapons', 'Other weapons'] }
      : { all: ['inventoryAllCollections', 'All collections'], Weapon: ['inventoryWeapons', 'Weapons'], Armor: ['inventoryArmour', 'Armour'], Soul: ['inventoryPacts', 'Pacts'], Cosmetic: ['inventoryCosmetics', 'Cosmetics'], discoveries: ['inventoryDiscoveries', 'Discoveries'] }, prefs.category);
    const filter = select(['inventoryProgressFilter', 'Progress filter'], mastery ? { all: ['inventoryAllProgress', 'All progress'], incomplete: ['inventoryNotMastered', 'Not mastered'], mastered: ['inventoryMastered', 'Mastered'], owned: ['inventoryOwned', 'Owned'], pinned: ['inventoryPinnedGoals', 'Pinned goals'] }
      : { all: ['inventoryAllItems', 'All items'], missing: ['inventoryMissing', 'Missing'], owned: ['inventoryOwned', 'Owned'], acquired: ['inventoryAcquiredXpHistory', 'Acquired / XP history'], pinned: ['inventoryPinnedGoals', 'Pinned goals'] }, prefs.filter);
    const view = select(['inventoryView', 'View'], mastery ? { rank: ['inventoryEnvoyRank', 'Envoy Rank'], checklist: ['inventoryMasteryChecklist', 'Mastery checklist'], planner: ['inventoryMasteryGoals', 'Mastery goals'] } : { grid: ['inventoryCollectionLog', 'Collection log'], list: ['inventoryCompactList', 'Compact list'], armory: ['inventoryArmoryOwnedCopies', 'Armory · owned copies'] }, prefs.view);
    const save = () => { try { localStorage.setItem(`overkot:${id}`, JSON.stringify({ search: search.value, category: category.value, filter: filter.value, view: view.value, pins: [...pins] })); } catch {} };
    function bar(value, max, label) {
      const progress = node('progress', 'collection-progress'); progress.max = Math.max(1, max); progress.value = Math.min(value, progress.max);
      progress.setAttribute('aria-label', label); return progress;
    }
    const image = row => window.ItemImages.create(row.icon, { className: 'collection-image', category: `${row.category || row.kind || ''} ${row.subcategory || ''}` });
    function render(body, snapshot, { number, button }) {
      body.classList.add('collection-body');
      const header = node('div', 'collection-heading');
      header.append(node('span', 'collection-eyebrow', mastery ? tr('inventoryEnvoyProgression', 'ENVOY PROGRESSION') : id === 'cosmetics' ? tr('inventoryYourCosmetics', 'YOUR COSMETICS') : tr('inventoryYourCollection', 'YOUR COLLECTION')));
      if (mastery) {
        const progress = snapshot.progress;
        header.append(node('strong', 'collection-total', snapshot.currentRank == null ? tr('inventoryEnvoyRankUnavailable', 'Envoy Rank unavailable')
          : tr('inventoryEnvoyRankNumber', 'Envoy Rank {rank}', { rank: number(snapshot.currentRank) })));
        const equipmentXP = snapshot.equipmentXP ?? 0;
        header.append(node('span', 'collection-caption', tr('inventoryEquipmentMasterySummary', '{xp} equipment mastery XP · {count} mastered', { xp: number(equipmentXP), count: number(snapshot.summary?.mastered || 0) })));
        if (snapshot.currentRank != null && progress && snapshot.totalXP != null) {
          header.append(node('span', 'collection-caption', tr('inventoryXpSource', '{xp} mastery XP · Calculated from {source}', { xp: number(snapshot.totalXP), source: snapshot.rankIsExact ? tr('inventoryInventoryBasis', 'inventory') : tr('inventoryKnownInventoryMastery', 'known inventory mastery') })));
          header.append(bar(progress.currentRankXP, progress.nextRankXP, tr('inventoryCalculatedMasteryProgress', 'Calculated mastery progress')),
            node('span', 'collection-caption', tr('inventoryRankProgress', '{xp} / {target} XP toward calculated ER {rank}', { xp: number(progress.currentRankXP), target: number(progress.nextRankXP), rank: number(progress.rank + 1) })));
        }
        header.append(node('p', snapshot.rankIsExact ? 'collection-caption' : 'collection-warning', snapshot.rankIsExact ? tr('inventoryEquipmentCompletedDiscoveriesAndSkill', 'Equipment, completed discoveries and skill ranks from inventory, using published XP tables.')
          : tr('inventoryPartialInventoryMasteryMissingOr', 'Partial inventory mastery. Missing or unrecognised records can leave the calculated rank and total incomplete.')));
        if (snapshot.discoveryXP != null) header.append(node('span', 'collection-caption', tr('inventoryDiscoverySkillXp', '{xp} discovery mastery XP{skill}', { xp: number(snapshot.discoveryXP), skill: snapshot.skillXP != null ? ' · ' + tr('inventorySkillXp', '{xp} skill mastery XP', { xp: number(snapshot.skillXP) }) : '' })));
        if (snapshot.summary?.unknownXP) header.append(node('span', 'collection-warning', tr('inventoryUnknownEquipmentXp', '{count} equipment XP records are unavailable.', { count: number(snapshot.summary.unknownXP) })));
      } else {
        const groups = Object.entries(snapshot.summary || {}).filter(([key]) => category.value === 'all' || key === category.value);
        const totals = groups.reduce((sum, [, row]) => ({ owned: sum.owned + row.owned, total: sum.total + row.total, unknown: sum.unknown + row.unknown }), { owned: 0, total: 0, unknown: 0 });
        if (category.value === 'discoveries') {
          const discoveries = snapshot.discoveries || [];
          const complete = discoveries.filter(row => row.complete === true).length;
          header.append(node('strong', 'collection-total', `${number(complete)} / ${number(discoveries.length)}`),
            node('span', 'collection-caption', tr('inventoryDiscoveryTargets', 'completed discovery targets')), bar(complete, discoveries.length, tr('inventoryDiscoveryCompletion', 'Discovery completion')));
        } else header.append(node('strong', 'collection-total', `${number(totals.owned)} / ${number(totals.total)}`),
          node('span', 'collection-caption', tr('inventoryOwnedCatalogue', 'catalogued items currently owned{unknown}', { unknown: totals.unknown ? ' · ' + tr('inventoryUnknownOwnership', '{count} ownership unknown', { count: number(totals.unknown) }) : '' })),
          bar(totals.owned, totals.total, tr('inventoryCollectionCompletion', 'Collection completion')));
      }
      body.append(header);
      if (!mastery && category.value === 'discoveries') {
        const scans = snapshot.discoveries || snapshot.scans || [];
        body.append(node('p', 'collection-caption', snapshot.discoveries ? tr('inventoryMemoriesAndDiscoveriesFromThe', 'Memories and discoveries from the published catalogue.') : tr('inventoryObservedLoreScansCompletionTotals', 'Observed lore scans. Completion totals are unavailable for entries without a published target.')));
        for (const row of scans) {
          if (search.value && !row.name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())) continue;
          if (filter.value === 'missing' && row.complete !== false || ['owned', 'acquired'].includes(filter.value) && !row.complete || filter.value === 'pinned' && !pins.has(row.id)) continue;
          const item = node('article', 'collection-row');
          const details = node('div', 'collection-details'); details.append(node('strong', 'collection-name', row.name), node('span', 'collection-caption', row.required != null
            ? `${row.current === null ? tr('inventoryUnavailable', 'Unavailable') : number(row.current ?? row.count ?? 0)} / ${number(row.required)}${row.complete ? ' · ' + tr('inventoryCompleteTag', 'Complete') : ''}${row.kind === 'tree' ? ' · ' + tr('inventoryWorldTreeTag', 'World tree') : ''}` : `${row.count == null ? tr('inventoryProgressUnavailable', 'Progress unavailable') : number(row.count)}${row.read ? ' · ' + tr('inventoryReadTag', 'Read') : ''}${row.redeemed ? ' · ' + tr('inventoryRedeemedTag', 'Redeemed') : ''}`));
          item.append(image(row), details);
          const pin = button('collection-pin', pins.has(row.id) ? '★' : '☆', () => { if (pins.has(row.id)) pins.delete(row.id); else if (pins.size < 200) pins.add(row.id); save(); handle.repaint(); });
          pin.setAttribute('aria-label', `${pins.has(row.id) ? tr('inventoryUnpin', 'Unpin') : tr('inventoryPin', 'Pin')} ${row.name}`); pin.setAttribute('aria-pressed', String(pins.has(row.id))); item.append(pin); body.append(item);
        }
        if (!scans.length) body.append(node('p', 'inventory-widget-empty', tr('inventoryNoDiscoveryRecordsAreAvailable', 'No discovery records are available.')));
        return;
      }
      const query = search.value.trim().toLocaleLowerCase();
      let rows = (snapshot.rows || []).filter(row => (category.value === 'all' || row.category === category.value)
        && (mastery || view.value !== 'armory' || row.copies?.length)
        && (!query || `${row.name} ${row.itemType} ${row.subcategory || ''}`.toLocaleLowerCase().includes(query))
        && (filter.value === 'all' || filter.value === 'pinned' && pins.has(row.id)
          || filter.value === 'owned' && row.owned === true || filter.value === 'missing' && row.owned === false
          || filter.value === 'acquired' && row.acquired || filter.value === 'incomplete' && !row.mastered || filter.value === 'mastered' && row.mastered));
      if (mastery && view.value === 'planner') rows.sort((a, b) => Number(pins.has(b.id)) - Number(pins.has(a.id)) || (a.remainingMasteryXP || 0) - (b.remainingMasteryXP || 0));
      if (mastery && view.value === 'rank') rows = rows.filter(row => row.owned === true || row.rank > 0 || pins.has(row.id))
        .sort((a, b) => Number(pins.has(b.id)) - Number(pins.has(a.id)) || Number(a.mastered) - Number(b.mastered)).slice(0, 6);
      const list = node('div', !mastery && view.value === 'grid' ? 'collection-grid' : 'collection-list');
      if (!rows.length) list.append(node('p', 'inventory-widget-empty', tr('inventoryNoItemsMatchTheseFilters', 'No items match these filters.')));
      for (const row of rows) {
        const card = node('article', `collection-row${row.owned === true ? ' is-owned' : ''}`); card.dataset.itemId = row.id;
        card.append(image(row));
        const details = node('div', 'collection-details'); details.append(node('strong', 'collection-name', row.name));
        details.append(node('span', 'collection-caption', mastery ? `${row.category} · ${row.rank === null ? tr('inventoryRankUnavailable', 'Rank unavailable') : tr('inventoryRankOf', 'Rank {rank} / {max}', { rank: number(row.rank || 0), max: number(row.maxRank || 30) })}`
          : `${row.category}${row.subcategory ? ` · ${row.subcategory}` : ''}`));
        details.append(node('span', `collection-state${row.owned === true ? ' is-owned' : ''}`, row.owned === true ? tr('inventoryOwned', 'Owned') : row.owned === null ? tr('inventoryOwnershipUnavailable', 'Ownership unavailable') : row.historical ? tr('inventoryXpHistoryNotOwned', 'XP history · not owned') : tr('inventoryMissing', 'Missing')));
        if (mastery) {
          if (row.xp !== null) details.append(bar(row.xp || 0, row.target, tr('inventoryItemMastery', '{name} mastery', { name: row.name })));
          details.append(node('span', 'collection-caption', row.xp === null ? tr('inventoryItemXpUnavailable', 'Item XP unavailable') : row.mastered ? tr('inventoryMastered', 'Mastered')
            : tr('inventoryMasteryLeft', '{xp} / {target} item XP · {remaining} mastery XP left', { xp: number(row.xp || 0), target: number(row.target || 0), remaining: number(row.remainingMasteryXP || 0) })));
          if (row.estimated) details.append(node('span', 'collection-caption', tr('inventoryUsesTheGeneralEquipmentCurve', 'Uses the general equipment curve; item-specific mastery data is unavailable.')));
          if (view.value === 'planner' && !row.mastered) details.append(node('span', 'collection-caption', tr('inventoryXpToRank', '{count} item XP to next rank', { count: number(Math.max(0, (row.nextXP || 0) - (row.xp || 0))) })));
        }
        if (!mastery && view.value === 'armory') for (const copy of row.copies || []) details.append(node('span', 'collection-copy',
          `${copy.quality} · ${copy.xp === null ? tr('inventoryXpUnavailable', 'XP unavailable') : tr('inventoryAmountXp', '{count} XP', { count: number(copy.xp) })}${copy.moonsteel ? ' · ' + tr('inventoryMoonsteelTag', 'Moonsteel') : ''}${copy.tempers.length ? ` · ${copy.tempers.join(', ')}` : ''}`));
        const pin = button('collection-pin', pins.has(row.id) ? '★' : '☆', () => { if (pins.has(row.id)) pins.delete(row.id); else if (pins.size < 200) pins.add(row.id); save(); handle.repaint(); });
        pin.setAttribute('aria-label', `${pins.has(row.id) ? tr('inventoryUnpin', 'Unpin') : tr('inventoryPin', 'Pin')} ${row.name}`); pin.setAttribute('aria-pressed', String(pins.has(row.id)));
        card.append(details, pin); list.append(card);
      }
      body.append(node('p', 'collection-caption', tr('inventoryMatchingItems', '{count} matching items', { count: number(rows.length) })), list);
      if (!mastery) body.append(node('p', 'collection-caption', tr('inventoryOwnershipUsesTheCurrentInventory', 'Ownership uses the current inventory. XP history preserves evidence of previously used gear. Totals follow the published catalogue.')));
    }
    handle = window.InventoryWidgetUI.mount(element, { labels, id, api, language, onResize, render,
      setup(toolbar) {
        toolbar.classList.add('collection-controls'); toolbar.append(search, category, filter, view);
        const changed = () => { save(); handle.repaint(); };
        for (const control of [search, category, filter, view]) control.addEventListener(control === search ? 'input' : 'change', changed);
        return () => { for (const control of [search, category, filter, view]) control.removeEventListener(control === search ? 'input' : 'change', changed); };
      },
    });
    return handle;
  },
};
