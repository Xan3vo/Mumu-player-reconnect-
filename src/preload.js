'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),

  start: () => ipcRenderer.invoke('watchdog:start'),
  stop: () => ipcRenderer.invoke('watchdog:stop'),

  saveInstance: (key, patch) =>
    ipcRenderer.invoke('instance:save', { key, patch }),

  reconnectNow: (serial) => ipcRenderer.invoke('instance:reconnect', serial),

  saveGeneral: (patch) => ipcRenderer.invoke('settings:general', patch),
  setMuMuRoot: (root) => ipcRenderer.invoke('settings:mumuRoot', root),
  browseMuMuRoot: () => ipcRenderer.invoke('settings:browseRoot'),

  openLogs: () => ipcRenderer.invoke('app:openLogs'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  onLog: (handler) =>
    ipcRenderer.on('watchdog:log', (event, entry) => handler(entry)),

  onInstances: (handler) =>
    ipcRenderer.on('watchdog:instances', (event, list) => handler(list)),

  onStatus: (handler) =>
    ipcRenderer.on('watchdog:status', (event, status) => handler(status))
});
