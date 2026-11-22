'use strict';

window.TemperTrackerWidget = {
  mount(element, { api = window.api, language = 'en', preferences, onResize = () => {} } = {}) {
    let t, snapshot = null, destroyed = false, revision = 0, selected = null;
    let view = 'blacksmith', filter = 'held', grouping = 'status';
    const groupings = { blacksmith: 'status', weapons: 'origin' };
    const hiddenStatuses = new Set();
    const collapsed = new Set();
    const normalize = window.TrackerPreferences.normalizeTemperTrackerPreferences;
    let hydrated = preferences !== undefined, saving = false, queuedPreferences = null;
    const editedPreferences = new Set();
    const getPreferences = () => normalize({ view, filter, groupings,
      hiddenStatuses: [...hiddenStatuses], collapsed: [...collapsed], search: search.value });
    function applyPreferences(value) {
      const next = normalize(value);
      view = next.view; filter = next.filter;
      Object.assign(groupings, next.groupings); grouping = groupings[view];
      hiddenStatuses.clear(); for (const status of next.hiddenStatuses) hiddenStatuses.add(status);
      collapsed.clear(); for (const id of next.collapsed) collapsed.add(id);
      search.value = next.search;
    }
    function mergePreferences(value) {
      const next = normalize(value), current = getPreferences();
      for (const field of editedPreferences) {
        if (field.startsWith('groupings.')) { const key = field.split('.')[1]; next.groupings[key] = current.groupings[key]; }
        else next[field] = current[field];
      }
      applyPreferences(next);
    }
    async function savePreferences() {
      if (saving || !hydrated || !queuedPreferences || typeof api.saveConfig !== 'function') return;
      saving = true;
      while (queuedPreferences) {
        const next = queuedPreferences; queuedPreferences = null;
        try { await api.saveConfig({ temperTrackerPreferences: next }); }
        catch (error) { console.warn('[Temper Tracker] Could not save preferences:', error.message); }
      }
      saving = false;
    }
    function preferencesChanged(field) {
      if (!hydrated) { editedPreferences.add(field); return; }
      queuedPreferences = getPreferences(); savePreferences();
    }
    function setPreferences(value) {
      if (destroyed || saving || queuedPreferences) return;
      if (hydrated) applyPreferences(value); else mergePreferences(value);
      hydrated = true;
      if (editedPreferences.size) {
        editedPreferences.clear(); queuedPreferences = getPreferences(); savePreferences();
      }
      render();
    }
    const node = (tag, cls, text) => {
      const result = document.createElement(tag); result.className = cls;
      if (text !== undefined) result.textContent = text;
      return result;
    };
    const button = (cls, text, handler) => {
      const result = node('button', cls, text); result.type = 'button'; result.addEventListener('click', handler); return result;
    };
    const format = (key, values) => Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), t[key]);
    const weaponCount = count => format(count === 1 ? 'temperOneWeapon' : 'temperWeaponCount', { count });
    const progress = row => `${row.unlockCount}/${row.unlockTarget}`;
    const unlockStatus = row => t[row.unlocked ? 'temperUnlocked' : 'temperIncomplete'];
    const controls = node('div', 'temper-controls');
    const views = node('select', 'temper-view-select');
    for (const value of ['blacksmith', 'weapons']) { const option = node('option', '', ''); option.value = value; views.append(option); }
    const search = node('input', 'temper-search'); search.type = 'search';
    const groups = node('select', 'temper-group-select');
    for (const value of ['status', 'origin', 'name', 'weapon']) { const option = node('option', '', ''); option.value = value; groups.append(option); }
    const filters = node('div', 'temper-filters'); filters.setAttribute('role', 'group');
    for (const value of ['all', 'held', 'missing']) {
      const item = button('temper-filter', '', () => { filter = value; preferencesChanged('filter'); render(); }); item.dataset.filter = value; filters.append(item);
    }
    const visibility = node('div', 'temper-filters'); visibility.setAttribute('role', 'group');
    for (const value of ['unlocked', 'incomplete']) {
      const item = button('temper-filter', '', () => {
        if (hiddenStatuses.has(value)) hiddenStatuses.delete(value); else hiddenStatuses.add(value);
        preferencesChanged('hiddenStatuses');
        render(); body.scrollTop = 0;
      });
      item.dataset.hide = value; visibility.append(item);
    }
    controls.append(views, search, groups, filters, visibility);
    const summary = node('div', 'temper-summary'); summary.setAttribute('role', 'status');
    const body = node('div', 'temper-scroll'); body.tabIndex = 0;
    element.replaceChildren(controls, summary, body);
    const hasInventory = () => snapshot && ['live', 'cached'].includes(snapshot.status);

    function icon(row) {
      const plaque = node('span', 'temper-icon'); plaque.dataset.origin = row.origin;
      const source = window.GameDataImages.temperIconUrl(row.icon);
      if (source) {
        const img = node('img', ''); img.src = source;
        img.alt = ''; img.width = 28; img.height = 28;
        img.addEventListener('error', () => { img.remove(); plaque.textContent = '◇'; }, { once: true });
        plaque.append(img);
      } else plaque.textContent = '◇';
      return plaque;
    }
    function tile(row, changed) {
      const item = button('temper-card', '', () => { selected = row.id; render(); body.scrollTop = 0; body.querySelector('.temper-back').focus(); });
      item.dataset.temperId = row.id; item.dataset.missing = String(view === 'weapons' && !row.copies);
      item.dataset.unlocked = String(row.unlocked);
      if (changed.has(row.id)) item.classList.add('temper-updated');
      const text = node('span', 'temper-card-text');
      text.append(node('span', 'temper-name', row.name), node('span', 'temper-source-count', view === 'blacksmith' ? unlockStatus(row) : weaponCount(row.weaponCount)));
      item.append(icon(row), text, node('span', 'temper-count', view === 'blacksmith' ? progress(row) : `×${row.copies}`));
      item.title = `${row.name} · ${view === 'blacksmith' ? format('temperUnlockProgress', { count: row.unlockCount, target: row.unlockTarget }) : format('temperCopyCount', { count: row.copies })}`;
      return item;
    }
    function renderDetail(row) {
      const back = button('temper-back', '‹ ' + t.temperBack, () => {
        const id = selected; selected = null; render();
        [...body.querySelectorAll('[data-temper-id]')].find(item => item.dataset.temperId === id)?.focus();
      });
      const header = node('div', 'temper-detail-title'); header.append(icon(row), node('strong', '', row.name), node('span', 'temper-count', view === 'blacksmith' ? progress(row) : `×${row.copies}`));
      const description = node('p', 'temper-description', row.unknown ? t.temperUnknown : row.description);
      const sourceLabel = node('div', 'temper-detail-label', t.temperOnWeapons);
      body.append(back, header);
      if (row.unlockCount !== null) body.append(node('p', 'temper-unlock-status', `${unlockStatus(row)} · ${format('temperUnlockProgress', { count: row.unlockCount, target: row.unlockTarget })}`));
      body.append(description, sourceLabel);
      if (!row.sources.length) body.append(node('p', 'temper-empty', t.temperNoneHeld));
      for (const source of row.sources) {
        const item = node('div', 'temper-weapon');
        const text = node('span', 'temper-card-text');
        const details = [source.quality, source.art, weaponCount(source.count)];
        if (source.equippedCount) details.push(format('temperEquippedCount', { count: source.equippedCount }));
        text.append(node('strong', 'temper-name', source.name), node('span', 'temper-source-count', details.filter(Boolean).join(' · ')));
        const count = node('span', 'temper-count', `×${source.stacks * source.count}`);
        count.title = format('temperCopiesEach', { count: source.stacks });
        item.append(text, count); body.append(item);
      }
    }
    function render(changed = new Set()) {
      if (destroyed) return;
      const focusId = document.activeElement?.dataset.temperId;
      const focusGroup = document.activeElement?.dataset.groupId;
      const focusBack = document.activeElement?.classList.contains('temper-back');
      const top = body.scrollTop;
      search.placeholder = t.temperSearch; search.setAttribute('aria-label', t.temperSearch);
      views.setAttribute('aria-label', t.temperView); views.value = view;
      for (const option of views.options) option.textContent = t[option.value === 'blacksmith' ? 'temperBlacksmith' : 'temperOnWeapons'];
      groups.setAttribute('aria-label', t.temperGroupBy); groups.title = t.temperGroupBy; groups.value = grouping;
      for (const option of groups.options) {
        option.textContent = t[{ status: 'temperUnlockState', origin: 'temperOrigin', name: 'temperAlphabetical', weapon: 'temperSourceWeapon' }[option.value]];
        option.hidden = option.disabled = (option.value === 'status' && view === 'weapons') || (option.value === 'weapon' && view === 'blacksmith');
      }
      body.dataset.view = view;
      filters.hidden = view !== 'weapons'; visibility.hidden = view !== 'blacksmith';
      filters.setAttribute('aria-label', t.temperFilter);
      visibility.setAttribute('aria-label', t.temperFilter);
      const rows = (snapshot?.rows || []).filter(row => view === 'weapons' || row.unlockCount !== null);
      const held = rows.filter(row => row.copies > 0).length;
      const unlocked = rows.filter(row => row.unlocked).length;
      const counts = { all: rows.length, held, missing: rows.length - held };
      for (const item of filters.children) {
        item.textContent = `${t[{ all: 'temperAll', held: 'temperHeld', missing: 'temperMissing' }[item.dataset.filter]]} ${hasInventory() ? counts[item.dataset.filter] : '—'}`;
        item.setAttribute('aria-pressed', String(item.dataset.filter === filter)); item.disabled = !hasInventory();
      }
      for (const item of visibility.children) {
        item.textContent = t[item.dataset.hide === 'unlocked' ? 'temperHideUnlocked' : 'temperHideIncomplete'];
        item.setAttribute('aria-pressed', String(hiddenStatuses.has(item.dataset.hide))); item.disabled = !hasInventory();
      }
      body.replaceChildren();
      if (!hasInventory()) {
        selected = null; controls.hidden = true;
        summary.textContent = t[snapshot?.status === 'connect' ? 'temperConnect' : snapshot?.status === 'data' ? 'temperDataWaiting' : 'temperWaiting'];
        onResize(); return;
      }
      controls.hidden = !!selected;
      summary.textContent = view === 'blacksmith'
        ? format('temperUnlockSummary', { unlocked, total: rows.length })
        : format('temperSummary', { held, total: rows.length, weapons: snapshot.weaponCount });
      if (snapshot.status === 'cached') summary.textContent += ' · ' + t.temperCached;
      if (snapshot.unreadableWeapons) summary.textContent += ' · ' + format('temperUnreadable', { count: snapshot.unreadableWeapons });
      if (snapshot.unreadableTempers) summary.textContent += ' · ' + format('temperUnlockUnreadable', { count: snapshot.unreadableTempers });
      if (selected) {
        const row = rows.find(row => row.id === selected);
        if (row) {
          renderDetail(row); body.scrollTop = top;
          if (focusBack) body.querySelector('.temper-back').focus({ preventScroll: true });
          onResize(); return;
        }
        selected = null; controls.hidden = false;
      }
      const query = search.value.trim().toLocaleLowerCase();
      const filtered = rows.filter(row => (view === 'blacksmith' ? !hiddenStatuses.has(row.unlocked ? 'unlocked' : 'incomplete')
        : (filter === 'all' || (filter === 'held' ? row.copies > 0 : row.copies === 0)))
        && (!query || [row.name, row.description, row.origin, ...row.sources.map(source => source.name)].some(text => text.toLocaleLowerCase().includes(query))));
      const sections = new Map();
      const add = (label, row) => { if (!sections.has(label)) sections.set(label, []); sections.get(label).push(row); };
      for (const row of filtered) {
        if (grouping === 'weapon') {
          for (const name of new Set(row.sources.map(source => source.name))) {
            const sources = row.sources.filter(source => source.name === name);
            add(name, { ...row, copies: sources.reduce((sum, source) => sum + source.stacks * source.count, 0), weaponCount: sources.reduce((sum, source) => sum + source.count, 0) });
          }
        } else add(grouping === 'status' ? (row.unlocked ? 'unlocked' : 'incomplete') : grouping === 'origin' ? row.origin : '', row);
      }
      if (!sections.size) body.append(node('p', 'temper-empty', grouping === 'weapon' ? t.temperNoSource : t.temperNoMatches));
      for (const [label, items] of [...sections.entries()].sort(([a], [b]) => grouping === 'status' ? b.localeCompare(a) : a.localeCompare(b))) {
        const section = node('section', 'temper-group');
        const id = grouping + ':' + label;
        if (label) {
          const title = grouping === 'status' ? `${t[label === 'unlocked' ? 'temperUnlocked' : 'temperIncomplete']} (${items.length})` : label;
          const head = button('temper-group-head', `${collapsed.has(id) ? '›' : '⌄'} ${title}`, () => {
            if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
            preferencesChanged('collapsed'); render();
          });
          head.setAttribute('aria-expanded', String(!collapsed.has(id))); head.dataset.origin = grouping === 'origin' ? label : '';
          head.dataset.groupId = id;
          section.append(head);
        }
        if (!collapsed.has(id)) {
          const grid = node('div', 'temper-grid'); for (const row of items) grid.append(tile(row, changed)); section.append(grid);
        }
        body.append(section);
      }
      body.scrollTop = top;
      if (focusId) [...body.querySelectorAll('[data-temper-id]')].find(item => item.dataset.temperId === focusId)?.focus({ preventScroll: true });
      if (focusGroup) [...body.querySelectorAll('[data-group-id]')].find(item => item.dataset.groupId === focusGroup)?.focus({ preventScroll: true });
      onResize();
    }
    function update(value) {
      if (destroyed) return;
      revision++;
      const count = row => view === 'blacksmith' ? row.unlockCount : row.copies;
      const previous = new Map((snapshot?.rows || []).map(row => [row.id, count(row)]));
      const changed = new Set(hasInventory() ? value.rows.filter(row => previous.get(row.id) !== count(row)).map(row => row.id) : []);
      snapshot = value; render(changed);
    }
    search.maxLength = 300;
    search.addEventListener('input', () => { preferencesChanged('search'); render(); body.scrollTop = 0; });
    groups.addEventListener('change', () => { grouping = groupings[view] = groups.value; preferencesChanged('groupings.' + view); render(); body.scrollTop = 0; });
    views.addEventListener('change', () => { view = views.value; grouping = groupings[view]; preferencesChanged('view'); render(); body.scrollTop = 0; });
    const unsubscribe = api.onTemperTrackerChanged(update);
    function setLanguage(value) { t = { ...TRANSLATIONS.en, ...TRANSLATIONS[value] }; render(); }
    if (hydrated) applyPreferences(preferences);
    setLanguage(language);
    if (!hydrated) {
      const load = typeof api.getState === 'function' ? api.getState() : Promise.resolve({});
      Promise.resolve(load).then(state => {
        if (!destroyed && !hydrated) setPreferences(state?.config?.temperTrackerPreferences);
      }).catch(() => { if (!destroyed && !hydrated) setPreferences(undefined); });
    }
    const initial = revision;
    api.getTemperTracker().then(value => { if (!destroyed && revision === initial) update(value); }).catch(() => {
      if (!destroyed) { summary.textContent = t.temperLoadError; onResize(); }
    });
    function destroy() { if (destroyed) return; destroyed = true; unsubscribe(); window.removeEventListener('unload', destroy); }
    window.addEventListener('unload', destroy, { once: true });
    return { setLanguage, setPreferences, destroy };
  },
};
