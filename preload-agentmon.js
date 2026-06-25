'use strict';
// Preload for a per-agent monitor window. Exposes the agent id (from the query string) + a live
// fleet-update subscription filtered to that agent.
const { contextBridge, ipcRenderer } = require('electron');
const id = new URLSearchParams(location.search).get('id') || '';
contextBridge.exposeInMainWorld('agentmon', {
  id,
  onUpdate: (cb) => ipcRenderer.on('fleet-update', (_e, d) => { if (d && (!d.id || d.id === id)) cb(d); }),
});
