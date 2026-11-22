'use strict';

const PLAYER_WIDGETS = Object.freeze(['storage-capacity', 'account-wallet', 'active-boons', 'equipment-progress', 'session-gains']);
const GROUPS = Object.freeze({ player: PLAYER_WIDGETS, daily: Object.freeze(['calendar']) });
const RETIRED = new Map(Object.entries(GROUPS).flatMap(([target, members]) => members.map(id => [id, target])));
const MAP_KEYS = ['widgetVisibility', 'moduleVisibility', 'widgetOpen', 'widgetDocked', 'widgetCollapsed'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const boolean = value => typeof value === 'boolean';

/** Consolidate saved views while preserving explicit choices made for their replacements. */
function migrateWidgetConfiguration(value) {
  const source = plain(value) ? value : {};
  const data = { ...source };
  const order = Array.isArray(source.dockWidgetOrder) ? source.dockWidgetOrder : [];
  const preferences = new Map();
  for (const [target, members] of Object.entries(GROUPS)) {
    const ordered = [...new Set([...order.filter(id => members.includes(id)), ...members])];
    const selected = ordered.find(id => source.widgetOpen?.[id] === true)
      || ordered.find(id => source.widgetVisibility?.[id] === true)
      || ordered.find(id => Object.hasOwn(source, `widgetBounds_${id}`))
      || ordered[0];
    preferences.set(target, [selected, ...ordered.filter(id => id !== selected)]);
  }

  for (const key of MAP_KEYS) {
    if (!plain(source[key])) continue;
    const map = { ...source[key] };
    for (const [target, members] of Object.entries(GROUPS)) {
      const legacy = members.filter(id => Object.hasOwn(map, id));
      if (!boolean(map[target]) && legacy.length) {
        const valid = legacy.map(id => map[id]).filter(boolean);
        if (key === 'widgetVisibility' || key === 'moduleVisibility' || key === 'widgetOpen') {
          if (valid.length) map[target] = valid.some(item => item === true);
        } else if (key === 'widgetCollapsed' && target === 'player') {
          // Several independent collapsed views do not make the combined tab bar collapsed.
          map[target] = false;
        } else {
          const representative = preferences.get(target).find(id => boolean(map[id]));
          if (representative) map[target] = map[representative];
        }
      }
      for (const id of members) delete map[id];
    }
    data[key] = map;
  }

  for (const [target, members] of Object.entries(GROUPS)) {
    const targetKey = `widgetBounds_${target}`;
    if (!Object.hasOwn(source, targetKey)) {
      const representative = preferences.get(target).find(id => Object.hasOwn(source, `widgetBounds_${id}`));
      if (representative) data[targetKey] = source[`widgetBounds_${representative}`];
    }
    for (const id of members) delete data[`widgetBounds_${id}`];
  }

  if (Array.isArray(source.dockWidgetOrder)) {
    data.dockWidgetOrder = [...new Set(source.dockWidgetOrder.filter(id => typeof id === 'string' && id.trim())
      .map(id => { const trimmed = id.trim(); return RETIRED.get(trimmed) || trimmed; }))];
  }
  if (Array.isArray(source.gridLayout?.columns)) {
    const explicit = new Set(source.gridLayout.columns.flatMap(column => Array.isArray(column?.widgets)
      ? column.widgets.filter(id => Object.hasOwn(GROUPS, id)) : []));
    const seen = new Set();
    data.gridLayout = { ...source.gridLayout, columns: source.gridLayout.columns.map(column => {
      if (!Array.isArray(column?.widgets)) return column;
      return { ...column, widgets: column.widgets.flatMap(id => {
        const target = RETIRED.get(id) || id;
        if (!Object.hasOwn(GROUPS, target)) return [id];
        if ((RETIRED.has(id) && explicit.has(target)) || seen.has(target)) return [];
        seen.add(target); return [target];
      }) };
    }) };
  }

  if (plain(source.tutorialCompleted)) {
    data.tutorialCompleted = Object.fromEntries(Object.entries(source.tutorialCompleted).filter(([id]) => !RETIRED.has(id)));
  }
  // Older profiles used moduleVisibility before widgetVisibility became authoritative.
  for (const target of Object.keys(GROUPS)) {
    if (!boolean(data.widgetVisibility?.[target]) && boolean(data.moduleVisibility?.[target])) {
      data.widgetVisibility = { ...(plain(data.widgetVisibility) ? data.widgetVisibility : {}), [target]: data.moduleVisibility[target] };
    }
  }
  const firstDailyUpgrade = source.dailyBriefVersion !== 1;
  if (firstDailyUpgrade) {
    const visibility = plain(data.widgetVisibility) ? data.widgetVisibility : {};
    if (!boolean(visibility.daily)) data.widgetVisibility = { ...visibility, daily: true };
    const open = plain(data.widgetOpen) ? data.widgetOpen : {};
    if (!boolean(open.daily)) data.widgetOpen = { ...open, daily: false };
  }
  data.dailyBriefVersion = 1;
  data.dailyAutoLogin = boolean(source.dailyAutoLogin) ? source.dailyAutoLogin : true;
  data.dailyAutoReset = boolean(source.dailyAutoReset) ? source.dailyAutoReset : true;
  return data;
}

module.exports = { migrateWidgetConfiguration, PLAYER_WIDGETS };
