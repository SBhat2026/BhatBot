'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bmaps', {
  onMap: (cb) => ipcRenderer.on('map', (_e, d) => cb(d)),
  ready: () => ipcRenderer.send('map-ready'),
});
