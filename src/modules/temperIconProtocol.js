'use strict';

const { temperIconUrl } = require('./gameDataImages');

// Both Electron sessions use the same verified data cache. The isolated
// Market session registers only this handler for the map asset scheme.
function createTemperIconHandler(dataManager) {
  return async (request, callback) => {
    const key = request.url.slice('overkot-map-tiles://data/'.length);
    if (request.url !== temperIconUrl(key) || !['GET', 'HEAD'].includes(request.method)) {
      callback({ error: -10 }); return;
    }
    try {
      if (!dataManager.manifest?.files[key] && !dataManager.cachedPath(key)) {
        await dataManager.checkForUpdates();
      }
      const file = await dataManager.ensureAsset(key);
      callback(file ? { path: file } : { error: -6 });
    } catch { callback({ error: -6 }); }
  };
}

module.exports = { createTemperIconHandler };
