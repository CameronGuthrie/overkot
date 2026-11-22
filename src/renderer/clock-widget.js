'use strict';

window.ClockWidget = {
  mount(element, { api = window.api, language = 'en', onResize = () => {} } = {}) {
    let t, sample, sampleMono, destroyed = false, request = 0;
    const identity = `clock-${crypto.randomUUID()}`;
    // All artwork is local vector geometry, including the smaller Saphene sun.
    element.innerHTML = `<svg class="clock-orbit" viewBox="0 0 310 183" role="img">
      <defs>
        <g id="${identity}-sun" fill="currentColor"><circle r="6"/><path d="M-2-9 0-13 2-9M7-6 11-9 10-4M9 2 13 4 8 5M3 8 3 13 0 9M-6 7-10 10-8 5M-9-1-13-3-8-4M-6-7-7-12-3-9"/></g>
        <path id="${identity}-moon" fill="currentColor" d="M5-11A12 12 0 1 0 9 8A11 11 0 0 1 5-11Z"/>
      </defs>
      <path class="clock-track" d="M39 143 A116 116 0 0 1 271 143"/>
      <path class="clock-horizon" d="M15 143H295"/>
      <g class="clock-mora clock-sun"><title>Mora</title><use href="#${identity}-sun"/><g class="clock-saphene clock-companion"><title>Saphene</title><use href="#${identity}-sun" transform="scale(.35)"/></g></g>
      <g class="clock-iridis clock-moon"><title>Iridis</title><use href="#${identity}-moon"/></g>
      <text class="clock-label" x="155" y="99" text-anchor="middle"></text>
      <text class="clock-countdown" x="155" y="126" text-anchor="middle"></text>
      <text class="clock-region clock-label" x="155" y="168" text-anchor="middle">MIDRATH</text>
    </svg>`;
    const $ = selector => element.querySelector(selector);
    const svg = $('.clock-orbit'), mora = $('.clock-mora'), moon = $('.clock-iridis'), companion = $('.clock-saphene');
    const label = $('.clock-label'), countdown = $('.clock-countdown');
    function setLanguage(value) {
      if (destroyed) return;
      t = { ...TRANSLATIONS.en, ...TRANSLATIONS[value] };
      render();
    }
    function current() { return WorldCycle.at((sample.time + performance.now() - sampleMono) / 1000); }
    function move(node, x, y) { node.setAttribute('transform', `translate(${x.toFixed(3)} ${y.toFixed(3)})`); }
    function render() {
      if (!sample || destroyed) return;
      const cycle = current();
      const active = WorldCycle.point(cycle.isDay ? cycle.sunAngle : cycle.moonAngle);
      const ghost = cycle.isDay ? moon : mora, visible = cycle.isDay ? mora : moon;
      move(visible, active.x, active.y); visible.style.opacity = '1';
      const progress = cycle.progress;
      move(ghost, 39 + 232 * (cycle.isDay ? progress : 1 - progress), 143);
      ghost.style.opacity = String(Math.min(progress / .08, 1) * Math.min((1 - progress) / .08, 1) * .32);
      const angle = cycle.sunAngle * Math.PI / 180;
      move(companion, 19 * Math.sin(angle), -19 * Math.cos(angle));
      const seconds = Math.max(1, Math.ceil(cycle.remaining));
      label.textContent = cycle.isDay ? t.clockNightIn : t.clockDayIn;
      countdown.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      svg.setAttribute('aria-label', `Midrath · ${label.textContent} ${countdown.textContent}`);
      svg.dataset.phase = cycle.isDay ? 'day' : 'night';
    }
    async function refresh() {
      const serial = ++request;
      try {
        const state = await api.getWorldClock();
        if (destroyed || serial !== request) return;
        sample = state; sampleMono = performance.now(); render();
      } catch { /* Keep the last shared clock running until IPC recovers. */ }
    }
    const unsubscribe = api.onWorldClockChanged(refresh);
    const visible = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', visible);
    const timer = setInterval(() => { if (!document.hidden) render(); }, 1000);
    // Local IPC only; main deduplicates and persists the daily HTTP cooldown.
    const sync = setInterval(refresh, 60000);
    function destroy() {
      if (destroyed) return;
      destroyed = true; request++; clearInterval(timer); clearInterval(sync); unsubscribe?.();
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('unload', destroy);
    }
    window.addEventListener('unload', destroy, { once: true });
    setLanguage(language); refresh(); onResize();
    return { setLanguage, destroy };
  },
};
