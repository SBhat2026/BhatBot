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
  transcribeAudio: (data) => ipcRenderer.invoke('transcribe-audio', data),
  synthesizeSpeech: (text) => ipcRenderer.invoke('synthesize-speech', { text }),
  summarizeForSpeech: (text) => ipcRenderer.invoke('summarize-for-speech', { text }),
  sayLocal: (text) => ipcRenderer.invoke('say-local', { text }),
  openNexus: () => ipcRenderer.invoke('open-nexus'),
  openStudio: () => ipcRenderer.invoke('open-studio'),
  openTerminal: () => ipcRenderer.invoke('open-terminal'),
  onWakeCommand: (cb) => ipcRenderer.on('wake-command', (_e, d) => cb(d.text)),
  onToolUpdate: (cb) => ipcRenderer.on('tool-update', (_e, u) => cb(u)),
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
