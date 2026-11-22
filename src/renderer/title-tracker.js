'use strict';

window.TitleTrackerWidget = {
  mount(element, { api = window.api, language = 'en', preferences, onResize = () => {} } = {}) {
    const normalize = window.TrackerPreferences.normalizeTitleTrackerPreferences;
    let prefs = normalize(preferences), snapshot = null, destroyed = false, snapshotRevision = 0, t;
    let pending = false, saving = false, saveFailed = false;
    let hydrated = preferences !== undefined || !api.getState;
    const editedFields = new Set(), editedPins = new Map();
    const node = (tag, cls, text) => {
      const result = document.createElement(tag); result.className = cls;
      if (text !== undefined) result.textContent = text;
      return result;
    };
    const button = (cls, text, handler) => {
      const result = node('button', cls, text); result.type = 'button';
      result.addEventListener('click', handler); return result;
    };
    const setIcon = (control, name) => {
      const icon = node('span', `title-icon title-icon-${name}`); icon.setAttribute('aria-hidden', 'true');
      control.replaceChildren(icon);
    };
    const format = (key, values) => Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), t[key]);
    const toolbar = node('div', 'title-toolbar');
    const toggleView = () => {
      prefs.pinnedOnly = !prefs.pinnedOnly; changed('pinnedOnly'); render(); body.scrollTop = 0;
      focusViewToggle();
    };
    const viewToggle = button('title-view-toggle', '', toggleView);
    toolbar.append(viewToggle);
    const controls = node('div', 'title-controls');
    const search = node('input', 'title-search'); search.type = 'search'; search.value = prefs.search;
    const visibility = node('div', 'title-filters'); visibility.setAttribute('role', 'group');
    for (const [value, key] of [['completed', 'showCompleted'], ['incomplete', 'showIncomplete']]) {
      const item = button('title-filter', '', () => {
        prefs[key] = !prefs[key]; changed(key); render(); body.scrollTop = 0;
      });
      item.dataset.hide = value; visibility.append(item);
    }
    const summary = node('div', 'title-summary'); summary.setAttribute('role', 'status');
    const error = node('div', 'title-save-error'); error.setAttribute('role', 'status'); error.hidden = true;
    const retry = button('title-retry', '', () => { pending = true; void save(); });
    error.append(node('span', 'title-save-message'), retry);
    const body = node('div', 'title-scroll'); body.tabIndex = 0;
    controls.append(search, visibility); element.replaceChildren(toolbar, controls, summary, error, body);
    const hasInventory = () => snapshot && ['live', 'cached'].includes(snapshot.status);
    const focusViewToggle = () => (body.querySelector('.title-view-toggle') || viewToggle).focus({ preventScroll: true });

    function changed(field) {
      if (!hydrated && field) editedFields.add(field);
      pending = true; void save();
    }
    async function save() {
      if (!hydrated || saving || !pending) return;
      saving = true; saveFailed = false;
      try {
        while (pending) {
          pending = false;
          if (await api.saveConfig({ titleTrackerPreferences: normalize(prefs) }) === false) throw new Error('Save failed');
        }
      } catch { pending = true; saveFailed = true; }
      finally { saving = false; renderSaveError(); }
    }
    function renderSaveError() {
      if (destroyed) return;
      error.hidden = !saveFailed;
      error.querySelector('.title-save-message').textContent = t.titleSaveFailed;
      retry.textContent = t.titleRetry;
      onResize();
    }
    function tile(row, showViewToggle = false) {
      const item = node('article', 'title-row'); item.dataset.titleId = row.id;
      item.dataset.completed = String(row.completed);
      const pinned = prefs.pinned.includes(row.id); item.dataset.pinned = String(pinned);
      const head = node('div', 'title-row-head');
      const name = node('strong', 'title-name', row.name);
      const pin = button('title-pin', '', () => {
        prefs.pinned = pinned ? prefs.pinned.filter(id => id !== row.id) : [...prefs.pinned, row.id];
        if (!hydrated) editedPins.set(row.id, !pinned);
        changed(); render();
        const nextPin = [...body.querySelectorAll('[data-title-id]')].find(item => item.dataset.titleId === row.id)?.querySelector('.title-pin');
        if (nextPin) nextPin.focus({ preventScroll: true });
        else if (prefs.pinnedOnly) focusViewToggle();
      });
      pin.dataset.titleId = row.id; pin.setAttribute('aria-pressed', String(pinned));
      pin.title = t[pinned ? 'titleUnpin' : 'titlePin'];
      pin.setAttribute('aria-label', `${pin.title} ${row.name}`);
      setIcon(pin, 'pin');
      const actions = node('div', 'title-row-actions');
      if (showViewToggle) {
        const compactToggle = button('title-view-toggle title-view-toggle-compact', '', toggleView);
        compactToggle.title = t.titleShowFilters;
        compactToggle.setAttribute('aria-label', t.titleShowFilters);
        compactToggle.setAttribute('aria-pressed', 'true');
        setIcon(compactToggle, 'eye-off');
        actions.append(compactToggle);
      }
      actions.append(pin);
      head.append(name, actions);
      const description = node('p', 'title-description', row.description);
      const progress = node('div', 'title-progress'); progress.setAttribute('role', 'progressbar');
      progress.setAttribute('aria-label', row.name); progress.setAttribute('aria-valuemin', '0');
      progress.setAttribute('aria-valuemax', String(row.target)); progress.setAttribute('aria-valuenow', String(row.count));
      const countText = format('titleCount', { count: row.count.toLocaleString(language), target: row.target.toLocaleString(language) });
      progress.setAttribute('aria-valuetext', countText);
      const fill = node('div', 'title-progress-fill'); fill.style.width = `${Math.min(100, row.count / row.target * 100)}%`;
      progress.append(fill, node('span', 'title-progress-count', countText));
      item.append(head, description, progress);
      if (row.completed) item.append(node('span', 'title-completed-label', t.titleCompleted));
      return item;
    }
    function render() {
      if (destroyed) return;
      const top = body.scrollTop, focusId = document.activeElement?.classList.contains('title-pin') ? document.activeElement.dataset.titleId : null;
      const focusView = document.activeElement?.classList.contains('title-view-toggle');
      element.dataset.pinnedOnly = String(prefs.pinnedOnly);
      viewToggle.title = t[prefs.pinnedOnly ? 'titleShowFilters' : 'titlePinnedOnlyHint'];
      viewToggle.setAttribute('aria-label', viewToggle.title);
      viewToggle.setAttribute('aria-pressed', String(prefs.pinnedOnly));
      setIcon(viewToggle, prefs.pinnedOnly ? 'eye-off' : 'eye');
      search.placeholder = t.titleSearch; search.setAttribute('aria-label', t.titleSearch);
      visibility.setAttribute('aria-label', t.titleFilter);
      for (const item of visibility.children) {
        const completed = item.dataset.hide === 'completed';
        item.textContent = t[completed ? 'titleHideCompleted' : 'titleHideIncomplete'];
        item.setAttribute('aria-pressed', String(!(completed ? prefs.showCompleted : prefs.showIncomplete)));
      }
      body.replaceChildren();
      toolbar.hidden = false;
      summary.hidden = false;
      controls.hidden = prefs.pinnedOnly || !hasInventory();
      if (!hasInventory()) {
        summary.textContent = t[snapshot?.status === 'connect' ? 'titleConnect' : snapshot?.status === 'data' ? 'titleDataWaiting' : 'titleWaiting'];
        if (prefs.pinnedOnly && (focusView || focusId)) focusViewToggle();
        renderSaveError(); return;
      }
      const rows = snapshot.rows || [], completed = rows.filter(row => row.completed).length;
      const notices = [];
      if (snapshot.status === 'cached') notices.push(t.titleCached);
      if (snapshot.unreadableChallenges) notices.push(format('titleUnreadable', { count: snapshot.unreadableChallenges }));
      summary.textContent = prefs.pinnedOnly ? '' : [format('titleSummary', { completed, total: rows.length }), ...notices].join(' · ');
      summary.hidden = !summary.textContent;
      const query = prefs.search.trim().toLocaleLowerCase();
      const filtered = rows.filter(row => prefs.pinnedOnly ? prefs.pinned.includes(row.id)
        : (row.completed ? prefs.showCompleted : prefs.showIncomplete)
          && (!query || `${row.name} ${row.description}`.toLocaleLowerCase().includes(query)));
      const pinned = filtered.filter(row => prefs.pinned.includes(row.id));
      const other = filtered.filter(row => !prefs.pinned.includes(row.id));
      toolbar.hidden = prefs.pinnedOnly && pinned.length > 0;
      for (const [label, items] of [[t.titlePinned, pinned], [t.titleAll, other]]) {
        if (!items.length) continue;
        const section = node('section', 'title-section');
        if (pinned.length && !prefs.pinnedOnly) section.append(node('h3', 'title-section-label', `${label} (${items.length})`));
        for (const row of items) section.append(tile(row, prefs.pinnedOnly && row === filtered[0]));
        body.append(section);
      }
      if (!filtered.length) body.append(node('p', 'title-empty', t[prefs.pinnedOnly ? 'titleNoPinned' : 'titleNoMatches']));
      window.OverkotMotion?.inventory('title-tracker', snapshot, body);
      body.scrollTop = top;
      if (focusId) {
        const nextPin = [...body.querySelectorAll('.title-pin')].find(item => item.dataset.titleId === focusId);
        if (nextPin) nextPin.focus({ preventScroll: true });
        else if (prefs.pinnedOnly) focusViewToggle();
      }
      if (focusView) focusViewToggle();
      renderSaveError();
    }
    function update(value) { if (!destroyed) { snapshotRevision++; snapshot = value; render(); } }
    function setPreferences(value) {
      if (destroyed || (hydrated && (pending || saving))) return;
      const next = normalize(value);
      if (!hydrated) {
        for (const field of editedFields) next[field] = prefs[field];
        for (const [id, pinned] of editedPins) {
          next.pinned = next.pinned.filter(item => item !== id);
          if (pinned) next.pinned.push(id);
        }
        editedFields.clear(); editedPins.clear();
      }
      hydrated = true; prefs = normalize(next); search.value = prefs.search;
      if (pending) void save();
      render();
    }
    function setLanguage(value) { language = value; t = { ...TRANSLATIONS.en, ...TRANSLATIONS[value] }; render(); }
    search.maxLength = 300;
    search.addEventListener('input', () => { prefs.search = search.value; changed('search'); render(); body.scrollTop = 0; });
    const unsubscribe = api.onTitleTrackerChanged(update);
    setLanguage(language);
    if (!hydrated) {
      api.getState().then(state => { if (!destroyed && !hydrated) setPreferences(state?.config?.titleTrackerPreferences); })
        .catch(() => { if (!destroyed && !hydrated) setPreferences(undefined); });
    }
    const initialSnapshotRevision = snapshotRevision;
    api.getTitleTracker().then(value => { if (snapshotRevision === initialSnapshotRevision) update(value); }).catch(() => {
      if (!destroyed && snapshotRevision === initialSnapshotRevision) { summary.textContent = t.titleLoadError; onResize(); }
    });
    function destroy() { if (destroyed) return; destroyed = true; unsubscribe(); window.removeEventListener('unload', destroy); }
    window.addEventListener('unload', destroy, { once: true });
    return { setLanguage, setPreferences, destroy };
  },
};
