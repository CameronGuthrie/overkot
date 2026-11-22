'use strict';

window.WolfTrainingWidget = {
  mount(element, { api = window.api, language = 'en', onResize = () => {} } = {}) {
    const fallback = {
      wolfDetails: 'Details',
      wolfCompanion: 'Wolf cub', wolfLive: 'Live', wolfCached: 'Saved inventory',
      wolfConnect: 'Connect to Soulframe to see your wolf companion.',
      wolfWaiting: 'Waiting for your companion inventory…',
      wolfEmpty: 'Your wolf companion will appear here once they join you.',
      wolfLoadError: 'Could not load your companion.', wolfRetry: 'Retry',
      wolfResting: 'Needs rest', wolfRestSince: 'Rest recorded at {time}',
      wolfTraining: 'Training', wolfTrained: 'Trained', wolfAllocated: 'Allocated',
      wolfAvailable: '{count} paws ready to allocate in game', wolfFullyAllocated: 'All trained paws allocated',
      wolfProgress: '{trained} trained · {allocated} allocated',
      wolfStatProgress: '{label}: {trained} trained, {allocated} allocated, {percent}% to the next paw',
      wolfMaxed: 'Fully trained', wolfNextPaw: '{current} / {target} XP to the next paw',
      wolfCurveEstimated: 'Higher paw ranks are approximate',
      wolfCurveHint: 'The first two paw thresholds are confirmed. Higher ranks use an estimated curve until verified game data is available.',
      wolfCatalogWaiting: 'Game labels are using the English fallback.',
      wolfUnreadable: '{count} companion records could not be read.',
      wolfEnergy: 'Energy', wolfBond: 'Bond',
      wolfBondPoints: '{count} bond points',
      wolfBondUnknown: 'Bond points from your inventory. The bond type cannot be confirmed yet.',
      wolfBondUnavailable: 'Bond value unavailable in this inventory.',
      wolfLegend: 'Paw states', wolfLegendTraining: 'Training progress toward the next paw',
      wolfLegendTrained: 'Trained and ready to allocate in game',
      wolfLegendAllocated: 'Allocated in game', wolfSavedAt: 'Last inventory update: {time}',
    };
    let t = fallback, snapshot = null, destroyed = false, revision = 0, details = false;
    const node = (tag, cls, text) => {
      const item = document.createElement(tag); item.className = cls;
      if (text !== undefined) item.textContent = text;
      return item;
    };
    const button = (cls, handler) => {
      const item = node('button', cls); item.type = 'button'; item.addEventListener('click', handler); return item;
    };
    const format = (key, values = {}) => Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), t[key] || fallback[key] || key);
    const number = value => new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(value);
    const svg = (cls, paths, viewBox = '0 0 24 24') => {
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('class', cls); icon.setAttribute('viewBox', viewBox); icon.setAttribute('aria-hidden', 'true');
      for (const pathData of paths) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', pathData); icon.append(path);
      }
      return icon;
    };
    const paw = cls => svg(cls, [
      'M8.6 13.2c1.5-2.1 5.3-2.1 6.8 0l2.7 3.5c1.3 2 .3 4.4-2 4.4-1.7 0-2.5-.7-4.1-.7s-2.4.7-4.1.7c-2.3 0-3.3-2.4-2-4.4z',
      'M7.4 6.3c.5 1.8-.1 3.5-1.2 3.8-1.2.3-2.5-.9-3-2.7S3.3 3.9 4.4 3.6c1.2-.3 2.5.9 3 2.7z',
      'M11.4 4.2c.1 1.9-.9 3.4-2.1 3.4S7.1 6.1 7 4.2c-.1-1.8.9-3.3 2.1-3.3s2.2 1.5 2.3 3.3z',
      'M17 4.2c-.1 1.9-1.1 3.4-2.3 3.4s-2.2-1.5-2.1-3.4C12.7 2.4 13.7.9 14.9.9S17.1 2.4 17 4.2z',
      'M20.8 7.4c-.5 1.8-1.8 3-3 2.7-1.1-.3-1.7-2-1.2-3.8s1.8-3 3-2.7c1.1.3 1.7 2 1.2 3.8z',
    ]);
    const toolbar = node('div', 'wolf-toolbar');
    const detailButton = button('wolf-details-toggle', () => { details = !details; render(); });
    const status = node('div', 'wolf-status'); status.setAttribute('role', 'status');
    toolbar.append(status, detailButton);
    const body = node('div', 'wolf-scroll');
    const footer = node('div', 'wolf-footer');
    element.replaceChildren(toolbar, body, footer);

    function name(row) { return row.name || t.wolfCompanion; }
    function time(value) { return new Date(value).toLocaleString(language, { dateStyle: 'short', timeStyle: 'short' }); }
    function pawSlot(state, fill = 0) {
      const slot = node('span', `wolf-paw-slot wolf-paw-${state}`); slot.setAttribute('aria-hidden', 'true');
      slot.append(paw('wolf-paw'));
      if (fill > 0) {
        const clip = node('span', 'wolf-paw-fill'); clip.style.clipPath = `inset(0 ${(1 - fill) * 100}% 0 0)`;
        clip.append(paw('wolf-paw')); slot.append(clip);
      }
      return slot;
    }
    function trainingRow(stat, changed) {
      const row = node('div', 'wolf-stat'); row.dataset.stat = stat.key;
      if (changed) row.classList.add('wolf-stat-updated');
      const top = node('div', 'wolf-stat-main');
      const label = node('span', 'wolf-stat-label', stat.label);
      const paws = node('span', 'wolf-paws');
      const max = snapshot.progression.skillThresholds.length;
      const pct = Math.round(Math.max(0, Math.min(1, stat.progress - stat.level)) * 100);
      paws.setAttribute('role', 'img');
      paws.setAttribute('aria-label', format('wolfStatProgress', { label: stat.label, trained: number(stat.level), allocated: number(stat.allocated), percent: number(pct) }));
      for (let i = 0; i < max; i++) {
        const state = i < stat.allocated ? 'allocated' : i < stat.level ? 'trained' : 'training';
        const fill = state === 'training' ? Math.max(0, Math.min(1, stat.progress - i)) : 0;
        paws.append(pawSlot(state, fill));
      }
      top.append(label, paws); row.append(top);
      const next = stat.nextThreshold;
      row.title = next === null ? t.wolfMaxed : format('wolfNextPaw', { current: number(stat.xp), target: `${stat.approximate ? '≈' : ''}${number(next)}` });
      if (details) {
        const info = node('div', 'wolf-stat-details');
        info.append(node('span', '', next === null ? `${number(stat.xp)} XP · ${t.wolfMaxed}`
          : format('wolfNextPaw', { current: number(stat.xp), target: `${stat.approximate ? '≈' : ''}${number(next)}` })),
        node('span', '', `${number(stat.allocated)}/${number(max)} ${t.wolfAllocated.toLocaleLowerCase(language)}`));
        row.append(info);
      }
      return row;
    }
    function card(row, changed) {
      const section = node('section', 'wolf-card'); section.dataset.pet = row.id;
      const head = node('div', 'wolf-card-head');
      const title = node('span', 'wolf-identity');
      title.append(node('strong', 'wolf-name', name(row)));
      if (row.temperament) title.append(node('span', 'wolf-temperament', row.temperament));
      head.append(paw('wolf-companion-paw'), title);
      section.append(head);
      const content = node('div', 'wolf-card-body');
      const vitals = node('div', 'wolf-vitals');
      const energy = node('div', 'wolf-energy');
      const energyHead = node('div', 'wolf-energy-head');
      energyHead.append(node('span', '', row.energyLabel || t.wolfEnergy), node('strong', '', `${number(row.energy)} / ${number(row.maxEnergy)}`));
      const track = node('div', 'wolf-energy-track'); const fill = node('span', 'wolf-energy-fill');
      const percent = Math.max(0, Math.min(100, row.energy / row.maxEnergy * 100));
      fill.style.width = `${percent}%`; track.append(fill);
      track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', row.energyLabel || t.wolfEnergy);
      track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', String(row.maxEnergy));
      track.setAttribute('aria-valuenow', String(Math.min(row.maxEnergy, row.energy)));
      energy.dataset.low = String(percent <= 20); energy.append(energyHead, track); vitals.append(energy);
      const bond = node('div', 'wolf-bond'); bond.append(node('span', '', row.bondStatLabel || t.wolfBond),
        node('strong', '', row.bondLabel || (row.bond === null ? '—' : number(row.bond))));
      if (row.bondLabel) bond.append(node('small', 'wolf-bond-points', number(row.bond)));
      bond.dataset.rankKnown = String(!!row.bondLabel);
      bond.title = row.bondLabel ? format('wolfBondPoints', { count: number(row.bond) })
        : row.bond === null ? t.wolfBondUnavailable : t.wolfBondUnknown;
      vitals.append(bond);
      content.append(vitals);
      if (row.needsRest) {
        const rest = node('div', 'wolf-rest', `☾ ${t.wolfResting}`);
        if (row.restDate !== null) rest.title = format('wolfRestSince', { time: time(row.restDate) });
        content.append(rest);
      }
      const stats = node('div', 'wolf-stats');
      for (const stat of row.stats) stats.append(trainingRow(stat, changed.has(`${row.id}:${stat.key}`)));
      content.append(stats);
      const trained = node('div', 'wolf-paw-summary');
      const allocatedCount = row.stats.reduce((sum, stat) => sum + stat.allocated, 0);
      trained.append(node('span', '', format('wolfProgress', { trained: `${snapshot.progression.estimated && row.stats.some(stat => stat.approximate) ? '≈' : ''}${number(row.trainedPaws)}`, allocated: number(allocatedCount) })),
        node('span', 'wolf-ready', row.availablePaws ? format('wolfAvailable', { count: `${snapshot.progression.estimated && row.stats.some(stat => stat.approximate) ? '≈' : ''}${number(row.availablePaws)}` }) : t.wolfFullyAllocated));
      content.append(trained); section.append(content);
      return section;
    }
    function render(changed = new Set()) {
      if (destroyed) return;
      const scrollTop = body.scrollTop;
      const hasInventory = ['live', 'cached'].includes(snapshot?.status);
      detailButton.textContent = t.wolfDetails; detailButton.setAttribute('aria-pressed', String(details)); detailButton.disabled = !hasInventory;
      detailButton.hidden = !hasInventory || !snapshot.rows.length;
      status.dataset.state = snapshot?.status || 'waiting';
      status.textContent = hasInventory ? t[snapshot.status === 'cached' ? 'wolfCached' : 'wolfLive']
        : t[snapshot?.status === 'connect' ? 'wolfConnect' : 'wolfWaiting'];
      status.title = snapshot?.updatedAt ? format('wolfSavedAt', { time: time(snapshot.updatedAt) }) : '';
      body.replaceChildren(); footer.replaceChildren();
      if (!hasInventory) { onResize(); return; }
      const row = snapshot.rows.find(item => item.id === snapshot.activePetId)
        || snapshot.rows.find(item => item.equipped) || snapshot.rows[0];
      if (!row) {
        const empty = node('div', 'wolf-empty'); empty.append(paw('wolf-companion-paw'), node('p', '', t.wolfEmpty)); body.append(empty);
      }
      if (row) body.append(card(row, changed));
      if (row) {
        const legend = node('div', 'wolf-legend'); legend.setAttribute('aria-label', t.wolfLegend);
        for (const [state, key, hint] of [['training', 'wolfTraining', 'wolfLegendTraining'], ['trained', 'wolfTrained', 'wolfLegendTrained'], ['allocated', 'wolfAllocated', 'wolfLegendAllocated']]) {
          const item = node('span', 'wolf-legend-item'); item.title = t[hint]; item.append(pawSlot(state, state === 'training' ? .55 : 0), node('span', '', t[key])); legend.append(item);
        }
        footer.append(legend);
        if (snapshot.progression.estimated) {
          const note = node('p', 'wolf-curve-note', `≈ ${t.wolfCurveEstimated}`); note.title = t.wolfCurveHint; footer.append(note);
        }
      }
      if (details && snapshot.catalogStatus === 'unavailable') footer.append(node('p', 'wolf-data-note', t.wolfCatalogWaiting));
      if (snapshot.unreadablePets) footer.append(node('p', 'wolf-data-note', format('wolfUnreadable', { count: number(snapshot.unreadablePets) })));
      body.scrollTop = scrollTop;
      onResize();
    }
    function update(value) {
      if (destroyed || !value || !Array.isArray(value.rows)) return;
      revision++;
      const previous = new Map((snapshot?.rows || []).flatMap(row => row.stats.map(stat => [`${row.id}:${stat.key}`, `${stat.xp}:${stat.allocated}`])));
      const changed = new Set(snapshot?.rows?.length ? value.rows.flatMap(row => row.stats.filter(stat => previous.get(`${row.id}:${stat.key}`) !== `${stat.xp}:${stat.allocated}`).map(stat => `${row.id}:${stat.key}`)) : []);
      snapshot = value; render(changed);
    }
    async function load() {
      const initial = revision;
      try { const value = await api.getWolfTraining(); if (!destroyed && revision === initial) update(value); }
      catch {
        if (destroyed || revision !== initial) return;
        status.textContent = t.wolfLoadError;
        body.replaceChildren(button('wolf-retry', load)); body.firstChild.textContent = t.wolfRetry; onResize();
      }
    }
    function setLanguage(value) {
      language = value || 'en';
      const translations = typeof TRANSLATIONS !== 'undefined' ? TRANSLATIONS : {};
      t = { ...fallback, ...translations.en, ...translations[language] }; render();
    }
    const unsubscribe = typeof api.onWolfTrainingChanged === 'function' ? api.onWolfTrainingChanged(update) : () => {};
    setLanguage(language); load();
    function destroy() { if (destroyed) return; destroyed = true; unsubscribe(); window.removeEventListener('unload', destroy); }
    window.addEventListener('unload', destroy, { once: true });
    return { setLanguage, destroy };
  },
};
