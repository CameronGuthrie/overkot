'use strict';

window.EquipmentProgressWidget = {
  mount(element, { api = window.api, language = 'en', onResize = () => {} } = {}) {
    const labels = window.InventoryWidgetUI.createLabels(language);
    const tr = labels.text;
    const node = (tag, className, text) => {
      const result = document.createElement(tag); result.className = className;
      if (text !== undefined) result.textContent = text;
      return result;
    };
    const categories = { melee: ['inventoryMelee', 'Melee'], ranged: ['inventoryRanged', 'Ranged'], sidearm: ['inventorySidearms', 'Sidearms'], pact: ['inventoryPacts', 'Pacts'], weapon: ['inventoryOtherWeapons', 'Other weapons'] };
    const search = node('input', 'equipment-search'); search.type = 'search'; search.maxLength = 200;
    labels.bind(search, 'placeholder', ['inventorySearchEquipment', 'Search equipment']);
    labels.bind(search, 'aria-label', ['inventorySearchEquipment', 'Search equipment']);
    function select(className, label, options) {
      const control = node('select', className); labels.bind(control, 'aria-label', label);
      for (const [value, text] of Object.entries(options)) {
        const option = node('option', ''); labels.bind(option, 'textContent', text); option.value = value; control.append(option);
      }
      return control;
    }
    const ownership = select('equipment-ownership', ['inventoryEquipmentOwnership', 'Equipment ownership'], {
      all: ['inventoryAllKnownTypes', 'All known types'], owned: ['inventoryOwned', 'Owned'], recorded: ['inventoryXpRecords', 'XP records'], history: ['inventoryNoLongerOwned', 'No longer owned'],
    });
    const category = select('equipment-category', ['inventoryEquipmentCategory', 'Equipment category'], { all: ['inventoryAllCategories', 'All categories'], ...categories });
    const filters = node('div', 'equipment-filters'); filters.append(ownership, category);
    function render(body, snapshot, helpers) {
      const { number } = helpers;
      const query = search.value.trim().toLocaleLowerCase();
      const rows = (snapshot.rows || []).filter(row => (!query || `${row.name} ${row.itemType}`.toLocaleLowerCase().includes(query))
        && (category.value === 'all' || row.category === category.value)
        && (ownership.value === 'all' || ownership.value === 'owned' && row.owned === true
          || ownership.value === 'recorded' && row.recorded || ownership.value === 'history' && row.recorded && row.owned === false));
      const total = snapshot.summary || {};
      const incompleteOwnership = (snapshot.rows || []).some(row => row.owned === null);
      const summary = node('p', 'equipment-summary', tr('inventoryEquipmentTotals', '{owned} {status} · {recorded} XP records · {mastered} mastered weapons', { owned: number(total.owned || 0), status: incompleteOwnership ? tr('inventoryConfirmedOwned', 'confirmed owned') : tr('inventoryOwnedLower', 'owned'), recorded: number(total.recorded || 0), mastered: number(total.masteredWeapons || 0) }));
      summary.setAttribute('role', 'status'); body.append(summary);
      if (snapshot.unreadableRecords) body.append(node('p', 'equipment-notice', tr('inventoryUnreadableEquipment', '{count} equipment records could not be fully read.', { count: number(snapshot.unreadableRecords) })));
      if (incompleteOwnership) body.append(node('p', 'equipment-notice', tr('inventorySomeOwnershipSectionsAreUnavailable', 'Some ownership sections are unavailable or incomplete. Affected XP records are not classified as no longer owned.')));
      const list = node('div', 'equipment-list');
      if (!rows.length) list.append(node('p', 'equipment-empty', snapshot.rows?.length ? tr('inventoryNoEquipmentMatchesTheseFilters', 'No equipment matches these filters.') : tr('inventoryNoWeaponOrPactXp', 'No weapon or Pact XP records are available.')));
      for (const row of rows) {
        const item = node('article', 'equipment-row'); item.dataset.equipmentId = row.id;
        const thumbnail = window.ItemImages.create(row.icon, { className: 'equipment-image', category: row.category });
        const details = node('div', 'equipment-row-content');
        const heading = node('div', 'equipment-row-heading');
        heading.append(node('strong', 'equipment-name', row.name), node('span', 'equipment-xp', row.xp === null ? tr('inventoryXpUnavailable', 'XP unavailable') : tr('inventoryAmountXp', '{count} XP', { count: number(row.xp) })));
        const badges = node('div', 'equipment-badges');
        badges.append(node('span', 'equipment-category-label', categories[row.category] ? tr(...categories[row.category]) : tr('inventoryEquipment', 'Equipment')),
          node('span', row.owned === true ? 'equipment-owned' : 'equipment-history', row.owned === true ? tr('inventoryOwned', 'Owned') : row.owned === false ? tr('inventoryHistoricalRecord', 'Historical record') : tr('inventoryOwnershipUnavailable', 'Ownership unavailable')));
        if (row.mastered) badges.append(node('span', 'equipment-mastered', tr('inventoryMastered', 'Mastered')));
        details.append(heading, badges);
        if (row.recorded && row.owned && row.recordedXP !== row.ownedXP) {
          details.append(node('p', 'equipment-detail', tr('inventoryXpRecord', 'XP record: {record} · Best owned copy: {owned}', { record: row.recordedXP === null ? tr('inventoryUnavailableLower', 'unavailable') : number(row.recordedXP), owned: row.ownedXP === null ? tr('inventoryUnavailableLower', 'unavailable') : number(row.ownedXP) })));
        }
        if (row.masteryTarget !== null && row.xp !== null) {
          const progress = node('div', 'equipment-progress'); progress.setAttribute('role', 'progressbar');
          progress.setAttribute('aria-label', tr('inventoryMasteryLabel', '{name} XP toward mastery', { name: row.name }));
          progress.setAttribute('aria-valuemin', '0'); progress.setAttribute('aria-valuemax', String(row.masteryTarget));
          progress.setAttribute('aria-valuenow', String(Math.min(row.xp, row.masteryTarget)));
          progress.setAttribute('aria-valuetext', tr('inventoryMasteryThreshold', '{xp} XP; mastery threshold {target} XP', { xp: number(row.xp), target: number(row.masteryTarget) }));
          const fill = node('span', 'equipment-progress-fill'); fill.style.width = `${Math.min(100, row.xp / row.masteryTarget * 100)}%`; progress.append(fill);
          details.append(progress, node('p', 'equipment-detail', row.mastered ? tr('inventoryKnownMasteryThresholdReached', 'Known mastery threshold reached') : tr('inventoryMasteryRemaining', '{count} XP to known mastery threshold', { count: number(Math.max(0, row.masteryTarget - row.xp)) })));
        }
        item.append(thumbnail, details);
        list.append(item);
      }
      body.append(list, node('p', 'equipment-scope', tr('inventoryHighestXpPerTypeIncluding', 'Highest XP per type, including historical records. Only known equipment is listed. XP bars do not estimate intermediate ranks; Pact ranks are not inferred.')));
    }
    return window.InventoryWidgetUI.mount(element, { labels, id: 'equipment-progress', api, language, onResize, render,
      setup(toolbar, helpers, handle) {
        toolbar.classList.add('equipment-controls'); toolbar.append(search, filters);
        const repaint = () => handle.repaint();
        search.addEventListener('input', repaint); ownership.addEventListener('change', repaint); category.addEventListener('change', repaint);
        return () => {
          search.removeEventListener('input', repaint); ownership.removeEventListener('change', repaint); category.removeEventListener('change', repaint);
        };
      },
    });
  },
};
