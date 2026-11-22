/** Selectable widget cards. Changes save immediately; window size is user-controlled. */
'use strict';

const $ = (sel) => document.querySelector(sel);

const WIDGET_DEFS = [
  { id: 'collection-log', nameKey: 'collectionLogWidget', descKey: 'collectionLogWidgetDesc', icon: 'collection', keywords: 'collection completion log weapons armour armor pacts souls discovery memories' },
  { id: 'cosmetics', nameKey: 'cosmeticsWidget', descKey: 'cosmeticsWidgetDesc', icon: 'cosmetics', keywords: 'collection cosmetics skins adornments' },
  { id: 'mastery-tracker', nameKey: 'masteryTrackerWidget', descKey: 'masteryTrackerWidgetDesc', icon: 'mastery', keywords: 'mastery envoy rank er xp checklist goals planner' },
  { id: 'resources', nameKey: 'resourcesWidget', descKey: 'resourcesWidgetDesc', icon: 'resources', keywords: 'resources materials currencies dracs arcs' },
  { id: 'enhancements', nameKey: 'enhancementsWidget', descKey: 'enhancementsWidgetDesc', icon: 'enhancements', keywords: 'runes motes totems joinery joineries techniques upgrades' },
  { id: 'crafting-planner', nameKey: 'craftingPlannerWidget', descKey: 'craftingPlannerWidgetDesc', icon: 'planner', keywords: 'crafting recipe planner materials goals' },
  { id: 'activity', nameKey: 'activityWidget', descKey: 'activityWidgetDesc', icon: 'activity', keywords: 'journal pickup feed activity inventory changes' },
  { id: 'crafting-log', nameKey: 'craftingLogWidget', descKey: 'craftingLogWidgetDesc', icon: 'craftlog', keywords: 'crafting completed recipes tuvalkane codex history' },
  { id: 'session-analysis', nameKey: 'sessionAnalysisWidget', descKey: 'sessionAnalysisWidgetDesc', icon: 'analysis', keywords: 'mastery session analysis xp hour rate history rank ups' },
  { id: 'daily', nameKey: 'dailyWidget', descKey: 'dailyWidgetDesc', icon: 'daily', keywords: 'daily reset login avakot gots faction vendor weapons zenith calendar' },
  { id: 'player', nameKey: 'playerWidget', descKey: 'playerWidgetDesc', icon: 'player', keywords: 'inventory wallet capacity equipment mastery xp session gains boons' },
  { id: 'boss', nameKey: 'bossTimers', descKey: 'bossTimersDesc', icon: 'boss' },
  { id: 'crafting', nameKey: 'craftingTimers', descKey: 'craftingTimersDesc', icon: 'settings' },
  { id: 'other', nameKey: 'otherTimers', descKey: 'otherTimersDesc', icon: 'timer' },
  { id: 'affiliation', nameKey: 'affiliationWidget', descKey: 'affiliationWidgetDesc', icon: 'affiliation' },
  { id: 'factions', nameKey: 'factionsWidget', descKey: 'factionsWidgetDesc', icon: 'flag' },
  { id: 'odeinfamy', nameKey: 'odeInfamyWidget', descKey: 'odeInfamyWidgetDesc', icon: 'star' },
  { id: 'wiki', nameKey: 'wikiWidget', descKey: 'wikiWidgetDesc', icon: 'search' },
  { id: 'groupfinder', nameKey: 'groupFinderWidget', descKey: 'groupFinderWidgetDesc', icon: 'group' },
  { id: 'market', nameKey: 'marketWidget', descKey: 'marketWidgetDesc', icon: 'market' },
  { id: 'minimap', nameKey: 'minimapWidget', descKey: 'minimapWidgetDesc', icon: 'map-pin', keywords: 'dungeon transparent overlay rooms' },
  { id: 'arena', nameKey: 'arenaFinderWidget', descKey: 'arenaFinderDesc', icon: 'arena' },
  { id: 'world-watch', nameKey: 'worldWatchWidget', descKey: 'worldWatchWidgetDesc', icon: 'clock', keywords: 'clock weather calendar world watch' },
  { id: 'clock', nameKey: 'clockWidget', descKey: 'clockWidgetDesc', icon: 'clock' },
  { id: 'weather', nameKey: 'weatherWidget', descKey: 'weatherWidgetDesc', icon: 'weather' },
  { id: 'build-exporter', nameKey: 'buildExporterWidget', descKey: 'buildExporterWidgetDesc', icon: 'clipboard' },
  { id: 'temper-tracker', nameKey: 'temperTrackerWidget', descKey: 'temperTrackerWidgetDesc', icon: 'temper' },
  { id: 'wolf-training', nameKey: 'wolfTrainingWidget', descKey: 'wolfTrainingWidgetDesc', icon: 'paw', keywords: 'wolf pet training companion paws' },
  { id: 'data-inventory', nameKey: 'dataInventoryWidget', descKey: 'dataInventoryWidgetDesc', icon: 'database', keywords: 'inventory json data snapshot search' },
  { id: 'data-ee-log', nameKey: 'dataEeLogWidget', descKey: 'dataEeLogWidgetDesc', icon: 'log', keywords: 'ee.log log data messages errors search' },
];
if (window.i18n?.titleTrackerEnabled === true) WIDGET_DEFS.push({
  id: 'title-tracker', nameKey: 'titleTrackerWidget', descKey: 'titleTrackerWidgetDesc', icon: 'title', keywords: 'epithet titles progress pinned',
});

const WIDGET_CATEGORIES = [
  { id: 'world', nameKey: 'widgetsCategoryWorld', name: 'World & exploration', widgets: ['arena', 'clock', 'daily', 'minimap', 'weather', 'world-watch'] },
  { id: 'timers', nameKey: 'widgetsCategoryTimers', name: 'Timers', widgets: ['boss', 'crafting', 'other'] },
  { id: 'progression', nameKey: 'widgetsCategoryProgression', name: 'Player & progression', widgets: ['affiliation', 'factions', 'mastery-tracker', 'odeinfamy', 'player', 'temper-tracker', 'title-tracker', 'wolf-training'] },
  { id: 'collection', nameKey: 'widgetsCategoryCollection', name: 'Collection & crafting', widgets: ['collection-log', 'cosmetics', 'crafting-log', 'crafting-planner', 'enhancements', 'resources'] },
  { id: 'community', nameKey: 'widgetsCategoryCommunity', name: 'Tools & community', widgets: ['build-exporter', 'groupfinder', 'market', 'wiki'] },
  { id: 'activity', nameKey: 'widgetsCategoryActivity', name: 'Activity & data', widgets: ['activity', 'session-analysis', 'data-inventory', 'data-ee-log'] },
];

function makeIcon(id) {
  const icon = document.createElement('span');
  icon.className = 'widget-card-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.appendChild(window.WidgetIcons.create(id, document));
  return icon;
}

document.addEventListener('DOMContentLoaded', () => {
  let config = {};
  let visibility = {};
  let widgetConnections = {};
  let t = TRANSLATIONS.en;
  let initialized = false;
  let loading = false;
  let saving = false;
  let loadError = false;
  let saveError = false;
  let closeAfterSave = false;
  let configRevision = 0;
  let connectionsRevision = 0;
  const pending = new Map();
  const cards = new Map();
  const categories = new Map();

  $('#close-btn').addEventListener('click', () => {
    if (pending.size > 0 && !saveError) {
      closeAfterSave = true;
      saveSelection();
    } else {
      window.api.windowClose();
    }
  });

  for (const category of WIDGET_CATEGORIES) {
    const section = document.createElement('section');
    section.className = 'widget-category';
    section.dataset.category = category.id;
    const heading = document.createElement('h2');
    heading.className = 'widget-category-title';
    heading.id = `widget-category-${category.id}`;
    section.setAttribute('aria-labelledby', heading.id);
    const grid = document.createElement('div');
    grid.className = 'widget-category-grid';
    section.append(heading, grid);
    $('#widgets-body').appendChild(section);
    categories.set(category.id, { section, heading, grid, order: '' });
  }

  for (const def of WIDGET_DEFS) {
    const card = document.createElement('div');
    card.className = 'widget-card';
    card.dataset.widget = def.id;
    card.dataset.keywords = def.keywords || '';

    const name = document.createElement('label');
    name.className = 'widget-card-name';
    name.id = `widget-name-${def.id}`;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `widget-toggle-${def.id}`;
    name.htmlFor = checkbox.id;
    checkbox.dataset.widget = def.id;
    checkbox.setAttribute('aria-labelledby', name.id);

    const desc = document.createElement('span');
    desc.className = 'widget-card-desc';
    desc.id = `widget-desc-${def.id}`;
    checkbox.setAttribute('aria-describedby', desc.id);

    const connect = document.createElement('button');
    connect.type = 'button';
    connect.className = 'widget-card-connect';
    connect.hidden = true;
    connect.setAttribute('aria-describedby', name.id);
    connect.addEventListener('click', () => window.api.openSettings('connections'));

    card.append(makeIcon(def.id), name, checkbox, desc, connect);
    cards.set(def.id, { card, name, checkbox, desc, connect });
    checkbox.addEventListener('change', () => {
      pending.set(def.id, checkbox.checked);
      render();
      saveSelection();
    });
  }

  function filterCards() {
    const lower = text => {
      try { return text.toLocaleLowerCase(document.documentElement.lang || 'en'); }
      catch { return text.toLowerCase(); }
    };
    const query = lower($('#widgets-search').value.trim());
    let visibleCount = 0;
    for (const category of WIDGET_CATEGORIES) {
      const group = categories.get(category.id);
      let categoryCount = 0;
      for (const id of category.widgets) {
        const item = cards.get(id);
        if (!item) continue;
        const { card, name, desc } = item;
        card.hidden = !lower(`${name.textContent} ${desc.textContent} ${card.dataset.keywords} ${group.heading.textContent}`).includes(query);
        if (!card.hidden) categoryCount++;
      }
      group.section.hidden = categoryCount === 0;
      visibleCount += categoryCount;
    }
    $('#widgets-empty').hidden = visibleCount !== 0;
  }

  function render() {
    t = { ...TRANSLATIONS.en, ...TRANSLATIONS[config.language || 'en'] };
    document.documentElement.lang = window.i18n?.localeTags?.[config.language] || config.language || 'en';
    document.title = $('#widgets-title').textContent = t.widgetsTitle || 'Widgets';
    $('#close-btn').title = t.tooltipClose || 'Close';
    $('#close-btn').setAttribute('aria-label', t.tooltipClose || 'Close');
    $('#widgets-search').placeholder = t.widgetsSearch || 'Search widgets';
    $('#widgets-search').setAttribute('aria-label', t.widgetsSearch || 'Search widgets');
    $('#widgets-empty').textContent = t.widgetsNoResults || 'No widgets match your search.';
    $('#widgets-hint').textContent = config.hideWhenGameClosed !== false
      ? t.widgetsHiddenHint || 'Widgets are hidden while the game is not running.'
      : t.widgetsAutoSaveHint || 'Select cards to show widgets. Changes save automatically.';

    let selectedCount = 0;
    for (const def of WIDGET_DEFS) {
      const { name, desc, checkbox, connect } = cards.get(def.id);
      name.textContent = t[def.nameKey] || TRANSLATIONS.en[def.nameKey] || def.id;
      desc.textContent = t[def.descKey] || TRANSLATIONS.en[def.descKey] || '';
      if (def.id === 'build-exporter') desc.textContent = window.api.buildWebsiteHost
        ? desc.textContent.replace('avakot.build', window.api.buildWebsiteHost) : t.inventoryUnavailableLower;
      if (def.id === 'wiki' && !window.api.wikiAvailable) desc.textContent = t.inventoryUnavailableLower;
      checkbox.checked = pending.has(def.id) ? pending.get(def.id) : visibility[def.id] === true;
      checkbox.disabled = !initialized;
      const wasFocused = document.activeElement === connect;
      const reason = widgetConnections[def.id];
      if (reason === 'artwork') connect.textContent = t.widgetsSignInForImages || 'Sign in to load images';
      else if (reason === 'market') connect.textContent = t.marketUiOpenConnections || 'Open Connections';
      else connect.textContent = t.settingsAvakotSignIn || 'Sign in with avakot.dev';
      connect.hidden = !reason;
      if (connect.hidden && wasFocused && !checkbox.disabled) checkbox.focus({ preventScroll: true });
      if (checkbox.checked) selectedCount++;
    }
    let collator;
    try { collator = new Intl.Collator(document.documentElement.lang, { sensitivity: 'base', numeric: true }); }
    catch { collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true }); }
    for (const category of WIDGET_CATEGORIES) {
      const group = categories.get(category.id);
      group.heading.textContent = t[category.nameKey] || category.name;
      const sorted = category.widgets.filter(id => cards.has(id)).sort((a, b) =>
        collator.compare(cards.get(a).name.textContent, cards.get(b).name.textContent) || a.localeCompare(b));
      const order = sorted.join(',');
      if (group.order !== order) {
        // A language change can move the card containing the focused control.
        const focused = group.grid.contains(document.activeElement) ? document.activeElement : null;
        group.grid.append(...sorted.map(id => cards.get(id).card));
        group.order = order;
        focused?.focus({ preventScroll: true });
      }
    }
    $('#widgets-count').textContent = (t.widgetsSelectedCount || '{count} / {total} selected')
      .replace('{count}', selectedCount).replace('{total}', WIDGET_DEFS.length);
    $('#widgets-retry').textContent = t.widgetsRetry || 'Retry';
    $('#widgets-retry').hidden = !(loadError || saveError);
    $('#widgets-feedback').hidden = !(loading || loadError || saveError);
    $('#widgets-feedback').dataset.error = String(loadError || saveError);
    $('#widgets-status').textContent = loadError ? t.widgetsLoadFailed || 'Could not load your widgets.'
      : saveError ? t.widgetsSaveFailed || 'Changes could not be saved.'
      : loading ? t.widgetsLoading || 'Loading widgets…' : '';
    filterCards();
  }

  function applyConfig(next) {
    config = { ...config, ...next };
    visibility = { ...(config.widgetVisibility || config.moduleVisibility || {}) };
    initialized = true;
    loadError = false;
    render();
  }

  async function loadState() {
    loading = true;
    loadError = false;
    render();
    const requestRevision = configRevision;
    const requestConnectionsRevision = connectionsRevision;
    try {
      const state = await window.api.getState();
      if (requestConnectionsRevision === connectionsRevision) widgetConnections = state?.widgetConnections || {};
      if (requestRevision === configRevision) applyConfig(state?.config || {});
    } catch {
      if (!initialized) loadError = true;
    } finally {
      loading = false;
      render();
    }
  }

  async function saveSelection() {
    if (saving || !initialized || pending.size === 0) return;
    saving = true;
    saveError = false;
    render();
    try {
      // Serialize writes, retaining newer clicks while an earlier save is in flight.
      // Start from the complete config map so unfamiliar/future widget IDs survive.
      while (pending.size > 0) {
        const changes = new Map(pending);
        const nextVisibility = { ...visibility, ...Object.fromEntries(changes) };
        const requestRevision = configRevision;
        const result = await window.api.saveConfig({ widgetVisibility: nextVisibility });
        if (result === false) throw new Error('Save failed');
        if (configRevision === requestRevision) visibility = nextVisibility;
        for (const [id, checked] of changes) {
          if (pending.get(id) === checked) pending.delete(id);
        }
        render();
      }
    } catch {
      // Keep unsaved intent available for Retry or the next selection change.
      saveError = true;
      closeAfterSave = false;
    } finally {
      saving = false;
      render();
      if (closeAfterSave && pending.size === 0) window.api.windowClose();
    }
  }

  $('#widgets-search').addEventListener('input', () => {
    filterCards();
    $('#widgets-scroll').scrollTop = 0;
  });
  $('#widgets-retry').addEventListener('click', () => initialized ? saveSelection() : loadState());
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      $('#widgets-search').focus();
      $('#widgets-search').select();
    }
  });
  window.api.onConfigChanged?.(next => {
    configRevision++;
    applyConfig(next);
  });
  window.api.onWidgetConnectionsChanged?.(connections => {
    connectionsRevision++;
    widgetConnections = connections;
    render();
  });
  loadState();
});
