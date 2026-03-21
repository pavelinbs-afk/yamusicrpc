'use strict';

const path = require('path');
const { BrowserWindow, shell } = require('electron');

let settingsWindow = null;

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.focus();
    return settingsWindow;
  }

  settingsWindow = new BrowserWindow({
    width: 440,
    height: 64,
    minWidth: 360,
    minHeight: 56,
    maxHeight: 900,
    show: false,
    frame: false,
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
    shell.openExternal(url);
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
