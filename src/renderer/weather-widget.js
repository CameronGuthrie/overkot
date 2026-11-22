'use strict';

window.WeatherWidget = {
  mount(element, { api = window.api, language = 'en', onResize = () => {} } = {}) {
    const fallback = {
      weatherNow: 'Now', weatherNext: 'Up next', weatherLater: 'Coming up',
      weatherClear: 'Clear', weatherBreeze: 'Breezy', weatherWind: 'Windy', weatherOvercast: 'Overcast',
      weatherRain: 'Rain', weatherThunder: 'Thunder', weatherRainbow: 'Rainbow chance',
      weatherChance: '{percent}% rainbow chance', weatherLoading: 'Loading forecast…',
      weatherUnavailable: 'Forecast unavailable', weatherWaiting: 'Waiting for the next forecast',
      weatherCached: 'Saved forecast', weatherForecast: 'Weather forecast',
      weatherPredicted: 'Predicted weather', weatherEstimated: 'Device time',
      weatherNote: 'Forecast follows the world weather cycle. Quests may override local weather.',
      weatherUpdated: 'Updated {time}', weatherLocalTime: 'Local time',
      weatherIn: 'in {time}', weatherSoon: 'under 1m', weatherMinutes: '{minutes}m',
      weatherHours: '{hours}h {minutes}m',
    };
    const kinds = {
      clear: 'weatherClear', breeze: 'weatherBreeze', wind: 'weatherWind', overcast: 'weatherOvercast',
      rain: 'weatherRain', thunder: 'weatherThunder', rainbow: 'weatherRainbow',
    };
    let locale, t, timeFormatter, sample, sampleMono = 0, request = 0;
    let destroyed = false, failed = false, paused = false, boundary = '', timelineKey = '', layoutKey = '';
    let rows = [];
    const create = (tag, className, text) => {
      const node = document.createElement(tag); node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const format = (key, values) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), t[key]);
    // Geometry and animations are bundled locally; remote names never become HTML.
    element.innerHTML = `<section class="weather-forecast" data-status="loading">
      <div class="weather-current">
        <div class="weather-current-copy">
          <div class="weather-eyebrow weather-now-label"></div>
          <div class="weather-current-name"></div>
          <div class="weather-chance" hidden></div>
        </div>
        <svg class="weather-scene" viewBox="0 0 120 100" aria-hidden="true" focusable="false">
          <circle class="weather-halo" cx="68" cy="43" r="35"/>
          <g class="weather-sun" transform="translate(73 32)">
            <g class="weather-rays" fill="none"><path d="M0-25v6M0 19v6M-25 0h6M19 0h6M-18-18l4 4M14 14l4 4M-18 18l4-4M14-14l4-4"/></g>
            <circle r="12"/>
          </g>
          <g class="weather-rainbow" fill="none">
            <path d="M18 66a40 40 0 0 1 80 0"/><path d="M24 66a34 34 0 0 1 68 0"/><path d="M30 66a28 28 0 0 1 56 0"/>
          </g>
          <path class="weather-cloud weather-cloud-back" d="M41 50a12 12 0 0 1 1-24 18 18 0 0 1 35-2 13 13 0 0 1 3 26Z"/>
          <path class="weather-cloud weather-cloud-front" d="M28 65a14 14 0 0 1 0-28 20 20 0 0 1 38-2 15 15 0 0 1 7 30Z"/>
          <g class="weather-rain" fill="none">
            <path d="m30 73-4 7"/><path d="m46 76-4 7"/><path d="m62 72-4 7"/><path d="m77 76-4 7"/>
            <path d="m36 87-3 5"/><path d="m68 87-3 5"/>
          </g>
          <path class="weather-bolt" d="m58 55-14 23h12l-5 17 23-28H60l8-12Z"/>
          <g class="weather-wind" fill="none">
            <path d="M17 49h58c13 0 13-16 2-16M9 61h83M31 73h35c12 0 12 15 1 15"/>
            <path class="weather-leaf" d="M90 50q14-14 19-3-9 11-19 3Z"/>
          </g>
          <path class="weather-ground" d="M15 95q45-5 90 0" fill="none"/>
        </svg>
      </div>
      <div class="weather-next" hidden>
        <div class="weather-next-heading"><span class="weather-eyebrow weather-next-label"></span><span class="weather-countdown" aria-live="off"></span></div>
        <div class="weather-next-name"></div>
        <div class="weather-progress" aria-hidden="true"><div class="weather-progress-fill"></div></div>
      </div>
      <div class="weather-later" hidden><div class="weather-eyebrow weather-later-label"></div><ol class="weather-timeline"></ol></div>
      <div class="weather-footer"><span class="weather-status" role="status"></span><span class="weather-local-time"></span></div>
    </section>`;
    const $ = selector => element.querySelector(selector);
    const root = $('.weather-forecast'), scene = $('.weather-scene');
    const currentName = $('.weather-current-name'), chance = $('.weather-chance');
    const next = $('.weather-next'), nextName = $('.weather-next-name'), countdown = $('.weather-countdown');
    const progress = $('.weather-progress-fill'), later = $('.weather-later'), timeline = $('.weather-timeline');
    const status = $('.weather-status'), localTime = $('.weather-local-time');

    function period(value) {
      if (!value || !Object.hasOwn(kinds, value.kind) || !Number.isFinite(value.start) || !Number.isFinite(value.end) || value.end <= value.start
        || !Number.isFinite(new Date(value.start).getTime()) || !Number.isFinite(new Date(value.end).getTime())) return null;
      return { start: value.start, end: value.end, kind: value.kind, rainbowChance: value.rainbowChance };
    }
    function now() { return sample.time + performance.now() - sampleMono; }
    function hasRainbow(value) { return Number.isFinite(value?.rainbowChance) && value.rainbowChance > 0; }
    function forecastName(value) {
      const name = t[kinds[value.kind]];
      return hasRainbow(value) && value.kind !== 'rainbow' ? `${name} · ${t.weatherRainbow}` : name;
    }
    function duration(milliseconds) {
      const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
    }
    function relative(milliseconds) {
      const minutes = Math.max(0, Math.ceil(milliseconds / 60000));
      const time = milliseconds < 60000 ? t.weatherSoon : minutes < 60
        ? format('weatherMinutes', { minutes })
        : format('weatherHours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
      return format('weatherIn', { time });
    }
    function localDate(timestamp) {
      const date = new Date(timestamp);
      return Number.isFinite(date.getTime()) ? timeFormatter.format(date) : '';
    }
    function setLanguage(value) {
      locale = value || 'en';
      const translations = typeof TRANSLATIONS === 'undefined' ? {} : TRANSLATIONS;
      t = { ...fallback, ...translations.en, ...translations[locale] };
      try { timeFormatter = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }); }
      catch { timeFormatter = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' }); }
      $('.weather-now-label').textContent = t.weatherNow;
      $('.weather-next-label').textContent = t.weatherNext;
      $('.weather-later-label').textContent = t.weatherLater;
      localTime.textContent = t.weatherLocalTime;
      root.setAttribute('aria-label', t.weatherForecast);
      timelineKey = ''; layoutKey = ''; render();
    }
    function render() {
      if (destroyed) return;
      if (!sample) {
        currentName.textContent = failed ? t.weatherUnavailable : t.weatherLoading;
        status.textContent = failed ? t.weatherWaiting : '';
        root.dataset.status = failed ? 'unavailable' : 'loading';
        scene.dataset.kind = 'unavailable';
        if (layoutKey !== root.dataset.status) { layoutKey = root.dataset.status; onResize(); }
        return;
      }
      const timestamp = now();
      const periods = [sample.current, ...sample.upcoming].filter(Boolean).sort((a, b) => a.start - b.start);
      const current = periods.find(value => value.start <= timestamp && value.end > timestamp);
      const upcoming = periods.filter(value => value.start > timestamp).slice(0, 3);
      const nextPeriod = upcoming[0];
      root.dataset.status = !current ? 'unavailable' : failed || sample.status === 'cached' ? 'cached'
        : sample.status === 'estimated' ? 'estimated' : 'ready';
      scene.dataset.kind = current ? hasRainbow(current) ? 'rainbow' : current.kind : 'unavailable';
      currentName.textContent = current ? t[kinds[current.kind]] : t.weatherUnavailable;
      chance.hidden = !hasRainbow(current);
      if (!chance.hidden) chance.textContent = format('weatherChance', { percent: Math.round(Math.min(1, current.rainbowChance) * 100) });
      next.hidden = !nextPeriod;
      if (nextPeriod) {
        nextName.textContent = forecastName(nextPeriod);
        countdown.textContent = duration(nextPeriod.start - timestamp);
        countdown.setAttribute('aria-label', relative(nextPeriod.start - timestamp));
        const start = current?.start ?? sample.time;
        const portion = (timestamp - start) / Math.max(1, nextPeriod.start - start);
        progress.style.width = `${Math.max(0, Math.min(1, portion)) * 100}%`;
      }
      later.hidden = !upcoming.length;
      const key = upcoming.map(value => `${value.start}:${value.kind}:${hasRainbow(value)}`).join('|');
      if (timelineKey !== key || rows.length !== upcoming.length) {
        timelineKey = key; rows = []; timeline.replaceChildren();
        for (const value of upcoming) {
          const item = create('li', 'weather-step'); item.dataset.kind = value.kind;
          item.dataset.rainbowChance = String(hasRainbow(value));
          const dot = create('span', 'weather-step-dot'); dot.setAttribute('aria-hidden', 'true');
          const name = create('span', 'weather-step-name', forecastName(value));
          const timing = create('span', 'weather-step-timing');
          const time = create('time', 'weather-step-time', localDate(value.start));
          time.dateTime = new Date(value.start).toISOString();
          const relativeNode = create('span', 'weather-step-relative');
          timing.append(time, relativeNode); item.append(dot, name, timing); timeline.append(item);
          rows.push(relativeNode);
        }
      }
      rows.forEach((node, index) => { node.textContent = relative(upcoming[index].start - timestamp); });
      const updated = sample.fetchedAt || sample.syncedAt;
      status.textContent = !current ? t.weatherWaiting : failed || sample.status === 'cached' ? t.weatherCached
        : sample.status === 'estimated' ? t.weatherEstimated : t.weatherPredicted;
      status.title = updated ? `${format('weatherUpdated', { time: localDate(updated) })}\n${t.weatherNote}` : t.weatherNote;
      const nextLayout = `${root.dataset.status}|${currentName.textContent}|${chance.textContent}|${chance.hidden}|${key}|${status.textContent}`;
      if (layoutKey !== nextLayout) { layoutKey = nextLayout; onResize(); }
    }
    async function refresh() {
      const serial = ++request;
      try {
        const state = await api.getWeatherForecast();
        if (destroyed || serial !== request) return;
        if (!state || !Number.isFinite(state.time)) throw new Error('Invalid forecast clock');
        const current = period(state.current);
        const upcoming = (Array.isArray(state.upcoming) ? state.upcoming : []).map(period).filter(Boolean);
        if (state.status === 'unavailable' && sample && [sample.current, ...sample.upcoming].some(value => value && value.start <= state.time && value.end > state.time)) {
          sample.time = state.time; sampleMono = performance.now();
          if (Number.isFinite(state.syncedAt)) sample.syncedAt = state.syncedAt;
          boundary = ''; failed = true; render(); return;
        }
        sample = { time: state.time, current, upcoming, status: state.status,
          fetchedAt: Number.isFinite(state.fetchedAt) ? state.fetchedAt : null,
          syncedAt: Number.isFinite(state.syncedAt) ? state.syncedAt : null };
        sampleMono = performance.now(); failed = state.status === 'unavailable';
        boundary = ''; render();
      } catch {
        if (destroyed || serial !== request) return;
        failed = true; render();
      }
    }
    function visibility() {
      const wasPaused = paused;
      paused = document.hidden || !!element.closest('.collapsed, .hidden, [hidden]');
      root.dataset.paused = String(paused);
      if (wasPaused && !paused) { render(); refresh(); }
    }
    const observer = new MutationObserver(visibility);
    for (let node = element; node; node = node.parentElement) observer.observe(node, { attributes: true, attributeFilter: ['class', 'hidden'] });
    document.addEventListener('visibilitychange', visibility);
    const unsubscribe = api?.onWeatherChanged?.(refresh);
    const timer = setInterval(() => {
      if (paused || destroyed) return;
      render();
      if (!sample) return;
      const timestamp = now();
      const current = [sample.current, ...sample.upcoming].find(value => value && value.start <= timestamp && value.end > timestamp);
      const nextBoundary = String(current?.start || 'expired');
      if (boundary && boundary !== nextBoundary) refresh();
      boundary = nextBoundary;
    }, 1000);
    const sync = setInterval(() => { if (!paused) refresh(); }, 60000);
    function destroy() {
      if (destroyed) return;
      destroyed = true; request++; clearInterval(timer); clearInterval(sync); observer.disconnect();
      unsubscribe?.(); document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('unload', destroy);
    }
    window.addEventListener('unload', destroy, { once: true });
    setLanguage(language); visibility(); refresh();
    return { setLanguage, destroy };
  },
};
