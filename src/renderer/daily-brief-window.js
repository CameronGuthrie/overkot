'use strict';

document.addEventListener('DOMContentLoaded', async () => {
  let widget = null, revision = 0, destroyed = false, latestConfig = {};
  const apply = config => {
    if (destroyed) return;
    const language = window.i18n?.localeTags?.[config?.language] || config?.language || 'en';
    document.documentElement.lang = language;
    if (typeof TRANSLATIONS !== 'undefined') {
      const labels = { ...TRANSLATIONS.en, ...TRANSLATIONS[language] };
      for (const element of document.querySelectorAll('[data-i18n]')) {
        if (labels[element.dataset.i18n]) element.textContent = labels[element.dataset.i18n];
      }
      for (const element of document.querySelectorAll('[data-i18n-label]')) {
        const text = labels[element.dataset.i18nLabel];
        if (!text) continue;
        element.setAttribute('aria-label', text);
        if (element.hasAttribute('title')) element.title = text;
      }
    }
    window.OverkotTheme?.apply(config || {}, { widgetId: 'daily' });
    widget?.setLanguage(language);
  };
  document.getElementById('daily-minimize').addEventListener('click', () => window.api.windowMinimize());
  document.getElementById('daily-close').addEventListener('click', () => window.api.windowClose());
  window.api.onConfigChanged?.(config => { revision++; latestConfig = config || {}; apply(latestConfig); });
  window.addEventListener('unload', () => { destroyed = true; widget?.destroy(); }, { once: true });
  const request = revision;
  try {
    const state = await window.api.getState();
    if (request === revision) latestConfig = state.config || {};
  } catch { /* The daily panel has its own retry controls. */ }
  if (destroyed) return;
  // This is a normal resizable pop-out. Content updates scroll within the
  // viewport instead of auto-fitting or changing the native window's bounds.
  widget = window.DailyBriefWidget.mount(document.getElementById('daily-brief-content'), { api: window.api, language: window.i18n?.localeTags?.[latestConfig.language] || latestConfig.language || 'en' });
  apply(latestConfig);
});
