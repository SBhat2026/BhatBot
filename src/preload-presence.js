'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('presence', {
  onUpdate: (cb) => ipcRenderer.on('presence-update', (_e, d) => cb(d)),
  ready: () => ipcRenderer.send('presence-ready'),
});
