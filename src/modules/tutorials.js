/** Shared tutorial catalogue and completion state for the main process and renderer. */
(function (root, factory) {
  const tutorials = factory();
  if (typeof module === 'object' && module.exports) module.exports = tutorials;
  else root.OverkotTutorials = tutorials;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  const WIDGET_TUTORIALS = {
    'session-analysis': {
      name: 'Session Analysis', icon: 'analysis', intro: 'Track mastery gains and rank-ups during observed live sessions.',
      detailTitle: 'Review your progress', detail: 'Choose the current session or a history period to see mastery XP, observed rates and the session timeline. History is saved privately on this device for the current account.',
      tip: 'Tracking starts from a live baseline. Saved inventory and offline play do not create sessions or gains.',
    },
    'collection-log': {
      name: 'Collection Log', icon: 'collection', intro: 'Track weapons, armour, Pacts, cosmetics and discoveries against the published game catalogue.',
      detailTitle: 'Choose your next collection goal', detail: 'Search or choose a category, filter missing items, and use the star to pin goals. Ownership reflects the current inventory; XP history preserves previously used gear.',
      tip: 'Discoveries shows published memory targets and world tree progress. Missing inventory sections show as unavailable.',
    },
    cosmetics: {
      name: 'Cosmetics', icon: 'cosmetics', intro: 'Keep track of the adornments and skins in your collection.',
      detailTitle: 'Find what is missing', detail: 'Search the catalogue, filter owned or missing cosmetics, and star the pieces you want to collect.',
      tip: 'Live and saved inventory labels show how recent your ownership information is.',
    },
    'mastery-tracker': {
      name: 'Envoy Rank & Mastery', icon: 'mastery', intro: 'See Envoy Rank calculated from the mastery contributions in your inventory.',
      detailTitle: 'Plan your mastery progress', detail: 'Switch between rank, checklist and goals. Search equipment, filter unmastered items, and star the weapons or Pacts you want to level.',
      tip: 'Equipment XP history, completed discoveries and available skill ranks determine Envoy Rank using published XP tables. Missing records are marked as partial; account-reported levels do not set your rank.',
    },
    resources: {
      name: 'Resources', icon: 'resources', intro: 'Browse crafting resources and consumables with current inventory quantities.',
      detailTitle: 'Find your materials', detail: 'Search or filter the resource list to see what you hold and what is missing.',
      tip: 'Quantities are inventory balances; buying, crafting and spending all affect them.',
    },
    enhancements: {
      name: 'Enhancements & Joineries', icon: 'enhancements', intro: 'Review your runes, motes, totems, techniques and joineries.',
      detailTitle: 'Filter your upgrades', detail: 'Choose a category, virtue or rank to narrow the list. Counts come from raw and upgraded inventory entries.',
      tip: 'Missing upgrade sections are shown as unavailable rather than empty.',
    },
    'crafting-planner': {
      name: 'Crafting Planner', icon: 'planner', intro: 'Choose crafting targets and compare their recipe ingredients with your inventory.',
      detailTitle: 'Build a plan', detail: 'Find a recipe and add it to your goals. Set quantities to combine ingredient requirements across the plan and see the remaining materials.',
      tip: 'Plans are saved on this device. A recipe may describe a reforge and require an existing item.',
    },
    activity: {
      name: 'Activity', icon: 'activity', intro: 'Follow observed resource and currency changes during your live session.',
      detailTitle: 'Read the feed', detail: 'The feed starts after a live inventory baseline. Use the gains filter to focus on increases, or include spending to see reductions.',
      tip: 'This is an inventory change feed. Purchases, crafting and consumption also appear as changes.',
    },
    'crafting-log': {
      name: 'Crafting Log', icon: 'craftlog', intro: 'Review the completed recipes recorded by your ancestors.',
      detailTitle: 'Browse crafting history', detail: 'Search completed recipes and inspect recorded craftwork tiers and ancestor progress.',
      tip: 'Recipes appear when they are present in the game inventory; this panel does not create a history for earlier sessions.',
    },
    boss: {
      name: 'Boss Timers', icon: 'boss',
      intro: 'Keep boss cooldowns in view while you play. Timers appear when Overkot reads them from your Soulframe session.',
      detailTitle: 'Read the countdown',
      detail: 'Each row shows the remaining time and a progress bar. Ready means the countdown has finished. Popup and sound alerts can be changed in Settings.',
      tip: 'An empty panel means no boss timers are available yet.',
    },
    crafting: {
      name: 'Crafting Timers', icon: 'settings',
      intro: 'Watch your active crafting countdowns without leaving the game. Overkot reads these timers from your current Soulframe session.',
      detailTitle: 'Know when crafting is ready',
      detail: 'The countdown and progress bar update automatically. Choose popup and sound alerts in Settings if you want a reminder when a timer finishes.',
      tip: 'Start crafting in game to give this panel something to track.',
    },
    other: {
      name: 'Other Timers', icon: 'timer',
      intro: 'This panel collects countdowns that do not belong to bosses or crafting, including temporary effects read from your game session.',
      detailTitle: 'Keep track of temporary effects',
      detail: 'Each row shows the remaining time. Timers refresh automatically as new game data arrives; Ready means the recorded countdown has ended.',
      tip: 'Popup and sound alerts are controlled in Settings.',
    },
    affiliation: {
      name: 'Daily Affiliation', icon: 'affiliation',
      intro: 'See how much daily affiliation you have earned and how much remains toward the daily cap.',
      detailTitle: 'Read your daily progress',
      detail: 'The earned total, progress bar, and remaining amount update from your Soulframe session. Connect to the game if the panel has no data.',
      tip: 'The display follows game data; earning affiliation still happens in Soulframe.',
    },
    factions: {
      name: 'Faction Standing', icon: 'flag',
      intro: 'Keep an eye on your standing with the Champions, the Fey, and the Silent Rose.',
      detailTitle: 'Follow each rank',
      detail: 'Each faction shows its current rank and progress within that rank. The bar fills as your recorded standing increases.',
      tip: 'Your faction data refreshes from your Soulframe session.',
    },
    odeinfamy: {
      name: 'Ode Infamy', icon: 'star',
      intro: 'View your recorded Ode Infamy progress alongside the rest of your overlay.',
      detailTitle: 'Watch your progress update',
      detail: 'The panel reads your current game data automatically. If it is empty, wait for Overkot to connect to your Soulframe session.',
      tip: 'Keep the panel docked for quick checks or float it near the part of the screen you use most.',
    },
    wiki: {
      name: 'Wiki Search', icon: 'search',
      intro: 'Look up Soulframe information directly from the overlay.',
      detailTitle: 'Search and read',
      detail: 'Type a search term in the widget and press Enter. Results open in a separate wiki window so you can read while keeping the overlay nearby.',
      tip: 'Wiki pages require an internet connection.',
    },
    groupfinder: {
      name: 'Group Finder', icon: 'group',
      intro: 'See your listing, open listings, and incoming requests at a glance.',
      detailTitle: 'Find a group',
      detail: 'Choose Open Group Finder in the widget to browse or manage listings. Use Settings → Connections to manage your avakot.dev account.',
      tip: 'Online status follows your Soulframe session.',
      action: { label: 'Open Group Finder', method: 'openGroupFinder' },
    },
    market: {
      name: 'Market', icon: 'market',
      intro: 'Browse the market and manage trades in a dedicated window launched from the dock.',
      detailTitle: 'Connect your market account',
      detail: 'Use the Market window to browse and sign in when needed. Settings → Connections lets you control whether the market session is remembered.',
      tip: 'The Market icon opens its own window instead of a small widget panel.',
      action: { label: 'Open Market', method: 'openMarket' },
    },
    minimap: {
      name: 'Mini-Map', icon: 'map-pin',
      intro: 'Explore the world map and see dungeon layouts in one panel. Dungeon mode can switch automatically when Overkot detects a dungeon.',
      detailTitle: 'Find your bearings',
      detail: 'Use + and − to zoom, the eye button for the legend, and the expand button for the full map. Choose the location button and press F6 in game to locate yourself from a screenshot.',
      tip: 'If location or dungeon detection is missing, check Settings → Game files.',
    },
    arena: {
      name: 'Arena Finder', icon: 'arena',
      intro: 'Check whether the current dungeon layout contains the wave-arena tile.',
      detailTitle: 'Read the active dungeon',
      detail: 'Arena Finder uses the same decoded room tiles as Mini-Map and works while Mini-Map is closed. If tile data is unavailable, the existing game-log diagnostic acts as a backup.',
      tip: 'Wave number and tier still come from the arena script. A new dungeon instance clears the previous result and wave.',
    },
    'world-watch': {
      name: 'World Watch', icon: 'clock',
      intro: 'Bring the world clock, current weather, ancestor encounter, and offerings together in one place.',
      detailTitle: 'Explore the three views',
      detail: 'Now gives you a quick overview. Forecast shows upcoming weather. Calendar shows daily encounters and offerings; clicking today’s card opens the calendar view.',
      tip: 'Choose your unlocked ancestors in Calendar settings to personalize encounters.',
      action: { label: 'Choose ancestors', method: 'openCalendarSettings' },
    },
    clock: {
      name: 'World Clock', icon: 'clock',
      intro: 'See the current Midrath world time and cycle while you play.',
      detailTitle: 'Follow the world cycle',
      detail: 'The clock refreshes automatically. Its status indicates whether time comes from the game or an estimate based on your device clock.',
      tip: 'World Watch combines this clock with weather and the calendar if you prefer one panel.',
    },
    weather: {
      name: 'Weather Forecast', icon: 'weather',
      intro: 'See the current world weather, what comes next, and the forecast timeline.',
      detailTitle: 'Plan for the next change',
      detail: 'The countdown shows how long remains until the next forecast period. Rainbow chances appear when available. Forecast status tells you when saved data is being used.',
      tip: 'Quests can override local weather, so the world forecast may differ from your immediate surroundings.',
    },
    'build-exporter': {
      name: 'Build Exporter', icon: 'clipboard',
      intro: 'Turn your currently recorded Soulframe loadout into a build draft.',
      detailTitle: 'Export your current build',
      detail: 'Once the widget has a loadout available, use its export button to open a draft in your browser. Review and finish the draft there.',
      tip: 'Connect to Soulframe and wait for loadout data if the export button is unavailable.',
    },
    'temper-tracker': {
      name: 'Temper Tracker', icon: 'temper',
      intro: 'Track your tempers and weapon progress from the inventory read by Overkot.',
      detailTitle: 'Find the items you need',
      detail: 'Switch between Blacksmith and Weapons, search by name, and use filters and grouping to narrow the list. The widget remembers your chosen view and filters.',
      tip: 'Live and saved inventory labels help you tell how recent the displayed data is.',
    },
    'title-tracker': {
      name: 'Title Tracker', icon: 'title',
      intro: 'Track epithet progress and keep the titles you are working toward close at hand.',
      detailTitle: 'Pin your goals',
      detail: 'Search titles, choose whether completed or incomplete entries appear, and pin your favorites. Use the view button to switch to a compact list of pinned titles.',
      tip: 'Your pinned titles and filters are saved for your next session.',
    },
    player: {
      name: 'Player', icon: 'player',
      intro: 'Your wallet, equipment storage, XP, session gains and boons share one panel.',
      detailTitle: 'Switch views without losing your place',
      detail: 'Overview combines balances and storage. Equipment tracks XP, Session measures net changes, and Boons shows account timers. Each tab keeps its controls and filters when you switch away.',
      tip: 'Session tracking continues while Player is enabled, even when the panel is closed.',
    },
    daily: {
      name: 'Daily Brief', icon: 'daily',
      intro: 'Review daily allowances, encounters, Zenith offerings, Avakot’s Gots and faction weapons.',
      detailTitle: 'See what changed today',
      detail: 'Today gives your remaining allowances and encounter. Vendors includes current Avakot stock and faction weapon Tempers. Calendar lets you look ahead.',
      tip: 'Done hides the brief until the next login or reset. Automatic opening at login and 00:00 UTC can be changed here or in Settings. The dock always opens it manually.',
    },
    'wolf-training': {
      name: 'Wolf Training', icon: 'paw',
      intro: 'See your wolf’s energy, bond, training progress, and paws that are ready to allocate.',
      detailTitle: 'Read the paws',
      detail: 'Paw states show training progress, trained paws, and paws allocated in game. Use Details for XP values and the legend. Rest warnings appear when the recorded companion needs rest.',
      tip: 'Higher paw thresholds are estimates where confirmed game data is unavailable. Allocate trained paws in Soulframe.',
    },
    'data-inventory': {
      name: 'Data · Inventory', icon: 'database',
      intro: 'Inspect the inventory snapshot that Overkot has read from your game session.',
      detailTitle: 'Explore the snapshot',
      detail: 'Use the viewer’s search and controls to inspect entries. Live or saved status tells you whether you are looking at current game data or a cached snapshot.',
      tip: 'This viewer helps you understand what data is available to other widgets.',
    },
    'data-ee-log': {
      name: 'Data · EE.log', icon: 'log',
      intro: 'Inspect the Soulframe game log used by Overkot for activity detection.',
      detailTitle: 'Search the log',
      detail: 'Use search to find messages and inspect recent activity. If the viewer cannot read the log, choose the correct EE.log location in Settings → Game files.',
      tip: 'Arena and dungeon detection depend on this log being available.',
    },
  };

  const TUTORIAL_IDS = Object.freeze(['app', ...Object.keys(WIDGET_TUTORIALS)]);

  function normalizeTutorialCompleted(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(TUTORIAL_IDS.filter(id => Object.hasOwn(value, id) && value[id] === true).map(id => [id, true]));
  }

  function isTutorialComplete(completed, id) {
    return TUTORIAL_IDS.includes(id) && !!completed && Object.hasOwn(completed, id) && completed[id] === true;
  }

  function completeTutorial(completed, id) {
    const next = normalizeTutorialCompleted(completed);
    if (TUTORIAL_IDS.includes(id)) next[id] = true;
    return next;
  }

  function formatChord(value, fallback) {
    return (typeof value === 'string' && value.trim() ? value.trim() : fallback).split('+').join(' + ');
  }

  function widgetTutorialPrefix(id) {
    return 'tour' + id.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join('');
  }

  function getTutorial(id, config = {}, translations = {}) {
    const tr = (key, fallback) => translations[key] || fallback;
    const focusChord = formatChord(config.interactionHotkey, 'Shift+F1');
    const visibilityChord = formatChord(config.overlayVisibilityHotkey, 'Shift+F2');
    if (id === 'app') return {
      id, name: tr('tourAppName', 'Welcome to Overkot'), icon: 'widgets', steps: [
        {
          title: tr('tourAppWelcomeTitle', 'Your companion in Soulframe'),
          body: tr('tourAppWelcomeBody', 'Keep timers, maps, world information, and progress in view while you play. This short tour will help you make the overlay your own.'),
          tip: tr('tourAppWelcomeTip', 'You can skip any tutorial and replay it later in Settings → Tutorials.'), visual: 'welcome',
        },
        {
          title: tr('tourAppFocusTitle', 'Focus when you need it'),
          body: tr('tourAppFocusBody', 'Press {shortcut} to focus the overlay and interact with its dock and widgets. Press it again or Escape to return control to your game.').replace('{shortcut}', () => focusChord),
          tip: tr('tourAppFocusTip', 'The dock stays passive until you focus it. Widget click-through can be changed in Settings → Overlay.'), visual: 'focus', chord: focusChord,
        },
        {
          title: tr('tourAppWidgetsTitle', 'Choose your widgets'),
          body: tr('tourAppWidgetsBody', 'Use the widgets button on the dock to choose the features you want. Selected widgets add an icon to the dock; click an icon to show or hide its panel.'),
          tip: tr('tourAppWidgetsTip', 'The first time you open a widget, you will see a short tour of its features.'), visual: 'widgets',
          action: { label: tr('tourAppWidgetsAction', 'Choose widgets'), method: 'openWidgets' },
        },
        {
          title: tr('tourAppArrangeTitle', 'Arrange your overlay'),
          body: tr('tourAppArrangeBody', 'Hold Shift while dragging a widget to move it. Drop it on the dock to dock it again. Drag dock icons to reorder them, and choose your screen edge in Settings → Overlay.'),
          tip: tr('tourAppArrangeTip', 'Floating widget positions and your dock order are saved.'), visual: 'layout',
        },
        {
          title: tr('tourAppVisibilityTitle', 'Hide or show the overlay'),
          body: tr('tourAppVisibilityBody', 'Press {shortcut} to hide or show the overlay. This is a separate shortcut from focusing it. Change either shortcut in Settings → Overlay.').replace('{shortcut}', () => visibilityChord),
          tip: tr('tourAppVisibilityTip', 'The small reminder by the app icon shows your current focus shortcut each time Overkot starts.'), visual: 'visibility', chord: visibilityChord,
          action: { label: tr('tourAppVisibilityAction', 'Open Settings'), method: 'openSettings' },
        },
        {
          title: tr('tourAppReadyTitle', 'Ready for your next adventure'),
          body: tr('tourAppReadyBody', 'The dock status shows whether Overkot has connected to Soulframe. If maps or activity detection are missing, check your game log and screenshot folder in Settings → Game files.'),
          tip: tr('tourAppReadyTip', 'Replay this tour or a widget tour any time in Settings → Tutorials.'), visual: 'ready',
        },
      ],
    };
    if (!Object.hasOwn(WIDGET_TUTORIALS, id)) return null;
    const widget = WIDGET_TUTORIALS[id];
    const prefix = widgetTutorialPrefix(id);
    const name = tr(prefix + 'Name', widget.name);
    const action = widget.action && { ...widget.action, label: tr(prefix + 'Action', widget.action.label) };
    return { id, name: tr('tourWidgetTitle', '{name} tutorial').replace('{name}', () => name), icon: widget.icon, steps: [
      { title: name, body: tr(prefix + 'Intro', widget.intro), tip: tr('tourWidgetShortcut', 'Press {shortcut} whenever you need to interact with the overlay.').replace('{shortcut}', () => focusChord), visual: 'widget' },
      { title: tr(prefix + 'DetailTitle', widget.detailTitle), body: tr(prefix + 'Detail', widget.detail), tip: tr(prefix + 'Tip', widget.tip), visual: 'feature', action },
      {
        title: id === 'market' ? tr('tourMarketDockTitle', 'Keep it within reach') : tr('tourDockTitle', 'Make room for it'),
        body: id === 'market' ? tr('tourMarketDockHint', 'Keep the Market icon on your dock for quick access. Drag icons to put your most-used features together.')
          : tr('tourDockHint', 'Click this widget’s dock icon to hide or show the panel. Hold Shift and drag to move it; drop it on the dock to dock it again.'),
        tip: tr('tourReplayHint', 'Replay this tutorial in Settings → Tutorials whenever you need a reminder.'), visual: 'layout',
      },
    ] };
  }

  return { WIDGET_TUTORIALS, TUTORIAL_IDS, normalizeTutorialCompleted, isTutorialComplete, completeTutorial, getTutorial, widgetTutorialPrefix, formatChord };
});
