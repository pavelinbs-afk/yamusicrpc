'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ymRpc', {
  setWindowExpanded: (expanded) => ipcRenderer.invoke('ym-rpc:set-expanded', !!expanded),
  hideToTray: () => ipcRenderer.invoke('ym-rpc:hide-to-tray'),
  quitApp: () => ipcRenderer.invoke('ym-rpc:quit'),
  getAppVersion: () => ipcRenderer.invoke('ym-rpc:app-version'),
});
