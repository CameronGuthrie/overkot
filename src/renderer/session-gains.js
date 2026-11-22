'use strict';

window.SessionGainsWidget = {
  mount(element, { api = window.api, language = 'en', onResize = () => {} } = {}) {
    const defaults = {
      sessionGainsSearch: 'Search session items', sessionGainsChangedOnly: 'Changed only',
      sessionGainsReset: 'Restart', sessionGainsResetting: 'Restarting…',
      sessionGainsExplanation: 'Net changes in your holdings. Spending, crafting and trades are included.',
      sessionGainsWaiting: 'A live inventory update starts tracking. Saved inventory does not start a session.',
      sessionGainsPaused: 'Tracking paused. These are the last live observations.',
      sessionGainsEmpty: 'No inventory changes yet. Keep playing and check back after the next inventory update.',
      sessionGainsNoMatches: 'No items match these filters.', sessionGainsWindow: 'Observed window',
      sessionGainsChanged: 'Changed items', sessionGainsNet: 'Net', sessionGainsHeld: 'Held',
      sessionGainsRate: 'Net / hour', sessionGainsItem: 'Item', sessionGainsSince: 'Tracking since',
      sessionGainsUnavailable: 'Changes are hidden for unavailable or incomplete sections:',
      sessionGainsLate: 'Newly available sections start from their first complete observation:',
      sessionGainsFailed: 'Could not restart tracking. Try again.',
      sessionGainsResources: 'Resources', sessionGainsConsumables: 'Consumables',
      sessionGainsRegular: 'Dracs', sessionGainsPremium: 'Arcs',
      sessionGainsBaseline: 'Starting amount',
    };
    let search = '', changedOnly = true, pending = false, actionError = false, destroyed = false;
    let searchInput, changedInput, changedText, resetButton;
    function translations(locale) {
      const all = typeof TRANSLATIONS === 'object' ? TRANSLATIONS : {};
      return { ...defaults, ...all.en, ...all[locale] };
    }
    function sectionName(section, t) {
      return ({ MiscItems: t.sessionGainsResources, Consumables: t.sessionGainsConsumables,
        RegularCredits: t.sessionGainsRegular, PremiumCredits: t.sessionGainsPremium })[section] || section;
    }
    const ui = InventoryWidgetUI.mount(element, {
      id: 'session-gains', api, language, onResize,
      setup(toolbar, { node, button }, handle) {
        const t = translations(language);
        toolbar.classList.add('session-gains-toolbar');
        searchInput = node('input', 'session-gains-search'); searchInput.type = 'search';
        searchInput.placeholder = t.sessionGainsSearch; searchInput.setAttribute('aria-label', t.sessionGainsSearch);
        const searchListener = () => { search = searchInput.value; handle.repaint(); };
        searchInput.addEventListener('input', searchListener);
        const filter = node('label', 'session-gains-filter');
        changedInput = node('input', ''); changedInput.type = 'checkbox'; changedInput.checked = changedOnly;
        changedText = node('span', '', t.sessionGainsChangedOnly);
        const filterListener = () => { changedOnly = changedInput.checked; handle.repaint(); };
        changedInput.addEventListener('change', filterListener); filter.append(changedInput, changedText);
        resetButton = button('session-gains-reset', t.sessionGainsReset, async () => {
          if (pending || destroyed || handle.getSnapshot()?.status !== 'live') return;
          pending = true; actionError = false; handle.repaint();
          try {
            const result = await api.inventoryWidgetAction('session-gains', 'reset');
            if (result?.ok === false || result === false) throw new Error('Reset rejected');
            if (!destroyed) await handle.refresh();
          } catch { if (!destroyed) actionError = true; }
          finally { pending = false; if (!destroyed) handle.repaint(); }
        });
        resetButton.disabled = true;
        toolbar.append(searchInput, filter, resetButton);
        return () => {
          destroyed = true;
          searchInput.removeEventListener('input', searchListener);
          changedInput.removeEventListener('change', filterListener);
        };
      },
      render(body, snapshot, { node, number, language: locale }) {
        body.classList.add('session-gains-body');
        const t = translations(locale);
        const signed = (value, options = {}) => number(value, { signDisplay: 'exceptZero', ...options });
        const date = value => new Date(value).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
        searchInput.placeholder = t.sessionGainsSearch; searchInput.setAttribute('aria-label', t.sessionGainsSearch);
        changedText.textContent = t.sessionGainsChangedOnly;
        resetButton.textContent = pending ? t.sessionGainsResetting : t.sessionGainsReset;
        resetButton.disabled = pending || snapshot.status !== 'live';
        if (actionError) { const warning = node('p', 'session-gains-warning', t.sessionGainsFailed); warning.setAttribute('role', 'alert'); body.append(warning); }
        body.append(node('p', 'session-gains-explanation', t.sessionGainsExplanation));
        if (snapshot.baselineAt == null) {
          body.append(node('p', 'session-gains-empty', t.sessionGainsWaiting)); return;
        }
        const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
        const summary = node('div', 'session-gains-summary');
        const minutes = Math.max(0, Math.floor((snapshot.elapsedHours || 0) * 60));
        for (const [name, value] of [[t.sessionGainsChanged, number(rows.filter(row => row.net !== 0).length)],
          [t.sessionGainsWindow, minutes >= 60 ? `${number(Math.floor(minutes / 60))}h ${number(minutes % 60)}m` : `${number(minutes)}m`]]) {
          const metric = node('div', 'session-gains-metric'); metric.append(node('span', '', name), node('strong', '', value)); summary.append(metric);
        }
        body.append(summary);
        body.append(node('p', 'session-gains-since', `${t.sessionGainsSince} ${date(snapshot.baselineAt)}`));
        if (snapshot.status !== 'live') body.append(node('p', 'session-gains-warning', t.sessionGainsPaused));
        for (const [sections, message] of [[snapshot.withheldSections, t.sessionGainsUnavailable], [snapshot.seededSections, t.sessionGainsLate]]) {
          if (sections?.length) body.append(node('p', 'session-gains-warning', `${message} ${sections.map(section => sectionName(section, t)).join(', ')}`));
        }
        const query = search.trim().toLocaleLowerCase(locale);
        const filtered = rows.filter(row => (!changedOnly || row.net !== 0)
          && (!query || `${row.name} ${row.itemType} ${sectionName(row.section, t)}`.toLocaleLowerCase(locale).includes(query)));
        if (!filtered.length) {
          body.append(node('p', 'session-gains-empty', query || (!changedOnly && rows.length) ? t.sessionGainsNoMatches : t.sessionGainsEmpty)); return;
        }
        const table = node('table', 'session-gains-table');
        const head = node('thead', ''), header = node('tr', '');
        for (const title of [t.sessionGainsItem, t.sessionGainsNet, t.sessionGainsHeld, t.sessionGainsRate]) {
          const cell = node('th', '', title); cell.scope = 'col'; header.append(cell);
        }
        head.append(header); table.append(head);
        const tbody = node('tbody', '');
        for (const row of filtered) {
          const tr = node('tr', 'session-gains-row'); tr.dataset.direction = row.net > 0 ? 'gain' : row.net < 0 ? 'loss' : 'same';
          const name = node('th', 'session-gains-name'); name.scope = 'row';
          name.append(node('span', '', row.name), node('small', '', sectionName(row.section, t)));
          name.title = `${row.itemType}\n${t.sessionGainsBaseline}: ${number(row.baseline)}\n${t.sessionGainsSince} ${date(row.baselineAt)}`;
          tr.append(name, node('td', 'session-gains-net', signed(row.net)), node('td', 'session-gains-held', number(row.current)),
            node('td', 'session-gains-rate', row.perHour === null ? '—' : signed(row.perHour, { maximumFractionDigits: 1 })));
          tbody.append(tr);
        }
        table.append(tbody); body.append(table);
      },
    });
    return { setLanguage(value) { language = value || 'en'; ui.setLanguage(language); }, destroy: () => ui.destroy() };
  },
};
