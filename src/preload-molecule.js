'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('mol', {
  onMolecule: (cb) => ipcRenderer.on('molecule', (_e, d) => cb(d)),
  ready: () => ipcRenderer.send('molecule-ready'),
});
