'use strict';

window.ActiveBoonsWidget = {
  mount(element, { api = window.api, language = 'en', onResize = () => {} } = {}) {
    let showEnded = false, handle, endedToggle;
    element.classList.add('active-boons-widget');

    function render(body, snapshot, { node, number, language, now, tr }) {
      endedToggle.hidden = true;
      if (!['live', 'cached'].includes(snapshot.status)) return;
      const note = text => node('p', 'boons-note', text);
      if (snapshot.state === 'unavailable') {
        body.append(note(tr('boonUnavailable', 'Boon information is unavailable in this inventory.')));
        return;
      }
      const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
      const currentTime = Number.isFinite(now) ? now : Date.now();
      const active = rows.filter(row => row.expiresAt > currentTime).sort((a, b) => a.expiresAt - b.expiresAt);
      const ended = rows.filter(row => row.expiresAt <= currentTime).sort((a, b) => b.expiresAt - a.expiresAt);
      if (snapshot.state === 'unreadable' && !rows.length) {
        body.append(note(tr('boonUnreadable', 'Boon records could not be read. Refresh after your next game update.')));
      } else if (!active.length) {
        body.append(note(tr('boonEmpty', 'No active boons in this inventory.')));
      } else {
        const summary = node('div', 'boons-summary');
        summary.append(node('span', 'boons-summary-title', tr('boonActiveHeading', 'Active boons')), node('strong', 'boons-count', number(active.length)));
        body.append(summary);
        const list = node('div', 'boons-list');
        for (const row of active) list.append(card(row, true));
        body.append(list);
      }
      if (ended.length) {
        endedToggle.hidden = false;
        endedToggle.textContent = showEnded
          ? tr('boonHideEnded', 'Hide ended ({count})', { count: number(ended.length) }) : tr('boonShowEnded', 'Show ended ({count})', { count: number(ended.length) });
        endedToggle.setAttribute('aria-expanded', String(showEnded));
        if (showEnded) {
          const list = node('div', 'boons-list boons-ended-list');
          for (const row of ended) list.append(card(row, false));
          body.append(list);
        }
      }
      if (snapshot.unreadableCount > 0) body.append(note(tr('boonUnreadableCount', 'Boon records with an unreadable name or expiration: {count}.', { count: number(snapshot.unreadableCount) })));
      if (snapshot.status === 'cached' && rows.length) body.append(note(tr('boonCacheHint', 'Countdowns use saved expiration times. Open Soulframe to confirm your current boons.')));

      function card(row, isActive) {
        const item = node('section', `boons-card${isActive ? '' : ' boons-card-ended'}`);
        const head = node('div', 'boons-card-head');
        head.append(node('strong', 'boons-name', row.name), node('span', 'boons-state', isActive ? tr('boonActive', 'Active') : tr('boonEnded', 'Ended')));
        item.append(head);
        const time = node('time', 'boons-expiration');
        time.dateTime = new Date(row.expiresAt).toISOString();
        const date = new Date(row.expiresAt).toLocaleString(language, { dateStyle: 'short', timeStyle: 'short' });
        time.textContent = isActive ? tr('boonEndsAt', 'Ends {date}', { date }) : tr('boonEndedAt', 'Ended {date}', { date });
        if (isActive) {
          const seconds = Math.max(0, Math.ceil((row.expiresAt - currentTime) / 1000));
          const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600);
          const minutes = Math.floor(seconds % 3600 / 60), remainder = seconds % 60;
          const duration = days ? tr('boonDuration', '{days}d {hours}h {minutes}m', { days: number(days), hours: number(hours), minutes: number(minutes) })
            : `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
          item.append(node('strong', 'boons-countdown', duration));
        }
        item.append(time);
        return item;
      }
    }

    handle = window.InventoryWidgetUI.mount(element, { id: 'active-boons', api, language, onResize, render, tickMs: 1000,
      setup(toolbar, { button }, ui) {
        endedToggle = button('boons-ended-toggle', 'Show ended', () => { showEnded = !showEnded; ui.repaint(); });
        endedToggle.hidden = true; endedToggle.setAttribute('aria-expanded', 'false'); toolbar.append(endedToggle);
      },
    });
    return { setLanguage: value => handle.setLanguage(value), destroy: () => handle.destroy() };
  },
};
