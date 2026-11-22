'use strict';

function blessedMeetingTimer(state, nowSeconds = Math.floor(Date.now() / 1000)) {
  const tag = 'UPGRADEGIVEN_GODANDGHOST';
  const timers = Array.isArray(state?.timers) ? state.timers : [];
  const matches = timers.filter(timer => typeof timer?.tag === 'string' && timer.tag.toUpperCase() === tag
    && Number.isFinite(timer.expiryTime) && timer.expiryTime > 0);
  if (!matches.length) return null;
  const timer = matches.reduce((latest, value) => value.expiryTime > latest.expiryTime ? value : latest);
  const remaining = Math.max(0, Math.ceil(timer.expiryTime - nowSeconds));
  const total = state.totalSeconds;
  const percent = remaining === 0 ? 100 : Number.isFinite(total) && total > 0
    ? Math.min(100, Math.max(0, (total - remaining) / total * 100)) : null;
  const names = state.namesMap || {};
  const name = names[tag] || names['/SF/Language/SystemMessages/AncestorBoosterNotification'] || names[timer.tag] || '';
  return { name: typeof name === 'string' ? name : '', remaining, percent, ready: remaining === 0 };
}

window.WorldWatchWidget = {
  mount(element, { api = window.api, language = 'en', showOfferings = true, timerState = null, onResize = () => {} } = {}) {
    const fallback = {
      worldWatchNow: 'Now', worldWatchForecast: 'Forecast', worldWatchCalendar: 'Calendar',
      worldWatchToday: 'Today', worldWatchOpenCalendar: 'Open today’s calendar',
      worldWatchLoading: 'Checking today…', worldWatchUnavailable: 'Calendar unavailable',
      worldWatchChoose: 'Choose your ancestors', worldWatchWaiting: 'Encounter not available',
      worldWatchOffers: 'Zenith: {names}', worldWatchNoOffers: 'Offerings unavailable',
      worldWatchUtc: 'UTC', ready: 'Ready',
    };
    let locale = language, t, formatter, destroyed = false, request = 0, snapshot = null, failed = false;
    let view = 'overview', calendar = null, forecast = null, midnightTimer;
    const create = (tag, className, text) => {
      const node = document.createElement(tag); node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const root = create('section', 'world-watch');
    const navigation = create('div', 'world-watch-tabs'); navigation.setAttribute('role', 'tablist');
    const stage = create('div', 'world-watch-stage');
    const panels = {}, tabs = {};
    const identity = `world-watch-${crypto.randomUUID()}`;
    for (const name of ['overview', 'forecast', 'calendar']) {
      const tab = create('button', 'world-watch-tab'); tab.type = 'button'; tab.dataset.view = name;
      tab.id = `${identity}-${name}-tab`; tab.setAttribute('role', 'tab');
      const panel = create('div', `world-watch-panel world-watch-${name}`);
      panel.id = `${identity}-${name}`; panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id); tab.setAttribute('aria-controls', panel.id);
      panel.tabIndex = 0;
      tabs[name] = tab; panels[name] = panel; navigation.append(tab); stage.append(panel);
      tab.addEventListener('click', () => select(name));
      tab.addEventListener('keydown', event => {
        const names = Object.keys(tabs), index = names.indexOf(name);
        let next;
        if (event.key === 'ArrowRight') next = names[(index + 1) % names.length];
        else if (event.key === 'ArrowLeft') next = names[(index + names.length - 1) % names.length];
        else if (event.key === 'Home') next = names[0];
        else if (event.key === 'End') next = names.at(-1);
        if (!next) return;
        event.preventDefault(); select(next); tabs[next].focus();
      });
    }
    const hero = create('div', 'world-watch-hero');
    const clockElement = create('div', 'clock-content world-watch-clock');
    const weatherElement = create('div', 'weather-content world-watch-weather');
    hero.append(clockElement, weatherElement);
    const todayButton = create('button', 'world-watch-today'); todayButton.type = 'button';
    const meetingFill = create('span', 'world-watch-meeting-fill'); meetingFill.setAttribute('aria-hidden', 'true');
    const dateLine = create('span', 'world-watch-date-line');
    const todayLabel = create('span', 'world-watch-today-label');
    const dateLabel = create('span', 'world-watch-date');
    const arrow = create('span', 'world-watch-calendar-arrow', '›'); arrow.setAttribute('aria-hidden', 'true');
    dateLine.append(todayLabel, dateLabel, arrow);
    const ancestorLine = create('span', 'world-watch-ancestor-line');
    const ancestor = create('span', 'world-watch-ancestor');
    const meetingStatus = create('span', 'world-watch-meeting'); meetingStatus.setAttribute('aria-hidden', 'true');
    const meetingPercent = create('span', 'world-watch-meeting-percent');
    const meetingCountdown = create('span', 'world-watch-meeting-countdown');
    meetingStatus.append(meetingPercent, meetingCountdown);
    ancestorLine.append(ancestor, meetingStatus);
    const offerings = create('span', 'world-watch-offerings');
    todayButton.append(meetingFill, dateLine, ancestorLine, offerings);
    todayButton.addEventListener('click', () => { select('calendar'); calendar?.showToday(); tabs.calendar.focus(); });
    panels.overview.append(hero, todayButton);
    root.append(navigation, stage); element.replaceChildren(root);

    const resize = () => { if (!destroyed) onResize(); };
    const clock = ClockWidget.mount(clockElement, { api, language: locale, onResize: resize });
    const weather = WeatherWidget.mount(weatherElement, { api, language: locale, onResize: resize });

    function select(name) {
      if (destroyed || !Object.hasOwn(panels, name)) return;
      view = name; root.dataset.view = name;
      for (const key of Object.keys(tabs)) {
        const selected = key === name;
        tabs[key].setAttribute('aria-selected', String(selected)); tabs[key].tabIndex = selected ? 0 : -1;
        panels[key].hidden = !selected;
      }
      if (name === 'calendar' && !calendar) {
        const content = create('div', 'calendar-content'); panels.calendar.append(content);
        calendar = CalendarWidget.mount(content, { api, language: locale, showOfferings, onResize: resize });
      }
      if (name === 'forecast' && !forecast) {
        const content = create('div', 'weather-content'); panels.forecast.append(content);
        forecast = WeatherWidget.mount(content, { api, language: locale, onResize: resize });
      }
      resize();
    }

    function renderToday() {
      if (destroyed) return;
      const date = snapshot?.date || new Date().toISOString().slice(0, 10);
      const value = new Date(`${date}T12:00:00Z`);
      dateLabel.textContent = `${Number.isFinite(value.getTime()) ? formatter.format(value) : date} · ${t.worldWatchUtc}`;
      todayLabel.textContent = t.worldWatchToday;
      ancestor.textContent = snapshot?.ancestor ? (t['daily' + snapshot.ancestor.replaceAll(' ', '')] || snapshot.ancestor)
        : (!snapshot ? failed ? t.worldWatchUnavailable : t.worldWatchLoading
        : !snapshot.encounterAvailable ? t.worldWatchWaiting : t.worldWatchChoose);
      const names = Array.isArray(snapshot?.offers) ? snapshot.offers.map(offer => offer.name).join(' · ') : '';
      offerings.textContent = names ? t.worldWatchOffers.replace('{names}', names) : t.worldWatchNoOffers;
      offerings.hidden = !showOfferings;
      offerings.title = offerings.textContent;
      todayButton.dataset.status = failed ? 'unavailable' : snapshot ? 'ready' : 'loading';
      renderMeeting();
    }

    function renderMeeting() {
      if (destroyed) return;
      const meeting = blessedMeetingTimer(timerState);
      todayButton.dataset.timerState = meeting ? meeting.ready ? 'ready' : 'active' : 'missing';
      meetingStatus.hidden = !meeting;
      meetingFill.hidden = !meeting || meeting.percent === null;
      meetingFill.style.width = `${meeting?.percent ?? 0}%`;
      meetingPercent.textContent = meeting?.percent === null || !meeting ? '' : `${Math.round(meeting.percent)}%`;
      meetingCountdown.textContent = !meeting ? '' : meeting.ready ? t.ready : [
        Math.floor(meeting.remaining / 3600), Math.floor(meeting.remaining % 3600 / 60), meeting.remaining % 60,
      ].map(value => String(value).padStart(2, '0')).join(':');
      const status = meeting ? [meeting.name, meetingPercent.textContent, meetingCountdown.textContent].filter(Boolean).join(' · ') : '';
      meetingStatus.title = status;
      todayButton.title = [t.worldWatchOpenCalendar, status].filter(Boolean).join('\n');
      todayButton.setAttribute('aria-label', `${t.worldWatchOpenCalendar}. ${dateLabel.textContent}. ${ancestor.textContent}${showOfferings ? `. ${offerings.textContent}` : ''}${status ? `. ${status}` : ''}`);
    }

    function setTimerState(value) {
      if (destroyed) return;
      timerState = value;
      renderMeeting();
    }

    async function refreshToday() {
      if (destroyed) return;
      const serial = ++request;
      const date = new Date().toISOString().slice(0, 10);
      try {
        const value = await api.getCalendarDay(date);
        if (destroyed || request !== serial) return;
        if (date !== new Date().toISOString().slice(0, 10)) {
          snapshot = null; failed = false; renderToday();
          return refreshToday();
        }
        if (value?.date !== date) throw new Error('Calendar returned a different day');
        snapshot = value; failed = false; renderToday();
      } catch {
        if (destroyed || request !== serial) return;
        // A stale encounter must not masquerade as today's after UTC rollover.
        if (snapshot?.date !== new Date().toISOString().slice(0, 10)) snapshot = null;
        failed = true; renderToday();
      }
    }
    function scheduleMidnight() {
      clearTimeout(midnightTimer);
      const now = new Date();
      midnightTimer = setTimeout(() => {
        snapshot = null; renderToday(); refreshToday(); scheduleMidnight();
      }, Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime() + 50);
    }
    function setLanguage(value) {
      if (destroyed) return;
      locale = value || 'en';
      const translations = typeof TRANSLATIONS === 'undefined' ? {} : TRANSLATIONS;
      t = { ...fallback, ...translations.en, ...translations[locale] };
      try { formatter = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }); }
      catch { formatter = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }); }
      tabs.overview.textContent = t.worldWatchNow;
      tabs.forecast.textContent = t.worldWatchForecast;
      tabs.calendar.textContent = t.worldWatchCalendar;
      navigation.setAttribute('aria-label', t.worldWatchWidget || 'World Watch');
      clock.setLanguage(locale); weather.setLanguage(locale); calendar?.setLanguage(locale); forecast?.setLanguage(locale);
      renderToday();
    }
    function setShowOfferings(value) {
      if (destroyed) return;
      showOfferings = value !== false; calendar?.setShowOfferings(showOfferings); renderToday();
    }
    function onVisibility() { if (!document.hidden && !destroyed) { refreshToday(); renderMeeting(); scheduleMidnight(); } }
    const unsubscribe = api.onCalendarChanged(refreshToday);
    const timer = setInterval(() => { if (!document.hidden) refreshToday(); }, 60000);
    const countdownTimer = setInterval(() => { if (!document.hidden) renderMeeting(); }, 1000);
    document.addEventListener('visibilitychange', onVisibility);
    function destroy() {
      if (destroyed) return;
      destroyed = true; request++;
      clearInterval(timer); clearInterval(countdownTimer); clearTimeout(midnightTimer); unsubscribe?.();
      document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('unload', destroy);
      clock.destroy(); weather.destroy(); calendar?.destroy(); forecast?.destroy();
      element.replaceChildren();
    }
    window.addEventListener('unload', destroy, { once: true });
    setLanguage(locale); select(view); refreshToday(); scheduleMidnight();
    return { setLanguage, setShowOfferings, setTimerState, destroy };
  },
};
