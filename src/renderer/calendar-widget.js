'use strict';

window.CalendarWidget = {
  mount(element, { api = window.api, language = 'en', showOfferings = true, onResize = () => {} } = {}) {
    let locale = language;
    let t = { ...TRANSLATIONS.en, ...TRANSLATIONS[locale] };
    let date = new Date().toISOString().slice(0, 10);
    let today = date;
    let serial = 0;
    let destroyed = false;
    let midnightTimer;
    const create = (tag, cls, text) => {
      const node = document.createElement(tag); node.className = cls;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const button = (cls, text, title, handler) => {
      const node = create('button', cls, text); node.type = 'button'; node.title = title;
      node.setAttribute('aria-label', title); node.addEventListener('click', handler); return node;
    };
    const shift = amount => {
      const value = new Date(`${date}T00:00:00Z`);
      value.setUTCDate(value.getUTCDate() + amount);
      date = value.toISOString().slice(0, 10); refresh();
    };
    const toolbar = create('div', 'calendar-toolbar');
    const previous = button('calendar-nav', '‹', t.calendarPrevious, () => shift(-1));
    const picker = create('input', 'calendar-date'); picker.type = 'date';
    const next = button('calendar-nav', '›', t.calendarNext, () => shift(1));
    picker.addEventListener('change', () => {
      if (picker.value && picker.validity.valid) { date = picker.value; refresh(); }
    });
    toolbar.append(previous, picker, next);
    const card = create('article', 'calendar-day'); card.setAttribute('aria-live', 'polite');
    const encounter = create('div', 'calendar-encounter');
    const offers = create('ul', 'calendar-offers'); offers.id = `calendar-offerings-${crypto.randomUUID()}`;
    const offersToggle = button('calendar-offers-toggle', t.calendarOffers, t.calendarHideOfferings, async () => {
      const previous = showOfferings;
      setShowOfferings(!showOfferings);
      try {
        if (await api.saveConfig({ calendarShowOfferings: showOfferings }) === false) throw new Error('Save failed');
      } catch {
        if (destroyed) return;
        setShowOfferings(previous);
        error.textContent = t.calendarSaveError; error.hidden = false; onResize();
      }
    });
    offersToggle.setAttribute('aria-controls', offers.id);
    card.append(encounter, offersToggle, offers);
    const footer = create('div', 'calendar-footer');
    const todayButton = button('calendar-action', t.calendarToday, t.calendarToday, () => { date = new Date().toISOString().slice(0, 10); refresh(); });
    const ancestors = button('calendar-action', t.calendarAncestors, t.calendarAncestors, () => api.openCalendarSettings());
    const utc = create('span', 'calendar-utc', t.calendarUtc);
    footer.append(todayButton, ancestors, utc);
    const error = create('div', 'calendar-error'); error.setAttribute('role', 'status'); error.hidden = true;
    element.replaceChildren(toolbar, card, footer, error);

    function setShowOfferings(value) {
      showOfferings = value !== false;
      offers.hidden = !showOfferings;
      offersToggle.setAttribute('aria-expanded', String(showOfferings));
      offersToggle.textContent = t.calendarOffers;
      offersToggle.setAttribute('aria-label', t.calendarOffers);
      offersToggle.title = showOfferings ? t.calendarHideOfferings : t.calendarShowOfferings;
      onResize();
    }
    setShowOfferings(showOfferings);

    function wikiLink(name, cls, label = name) {
      if (!api.wikiAvailable) return create('span', cls, label);
      return button(`calendar-link ${cls}`, label, label, () => api.openWikiSearch(name));
    }
    function render(data) {
      today = data.today;
      picker.value = date;
      picker.min = data.firstDate; picker.max = data.lastDate;
      picker.setAttribute('aria-label', t.calendarDate);
      previous.disabled = date <= data.firstDate; next.disabled = date >= data.lastDate;
      previous.title = t.calendarPrevious; previous.setAttribute('aria-label', t.calendarPrevious);
      next.title = t.calendarNext; next.setAttribute('aria-label', t.calendarNext);
      todayButton.textContent = t.calendarToday; todayButton.disabled = date === today;
      ancestors.textContent = t.calendarAncestors; utc.textContent = t.calendarUtc;
      todayButton.title = t.calendarToday; todayButton.setAttribute('aria-label', t.calendarToday);
      ancestors.title = t.calendarAncestors; ancestors.setAttribute('aria-label', t.calendarAncestors);
      card.dataset.date = date;
      encounter.replaceChildren();
      encounter.append(create('span', 'calendar-label', t.calendarEncounter));
      if (data.ancestor) encounter.append(wikiLink(data.ancestor, 'calendar-ancestor', t['daily' + data.ancestor.replaceAll(' ', '')]));
      else encounter.append(create('p', 'calendar-empty', !data.encounterAvailable ? t.calendarUnavailable : t.calendarWaiting));
      encounter.append(create('div', 'calendar-source', data.customized ? t.calendarCustom : data.source === 'cached' ? t.calendarCached : data.source === 'live' ? t.calendarAccount : t.calendarChoose));
      offers.replaceChildren();
      if (data.offers) for (const offer of data.offers) {
        const row = create('li', 'calendar-offer');
        row.append(wikiLink(offer.name, 'calendar-offer-name'), create('span', 'calendar-price', `${offer.price.toLocaleString(locale)} ${t.calendarArcs}`));
        offers.append(row);
      }
      else offers.append(create('li', 'calendar-empty', t.calendarUnavailable));
      setShowOfferings(showOfferings);
    }
    async function refresh() {
      const request = ++serial;
      const current = new Date().toISOString().slice(0, 10);
      if (date === today && today !== current) date = current;
      try {
        const data = await api.getCalendarDay(date);
        if (destroyed || request !== serial) return;
        render(data); error.hidden = true;
      } catch {
        if (destroyed || request !== serial) return;
        error.textContent = t.calendarLoadError; error.hidden = false; onResize();
      }
    }
    function scheduleMidnight() {
      clearTimeout(midnightTimer);
      const now = new Date();
      midnightTimer = setTimeout(() => { refresh(); scheduleMidnight(); }, Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime() + 50);
    }
    const unsubscribe = api.onCalendarChanged(refresh);
    const timer = setInterval(refresh, 60000); // Refresh the feed only when this module is enabled.
    const onVisibility = () => { if (!document.hidden) { refresh(); scheduleMidnight(); } };
    document.addEventListener('visibilitychange', onVisibility);
    scheduleMidnight(); refresh();
    const controller = {
      setShowOfferings,
      showToday() { if (!destroyed) { date = new Date().toISOString().slice(0, 10); refresh(); } },
      setLanguage(value) { locale = value || 'en'; t = { ...TRANSLATIONS.en, ...TRANSLATIONS[locale] }; refresh(); },
      destroy() {
        if (destroyed) return;
        destroyed = true; serial++; clearInterval(timer); clearTimeout(midnightTimer); unsubscribe?.();
        document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('beforeunload', onUnload);
      },
    };
    const onUnload = () => controller.destroy();
    window.addEventListener('beforeunload', onUnload, { once: true });
    return controller;
  },
};
