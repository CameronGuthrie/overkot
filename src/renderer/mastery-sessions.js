'use strict';

window.MasterySessionsWidget = {
  mount(element, { api = window.api, language = 'en', onResize = () => {} } = {}) {
    const labels = window.InventoryWidgetUI.createLabels(language);
    const tr = labels.text;
    let handle, range, shown = 20, currentRange = 'current';
    try { const value = window.localStorage.getItem('overkot.mastery-sessions.range'); if (['current', 'last', '7d', '30d', 'all'].includes(value)) currentRange = value; } catch {}
    const node = (tag, className = '', text) => {
      const result = document.createElement(tag); result.className = className;
      if (text !== undefined) result.textContent = text; return result;
    };
    const scope = session => session.basis === 'equipment' ? tr('inventoryEquipmentMasteryXp', 'Equipment mastery XP')
      : session.scope === 'complete' ? tr('inventoryTotalMasteryXp', 'Total mastery XP') : tr('inventoryEquipmentKnownDiscoverySkillMastery', 'Equipment + known discovery / skill mastery XP');
    const duration = (hours, number) => hours * 60 < 1 ? tr('inventorySeconds', '{seconds}s', { seconds: number(Math.max(0, Math.round(hours * 3600))) })
      : hours < 1 ? tr('inventoryMinutes', '{minutes}m', { minutes: number(Math.floor(hours * 60)) }) : tr('inventoryHoursMinutes', '{hours}h {minutes}m', { hours: number(Math.floor(hours)), minutes: number(Math.floor(hours * 60) % 60) });
    const date = (value, locale) => new Date(value).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
    function metric(label, value) { const result = node('div', 'mastery-session-metric'); result.append(node('span', '', label), node('strong', '', value)); return result; }
    function metrics(session, number) {
      const result = node('div', 'mastery-session-metrics');
      result.append(metric(tr('inventoryMasteryGained', 'Mastery gained'), number(session.gained)), metric(tr('inventoryNetXp', 'Net XP'), number(session.net, { signDisplay: 'exceptZero' })),
        metric(tr('inventoryNetXpHour', 'Net XP / hour'), session.perHour === null ? '—' : number(session.perHour, { maximumFractionDigits: 1 })), metric(tr('inventoryErIncreases', 'ER increases'), session.rankUps === null ? '—' : number(session.rankUps)));
      return result;
    }
    function timeline(session, number, locale) {
      const wrapper = node('div', 'mastery-session-timeline-wrapper');
      const chart = node('div', 'mastery-session-timeline'); chart.setAttribute('role', 'img');
      chart.setAttribute('aria-label', tr('inventoryTimelineLabel', 'Mastery XP changes between inventory observations. {gained} gained; {net} net.', { gained: number(session.gained), net: number(session.net) }));
      const values = (session.samples || []).slice(1).map((sample, index) => ({ at: sample.at, delta: sample.xp - session.samples[index].xp }));
      const max = Math.max(1, ...values.map(value => Math.abs(value.delta)));
      for (const value of values) {
        const bar = node('div', 'mastery-session-bar'); bar.dataset.direction = value.delta < 0 ? 'loss' : 'gain';
        bar.style.height = `${Math.max(2, Math.abs(value.delta) / max * 100)}%`;
        bar.title = tr('inventoryTimelineObservation', '{time} · {xp} mastery XP', { time: date(value.at, locale), xp: number(value.delta, { signDisplay: 'exceptZero' }) }); chart.append(bar);
      }
      if (!values.length) chart.append(node('span', 'mastery-session-chart-empty', tr('inventoryTheNextInventoryUpdateAdds', 'The next inventory update adds an observation.')));
      const labels = node('div', 'mastery-session-chart-labels'); labels.append(node('span', '', date(session.start, locale)), node('span', '', date(session.end, locale)));
      wrapper.append(chart, labels); return wrapper;
    }
    return window.InventoryWidgetUI.mount(element, { labels, id: 'session-analysis', api, language, onResize, tickMs: 30000,
      setup(toolbar, helpers, ui) {
        handle = ui; toolbar.classList.add('mastery-session-controls');
        range = node('select'); labels.bind(range, 'aria-label', ['inventorySessionDateRange', 'Session date range']);
        for (const [value, text] of Object.entries({ current: ['inventoryCurrentSession', 'Current session'], last: ['inventoryLastSession', 'Last session'], '7d': ['inventoryLast7Days', 'Last 7 days'], '30d': ['inventoryLast30Days', 'Last 30 days'], all: ['inventoryAllObservedSessions', 'All observed sessions'] })) {
          const option = node('option', ''); labels.bind(option, 'textContent', text); option.value = value; range.append(option);
        }
        range.value = currentRange;
        const change = () => { currentRange = range.value; shown = 20; try { window.localStorage.setItem('overkot.mastery-sessions.range', currentRange); } catch {} handle.repaint(); };
        range.addEventListener('change', change); toolbar.append(range);
        return () => range.removeEventListener('change', change);
      },
      render(body, snapshot, { number, language: locale, button, now }) {
        body.classList.add('mastery-sessions-body');
        body.append(node('p', 'mastery-session-note', tr('inventoryObservedLiveSessionsOnlyEach', 'Observed live sessions only. Each starts at its first usable inventory snapshot; offline time is excluded.')));
        if (snapshot.persistenceError || snapshot.storageError) body.append(node('p', 'mastery-session-warning', tr('inventorySessionHistoryCouldNotBe', 'Session history could not be saved. Current observations remain available until the app closes.')));
        if (snapshot.unavailable) body.append(node('p', 'mastery-session-warning', tr('inventoryMasteryHistoryIsUnavailableIn', 'Mastery history is unavailable in this snapshot. Tracking resumes with a new baseline when it returns.')));
        const all = snapshot.sessions || [], current = all.find(session => session.isCurrent);
        const day = 86400000, from = currentRange === '7d' ? (snapshot.now || now) - 7 * day : currentRange === '30d' ? (snapshot.now || now) - 30 * day : 0;
        const selected = currentRange === 'current' ? current ? [current] : [] : currentRange === 'last' ? all.filter(session => !session.isCurrent).slice(0, 1) : all.filter(session => session.end >= from);
        if (!selected.length) {
          body.append(node('p', 'inventory-widget-empty', currentRange === 'current' ? tr('inventoryALiveInventoryStartsA', 'A live inventory starts a new observed session. Earlier sessions remain in the date range menu.') : tr('inventoryNoObservedSessionsInThis', 'No observed sessions in this range.'))); return;
        }
        const groups = new Map();
        for (const session of selected) {
          const key = `${session.basis}:${session.scope}`;
          if (!groups.has(key)) groups.set(key, { ...session, gained: 0, net: 0, rankUps: 0, elapsedHours: 0, count: 0 });
          const group = groups.get(key); group.gained += session.gained; group.net += session.net;
          group.rankUps = group.rankUps === null || session.rankUps === null ? null : group.rankUps + session.rankUps;
          group.elapsedHours += session.elapsedHours; group.count++;
        }
        for (const group of groups.values()) {
          group.perHour = group.elapsedHours > 0 ? group.net / group.elapsedHours : null;
          const summary = node('section', 'mastery-session-summary');
          summary.append(node('h4', 'mastery-session-scope', scope(group)), metrics(group, number),
            node('p', 'mastery-session-note', tr('inventorySessionSummary', '{count} {unit} · {duration} observed', { count: number(group.count), unit: group.count === 1 ? tr('inventorySessionUnit', 'session') : tr('inventorySessionsUnit', 'sessions'), duration: duration(group.elapsedHours, number) }))); body.append(summary);
        }
        const latest = selected[0];
        body.append(node('h4', 'mastery-session-title', currentRange === 'current' || currentRange === 'last' ? tr('inventoryXpBetweenObservations', 'XP between observations') : tr('inventoryLatestSessionTimeline', 'Latest session timeline')), timeline(latest, number, locale));
        if (currentRange !== 'current') {
          body.append(node('h4', 'mastery-session-title', tr('inventoryObservedSessions', 'Observed sessions')));
          for (const session of selected.slice(0, shown)) {
            const item = node('article', 'mastery-session-history');
            const rankSummary = session.rankBasis === 'inventory' && session.rankFrom !== null && session.rankTo !== null
              ? tr('inventorySessionRanks', '{scope} ER {from} → {to}', { scope: session.scope === 'complete' ? tr('inventoryInventory', 'Inventory') : tr('inventoryKnownMastery', 'Known-mastery'), from: number(session.rankFrom), to: number(session.rankTo) }) : tr('inventoryInventoryErUnavailableForThis', 'Inventory ER unavailable for this session');
            item.append(node('strong', '', `${date(session.start, locale)}${session.isCurrent ? ' · ' + tr('inventoryCurrentTag', 'Current') : ''}`), node('p', 'mastery-session-note', `${scope(session)} · ${duration(session.elapsedHours, number)} · ${rankSummary}`), metrics(session, number)); body.append(item);
          }
          if (selected.length > shown) body.append(button('mastery-session-more', tr('inventoryMoreResults', 'Show more ({count})', { count: selected.length - shown }), () => { shown += 20; handle.repaint(); }));
        }
        body.append(node('p', 'mastery-session-note', tr('inventoryAChangeInAvailableMastery', 'A change in available mastery sources or game data starts a new baseline. Up to 100 sessions and 120 observations per session are retained.')));
      },
    });
  },
};
