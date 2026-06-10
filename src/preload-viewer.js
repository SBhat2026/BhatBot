'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('viewer', {
  onModel: (cb) => ipcRenderer.on('model', (_e, d) => cb(d)),
  ready: () => ipcRenderer.send('viewer-ready'),
});
