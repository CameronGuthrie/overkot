/**
 * Widget Host – Standalone renderer for individual widget windows.
 *
 * Each widget window loads widget-host.html?widget=<id>, and this script
 * activates only the matching widget, receives state from the main process,
 * and handles dragging, click-through, and auto-fit.
 *
 * Shared logic lives in separate scripts loaded before this file:
 *   - shared-constants.js  — TRANSLATIONS
 *   - timer-utils.js       — timer duration, categorization, name lookup, rendering
 *   - widget-data.js       — affiliation, factions, group finder rendering
 *   - minimap.js           — canvas-based map renderer (Minimap namespace)
 */

// ═══════════════════════════════════════════════════════════
// Determine which widget this window hosts
// ═══════════════════════════════════════════════════════════
const WIDGET_ID = new URLSearchParams(window.location.search).get('widget');
// `embed=1` is set by the dock window when it loads us as an <iframe>. In
// that mode the widget is a passive cell — drag/resize/fit-window-size
// would target the dock window itself and break the layout, so we skip
// every code path that talks to the host window's bounds.
const IS_EMBEDDED = new URLSearchParams(window.location.search).get('embed') === '1';

// ═══════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════
let config = {};
let calendarWidget = null;
let clockWidget = null;
let weatherWidget = null;
let worldWatchWidget = null;
let buildExporterWidget = null;
let temperTrackerWidget = null;
let titleTrackerWidget = null;
let wolfTrainingWidget = null;
let dataViewer = null;
let inventoryModuleWidget = null;
let t = {};
let namesMap = {};
let currentTimers = [];
let dailyAffiliation = null;
let dailyAffiliationOde = null;
let factions = null;
let gfState = null;
let isDragging = false;
let layoutEditing = false;
let overlayInteractive = false;
let nativeShiftTracking = false;
let finishLayoutGesture = null;
let suppressLayoutClick = false;
let customWidth = 0;
let customHeight = 0;
let sizePreferenceKey = null;
let arenaStatus = 'unknown';
let arenaDetectionSource = 'none';
let arenaWave = null; // { wave, tier, total } | null

const $ = (sel) => document.querySelector(sel);

// ═══════════════════════════════════════════════════════════
// Initialization
// ═══════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  if (!WIDGET_ID) return;
  if (WIDGET_ID === 'title-tracker' && window.i18n.titleTrackerEnabled !== true) return;

  // Show only this widget's template
  const widget = document.querySelector(`.timer-widget[data-widget="${WIDGET_ID}"]`);
  if (widget) widget.style.display = '';

  // Hide the resize handle when running as a docked-grid cell — the dock
  // owns sizing in that mode.
  if (IS_EMBEDDED) {
    document.body.dataset.embedded = 'true';
    const handle = document.getElementById('resize-handle');
    if (handle) handle.style.display = 'none';
    // Report our natural content size to the parent dock window so it can
    // equalize column widths and stretch this iframe to the right height.
    setupEmbedSizeReporting();
  }

  // Load initial state
  const state = await window.api.getState();
  config = state.config || {};
  overlayInteractive = state.overlayInteractive === true;
  nativeShiftTracking = state.nativeLayoutTracking ?? state.platformSupport?.platform === 'win32';
  currentTimers = state.timers || [];
  namesMap = state.namesMap || {};
  if (state.timerDurations) setTimerDurationsData(state.timerDurations);
  dailyAffiliation = state.dailyAffiliation ?? null;
  dailyAffiliationOde = state.dailyAffiliationOde ?? null;
  if (state.factions != null) factions = state.factions;
  if (state.arenaStatus) arenaStatus = state.arenaStatus;
  if (state.arenaDetectionSource) arenaDetectionSource = state.arenaDetectionSource;
  if (state.arenaWave !== undefined) arenaWave = state.arenaWave;

  // Widget visibility belongs to the dock. Old collapse preferences must not
  // leave a newly opened widget displaying an empty title strip.
  widget?.classList.remove('collapsed');
  setLayoutEditing(state.layoutEditing === true);
  window.api.onLayoutEditing?.(setLayoutEditing);

  // Apply config
  const lang = window.i18n?.localeTags?.[config.language] || config.language || 'en';
  document.documentElement.lang = lang;
  t = (typeof TRANSLATIONS !== 'undefined' && TRANSLATIONS[lang]) || (typeof TRANSLATIONS !== 'undefined' && TRANSLATIONS.en) || {};
  applyConfig();
  applyTranslations();

  // Initial render
  render();

  // Fetch GF state for groupfinder widget
  if (WIDGET_ID === 'groupfinder') {
    window.api.gfGetState().then(s => { if (s) { gfState = s; renderGroupFinderWidget(); } }).catch(() => {});
  }

  // Init minimap if this is the minimap widget
  if (WIDGET_ID === 'minimap') {
    Minimap.init({ config, $ });
  }

  if (WIDGET_ID === 'calendar') {
    calendarWidget = CalendarWidget.mount(widget.querySelector('.calendar-content'), {
      language: lang, showOfferings: config.calendarShowOfferings !== false, onResize: fitWindowToContent,
    });
  }

  if (WIDGET_ID === 'clock') {
    clockWidget = ClockWidget.mount(widget.querySelector('.clock-content'), { language: lang, onResize: fitWindowToContent });
  }

  if (WIDGET_ID === 'weather') {
    weatherWidget = WeatherWidget.mount(widget.querySelector('.weather-content'), { language: lang, onResize: fitWindowToContent });
  }

  if (WIDGET_ID === 'world-watch') {
    worldWatchWidget = WorldWatchWidget.mount(widget.querySelector('.world-watch-content'), {
      api: window.api, language: lang, showOfferings: config.calendarShowOfferings !== false, onResize: fitWindowToContent,
      timerState: worldWatchTimerState(),
    });
    window.addEventListener('unload', () => worldWatchWidget?.destroy(), { once: true });
  }

  if (WIDGET_ID === 'build-exporter') {
    buildExporterWidget = BuildExporterWidget.mount(widget.querySelector('.build-exporter-content'), { language: lang, onResize: fitWindowToContent });
  }

  if (WIDGET_ID === 'temper-tracker') {
    temperTrackerWidget = TemperTrackerWidget.mount(widget.querySelector('.temper-content'), { language: lang, preferences: config.temperTrackerPreferences, onResize: fitWindowToContent });
  }

  if (WIDGET_ID === 'title-tracker') {
    titleTrackerWidget = TitleTrackerWidget.mount(widget.querySelector('.title-content'), { language: lang, preferences: config.titleTrackerPreferences, onResize: fitWindowToContent });
  }

  if (WIDGET_ID === 'player' || WIDGET_ID === 'daily') {
    const type = WIDGET_ID === 'player' ? window.PlayerWidget : window.DailyBriefWidget;
    inventoryModuleWidget = type.mount(widget.querySelector(WIDGET_ID === 'player' ? '.player-content' : '.daily-content'), { api: window.api, language: lang, onResize: fitWindowToContent });
    window.addEventListener('unload', () => inventoryModuleWidget?.destroy(), { once: true });
  }

  if (['collection-log', 'cosmetics', 'mastery-tracker', 'resources', 'enhancements', 'crafting-planner', 'activity', 'crafting-log'].includes(WIDGET_ID)) {
    const type = ['collection-log', 'cosmetics', 'mastery-tracker'].includes(WIDGET_ID) ? window.CollectionTrackerWidget : window.CollectionExtrasWidget;
    inventoryModuleWidget = type.mount(widget.querySelector('.collection-content'), { id: WIDGET_ID, api: window.api, language: lang, onResize: fitWindowToContent });
    window.addEventListener('unload', () => inventoryModuleWidget?.destroy(), { once: true });
  }
  if (WIDGET_ID === 'session-analysis') {
    inventoryModuleWidget = window.MasterySessionsWidget.mount(widget.querySelector('.collection-content'), { api: window.api, language: lang, onResize: fitWindowToContent });
    window.addEventListener('unload', () => inventoryModuleWidget?.destroy(), { once: true });
  }

  if (WIDGET_ID === 'wolf-training') {
    wolfTrainingWidget = WolfTrainingWidget.mount(widget.querySelector('.wolf-training-content'), { api: window.api, language: lang, onResize: fitWindowToContent });
    window.addEventListener('unload', () => wolfTrainingWidget?.destroy(), { once: true });
  }

  if (WIDGET_ID === 'data-inventory' || WIDGET_ID === 'data-ee-log') {
    dataViewer = DataViewer.mount(widget.querySelector('.data-content'), {
      kind: WIDGET_ID === 'data-inventory' ? 'inventory' : 'ee-log', api: window.api, names: namesMap, language: lang,
    });
    window.addEventListener('unload', () => dataViewer?.destroy(), { once: true });
  }

  // Set widget type on body for CSS targeting
  document.body.dataset.widget = WIDGET_ID;

  // Bind events
  bindWidgetEvents();
  bindDragToMove();
  bindResizeHandle();
  setupOverlayInteractionListeners();

  // Listen for size reset from settings
  window.api.onResetWidgetSizes(() => {
    const size = config.widgetSizes?.[WIDGET_ID];
    if (size && (size.width != null || size.height != null)) {
      applyWidgetSizePreferences();
      return;
    }
    customWidth = 0;
    customHeight = 0;
    applyWidgetSizeStyles();
    fitWindowToContent();
  });
  window.api.onWidgetLayoutApplied?.(restoreWidgetLayout);

  // Restore custom width if the saved bounds (applied by main process) differ from natural content width
  if (!config.widgetSizes?.[WIDGET_ID] && WIDGET_ID !== 'minimap' && !WIDGET_ID.startsWith('data-')) {
    const savedWidth = window.outerWidth;
    const naturalWidth = Math.max(document.body.scrollWidth, 300);
    if (Math.abs(savedWidth - naturalWidth) > 2) {
      customWidth = savedWidth;
      document.body.style.maxWidth = savedWidth + 'px';
    }
  }

  // Auto-fit after first render
  fitWindowToContent();

  // Listen for state updates
  window.api.onStateUpdate((data) => {
    if (typeof data.overlayInteractive === 'boolean') overlayInteractive = data.overlayInteractive;
    if (typeof data.layoutEditing === 'boolean') setLayoutEditing(data.layoutEditing);
    currentTimers = data.timers || [];
    if (data.namesMap) namesMap = data.namesMap;
    dataViewer?.setNames(namesMap);
    if (data.timerDurations) setTimerDurationsData(data.timerDurations);
    if (Object.hasOwn(data, 'dailyAffiliation')) dailyAffiliation = data.dailyAffiliation;
    if (Object.hasOwn(data, 'dailyAffiliationOde')) dailyAffiliationOde = data.dailyAffiliationOde;
    if (data.factions != null) factions = data.factions;
    if (data.arenaStatus) arenaStatus = data.arenaStatus;
    if (data.arenaDetectionSource) arenaDetectionSource = data.arenaDetectionSource;
    if (data.arenaWave !== undefined) arenaWave = data.arenaWave;
    render();
    fitWindowToContent();
  });

  // Arena status updates (Glades enter/exit + arena tile)
  window.api.onArenaStatus((status, source) => {
    arenaStatus = status;
    if (source) arenaDetectionSource = source;
    if (WIDGET_ID === 'arena') {
      renderArena();
      fitWindowToContent();
    }
  });

  // Arena wave counter updates (separate channel from arena-status so the
  // status badge isn't redundantly re-rendered every wave).
  window.api.onArenaWave((wave) => {
    arenaWave = wave;
    if (WIDGET_ID === 'arena') {
      renderArena();
      fitWindowToContent();
    }
  });

  // Listen for GF state updates
  if (WIDGET_ID === 'groupfinder') {
    window.api.gfOnStateUpdate((data) => {
      gfState = data;
      renderGroupFinderWidget();
      fitWindowToContent();
    });
  }

  // Countdown ticker for timer widgets
  if (['boss', 'crafting', 'other'].includes(WIDGET_ID)) {
    setInterval(() => render(), 1000);
  }

  // Listen for config changes
  window.api.onConfigChanged((newConfig) => {
    config = newConfig;
    const lang = window.i18n?.localeTags?.[config.language] || config.language || 'en';
    document.documentElement.lang = lang;
    t = (typeof TRANSLATIONS !== 'undefined' && TRANSLATIONS[lang]) || (typeof TRANSLATIONS !== 'undefined' && TRANSLATIONS.en) || {};
    if (newConfig.poiVisibility && typeof newConfig.poiVisibility === 'object' && WIDGET_ID === 'minimap' && Minimap.inited) {
      const vis = Minimap.poiVisibility;
      for (const k of Object.keys(vis)) {
        if (typeof newConfig.poiVisibility[k] === 'boolean') vis[k] = newConfig.poiVisibility[k];
      }
      Minimap.invalidateSpreadCache();
      Minimap.scheduleRender();
      Minimap.rebuildLegend(newConfig);
    }
    applyConfig();
    applyTranslations();
    calendarWidget?.setLanguage(lang);
    calendarWidget?.setShowOfferings(config.calendarShowOfferings !== false);
    clockWidget?.setLanguage(lang);
    weatherWidget?.setLanguage(lang);
    worldWatchWidget?.setLanguage(lang);
    worldWatchWidget?.setShowOfferings(config.calendarShowOfferings !== false);
    buildExporterWidget?.setLanguage(lang);
    temperTrackerWidget?.setLanguage(lang);
    temperTrackerWidget?.setPreferences(newConfig.temperTrackerPreferences);
    titleTrackerWidget?.setLanguage(lang);
    titleTrackerWidget?.setPreferences(newConfig.titleTrackerPreferences);
    wolfTrainingWidget?.setLanguage(lang);
    inventoryModuleWidget?.setLanguage(lang);
    dataViewer?.setLanguage(lang);
    render();
    fitWindowToContent();
  });
});

// ═══════════════════════════════════════════════════════════
// Config → DOM
// ═══════════════════════════════════════════════════════════
function applyConfig() {
  OverkotTheme.apply(config);
  applyWidgetSizePreferences();
  if (config.hideBars) document.body.classList.add('bars-hidden');
  else document.body.classList.remove('bars-hidden');
}

function applyTranslations() {
  const widget = document.querySelector(`.timer-widget[data-widget="${WIDGET_ID}"]`);
  if (!widget) return;
  for (const element of widget.querySelectorAll('[data-i18n]')) {
    const key = element.dataset.i18n;
    element.textContent = t[key] || TRANSLATIONS.en[key] || element.textContent;
  }
  const collectionKey = { 'collection-log': 'collectionLogWidget', cosmetics: 'cosmeticsWidget', 'mastery-tracker': 'masteryTrackerWidget', resources: 'resourcesWidget', enhancements: 'enhancementsWidget', 'crafting-planner': 'craftingPlannerWidget', activity: 'activityWidget', 'crafting-log': 'craftingLogWidget' }[WIDGET_ID];
  if (collectionKey) widget.setAttribute('aria-label', t[collectionKey] || TRANSLATIONS.en[collectionKey]);
  if (WIDGET_ID === 'session-analysis') widget.setAttribute('aria-label', t.sessionAnalysisWidget || TRANSLATIONS.en.sessionAnalysisWidget);
  const title = widget.querySelector('.widget-title');
  {
    const keys = { player: 'playerWidget', daily: 'dailyWidget', boss: 'bossTimers', crafting: 'craftingTimers', other: 'otherTimers', affiliation: 'affiliationWidget', factions: 'factionsWidget', odeinfamy: 'odeInfamyWidget', wiki: 'wikiWidget', groupfinder: 'groupFinderWidget', minimap: 'minimapWidget', arena: 'arenaFinderWidget', 'world-watch': 'worldWatchWidget', clock: 'clockWidget', weather: 'weatherWidget', 'build-exporter': 'buildExporterWidget', 'temper-tracker': 'temperTrackerWidget', 'title-tracker': 'titleTrackerWidget', 'wolf-training': 'wolfTrainingWidget' };
    const label = t[keys[WIDGET_ID]] || TRANSLATIONS.en[keys[WIDGET_ID]];
    if (label) widget.setAttribute('aria-label', label);
    if (title && label) title.textContent = label;
  }

  // Wiki widget: search placeholder
  if (WIDGET_ID === 'wiki') {
    const wikiInput = $('#wiki-search-input');
    if (wikiInput) {
      wikiInput.disabled = !window.api.wikiAvailable;
      wikiInput.placeholder = wikiInput.disabled ? `${t.wikiWidget} · ${t.inventoryUnavailableLower}` : t.wikiSearchPlaceholder;
    }
  }

  // Group Finder widget: labels
  if (WIDGET_ID === 'groupfinder') {
    const myListingLabel = widget.querySelector('.gf-widget-label');
    const labels = widget.querySelectorAll('.gf-widget-label');
    if (labels[0]) labels[0].textContent = t.gfMyListingLabel || 'My Listing:';
    if (labels[1]) labels[1].textContent = t.gfOpenListingsLabel || 'Open Listings:';
    if (labels[2]) labels[2].textContent = t.gfRequestsLabel || 'Requests:';
    const openBtn = $('#gf-widget-open-btn');
    if (openBtn) openBtn.textContent = t.gfOpenGroupFinder || 'Open Group Finder';
  }
}

// ═══════════════════════════════════════════════════════════
// Dispatch render to the correct widget type
// ═══════════════════════════════════════════════════════════
function render() {
  if (['boss', 'crafting', 'other'].includes(WIDGET_ID)) renderTimers();
  else if (WIDGET_ID === 'affiliation') renderAffiliation();
  else if (WIDGET_ID === 'factions') renderFactions();
  else if (WIDGET_ID === 'odeinfamy') renderOdeInfamy();
  else if (WIDGET_ID === 'groupfinder') renderGroupFinderWidget();
  else if (WIDGET_ID === 'arena') renderArena();
  else if (WIDGET_ID === 'world-watch') worldWatchWidget?.setTimerState(worldWatchTimerState());
  // wiki and minimap don't need periodic re-render
}

function worldWatchTimerState() {
  return { timers: currentTimers, namesMap, totalSeconds: getTimerDuration('UPGRADEGIVEN_GODANDGHOST') };
}

// ═══════════════════════════════════════════════════════════
// Timer rendering (boss / crafting / other)
// ═══════════════════════════════════════════════════════════
function renderTimers() {
  const nowSecs = Math.floor(Date.now() / 1000);
  const mod = $(`.timer-widget[data-widget="${WIDGET_ID}"]`);
  if (!mod) return;

  const timersContainer = mod.querySelector('.widget-timers');
  const emptyEl = mod.querySelector('.widget-empty');
  const countEl = mod.querySelector('.widget-count');

  // Filter to this widget's category
  const catTimers = (currentTimers || [])
    .filter(timer => categorizeTimer(timer.tag) === WIDGET_ID)
    .sort((a, b) => (a.expiryTime - nowSecs) - (b.expiryTime - nowSecs));

  if (countEl) countEl.textContent = catTimers.length;

  if (catTimers.length === 0) {
    emptyEl.classList.remove('hidden');
    if (timersContainer.children.length) timersContainer.replaceChildren();
    return;
  }

  emptyEl.classList.add('hidden');
  const rows = catTimers.map(timer => {
    const remaining = timer.expiryTime - nowSecs;
    return { key: JSON.stringify([timer.tag, timer.expiryTime]), tag: timer.tag, remaining,
      name: lookupTimerName(namesMap, timer.tag), time: formatTime(timer.tag, remaining, t) };
  });
  const entries = reconcileNormalTimers(timersContainer, rows, { hideCountdown: config.hideCountdown, readyLabel: t.ready || 'Ready' });
  catTimers.forEach((timer, index) => {
    const remaining = timer.expiryTime - nowSecs;
    const duration = getTimerDuration(timer.tag);
    window.OverkotMotion?.sample(`timer:${WIDGET_ID}:${timer.tag}:${timer.expiryTime}`, {
      value: (duration - Math.max(remaining, 0)) / Math.max(duration, 1),
      complete: remaining <= 0, urgent: remaining > 0 && remaining <= 60, element: entries[index],
    });
  });
}

// renderNormal → provided by timer-utils.js

// ═══════════════════════════════════════════════════════════
// Affiliation rendering (delegated to widget-data.js)
// ═══════════════════════════════════════════════════════════

function renderAffiliation() {
  renderAffiliationWidget($('.timer-widget[data-widget="affiliation"]'), dailyAffiliation, t, null);
}

// ═══════════════════════════════════════════════════════════
// Faction standing rendering (delegated to widget-data.js)
// ═══════════════════════════════════════════════════════════

function renderFactions() {
  renderFactionsWidget($('.timer-widget[data-widget="factions"]'), factions, t, null, namesMap);
}

// ═══════════════════════════════════════════════════════════
// Ode Infamy widget rendering (delegated to widget-data.js)
// ═══════════════════════════════════════════════════════════

function renderOdeInfamy() {
  renderOdeInfamyWidget($('.timer-widget[data-widget="odeinfamy"]'), factions, t, null, namesMap, dailyAffiliationOde);
}

// ═══════════════════════════════════════════════════════════
// Group Finder widget rendering (delegated to widget-data.js)
// ═══════════════════════════════════════════════════════════
function renderGroupFinderWidget() {
  renderGroupFinderWidgetCard(gfState, t, $);
}

// ═══════════════════════════════════════════════════════════
// Arena Finder rendering (current decoded dungeon tile, log fallback)
// ═══════════════════════════════════════════════════════════
function renderArena() {
  const dot = $('#arena-status-dot');
  const text = $('#arena-status-text');
  if (!dot || !text) return;

  const map = {
    unknown:        { cls: 'unknown',        key: 'arenaWaitingForTiles', fallback: 'Waiting for dungeon data…' },
    not_in_glades:  { cls: 'not-in-glades',  key: 'arenaNotConfirmed', fallback: 'Arena not confirmed' },
    not_in_dungeon: { cls: 'not-in-glades', key: 'arenaOutsideDungeon', fallback: 'Outside a dungeon' },
    no_arena:       { cls: 'no-arena',       key: 'arenaNoArena',     fallback: 'No arena found' },
    arena:          { cls: 'arena',          key: 'arenaFound',       fallback: 'Arena found!' },
  };
  const entry = map[arenaStatus] || map.unknown;
  dot.className = `arena-status-dot ${entry.cls}`;
  text.textContent = (t && t[entry.key]) || entry.fallback;
  const source = typeof arenaDetectionSource === 'string' ? arenaDetectionSource : 'none';
  text.title = source === 'tiles' ? (t.arenaTileSource || 'Current dungeon tile data')
    : source === 'log' ? (t.arenaLogSource || 'Log fallback · dungeon tiles unavailable') : '';

  // Wave counter — only shown while we have an active wave reading. The
  // watcher clears it whenever we leave the arena tile so this row hides
  // automatically. Joining a run mid-way naturally lands here too: the
  // first wave the log reports (e.g. wave 7) is what we display.
  const row = $('#arena-wave-row');
  if (!row) return;
  if (arenaStatus !== 'arena' || !arenaWave || typeof arenaWave.wave !== 'number') {
    row.style.display = 'none';
    return;
  }
  row.style.display = '';
  const total = arenaWave.total || 20;
  const wave  = Math.min(Math.max(arenaWave.wave, 0), total);
  const pct   = (wave / total) * 100;
  const waveLabel = (t && t.arenaWaveLabel) || 'Wave';
  const labelEl = $('#arena-wave-label');
  const valueEl = $('#arena-wave-value');
  const fillEl  = $('#arena-wave-fill');
  const pctEl   = $('#arena-wave-pct');
  if (labelEl) labelEl.textContent = waveLabel;
  if (valueEl) valueEl.textContent = `${wave} / ${total}`;
  if (fillEl)  fillEl.style.width = `${pct}%`;
  if (pctEl)   pctEl.textContent = `${Math.round(pct)}%`;
}

// ═══════════════════════════════════════════════════════════
// Widget content events (wiki search, GF open)
// ═══════════════════════════════════════════════════════════
function bindWidgetEvents() {
  const widget = document.querySelector(`.timer-widget[data-widget="${WIDGET_ID}"]`);
  if (!widget) return;

  // Wiki search
  if (WIDGET_ID === 'wiki') {
    const wikiInput = $('#wiki-search-input');
    if (wikiInput) {
      wikiInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const query = wikiInput.value.trim();
          if (query) {
            window.api.openWikiSearch(query);
            wikiInput.value = '';
            wikiInput.blur();
          }
        }
      });
    }
  }

  // Group Finder open button
  if (WIDGET_ID === 'groupfinder') {
    const gfOpenBtn = $('#gf-widget-open-btn');
    if (gfOpenBtn) gfOpenBtn.addEventListener('click', () => window.api.openGroupFinder());
  }
}

// ═══════════════════════════════════════════════════════════
// Layout editing: Shift temporarily makes the whole widget movable.
// ═══════════════════════════════════════════════════════════
function bindDragToMove() {
  window.api.onLayoutKeyMonitorStatus?.((active) => { nativeShiftTracking = !!active; });
  // Embedded cells inside the dock are dragged at the dock level, not by
  // moving their iframe (which would resize the dock window itself).
  if (IS_EMBEDDED) { bindEmbedDrag(); return; }
  const region = document.querySelector(`.timer-widget[data-widget="${WIDGET_ID}"]`);
  if (!region) return;

  // Capture before map panning, form controls, and widget-specific handlers.
  // Clicking content in normal use retains all of its usual behavior.
  document.addEventListener('pointerdown', event => {
    if (!layoutEditing && (!event.shiftKey || !document.hasFocus())) { suppressLayoutClick = false; return; }
    if (event.button !== 0 || event.isPrimary === false || finishLayoutGesture) return;
    if (event.target.closest('#resize-handle') || !region.contains(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!layoutEditing) {
      setLayoutEditing(true);
      window.api.setLayoutEditing?.(true);
    }
    beginWidgetDrag(region, event);
  }, true);

  for (const type of ['click', 'dblclick', 'contextmenu', 'wheel']) {
    document.addEventListener(type, event => {
      if (!layoutEditing && !isDragging && !(event.shiftKey && document.hasFocus()) && !(type === 'click' && suppressLayoutClick)) return;
      if (type === 'click') suppressLayoutClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { capture: true, passive: false });
  }
  document.addEventListener('keydown', event => {
    if (event.key === 'Shift' && !nativeShiftTracking && document.hasFocus()) {
      setLayoutEditing(true);
      window.api.setLayoutEditing?.(true);
    }
    if (!layoutEditing || event.key === 'Shift' || event.key === 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  document.addEventListener('keyup', event => {
    if (event.key !== 'Shift' || event.shiftKey || nativeShiftTracking) return;
    setLayoutEditing(false);
    window.api.setLayoutEditing?.(false);
  }, true);
  window.addEventListener('blur', () => {
    if (nativeShiftTracking) return;
    setLayoutEditing(false);
    window.api.setLayoutEditing?.(false);
  });
}

function setLayoutEditing(editing) {
  const next = editing === true && !IS_EMBEDDED;
  if (!next && finishLayoutGesture) finishLayoutGesture(false);
  layoutEditing = next;
  document.body.classList.toggle('layout-editing', next);
  document.body.dataset.layoutEditing = String(next);
}

function beginWidgetDrag(region, event) {
  const threshold = 3;
  const state = { pointerId: event.pointerId, x: event.screenX, y: event.screenY, dx: 0, dy: 0, moved: false, frame: 0 };
  isDragging = true;
  suppressLayoutClick = true;
  document.body.classList.add('layout-dragging');
  region.setPointerCapture(event.pointerId);
  window.api.windowDragStart(threshold, false);

  const flush = () => {
    state.frame = 0;
    if (state.dx || state.dy) window.api.windowMoveBy(state.dx, state.dy, false);
    state.dx = 0;
    state.dy = 0;
  };
  const finish = (cancelled = false, pointerEvent) => {
    if (finishLayoutGesture !== finish || (pointerEvent && pointerEvent.pointerId !== state.pointerId)) return;
    finishLayoutGesture = null;
    if (state.frame) cancelAnimationFrame(state.frame);
    if (!cancelled) flush();
    region.removeEventListener('pointermove', move);
    region.removeEventListener('pointerup', up);
    region.removeEventListener('pointercancel', abort);
    region.removeEventListener('lostpointercapture', abort);
    window.removeEventListener('blur', blur);
    window.api.windowDragEnd(cancelled);
    if (region.hasPointerCapture(state.pointerId)) region.releasePointerCapture(state.pointerId);
    isDragging = false;
    document.body.classList.remove('layout-dragging');
    positionResizeHandle();
    fitWindowToContent();
  };
  const move = pointerEvent => {
    if (pointerEvent.pointerId !== state.pointerId) return;
    if ((pointerEvent.buttons & 1) === 0) { finish(false, pointerEvent); return; }
    const dx = pointerEvent.screenX - state.x;
    const dy = pointerEvent.screenY - state.y;
    if (!state.moved && Math.max(Math.abs(dx), Math.abs(dy)) > threshold) state.moved = true;
    if (!state.moved) return;
    state.dx += dx;
    state.dy += dy;
    state.x = pointerEvent.screenX;
    state.y = pointerEvent.screenY;
    if (!state.frame) state.frame = requestAnimationFrame(flush);
  };
  const up = pointerEvent => finish(false, pointerEvent);
  const abort = pointerEvent => finish(true, pointerEvent);
  const blur = () => finish(true);
  finishLayoutGesture = finish;
  region.addEventListener('pointermove', move);
  region.addEventListener('pointerup', up);
  region.addEventListener('pointercancel', abort);
  region.addEventListener('lostpointercapture', abort);
  window.addEventListener('blur', blur);
}

// ═══════════════════════════════════════════════════════════
// Click-through overlay interaction
// ═══════════════════════════════════════════════════════════
function setupOverlayInteractionListeners() {
  window.api.onOverlayInteraction((interactive) => {
    overlayInteractive = interactive === true;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlayInteractive) {
      window.api.exitInteractiveMode();
    }
  });
}

// ═══════════════════════════════════════════════════════════
// Auto-fit window size to content
// ═══════════════════════════════════════════════════════════
let fitDebounceTimer = null;

function applyWidgetSizeStyles() {
  document.body.style.maxWidth = customWidth ? customWidth + 'px' : '';
  document.body.classList.toggle('widget-manual-height', customHeight > 0);
  positionResizeHandle();
}

function applyWidgetSizePreferences() {
  if (IS_EMBEDDED) return;
  const size = config.widgetSizes?.[WIDGET_ID] || null;
  const key = JSON.stringify(size);
  if (key === sizePreferenceKey) return;
  sizePreferenceKey = key;
  customWidth = Number.isFinite(size?.width) && size.width > 0 ? size.width : 0;
  customHeight = Number.isFinite(size?.height) && size.height > 0 ? size.height : 0;
  applyWidgetSizeStyles();
}

function restoreWidgetLayout(bounds) {
  if (IS_EMBEDDED || !Number.isFinite(bounds?.width) || bounds.width <= 0) return;
  clearTimeout(fitDebounceTimer);
  const size = config.widgetSizes?.[WIDGET_ID];
  customWidth = Object.hasOwn(config, 'widgetSizes') ? (size?.width || 0) : bounds.width;
  customHeight = size?.height || 0;
  if (WIDGET_ID !== 'minimap' && !WIDGET_ID.startsWith('data-')) {
    document.body.style.maxWidth = customWidth ? customWidth + 'px' : '';
  }
  document.body.classList.toggle('widget-manual-height', customHeight > 0);
  positionResizeHandle();
  fitWindowToContent();
}

function fitWindowToContent() {
  // In embedded mode the iframe is sized by the dock; we must never call
  // fit-window-size from here because it would resize the dock window.
  // Instead, push our natural content size to the dock so it can stretch
  // this cell and equalize the column.
  if (IS_EMBEDDED) { reportEmbedSize(); return; }
  if (isDragging) return;
  // The minimap fills its viewport and preserves the size chosen in layout mode.
  if (WIDGET_ID === 'minimap' || WIDGET_ID.startsWith('data-')) { positionResizeHandle(); return; }
  clearTimeout(fitDebounceTimer);
  fitDebounceTimer = setTimeout(() => {
    if (isDragging) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (isDragging) return;
        // Only grow the window when content actually overflows horizontally.
        // Comparing scrollWidth against outerWidth with a fixed 4px tolerance is
        // unreliable on systems with non-integer DPI scaling or certain font
        // rasterisers — `scrollWidth` can sit a few pixels above `outerWidth`
        // round after round, producing a feedback loop that slowly grows the
        // window (most visible while the user is dragging it). Using
        // `clientWidth` (the actual viewport) avoids that jitter entirely.
        const overflow = document.body.scrollWidth - document.body.clientWidth;
        const measuredWidth = Math.max(document.body.scrollWidth, 300);
        const autoWidth = overflow > 1
          ? measuredWidth
          : window.outerWidth;
        const contentWidth = customWidth || autoWidth;
        // The viewport and fixed resize handle can keep body.scrollHeight at
        // the old window height after a panel closes. Measure the actual card.
        const activeWidget = document.querySelector(`.timer-widget[data-widget="${WIDGET_ID}"]`);
        const contentHeight = customHeight || (activeWidget ? Math.ceil(activeWidget.getBoundingClientRect().height) : document.body.scrollHeight);
        if (contentWidth > 0 && contentHeight > 0) {
          window.api.fitWindowSize(contentWidth, contentHeight);
        }
        positionResizeHandle();
      });
    });
  }, 50);
}

// Anchor the resize handle to the active widget's actual right/bottom edge.
// The handle is `position: fixed` to the viewport, so if the Electron window
// width ever drifts wider than the rendered widget (e.g. during a drag, or
// while a saved bounds + maxWidth cap is in effect), the handle would slide
// away from the visible content. Re-pin it to the widget's bounding rect on
// every layout pass so it always sits flush with the rendered corner.
function positionResizeHandle() {
  if (IS_EMBEDDED) return;
  const handle = document.getElementById('resize-handle');
  if (!handle) return;
  const widget = document.querySelector(`.timer-widget[data-widget="${WIDGET_ID}"]`);
  if (!widget) return;
  const rect = widget.getBoundingClientRect();
  const rightOffset = Math.max(Math.round(window.innerWidth - rect.right), 0);
  const bottomOffset = Math.max(Math.round(window.innerHeight - rect.bottom), 0);
  handle.style.right = rightOffset + 'px';
  handle.style.bottom = bottomOffset + 'px';
}

// ═══════════════════════════════════════════════════════════
// Embedded (docked-grid) size reporting
// ═══════════════════════════════════════════════════════════
// When this widget runs inside the dock window as an <iframe>, the dock
// owns layout. It needs to know each widget's natural content size so it
// can equalize column widths (column = max widget width) and stretch each
// cell to its natural height. We push that on every layout-relevant change
// using a ResizeObserver, and on demand from fitWindowToContent().
let _embedLastReport = { w: 0, h: 0 };
let _embedRafPending = false;
function setupEmbedSizeReporting() {
  if (!IS_EMBEDDED) return;
  // Defer until the first widget render so the body has real content.
  const ro = new ResizeObserver(() => reportEmbedSize());
  // Observe the active widget element if present, else fall back to body.
  requestAnimationFrame(() => {
    const widget = document.querySelector(`.timer-widget[data-widget="${WIDGET_ID}"]`);
    ro.observe(widget || document.body);
    reportEmbedSize();
  });
}
function reportEmbedSize() {
  if (!IS_EMBEDDED) return;
  if (_embedRafPending) return;
  _embedRafPending = true;
  requestAnimationFrame(() => {
    _embedRafPending = false;
    const widget = document.querySelector(`.timer-widget[data-widget="${WIDGET_ID}"]`);
    const target = widget || document.body;
    // scrollWidth/Height capture the natural content size even when the
    // iframe is currently smaller than the content.
    const w = Math.max(target.scrollWidth, target.getBoundingClientRect().width || 0);
    const h = Math.max(target.scrollHeight, target.getBoundingClientRect().height || 0);
    const W = Math.ceil(w);
    const H = Math.ceil(h);
    if (W === _embedLastReport.w && H === _embedLastReport.h) return;
    _embedLastReport = { w: W, h: H };
    try {
      window.parent.postMessage(
        { type: 'overkot-widget-size', widget: WIDGET_ID, w: W, h: H },
        '*'
      );
    } catch (_) { /* parent gone */ }
  });
}

// Embed-mode drag: forwards mouse events from the widget header up to the
// dock window via postMessage. The dock owns drag state; this iframe just
// reports cursor positions in dock-window coordinates.
//
// We translate iframe-local clientX/Y into dock-window-local clientX/Y by
// adding the iframe element's offset. The iframe doesn't know its own
// offset directly (cross-frame), so we send local coords + the widget id
// and the dock looks up the iframe's bounding rect itself when it
// needs page coordinates. To keep this code simple and compatible with
// the dock's existing clientX/clientY handlers, we instead send the
// cursor's *screen* coordinates and let the dock convert via
// `screenX - window.screenX`. Easier: post screenX/Y directly.
function bindEmbedDrag() {
  const dragRegions = document.querySelectorAll('.widget-drag-region');
  dragRegions.forEach(region => {
    region.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('button') || e.target.closest('input')) return;
      e.preventDefault();
      // Convert this iframe's coordinates into dock-window coordinates by
      // walking the frameElement's offset chain. We can't do that from
      // inside the iframe, so we post screen coords and let the dock
      // subtract its own screen origin.
      const post = (type, ev) => {
        try {
          window.parent.postMessage({
            type,
            widget: WIDGET_ID,
            screenX: ev.screenX,
            screenY: ev.screenY,
            clientX: ev.clientX,
            clientY: ev.clientY,
          }, '*');
        } catch (_) { /* parent gone */ }
      };
      post('overkot-embed-drag-start', e);

      const onMove = (ev) => post('overkot-embed-drag-move', ev);
      const onUp   = (ev) => {
        post('overkot-embed-drag-end', ev);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

// ═══════════════════════════════════════════════════════════
// Manual resize handle
// ═══════════════════════════════════════════════════════════
function bindResizeHandle() {
  if (IS_EMBEDDED) return;
  const handle = document.getElementById('resize-handle');
  if (!handle) return;
  const sizing = window.OverkotWidgetSizing;
  if (!sizing) return;
  const readout = document.getElementById('widget-size-readout');
  window.addEventListener('resize', () => {
    positionResizeHandle();
    if (readout && !readout.hidden) readout.textContent = `${window.innerWidth} × ${window.innerHeight} px`;
  });

  handle.addEventListener('pointerdown', (e) => {
    if (!layoutEditing || e.button !== 0 || e.isPrimary === false || finishLayoutGesture) return;
    e.preventDefault();
    e.stopPropagation();
    isDragging = true;
    suppressLayoutClick = true;
    handle.setPointerCapture(e.pointerId);
    const startX = e.screenX;
    const startY = e.screenY;
    const startWidth = window.outerWidth;
    const startHeight = window.outerHeight;
    let last = null;
    let precise = config.widgetResizeMode === 'free' || e.altKey === true;
    if (readout) { readout.hidden = false; readout.textContent = `${startWidth} × ${startHeight} px`; }

    const onPointerMove = (event) => {
      if (event.pointerId !== e.pointerId) return;
      if ((event.buttons & 1) === 0) { finish(false, event); return; }
      const dx = event.screenX - startX, dy = event.screenY - startY;
      if (!last && Math.max(Math.abs(dx), Math.abs(dy)) < 2) return;
      precise = config.widgetResizeMode === 'free' || event.altKey === true;
      last = sizing.resizeSize({ id: WIDGET_ID, startWidth, startHeight, dx, dy, mode: precise ? 'free' : 'grid' });
      customWidth = last.width;
      customHeight = last.height;
      applyWidgetSizeStyles();
      if (readout) readout.textContent = `${last.width} × ${last.height} px${precise ? ' · Precise' : ' · Grid'}`;
      window.api.windowResizeTo(last.width, last.height, { manual: true, precise, commit: false });
    };
    const finish = (_cancelled = false, event) => {
      if (finishLayoutGesture !== finish || (event && event.pointerId !== e.pointerId)) return;
      finishLayoutGesture = null;
      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', abort);
      handle.removeEventListener('lostpointercapture', abort);
      window.removeEventListener('blur', blur);
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      if (last) window.api.windowResizeTo(last.width, last.height, { manual: true, precise, commit: true });
      if (readout) readout.hidden = true;
      isDragging = false;
      fitWindowToContent();
    };
    const up = event => finish(false, event);
    const abort = event => finish(true, event);
    const blur = () => finish(true);
    finishLayoutGesture = finish;
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', abort);
    handle.addEventListener('lostpointercapture', abort);
    window.addEventListener('blur', blur);
  });
}

// ═══════════════════════════════════════════════════════════
// Mini-Map (delegated to minimap.js → Minimap namespace)
// ═══════════════════════════════════════════════════════════
