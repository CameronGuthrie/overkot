'use strict';

const { catalogAsset } = require('./localizedCatalogs');
const { resolveTemperIcon, validTemperCatalog } = require('./catalogData');

// These Widgets menu cards display GameDataImages through ItemImages, including
// equipment inside Player and vendor stock inside Daily Brief.
const itemArtworkWidgets = [
  'collection-log', 'cosmetics', 'mastery-tracker', 'resources', 'enhancements',
  'crafting-planner', 'activity', 'crafting-log', 'player', 'daily',
];

function widgetConnections({ signedIn, services, dataManager, mapTileManager, language, marketConnection }) {
  const widgets = {};
  if (!services.accountApi || !services.accountPortal) return widgets;
  if (services.marketApi && (!signedIn || marketConnection?.requiresLink || marketConnection?.requiresReconnect)) {
    widgets.market = 'market';
  }
  if (signedIn || !services.dataOrigin) return widgets;

  // Item images have their own service and session-only cache. A public
  // catalogue can still refer to artwork served by the protected endpoint.
  if (!services.imageBase) {
    for (const id of itemArtworkWidgets) widgets[id] = 'artwork';
    if (services.marketPublicApi && !widgets.market) widgets.market = 'artwork';
  }
  if (dataManager.manifestUrl !== `${services.dataOrigin}/protected/overlay/v2/manifest.json`) return widgets;

  const published = Object.keys(dataManager.manifest?.files || {});
  const missingIcon = prefix => published.some(key => key.startsWith(prefix) && !dataManager.cachedPath(key));
  if (!mapTileManager.hasCachedTerrain()) widgets.minimap = 'account';
  else if (missingIcon('map-icons/')) widgets.minimap = 'artwork';
  if (services.buildWebsite && !dataManager.cachedPath('build-export/catalog.json')) widgets['build-exporter'] = 'account';
  const temperCatalog = dataManager.readJSON(catalogAsset(dataManager, 'tempers', language));
  if (!validTemperCatalog(temperCatalog)) {
    widgets['temper-tracker'] = 'account';
  } else if (temperCatalog.tempers.some(row => {
    const key = resolveTemperIcon(row.id, row.icon);
    return key && !dataManager.cachedPath(key);
  })) {
    widgets['temper-tracker'] = 'artwork';
  }
  // Vendor offers and Market listings can use hashed temper artwork even
  // when a community service supplies public item images.
  const vendorIcons = services.vendorCatalog && !widgets.daily;
  const marketIcons = services.marketPublicApi && !widgets.market;
  if ((vendorIcons || marketIcons) && (!dataManager.manifest || missingIcon('temper-icons/'))) {
    if (vendorIcons) widgets.daily = 'artwork';
    if (marketIcons) widgets.market = 'artwork';
  }
  return widgets;
}

module.exports = { widgetConnections };
