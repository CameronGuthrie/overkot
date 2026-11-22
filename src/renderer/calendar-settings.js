'use strict';

document.addEventListener('DOMContentLoaded', async () => {
  const api = window.api;
  const state = await api.getState();
  let t = { ...TRANSLATIONS.en, ...TRANSLATIONS[state.config?.language || 'en'] };
  const list = document.getElementById('calendar-ancestor-list');
  const error = document.getElementById('calendar-settings-error');
  const reset = document.getElementById('calendar-reset');
  let serial = 0;
  const rows = new Map();
  const close = document.getElementById('close-btn');
  close.addEventListener('click', () => api.windowClose());
  document.addEventListener('keydown', event => { if (event.key === 'Escape') api.windowClose(); });
  function render(settings) {
    document.getElementById('calendar-settings-title').textContent = t.calendarSettings;
    document.getElementById('calendar-settings-intro').textContent = t.calendarSettingsIntro;
    document.getElementById('calendar-account-source').textContent = settings.source === 'live' ? t.calendarAccount : settings.source === 'cached' ? t.calendarCached : t.calendarWaiting;
    close.title = t.tooltipClose; close.setAttribute('aria-label', t.tooltipClose);
    reset.textContent = t.calendarReset; reset.disabled = !settings.customized;
    for (const ancestor of settings.ancestors) {
      let row = rows.get(ancestor.name);
      if (!row) {
        const label = document.createElement('label'); label.className = 'calendar-ancestor-row';
        const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.ancestor = ancestor.name;
        const info = document.createElement('div'); info.className = 'calendar-ancestor-info';
        const name = document.createElement('div');
        const detail = document.createElement('div'); detail.className = 'calendar-ancestor-detail';
        const badge = document.createElement('span'); badge.className = 'calendar-override-label';
        info.append(name, detail); label.append(input, info, badge); list.append(label);
        input.addEventListener('change', () => perform(() => api.setCalendarAncestor(ancestor.name, input.checked)));
        row = { input, name, detail, badge }; rows.set(ancestor.name, row);
      }
      row.name.textContent = t['daily' + ancestor.name.replaceAll(' ', '')] || ancestor.name;
      row.input.checked = ancestor.unlocked === true;
      row.input.indeterminate = ancestor.unlocked === null;
      row.input.disabled = ancestor.always;
      row.detail.textContent = ancestor.always ? t.calendarAlways : ancestor.automatic === null ? t.calendarUnknown : ancestor.automatic ? t.calendarUnlocked : t.calendarLocked;
      row.badge.textContent = ancestor.overridden ? t.calendarOverride : '';
    }
  }
  async function perform(action = () => api.getCalendarSettings()) {
    const request = ++serial;
    try {
      const value = await action();
      if (request !== serial) return;
      render(value); error.textContent = '';
    } catch { if (request === serial) error.textContent = t.calendarLoadError; }
  }
  reset.addEventListener('click', () => perform(() => api.resetCalendarAncestors()));
  const unsubscribe = api.onCalendarChanged(() => perform());
  window.addEventListener('beforeunload', () => unsubscribe?.(), { once: true });
  api.onConfigChanged(config => { t = { ...TRANSLATIONS.en, ...TRANSLATIONS[config.language || 'en'] }; perform(); });
  await perform();
});
