'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ymRpc', {
  setWindowExpanded: (expanded) => ipcRenderer.invoke('ym-rpc:set-expanded', !!expanded),
  quitApp: () => ipcRenderer.invoke('ym-rpc:quit'),
  getAppVersion: () => ipcRenderer.invoke('ym-rpc:app-version'),
});
