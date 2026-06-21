'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('wc', {
  snapshot: () => ipcRenderer.invoke('wc-snapshot'),
});
