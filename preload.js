'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bhatbot', {
  getApiKey: () => ipcRenderer.invoke('get-api-key'),
  saveApiKey: (key) => ipcRenderer.invoke('save-api-key', key),
  chat: (payload) => ipcRenderer.invoke('chat', payload),
  hideWindow: () => ipcRenderer.invoke('hide-window'),
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),
  pickMedia: () => ipcRenderer.invoke('pick-media'),
  getContextPath: () => ipcRenderer.invoke('get-context-path'),
  getMemoryPath: () => ipcRenderer.invoke('get-memory-path'),
  getVoiceConfig: () => ipcRenderer.invoke('get-voice-config'),
  setTtsSpeed: (v) => ipcRenderer.invoke('set-tts-speed', v),
  getHealth: () => ipcRenderer.invoke('get-health'),
  transcribeAudio: (data) => ipcRenderer.invoke('transcribe-audio', data),
  synthesizeSpeech: (text) => ipcRenderer.invoke('synthesize-speech', { text }),
  playTTS: (text, full) => ipcRenderer.invoke('play-tts', { text, full }),
  stopTTS: () => ipcRenderer.invoke('stop-tts'),
  summarizeForSpeech: (text) => ipcRenderer.invoke('summarize-for-speech', { text }),
  sayLocal: (text) => ipcRenderer.invoke('say-local', { text }),
  openNexus: () => ipcRenderer.invoke('open-nexus'),
  openStudio: () => ipcRenderer.invoke('open-studio'),
  openTerminal: () => ipcRenderer.invoke('open-terminal'),
  getPanelUrls: () => ipcRenderer.invoke('get-panel-urls'),
  focusBrowser: () => ipcRenderer.invoke('focus-browser'),
  onShowPanel: (cb) => ipcRenderer.on('show-panel', (_e, id) => cb(id)),
  onStudioReload: (cb) => ipcRenderer.on('studio-reload', () => cb()),
  onWakeCommand: (cb) => ipcRenderer.on('wake-command', (_e, d) => cb(d.text)),
  onBargeIn: (cb) => ipcRenderer.on('barge-in', (_e, d) => cb(d)),
  onTtsIdle: (cb) => ipcRenderer.on('tts-idle', (_e, d) => cb(d)),
  ensurePermissions: (opts) => ipcRenderer.invoke('ensure-permissions', opts),
  permStatus: () => ipcRenderer.invoke('perm-status'),
  sendGuidance: (text) => ipcRenderer.send('agent-guidance', { text }),
  listNotes: () => ipcRenderer.invoke('list-notes'),
  endSession: () => ipcRenderer.send('end-session'),
  onSessionNote: (cb) => ipcRenderer.on('session-note', (_e, n) => cb(n)),
  attachPaths: (paths) => ipcRenderer.invoke('attach-paths', paths),
  credStore: (c) => ipcRenderer.invoke('cred-store', c),
  credList: () => ipcRenderer.invoke('cred-list'),
  credRemove: (ref) => ipcRenderer.invoke('cred-remove', { ref }),
  readModel: (p) => ipcRenderer.invoke('read-model', p),
  open3DViewer: (p) => ipcRenderer.invoke('open-3d-viewer', p),
  onToolUpdate: (cb) => ipcRenderer.on('tool-update', (_e, u) => cb(u)),
  onJobUpdate: (cb) => ipcRenderer.on('job-update', (_e, j) => cb(j)),
  removeToolUpdateListener: () => ipcRenderer.removeAllListeners('tool-update')
});

// Embedded Claude Code terminal (pty) — same API the standalone terminal window uses,
// so the xterm panel can live inside the main HUD.
contextBridge.exposeInMainWorld('term', {
  start: (cols, rows) => ipcRenderer.send('pty-start', { cols, rows }),
  input: (data) => ipcRenderer.send('pty-input', data),
  resize: (cols, rows) => ipcRenderer.send('pty-resize', { cols, rows }),
  onData: (cb) => ipcRenderer.on('pty-data', (_e, d) => cb(d)),
  onExit: (cb) => ipcRenderer.on('pty-exit', () => cb())
});
