const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('brain', {graph: () => ipcRenderer.invoke('synapse-graph'), onUpdate: cb => ipcRenderer.on('synapse-update',(_e,g)=>cb(g)), onPressure: cb => ipcRenderer.on('memory-pressure',(_e,v)=>cb(v))});
