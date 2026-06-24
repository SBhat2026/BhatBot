'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bmaps', {
  onMap: (cb) => ipcRenderer.on('map', (_e, d) => cb(d)),
  ready: () => ipcRenderer.send('map-ready'),
  rendered: () => ipcRenderer.send('map-rendered'),   // map fully drawn → main snapshots it
});
