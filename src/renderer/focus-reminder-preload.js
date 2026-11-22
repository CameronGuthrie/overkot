'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('focusReminder', {
  onState: callback => ipcRenderer.on('focus-reminder:state', (_event, state) => callback(state)),
});
