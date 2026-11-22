'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const listen = (channel, callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
// theme.js uses this narrow API. Remote wiki WebContents never load this file.
contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('wiki:state'),
  onThemeChanged: callback => listen('theme-changed', callback),
});
contextBridge.exposeInMainWorld('wikiChrome', {
  getState: () => ipcRenderer.invoke('wiki:state'),
  action: action => ipcRenderer.invoke('wiki:action', action),
  onChanged: callback => listen('wiki:changed', callback),
});
