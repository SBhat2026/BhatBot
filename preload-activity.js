'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('activity', {
  onUpdate: (cb) => ipcRenderer.on('tool-update', (_e, u) => cb(u)),
  onScreenshot: (cb) => ipcRenderer.on('screenshot', (_e, s) => cb(s)),
  onModel: (cb) => ipcRenderer.on('model', (_e, m) => cb(m)),
  onConfirm: (cb) => ipcRenderer.on('confirm-required', (_e, c) => cb(c)),
  requestScreenshot: () => ipcRenderer.invoke('get-playwright-screenshot'),
  pause: () => ipcRenderer.send('agent-pause'),
  resume: () => ipcRenderer.send('agent-resume'),
  stop: () => ipcRenderer.send('agent-stop'),
  respond: (id, approved) => ipcRenderer.send('confirm-response', { id, approved }),
  sendGuidance: (text) => ipcRenderer.send('agent-guidance', { text }),
  onGuidanceApplied: (cb) => ipcRenderer.on('tool-update', (_e, u) => { if (u.type === 'guidance_applied') cb(u); }),
  onLearnPrompt: (cb) => ipcRenderer.on('learn_prompt', (_e, p) => cb(p)),
  saveGuidancePref: (text) => ipcRenderer.invoke('save-guidance-pref', text),
  getHealth: () => ipcRenderer.invoke('get-health')
});
