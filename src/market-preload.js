'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const action = (name, value) => ipcRenderer.invoke('market-frontend:action', name, value);
const subscribe = (channel, callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

// This frontend only receives the market capability. The overlay's game,
// filesystem, settings and arbitrary external-navigation IPC are not exposed.
contextBridge.exposeInMainWorld('overkotMarket', {
  request: value => ipcRenderer.invoke('market-frontend:request', value),
  getState: () => action('state'),
  onChanged: callback => subscribe('market:changed', callback),
  openAccountSettings: () => action('account-settings'),
  loginWithAvakot: options => action('avakot-login', options),
  cancelAvakotLogin: () => action('avakot-cancel'),
  openWebsite: section => action('website', section),
  close: () => action('close'),
});
const i18n = ipcRenderer.sendSync('get-i18n');
contextBridge.exposeInMainWorld('i18n', {
  translations: Object.fromEntries(Object.entries(i18n.translations).map(([code, messages]) =>
    [code, Object.fromEntries(Object.entries(messages).filter(([key]) => key.startsWith('marketUi')))])),
  localeTags: Object.fromEntries(i18n.languages.map(({ code, locale }) => [code, locale || code])),
});

// The inventory iframe reuses the proven inventory composer and validation.
contextBridge.exposeInMainWorld('api', {
  marketGetState: () => action('state'), marketRefresh: () => action('refresh'),
  marketLogin: value => action('login', value), marketLogout: () => action('logout'),
  marketAvakotLogin: value => action('avakot-login', value), marketAvakotCancel: () => action('avakot-cancel'),
  marketBrowse: value => action('browse', value), marketCreateListing: value => action('create', value),
  marketUpdateListing: value => action('update', value), marketCloseListing: id => action('update', { id, status: 'CLOSED' }),
  marketCopyContact: id => action('copy-contact', id), openMarketWebsite: section => action('website', section),
  onMarketChanged: callback => subscribe('market:changed', callback),
  onGameArtworkAvailable: callback => subscribe('game-artwork-available', () => callback()),
  onMapTilesUpdated: callback => subscribe('map-tiles-updated', info => {
    if (!info?.requiresSignIn) callback();
  }),
  openAccountSettings: () => action('account-settings'),
  getState: () => action('appearance'), onConfigChanged: callback => subscribe('config-changed', callback),
  onThemeChanged: callback => subscribe('config-changed', callback), windowClose: () => action('close'),
});
