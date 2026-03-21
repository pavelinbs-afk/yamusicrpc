'use strict';

const path = require('path');
const { app, BrowserWindow, shell } = require('electron');

let settingsWindow = null;

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.focus();
    return settingsWindow;
  }

  const ver = typeof app.getVersion === 'function' ? app.getVersion() : '';
  settingsWindow = new BrowserWindow({
    width: 560,
    height: 64,
    minWidth: 480,
    minHeight: 56,
    maxHeight: 820,
    show: false,
    frame: false,
    title: ver ? `Yandex Music RPC v${ver}` : 'Yandex Music RPC',
    titleBarStyle: 'hidden',
    skipTaskbar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  settingsWindow.once('ready-to-show', () => {
    settingsWindow.show();
  });
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        shell.openExternal(url);
      }
    } catch (_) {}
    return { action: 'deny' };
  });

  return settingsWindow;
}

function showSettingsWindow() {
  createSettingsWindow();
}

function getSettingsWindow() {
  return settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : null;
}

module.exports = {
  createSettingsWindow,
  showSettingsWindow,
  getSettingsWindow,
};
