'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bmaps', {
  onMap: (cb) => ipcRenderer.on('map', (_e, d) => cb(d)),
  ready: () => ipcRenderer.send('map-ready'),
  rendered: () => ipcRenderer.send('map-rendered'),   // map fully drawn → main snapshots it
  // Interactive route-planner bridges to the maps backend (Google when keyed, else OSM/OSRM).
  geocode: (q) => ipcRenderer.invoke('maps-geocode', q),
  routePath: (points, mode) => ipcRenderer.invoke('maps-route-path', points, mode),
});
