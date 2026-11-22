'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// This passive surface can receive alert data, but cannot change app state.
contextBridge.exposeInMainWorld('moonsteelAlert', Object.freeze({
  onData(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('moonsteel-alert:data', listener);
    return () => ipcRenderer.removeListener('moonsteel-alert:data', listener);
  },
}));
