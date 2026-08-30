'use strict';
// Preload for the Blender Studio window. Two channels only: the build event stream in, and one
// narrow file read out (the exported GLB, so the viewer can play it). The window never gets a
// general-purpose file reader — main.js refuses any path outside the Blender workspace.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('blenderStudio', {
  onEvent: (cb) => ipcRenderer.on('blender-event', (_e, d) => cb(d)),
  readModel: (p) => ipcRenderer.invoke('blender-read-model', p),
  ready: () => ipcRenderer.send('blender-ready'),
});
