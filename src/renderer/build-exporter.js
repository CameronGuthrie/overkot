'use strict';

window.BuildExporterWidget = {
  mount(element, { api = window.api, language = 'en', onResize = () => {} } = {}) {
    let t, snapshot = { available: false, reason: 'waiting', name: '' }, busy = false, result = null, destroyed = false, revision = 0;
    const button = document.createElement('button'); button.className = 'build-exporter-button'; button.type = 'button';
    button.setAttribute('aria-live', 'polite');
    element.replaceChildren(button);
    function render() {
      if (destroyed) return;
      const unavailable = `${t.buildExporterWidget} · ${t.inventoryUnavailableLower}`;
      const label = api.buildWebsiteHost ? t.buildExportButton.replace('avakot.build', api.buildWebsiteHost) : unavailable;
      button.textContent = busy ? t.buildExportWorking : result && !result.ok ? t.buildExportRetry : label;
      button.disabled = busy || !api.buildWebsiteHost || !snapshot.available;
      element.setAttribute('aria-busy', String(busy));
      const errors = { connect: 'buildExportConnect', data: 'temperDataWaiting', 'session-changed': 'buildExportSession', 'refresh-failed': 'buildExportRefreshError',
        'no-loadout': 'buildExportNoLoadout', 'incomplete-loadout': 'buildExportIncomplete', 'too-large': 'buildExportLarge', 'open-failed': 'buildExportOpenError' };
      button.dataset.error = String(!!result && !result.ok);
      button.title = !api.buildWebsiteHost ? unavailable : busy ? t.buildExportReading : result?.ok ? (result.partial ? t.buildExportPartial : t.buildExportHint)
        : result ? t[errors[result.error] || 'buildExportOpenError'] : snapshot.available ? t.buildExportHint
          : t[snapshot.reason === 'connect' ? 'buildExportConnect' : snapshot.reason === 'data' ? 'temperDataWaiting' : snapshot.reason === 'no-loadout' ? 'buildExportNoLoadout' : 'buildExportWaiting'];
      button.setAttribute('aria-description', button.title);
      onResize();
    }
    function update(value) {
      revision++;
      if (snapshot.name !== value.name || snapshot.available !== value.available) result = null;
      snapshot = value; render();
    }
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      busy = true; result = null; render();
      try { result = await api.exportCurrentBuild(); }
      catch { result = { ok: false, error: 'open-failed' }; }
      finally { busy = false; render(); }
    });
    const unsubscribe = api.onBuildExportChanged(update);
    function setLanguage(value) { t = { ...TRANSLATIONS.en, ...TRANSLATIONS[value] }; render(); }
    setLanguage(language);
    const initial = revision;
    api.getBuildExportStatus().then(value => { if (!destroyed && revision === initial) update(value); }).catch(() => {});
    function destroy() { destroyed = true; unsubscribe(); }
    window.addEventListener('unload', destroy, { once: true });
    return { setLanguage, destroy };
  },
};
