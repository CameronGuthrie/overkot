/**
 * Shared constants between renderer windows.
 * Extracted from renderer.js for reuse in settings and other popout windows.
 */

// Languages and translations loaded from langs/*.json via preload bridge
const LANGUAGES = window.i18n.languages;
// Stored Group Finder values are shared by the full window and the docked widget.
const ACTIVITY_KEY_MAP = {
  'Boss / Encounter': 'gfActivityBoss',
  'Farming / Repeats': 'gfActivityFarming',
  'Quest / Progression': 'gfActivityQuest',
  'Exploration': 'gfActivityExploration',
  'Help / Teaching': 'gfActivityHelp',
  'General Grouping': 'gfActivityGeneral',
};
// Widgets receive BCP 47 tags for Intl date/number formatting. Both a game's
// saved code and its browser locale reference the same interface dictionary.
const TRANSLATIONS = { ...window.i18n.translations };
for (const { code, locale } of LANGUAGES) {
  if (locale) TRANSLATIONS[locale] = TRANSLATIONS[code];
}

// All widget ids that can appear in the docked-grid layout. Must stay in
// sync with `ALL_WIDGET_IDS` in main.js.
window.ALL_WIDGET_IDS = ['boss', 'crafting', 'other', 'affiliation', 'factions', 'odeinfamy', 'wiki', 'groupfinder', 'minimap', 'arena', 'world-watch', 'clock', 'weather', 'build-exporter', 'temper-tracker', 'wolf-training', 'data-inventory', 'data-ee-log', 'player', 'daily', 'collection-log', 'cosmetics', 'mastery-tracker', 'resources', 'enhancements', 'crafting-planner', 'activity', 'crafting-log', 'session-analysis'];
if (window.i18n.titleTrackerEnabled === true) window.ALL_WIDGET_IDS.push('title-tracker');
