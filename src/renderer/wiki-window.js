'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let revision = 0;
  let language;
  function render(state) {
    revision++;
    const t = state.labels || {};
    if (state.locale && state.locale !== language) {
      language = state.locale;
      document.documentElement.lang = language;
      document.title = (t.wikiWidget || 'Wiki Search') + ' · Overkot';
      document.querySelector('.brand strong').textContent = t.wikiWidget || 'Wiki Search';
      document.querySelector('.wiki-controls').setAttribute('aria-label', t.wikiControls || 'Wiki window controls');
      for (const [id, key] of Object.entries({ 'wiki-back': 'wikiBack', 'wiki-forward': 'wikiForward',
        'wiki-external': 'wikiExternal', 'wiki-reload': 'wikiReload', 'wiki-close': 'wikiClose' })) {
        if (t[key]) { $(id).title = t[key]; $(id).setAttribute('aria-label', t[key]); }
      }
      $('wiki-retry').textContent = t.wikiRetry || 'Try again';
      $('wiki-error-external').textContent = t.wikiOpenBrowser || 'Open in browser ↗';
    }
    $('wiki-back').disabled = !state.canGoBack;
    $('wiki-forward').disabled = !state.canGoForward;
    $('wiki-reload').setAttribute('aria-busy', String(!!state.loading));
    $('wiki-external').disabled = !state.url;
    $('wiki-status-title').textContent = state.error ? t.wikiLoadFailed || 'Could not load the wiki' : t.wikiOpening || 'Opening the wiki…';
    $('wiki-status-message').textContent = state.error || t.wikiLoading || 'Loading your search from Soulframe Wiki.';
    $('wiki-error-actions').hidden = !state.error;
  }
  async function action(name) {
    try { await window.wikiChrome.action(name); }
    catch { $('wiki-reload').setAttribute('aria-busy', 'false'); }
  }
  document.addEventListener('DOMContentLoaded', async () => {
    for (const [id, command] of Object.entries({ 'wiki-back': 'back', 'wiki-forward': 'forward', 'wiki-external': 'external', 'wiki-reload': 'reload', 'wiki-close': 'close', 'wiki-retry': 'reload', 'wiki-error-external': 'external' })) {
      $(id).addEventListener('click', () => void action(command));
    }
    window.wikiChrome.onChanged(render);
    async function refresh() {
      const requested = revision;
      try { const state = await window.wikiChrome.getState(); if (revision === requested) render(state); } catch { /* Later navigation events can recover the chrome. */ }
    }
    window.api.onThemeChanged(refresh);
    await refresh();
  });
})();
