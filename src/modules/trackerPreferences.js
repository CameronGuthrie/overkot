'use strict';

// Shared by configuration IPC and the browser widgets. Keep preferences bounded
// and independent of inventories so malformed saved profiles cannot break a list.
(function(root, factory) {
  const preferences = factory();
  if (typeof module === 'object' && module.exports) module.exports = preferences;
  else root.TrackerPreferences = preferences;
})(typeof window === 'object' ? window : globalThis, function() {
  const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const choice = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
  const search = value => typeof value === 'string' ? value.slice(0, 300) : '';
  const strings = (value, accept, limit = 500) => [...new Set((Array.isArray(value) ? value : [])
    .filter(item => typeof item === 'string' && item.length <= 300 && accept(item)))].slice(0, limit);

  function normalizeTitleTrackerPreferences(value) {
    const data = record(value);
    return {
      showCompleted: typeof data.showCompleted === 'boolean' ? data.showCompleted : true,
      showIncomplete: typeof data.showIncomplete === 'boolean' ? data.showIncomplete : true,
      pinnedOnly: typeof data.pinnedOnly === 'boolean' ? data.pinnedOnly : false,
      pinned: strings(data.pinned, id => id.length > 0 && !/[\x00-\x1f\x7f]/.test(id)),
      search: search(data.search),
    };
  }

  function normalizeTemperTrackerPreferences(value) {
    const data = record(value), groupings = record(data.groupings);
    return {
      view: choice(data.view, ['blacksmith', 'weapons'], 'blacksmith'),
      filter: choice(data.filter, ['all', 'held', 'missing'], 'held'),
      groupings: {
        blacksmith: choice(groupings.blacksmith, ['status', 'origin', 'name'], 'status'),
        weapons: choice(groupings.weapons, ['origin', 'name', 'weapon'], 'origin'),
      },
      hiddenStatuses: strings(data.hiddenStatuses, status => ['unlocked', 'incomplete'].includes(status), 2),
      collapsed: strings(data.collapsed, id => /^(status|origin|weapon):[^\x00-\x1f\x7f]+$/.test(id)),
      search: search(data.search),
    };
  }

  return { normalizeTitleTrackerPreferences, normalizeTemperTrackerPreferences };
});
