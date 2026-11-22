'use strict';

window.DailyBriefWidget = {
  mount(element, { api = window.api, language = 'en', onResize = () => {} } = {}) {
    let locale = language, snapshot = null, destroyed = false, revision = 0, active = 'today', failed = false;
    let calendar = null, showAll = false, query = '', saving = false, preferenceError = false;
    let nextStockExpiry = null, displayedDay = new Date().toISOString().slice(0, 10);
    const pending = new Map(), expanded = new Set(['avakot']);
    const node = (tag, className = '', text) => {
      const value = document.createElement(tag); value.className = className;
      if (text !== undefined) value.textContent = text;
      return value;
    };
    const button = (className, text, handler) => { const value = node('button', className, text); value.type = 'button'; value.addEventListener('click', handler); return value; };
    const catalogs = typeof TRANSLATIONS === 'undefined' ? {} : TRANSLATIONS;
    function tr(key, fallback, params) {
      const text = catalogs[locale]?.[key] || catalogs.en?.[key] || fallback;
      return params ? text.replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match) : text;
    }
    const staticLabels = [];
    function label(control, key, fallback) {
      staticLabels.push({ control, key, fallback });
      return control;
    }
    function currencyName(value) {
      if (value === 'Dracs') return tr('sessionGainsRegular', 'Dracs');
      if (value === 'Arcs') return tr('calendarArcs', 'Arcs');
      if (value === 'Standing') return tr('odeInfamyStanding', 'Standing');
      return value || '';
    }
    const number = value => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
    const root = node('section', 'daily-brief');
    const header = node('header', 'daily-header'), title = node('div', 'daily-heading');
    const dateLabel = node('strong', 'daily-date'), countdown = node('span', 'daily-reset');
    title.append(dateLabel, countdown);
    header.append(title, label(button('daily-done', '', () => api.dismissDailyBrief()), 'tourDone', 'Done'));
    const tabs = node('div', 'daily-tabs'); tabs.setAttribute('role', 'tablist');
    const stage = node('div', 'daily-stage'), panels = {}, tabButtons = {};
    const identity = `daily-${crypto.randomUUID()}`;
    for (const [id, key, name] of [['today', 'calendarToday', 'Today'], ['vendors', 'dailyVendors', 'Vendors'], ['calendar', 'calendarWidget', 'Calendar']]) {
      const tab = label(button('daily-tab', '', () => select(id)), key, name); tab.id = `${identity}-${id}-tab`; tab.setAttribute('role', 'tab');
      const panel = node('div', `daily-panel daily-${id}`); panel.id = `${identity}-${id}`; panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id); tab.setAttribute('aria-controls', panel.id);
      tab.addEventListener('keydown', event => {
        const ids = ['today', 'vendors', 'calendar'], i = ids.indexOf(id);
        const next = event.key === 'ArrowRight' ? ids[(i + 1) % ids.length] : event.key === 'ArrowLeft' ? ids[(i + ids.length - 1) % ids.length]
          : event.key === 'Home' ? ids[0] : event.key === 'End' ? ids.at(-1) : null;
        if (next) { event.preventDefault(); select(next); tabButtons[next].focus(); }
      });
      panels[id] = panel; tabButtons[id] = tab; tabs.append(tab); stage.append(panel);
    }
    const vendorControls = node('div', 'daily-vendor-controls');
    const search = node('input', 'daily-search'); search.type = 'search';
    search.addEventListener('input', () => { query = search.value.trim().toLocaleLowerCase(locale); renderVendors(); });
    const allLabel = node('label', 'daily-check'), allInput = node('input'); allInput.type = 'checkbox';
    allInput.addEventListener('change', () => { showAll = allInput.checked; renderVendors(); });
    allLabel.append(allInput, label(node('span'), 'dailyAllFavors', 'Include all faction favors'));
    vendorControls.append(search, allLabel);
    const vendorBody = node('div', 'daily-scroll daily-vendor-list'); panels.vendors.append(vendorControls, vendorBody);
    const todayBody = node('div', 'daily-scroll daily-today-content'); panels.today.append(todayBody);
    const error = node('p', 'daily-error'); error.setAttribute('role', 'status');
    const footer = node('footer', 'daily-footer');
    const refreshButton = label(button('daily-refresh', '', () => { void refresh(true); }), 'gfRefresh', 'Refresh');
    const settings = node('details', 'daily-preferences'), summary = label(node('summary'), 'dailyShowAuto', 'Show automatically'); settings.append(summary);
    const choices = {};
    for (const [key, titleKey, text] of [['dailyAutoLogin', 'dailyOnLogin', 'When I log in to Soulframe'], ['dailyAutoReset', 'dailyOnReset', 'At the daily reset · 00:00 UTC']]) {
      const choice = node('label', 'daily-check'), input = node('input'); input.type = 'checkbox'; input.checked = true;
      input.addEventListener('change', () => { pending.set(key, input.checked); void savePreferences(); });
      choice.append(input, label(node('span'), titleKey, text)); settings.append(choice); choices[key] = input;
    }
    footer.append(settings, refreshButton); root.append(header, tabs, stage, error, footer); element.replaceChildren(root);

    function select(id) {
      if (destroyed) return;
      active = id;
      for (const key of Object.keys(panels)) {
        panels[key].hidden = key !== id; tabButtons[key].tabIndex = key === id ? 0 : -1; tabButtons[key].setAttribute('aria-selected', String(key === id));
      }
      if (id === 'calendar' && !calendar) {
        const content = node('div', 'calendar-content'); panels.calendar.append(content);
        calendar = window.CalendarWidget.mount(content, { api, language: locale, onResize: () => { if (!destroyed && active === 'calendar') onResize(); } });
      }
      onResize();
    }
    function heading(body, text) { body.append(node('h3', 'daily-section-title', text)); }
    function note(body, text) { body.append(node('p', 'daily-note', text)); }
    function renderToday() {
      const top = todayBody.scrollTop; todayBody.replaceChildren();
      if (!snapshot) {
        note(todayBody, failed ? tr('dailyLoadFailed', 'Daily information could not be loaded. Use Refresh to retry.')
          : tr('dailyCheckingToday', 'Checking today’s information…'));
        return;
      }
      if (snapshot.date !== new Date().toISOString().slice(0, 10)) { note(todayBody, tr('dailyUpdatingDay', 'Updating for the new day…')); return; }
      heading(todayBody, tr('dailyOverview', 'Your daily overview'));
      if (snapshot.allowanceStatus !== 'live') {
        const status = {
          connect: tr('dailyConnectAllowances', 'Connect to Soulframe for your daily allowances.'),
          waiting: tr('temperWaiting', 'Waiting for inventory…'),
          cached: tr('dailySavedAllowances', 'Saved inventory · allowances may have changed.'),
          stale: tr('dailyWaitingInventory', 'Waiting for today’s inventory update.'),
        };
        note(todayBody, status[snapshot.allowanceStatus] || tr('dailyInventoryUnavailable', 'Inventory unavailable.'));
      }
      const budgets = node('div', 'daily-budgets');
      const budgetLabels = [
        ['affiliation', tr('dailyAffiliationLeft', 'Affiliation remaining')],
        ['playtime', tr('dailyTotalPlayed', 'Total played time')],
        ['trades', tr('dailyTradesLeft', 'Trades remaining')],
      ];
      for (const [key, text] of budgetLabels) {
        const amount = snapshot.allowanceStatus === 'stale' ? null : snapshot.allowances?.[key];
        const played = snapshot.playtime?.seconds;
        const value = key === 'playtime' ? typeof played === 'number' && Number.isFinite(played) && played >= 0
          ? tr('weatherHours', '{hours}h {minutes}m', { hours: number(Math.floor(played / 3600)), minutes: number(Math.floor(played % 3600 / 60)) }) : '—'
          : Number.isSafeInteger(amount) && amount >= 0 ? number(amount) : '—';
        const card = node('div', 'daily-budget'); card.append(node('span', '', text), node('strong', '', value)); budgets.append(card);
      }
      todayBody.append(budgets);
      if (snapshot.playtime?.status === 'cached') note(todayBody, tr('dailySavedPlaytime', 'Saved total played time · refresh to check the latest profile.'));
      heading(todayBody, tr('dailyTodaysEncounter', 'Today’s encounter'));
      const day = snapshot.calendar;
      if (day?.ancestor) todayBody.append(node('strong', 'daily-ancestor', tr('daily' + day.ancestor.replaceAll(' ', ''), day.ancestor)));
      else if (day?.encounterAvailable && !day.inventoryReady) {
        note(todayBody, tr('dailyEncounterDepends', 'Your encounter depends on the ancestors you have unlocked.'));
        todayBody.append(button('daily-choose-ancestors', tr('dailyChooseAncestors', 'Choose ancestors'), () => api.openCalendarSettings()));
      } else note(todayBody, tr('dailyEncounterUnavailable', 'Encounter information is unavailable for this day.'));
      const upcoming = node('div', 'daily-upcoming');
      for (const [key, name] of [['tuvalkane', tr('dailyTuvalkane', 'Tuvalkane')], ['zenith', tr('dailyZenith', 'Zenith')]]) {
        const next = snapshot.upcoming?.[key];
        const when = next?.status === 'locked' ? tr('dailyLocked', 'Not unlocked') : Number.isInteger(next?.days) && next.days > 0
          ? next.days === 1 ? tr('dailyTomorrow', 'Tomorrow') : tr('dailyInDays', 'In {days} days', { days: number(next.days) }) : tr('dailyUnavailable', 'Unavailable');
        const row = node('div', 'daily-next-encounter'); row.append(node('span', '', tr('dailyNextEncounter', 'Next {name}', { name })), node('strong', '', when)); upcoming.append(row);
      }
      todayBody.append(upcoming);
      heading(todayBody, tr('calendarOffers', 'Zenith’s offerings'));
      if (!day?.offers?.length) note(todayBody, tr('dailyNoOfferings', 'Offerings are unavailable for this day.'));
      else for (const offer of day.offers) {
        const row = node('div', 'daily-offer');
        const price = tr('dailyPrice', '{price} {currency}', { price: number(offer.price), currency: tr('calendarArcs', 'Arcs') });
        row.append(node('strong', '', offer.name), node('span', '', price)); todayBody.append(row);
      }
      todayBody.scrollTop = top;
    }
    function countdownText(until) {
      if (!Number.isFinite(until)) return '—';
      const seconds = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
    }
    function itemCard(item, faction) {
      const card = node('article', 'daily-vendor-item'), line = node('div', 'daily-item-heading');
      const identity = node('div', 'daily-item-identity');
      if (window.ItemImages) identity.append(window.ItemImages.create(item.icon, { className: 'daily-item-icon', category: item.isWeapon ? 'weapon' : '' }));
      identity.append(node('strong', '', item.name));
      const price = item.price == null ? tr('dailyPriceUnavailable', 'Price unavailable')
        : tr('dailyPrice', '{price} {currency}', { price: number(item.price), currency: currencyName(item.currency) }).trim();
      line.append(identity, node('span', 'daily-price', price)); card.append(line);
      const badges = [];
      if (item.quality) badges.push(item.qualityId === 'IQ_OFFICER' ? tr('dailyOfficer', 'Officer') : item.quality);
      if (item.requiredRank !== null && item.requiredRank !== undefined) badges.push(tr('dailyRank', 'Rank {rank}', { rank: number(item.requiredRank) }));
      if (item.eligible === false) badges.push(tr('dailyRankRequired', 'Rank required'));
      if (item.weekly) badges.push(tr('dailyWeekly', 'Weekly'));
      if (item.limit !== null && item.limit !== undefined) badges.push(tr('dailyPurchaseLimit', 'Purchase limit {limit}', { limit: number(item.limit) }));
      if (badges.length) card.append(node('p', 'daily-item-meta', badges.join(' · ')));
      if (faction && item.isWeapon) {
        if (item.rollDate !== new Date().toISOString().slice(0, 10) || item.rollDate !== snapshot.date) note(card, tr('dailyTempersUnavailable', 'Today’s tempers are unavailable.'));
        else if (item.tempers?.length) {
          const list = node('ul', 'daily-tempers');
          for (const temper of item.tempers) {
            const row = node('li', 'daily-temper'), icon = node('span', 'daily-temper-icon');
            icon.setAttribute('aria-hidden', 'true');
            const fallback = node('span', 'daily-temper-fallback', '◇'); icon.append(fallback);
            const source = window.GameDataImages.temperIconUrl(temper.icon);
            if (source) {
              const image = node('img'); image.alt = ''; image.loading = 'lazy'; image.draggable = false;
              image.addEventListener('load', () => { fallback.hidden = true; });
              image.addEventListener('error', () => { image.hidden = true; fallback.hidden = false; });
              image.src = source;
              icon.append(image);
            }
            row.append(icon, node('span', '', `${temper.name}${temper.count > 1 ? ` ×${number(temper.count)}` : ''}`)); list.append(row);
          }
          card.append(list);
        } else note(card, tr('dailyNoTempers', 'No tempers reported.'));
      }
      if (Number.isFinite(item.expiresAt)) {
        const expiry = node('p', 'daily-item-meta'); expiry.dataset.countdown = String(item.expiresAt);
        expiry.textContent = tr('dailyRefreshIn', 'Refreshes in {time}', { time: countdownText(item.expiresAt) }); card.append(expiry);
      }
      return card;
    }
    function renderVendors() {
      const top = vendorBody.scrollTop; vendorBody.replaceChildren();
      nextStockExpiry = null;
      const data = snapshot?.vendors;
      if (!data) { note(vendorBody, tr('dailyCheckingVendors', 'Checking vendors…')); return; }
      if (data.catalogStatus === 'cached') note(vendorBody, tr('dailyCachedCatalogue', 'Saved vendor catalogue · refresh to check the latest faction offers.'));
      const matches = item => !query || `${item.name} ${item.itemType} ${(item.tempers || []).map(row => row.name).join(' ')}`.toLocaleLowerCase(locale).includes(query);
      function group(id, name, items, faction = false) {
        const section = node('details', 'daily-vendor-group'); section.open = expanded.has(id);
        const title = node('summary', '', `${name} · ${number(items.length)}`); section.append(title);
        section.addEventListener('toggle', () => section.open ? expanded.add(id) : expanded.delete(id));
        for (const item of items) section.append(itemCard(item, faction));
        vendorBody.append(section); return section;
      }
      const stock = data.avakot?.items || [], now = Date.now();
      const expiries = stock.map(item => item.expiresAt).filter(value => Number.isFinite(value) && value > now);
      nextStockExpiry = expiries.length ? Math.min(...expiries) : null;
      const live = stock.filter(item => (!Number.isFinite(item.expiresAt) || item.expiresAt > now) && matches(item));
      const avakot = group('avakot', tr('dailyAvakotShop', 'Avakot’s Gots'), live);
      if (!live.length) {
        const status = {
          connect: tr('dailyConnectStock', 'Connect to Soulframe to load Avakot’s current stock.'),
          waiting: tr('dailyLoadingStock', 'Loading current stock…'),
          unavailable: tr('dailyStockFailed', 'Current stock could not be loaded. Use Refresh to retry.'),
        };
        note(avakot, status[data.stockStatus] || (query ? tr('dailyNoMatchingOffers', 'No matching offers.')
          : tr('dailyNoOffers', 'No current offers reported.')));
      }
      if (data.stockStatus === 'cached') note(avakot, tr('dailySavedStock', 'Saved stock · open Soulframe to confirm availability.'));
      note(avakot, tr('dailyStockHint', 'Stock can change during the day. Each timed offer shows its own refresh.'));
      heading(vendorBody, showAll ? tr('dailyFactionFavors', 'Faction favors') : tr('dailyFactionWeapons', 'Faction weapons · calculated daily Tempers'));
      if (!data.factions?.length) note(vendorBody, tr('dailyFactionUnavailable', 'Faction vendor information is unavailable. Use Refresh to retry.'));
      for (const faction of data.factions || []) {
        const items = faction.items.filter(item => (showAll || item.isWeapon) && matches(item));
        const section = group(faction.id, faction.name, items, true);
        if (!items.length) note(section, tr('dailyNoItems', 'No matching items.'));
      }
      vendorBody.scrollTop = top;
      if (active === 'vendors') onResize();
    }
    function paint() {
      if (destroyed) return;
      const today = new Date().toISOString().slice(0, 10);
      dateLabel.textContent = snapshot ? tr('dailyBriefDate', 'Daily Brief · {date} UTC', { date: today }) : tr('dailyWidget', 'Daily Brief');
      countdown.textContent = !snapshot ? '' : snapshot.date === today ? tr('dailyResetIn', 'Daily reset in {time}', { time: countdownText(snapshot.resetAt) }) : tr('dailyUpdatingDay', 'Updating for the new day…');
      renderError();
      for (const [key, value] of [['dailyAutoLogin', snapshot?.settings?.autoLogin], ['dailyAutoReset', snapshot?.settings?.autoReset]]) {
        if (!pending.has(key) && typeof value === 'boolean') choices[key].checked = value;
      }
      renderToday(); renderVendors(); onResize();
    }
    function renderError() {
      error.textContent = preferenceError ? tr('dailyPreferenceError', 'Could not save automatic opening settings. Change a setting to retry.')
        : failed ? tr('dailyRefreshFailed', 'Could not refresh. Previously loaded information may be out of date.') : '';
      error.hidden = !preferenceError && !failed;
    }
    async function refresh(force = false) {
      if (destroyed) return;
      const serial = ++revision; refreshButton.disabled = true;
      try {
        const value = await (force ? api.refreshDailyBrief() : api.getDailyBrief());
        if (!destroyed && serial === revision) { snapshot = value; failed = false; paint(); }
      } catch { if (!destroyed && serial === revision) { failed = true; paint(); } }
      finally { if (!destroyed) refreshButton.disabled = false; }
    }
    async function savePreferences() {
      if (saving || destroyed) return;
      saving = true; preferenceError = false; renderError();
      try {
        while (pending.size && !destroyed) {
          const changes = new Map(pending), result = await api.saveConfig(Object.fromEntries(changes));
          if (result === false) throw new Error('Save failed');
          for (const [key, value] of changes) if (pending.get(key) === value) pending.delete(key);
        }
      } catch { if (!destroyed) { preferenceError = true; renderError(); } }
      finally { saving = false; }
    }
    const unsubscribe = api.onDailyBriefChanged(value => { if (destroyed) return; revision++; snapshot = value; failed = false; paint(); });
    const timer = setInterval(() => {
      if (destroyed || !snapshot) return;
      const today = new Date().toISOString().slice(0, 10);
      if (today !== displayedDay) { displayedDay = today; paint(); void refresh(true); }
      countdown.textContent = snapshot.date === today ? tr('dailyResetIn', 'Daily reset in {time}', { time: countdownText(snapshot.resetAt) }) : tr('dailyUpdatingDay', 'Updating for the new day…');
      for (const label of root.querySelectorAll('[data-countdown]')) label.textContent = tr('dailyRefreshIn', 'Refreshes in {time}', { time: countdownText(Number(label.dataset.countdown)) });
      if (nextStockExpiry !== null && nextStockExpiry <= Date.now()) { renderToday(); renderVendors(); }
    }, 1000);
    function translateControls() {
      for (const { control, key, fallback } of staticLabels) control.textContent = tr(key, fallback);
      search.placeholder = tr('dailySearchVendor', 'Search vendor items');
      search.setAttribute('aria-label', search.placeholder);
      query = search.value.trim().toLocaleLowerCase(locale);
    }
    translateControls(); select('today'); paint(); void refresh();
    return { setLanguage(value) { if (destroyed) return; locale = value || 'en'; translateControls(); calendar?.setLanguage(locale); paint(); }, destroy() {
      if (destroyed) return; destroyed = true; revision++; unsubscribe?.(); clearInterval(timer); calendar?.destroy();
    } };
  },
};
