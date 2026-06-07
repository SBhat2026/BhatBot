'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('term', {
  start: (cols, rows) => ipcRenderer.send('pty-start', { cols, rows }),
  input: (data) => ipcRenderer.send('pty-input', data),
  resize: (cols, rows) => ipcRenderer.send('pty-resize', { cols, rows }),
  onData: (cb) => ipcRenderer.on('pty-data', (_e, d) => cb(d)),
  onExit: (cb) => ipcRenderer.on('pty-exit', () => cb())
});
