(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CollectionExtrasWidget = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const normalize = value => typeof value === 'string' ? value.trim().toLowerCase().replace(/^\/sf\/storeitems\//, '/sf/') : '';
  const quantity = value => Number.isSafeInteger(value) && value > 0 && value <= 999 ? value : 1;
  const GOALS_KEY = 'overkot.crafting-planner.goals.v1';

  /** Shared ingredients are combined before subtracting stock, so two goals cannot spend it twice. */
  function computeCraftingPlan(recipes, goals) {
    const byType = new Map((recipes || []).map(row => [normalize(row.itemType), row]));
    const materials = new Map(), targets = [], missing = [], stock = new Map();
    for (const goal of (goals || []).slice(0, 200)) {
      const recipe = byType.get(normalize(goal?.itemType));
      if (!recipe) { missing.push(goal?.itemType || ''); continue; }
      const count = quantity(goal.quantity); targets.push({ ...recipe, quantity: count });
      for (const ingredient of recipe.ingredients || []) {
        const id = normalize(ingredient.itemType);
        if (!id || !Number.isSafeInteger(ingredient.required) || ingredient.required <= 0) continue;
        if (!materials.has(id)) materials.set(id, { ...ingredient, required: 0 });
        const row = materials.get(id);
        row.required += ingredient.required * count;
        if (ingredient.owned === null || row.owned === null) row.owned = null;
        else row.owned = Math.max(row.owned || 0, ingredient.owned || 0);
        for (const choice of ingredient.choices || [{ itemType: ingredient.itemType, owned: ingredient.owned }]) {
          const choiceId = normalize(choice.itemType), current = stock.get(choiceId);
          if (choice.owned === null || current === null) stock.set(choiceId, null);
          else stock.set(choiceId, Math.max(current || 0, choice.owned || 0));
        }
      }
    }
    const rows = [...materials.values()].map(row => {
      let needed = row.required, unknown = false;
      for (const choice of row.choices || [{ itemType: row.itemType, owned: row.owned }]) {
        const choiceId = normalize(choice.itemType), held = stock.get(choiceId);
        if (held === null) { unknown = true; continue; }
        const used = Math.min(needed, held || 0); needed -= used; stock.set(choiceId, (held || 0) - used);
      }
      return { ...row, allocated: row.required - needed, missing: needed > 0 && unknown ? null : needed };
    });
    rows.sort((a, b) => (b.missing || 0) - (a.missing || 0) || a.name.localeCompare(b.name));
    return { targets, materials: rows, missingRecipes: missing,
      ready: targets.length > 0 && missing.length === 0 && targets.every(row => row.recipeComplete) && rows.every(row => row.missing === 0) };
  }

  function readGoals(storage) {
    try {
      const value = JSON.parse(storage?.getItem(GOALS_KEY) || '[]');
      if (!Array.isArray(value)) return [];
      const seen = new Set();
      return value.filter(row => {
        const id = normalize(row?.itemType);
        if (!id || seen.has(id)) return false; seen.add(id); return true;
      }).slice(0, 200).map(row => ({ itemType: row.itemType, quantity: quantity(row.quantity) }));
    } catch { return []; }
  }

  function mount(element, { id, api = window.api, language = 'en', onResize = () => {} } = {}) {
    const labels = window.InventoryWidgetUI.createLabels(language);
    const tr = labels.text;
    let storage; try { storage = window.localStorage; } catch { storage = null; }
    let goals = readGoals(storage), handle, search, category, virtue, rank, onlyHeld, gainsOnly, pending = false, actionError = false, destroyed = false;
    let visibleLimit = 100;
    const node = (tag, className = '', text) => {
      const result = document.createElement(tag); result.className = className;
      if (text !== undefined) result.textContent = text; return result;
    };
    const button = (text, click, label = text) => {
      const result = node('button', 'collection-extras-button', text); result.type = 'button'; result.setAttribute('aria-label', label);
      result.addEventListener('click', click); return result;
    };
    function select(label, options) {
      const result = node('select'); labels.bind(result, 'aria-label', label);
      for (const [value, text] of Object.entries(options)) { const option = node('option', ''); labels.bind(option, 'textContent', text); option.value = value; result.append(option); }
      if (Object.hasOwn(options, 'all')) result.value = 'all';
      return result;
    }
    const saveGoals = () => { try { storage?.setItem(GOALS_KEY, JSON.stringify(goals)); } catch { /* The current plan still works without storage. */ } };
    const repaint = () => handle?.repaint();
    function icon(row) {
      return window.ItemImages.create(row.icon, { className: 'collection-extras-icon', category: `${row.category || row.kind || ''} ${row.subcategory || ''}` });
    }
    function heading(row, value) {
      const result = node('div', 'collection-extras-heading'), image = icon(row);
      if (image) result.append(image);
      result.append(node('strong', 'collection-extras-name', row.name));
      if (value !== undefined) result.append(node('span', 'collection-extras-value', value));
      return result;
    }
    function notice(body, text) { body.append(node('p', 'collection-extras-note', text)); }
    function paged(body, rows, render) {
      const list = node('div', 'collection-extras-list');
      for (const row of rows.slice(0, visibleLimit)) list.append(render(row));
      if (!rows.length) notice(list, tr('inventoryNoEntriesMatchTheseFilters', 'No entries match these filters.'));
      body.append(list);
      if (rows.length > visibleLimit) body.append(button(tr('inventoryMoreResults', 'Show more ({count})', { count: rows.length - visibleLimit }), () => { visibleLimit += 100; repaint(); }));
    }
    function addGoal(row) {
      const found = goals.find(goal => normalize(goal.itemType) === normalize(row.itemType));
      if (found) found.quantity = Math.min(999, found.quantity + 1);
      else if (goals.length < 200) goals.push({ itemType: row.itemType, quantity: 1 });
      saveGoals(); repaint();
    }
    function planner(body, snapshot, helpers, filtered) {
      const { number } = helpers, plan = computeCraftingPlan(snapshot.rows, goals);
      body.append(node('p', 'collection-extras-summary', plan.ready ? tr('inventoryAllListedIngredientsForYour', 'All listed ingredients for your plan are held.') : tr('inventoryPlannedRecipes', '{count} planned recipes', { count: number(plan.targets.length) })));
      const targetList = node('div', 'collection-extras-goals');
      for (const target of plan.targets) {
        const row = node('div', 'collection-extras-goal');
        row.append(icon(target), node('span', 'collection-extras-name', `${target.name}${target.recipeKind === 'reforge' ? ' · ' + tr('inventoryReforgeTag', 'Reforge') : ''}`));
        const count = node('input', 'collection-extras-quantity'); count.type = 'number'; count.min = '1'; count.max = '999'; count.step = '1'; count.value = String(target.quantity);
        count.setAttribute('aria-label', tr('inventoryRecipeQuantity', 'Recipe quantity: {name}', { name: target.name }));
        count.addEventListener('change', () => { const goal = goals.find(goal => normalize(goal.itemType) === normalize(target.itemType)); if (goal) goal.quantity = quantity(Number(count.value)); saveGoals(); repaint(); });
        row.append(count, button('×', () => { goals = goals.filter(goal => normalize(goal.itemType) !== normalize(target.itemType)); saveGoals(); repaint(); }, tr('inventoryRemoveItem', 'Remove {name}', { name: target.name })));
        targetList.append(row);
      }
      if (plan.missingRecipes.length) targetList.append(button(tr('inventoryRemoveUnavailableRecipes', 'Remove unavailable recipes'), () => {
        const missing = new Set(plan.missingRecipes.map(normalize)); goals = goals.filter(row => !missing.has(normalize(row.itemType))); saveGoals(); repaint();
      }));
      body.append(targetList);
      if (plan.materials.length) {
        body.append(node('h4', 'collection-extras-section-title', tr('inventoryIngredientsForYourPlan', 'Ingredients for your plan')));
        for (const item of plan.materials) {
          const row = node('article', 'collection-extras-row'); row.dataset.ready = String(item.missing === 0);
          row.append(heading(item, `${item.missing === null ? '—' : number(item.allocated)} / ${number(item.required)}`));
          row.append(node('small', 'collection-extras-detail', item.missing === null ? tr('inventoryHeldQuantityUnavailable', 'Held quantity unavailable') : item.missing ? tr('inventoryMoreNeeded', '{count} more needed', { count: number(item.missing) }) : tr('inventoryHeld', 'Held')));
          body.append(row);
        }
      }
      if (plan.targets.some(target => !target.recipeComplete)) notice(body, tr('inventoryARecipeHasUnreadableIngredients', 'A recipe has unreadable ingredients. Its totals are incomplete.'));
      if (plan.missingRecipes.length) notice(body, tr('inventoryRecipesAbsent', '{count} saved recipes are absent from the current catalogue.', { count: plan.missingRecipes.length }));
      body.append(node('h4', 'collection-extras-section-title', tr('inventoryAddARecipe', 'Add a recipe')));
      if (!snapshot.catalogAvailable) notice(body, tr('inventoryWaitingForTheCraftingCatalogue', 'Waiting for the crafting catalogue.'));
      paged(body, filtered, row => {
        const item = node('article', 'collection-extras-row'); item.append(heading(row));
        const line = node('div', 'collection-extras-heading');
        line.append(node('small', 'collection-extras-detail', tr('inventoryRecipeIngredients', '{kind}{count} ingredients{availability}', { kind: row.recipeKind === 'reforge' ? tr('inventoryReforge', 'Reforge · ') : '', count: number(row.ingredients.length), availability: row.ready ? ' · ' + tr('inventoryIngredientsHeld', 'Listed ingredients held') : '' })), button(tr('inventoryAddRecipe', '+ Add'), () => addGoal(row), tr('inventoryAddToPlan', 'Add {name} to plan', { name: row.name })));
        item.append(line); return item;
      });
      notice(body, tr('inventoryOnlyListedRecipeIngredientsAre', 'Only listed recipe ingredients are totaled. Dracs costs are not included. Reforging can require the existing item.'));
    }

    return window.InventoryWidgetUI.mount(element, { labels, id, api, language, onResize,
      setup(toolbar, helpers, ui) {
        handle = ui; toolbar.classList.add('collection-extras-controls');
        search = node('input'); search.type = 'search'; search.maxLength = 200;
        const searchLabel = ({ resources: ['inventorySearchResources', 'Search resources'], enhancements: ['inventorySearchEnhancements', 'Search enhancements'], activity: ['inventorySearchObservations', 'Search observations'], 'crafting-log': ['inventorySearchCraftingRecords', 'Search crafting records'], 'crafting-planner': ['inventorySearchRecipes', 'Search recipes'] })[id] || ['inventorySearch', 'Search'];
        labels.bind(search, 'placeholder', searchLabel); labels.bind(search, 'aria-label', searchLabel);
        const searchListener = () => { visibleLimit = 100; repaint(); }; search.addEventListener('input', searchListener); toolbar.append(search);
        const listeners = [[search, 'input', searchListener]];
        function filter(control) { toolbar.append(control); const listener = () => { visibleLimit = 100; repaint(); }; control.addEventListener('change', listener); listeners.push([control, 'change', listener]); return control; }
        function checkbox(label) { const wrapper = node('label', 'collection-extras-check'), control = node('input'); control.type = 'checkbox'; const caption = node('span'); labels.bind(caption, 'textContent', label); wrapper.append(control, caption); toolbar.append(wrapper); const listener = () => repaint(); control.addEventListener('change', listener); listeners.push([control, 'change', listener]); return control; }
        if (id === 'resources') {
          category = filter(select(['inventoryResourceCategory', 'Resource category'], { all: ['inventoryAllCategories', 'All categories'], Currency: ['inventoryCurrency', 'Currency'], Resource: ['inventoryMaterials', 'Materials'], Consumable: ['inventoryConsumables', 'Consumables'], 'Key Item': ['inventoryKeyItems', 'Key items'] })); onlyHeld = checkbox(['inventoryHeldOnly', 'Held only']);
        } else if (id === 'enhancements') {
          category = filter(select(['inventoryEnhancementType', 'Enhancement type'], { all: ['inventoryAllEnhancements', 'All enhancements'], mote: ['inventoryRunesMotes', 'Runes & motes'], totem: ['inventoryTotems', 'Totems'], technique: ['inventoryTechniques', 'Techniques'], joinery: ['inventoryJoineries', 'Joineries'] }));
          virtue = filter(select(['inventoryVirtue', 'Virtue'], { all: ['inventoryAllVirtues', 'All virtues'], COURAGE: ['inventoryCourage', 'Courage'], GRACE: ['inventoryGrace', 'Grace'], SPIRIT: ['inventorySpirit', 'Spirit'], none: ['inventoryNoVirtue', 'No virtue'] }));
          rank = filter(select(['inventoryEnhancementRank', 'Enhancement rank'], { all: ['inventoryAllRanks', 'All ranks'], 0: ['inventoryUnranked', 'Unranked'], 1: ['inventoryRank1', 'Rank 1'], 2: ['inventoryRank2', 'Rank 2'], 3: ['inventoryRank3', 'Rank 3'] }));
        } else if (id === 'activity') {
          category = filter(select(['inventoryObservationKind', 'Observation kind'], { all: ['inventoryAllObservations', 'All observations'], item: ['inventoryItems', 'Items'], currency: ['inventoryCurrency', 'Currency'], xp: ['inventoryXp', 'XP'] })); gainsOnly = checkbox(['inventoryGainsOnly', 'Gains only']); gainsOnly.checked = true;
          const restart = button('', async () => {
            if (pending || destroyed) return; pending = true; actionError = false; repaint();
            try { await api.inventoryWidgetAction(id, 'reset'); if (!destroyed) await ui.refresh(); } catch { actionError = true; }
            finally { pending = false; repaint(); }
          });
          labels.bind(restart, 'textContent', ['inventoryRestart', 'Restart']);
          labels.bind(restart, 'aria-label', ['inventoryRestart', 'Restart']);
          toolbar.append(restart);
        } else if (id === 'crafting-log') {
          category = filter(select(['inventoryCraftingQuality', 'Crafting quality'], { all: ['inventoryAllQualities', 'All qualities'], IQ_WORN: ['inventoryStock', 'Stock'], IQ_MILITARY: ['inventoryMilitary', 'Military'], IQ_OFFICER: ['inventoryOfficer', 'Officer'], IQ_NOBLE: ['inventoryNoble', 'Noble'], IQ_MASTERWORK: ['inventorySovereign', 'Sovereign'], IQ_LEGENDARY: ['inventoryLegendary', 'Legendary'] }));
        }
        return () => { destroyed = true; for (const [control, name, listener] of listeners) control.removeEventListener(name, listener); };
      },
      render(body, snapshot, helpers) {
        body.classList.add('collection-extras-body');
        const { number, language: locale } = helpers, query = search.value.trim().toLocaleLowerCase(locale);
        let rows = (snapshot.rows || []).filter(row => !query || `${row.name} ${row.itemType} ${row.category || ''} ${row.subcategory || ''} ${row.ancestorName || ''} ${row.compat || ''}`.toLocaleLowerCase(locale).includes(query));
        if (id === 'crafting-planner') { planner(body, snapshot, helpers, rows); return; }
        if (snapshot.unavailableSections?.length) notice(body, tr('inventoryUnavailableSections', 'Unavailable inventory sections: {sections}', { sections: snapshot.unavailableSections.join(', ') }));
        if (snapshot.unreadableRecords) notice(body, tr('inventoryUnreadableRecords', '{count} records could not be read.', { count: number(snapshot.unreadableRecords) }));
        if (id === 'resources') {
          rows = rows.filter(row => (category.value === 'all' || row.category === category.value) && (!onlyHeld.checked || row.count > 0));
          body.append(node('p', 'collection-extras-summary', tr('inventoryResourcesHeld', '{count} resource types held', { count: number(snapshot.summary?.held || 0) })));
          paged(body, rows, row => { const item = node('article', 'collection-extras-row'); item.append(heading(row, row.count === null ? '—' : number(row.count)), node('small', 'collection-extras-detail', row.category)); return item; });
        } else if (id === 'enhancements') {
          rows = rows.filter(row => (category.value === 'all' || row.kind === category.value) && (virtue.value === 'all' || virtue.value === 'none' && !row.virtue || row.virtue === virtue.value)
            && (rank.value === 'all' || row.ranks[Number(rank.value)] > 0));
          body.append(node('p', 'collection-extras-summary', tr('inventoryCopySummary', '{count} copies · {variants} variants', { count: number(snapshot.summary?.copies || 0), variants: number(snapshot.summary?.types || 0) })));
          paged(body, rows, row => {
            const item = node('article', 'collection-extras-row'); item.dataset.virtue = row.virtue;
            item.append(heading(row, tr('inventoryHeldAmount', '{count} held', { count: number(row.count) })), node('small', 'collection-extras-detail', [row.kind === 'mote' ? tr('inventoryRuneMote', 'Rune / mote') : row.kind, row.virtue, row.compat].filter(Boolean).join(' · ')));
            const ranks = node('div', 'collection-extras-ranks');
            row.ranks.forEach((count, index) => ranks.append(node('span', count ? 'collection-extras-rank held' : 'collection-extras-rank', `${index ? `R${index}` : 'R0'} × ${number(count)}`))); item.append(ranks); return item;
          });
        } else if (id === 'activity') {
          if (actionError) notice(body, tr('inventoryCouldNotRestartObservationsTry', 'Could not restart observations. Try again.'));
          notice(body, tr('inventoryObservedInventoryChangesDuringThis', 'Observed inventory changes during this connection. Trades, crafting and spending are included.'));
          if (!snapshot.tracking) { notice(body, tr('inventoryAFreshLiveSnapshotStarts', 'A fresh live snapshot starts observations. Saved inventory contains no event history.')); return; }
          rows = rows.filter(row => (category.value === 'all' || row.kind === category.value) && (!gainsOnly.checked || row.delta > 0));
          if (snapshot.withheldSections?.length) notice(body, tr('inventoryIncompleteSections', 'Changes withheld for incomplete sections: {sections}', { sections: snapshot.withheldSections.join(', ') }));
          if (!snapshot.rows?.length) notice(body, tr('inventoryNoObservedChangesYetKeep', 'No observed changes yet. Keep playing until the next inventory update.'));
          paged(body, rows, row => {
            const item = node('article', 'collection-extras-row'); item.dataset.direction = row.delta > 0 ? 'gain' : 'loss';
            item.append(heading(row, `${number(row.delta, { signDisplay: 'exceptZero' })}${row.kind === 'xp' ? ' XP' : ''}`), node('small', 'collection-extras-detail', `${new Date(row.at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${row.section}`)); return item;
          });
        } else if (id === 'crafting-log') {
          rows = rows.filter(row => category.value === 'all' || row.quality === category.value);
          if (!snapshot.available) notice(body, tr('inventoryAncestorCraftingRecordsAreUnavailable', 'Ancestor crafting records are unavailable in this inventory.'));
          for (const ancestor of snapshot.ancestors || []) notice(body, `${ancestor.name}${ancestor.rank === null ? '' : ' · ' + tr('inventoryAncestorRank', 'Rank {rank}', { rank: number(ancestor.rank) })}${ancestor.xp === null ? '' : ' · ' + tr('inventoryAncestorXp', '{xp} XP', { xp: number(ancestor.xp) })}`);
          body.append(node('p', 'collection-extras-summary', tr('inventoryCraftCount', '{count} recorded craft / quality combinations', { count: number(snapshot.rows?.length || 0) })));
          paged(body, rows, row => { const item = node('article', 'collection-extras-row'); item.append(heading(row, row.qualityName), node('small', 'collection-extras-detail', row.ancestorName)); return item; });
          notice(body, tr('inventoryPermanentAncestorCraftingRecordsThe', 'Permanent ancestor crafting records. The game does not report craft dates or repeat counts.'));
        }
      },
    });
  }
  return { mount, computeCraftingPlan, readGoals };
});
