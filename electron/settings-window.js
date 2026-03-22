'use strict';

const path = require('path');
const { app, BrowserWindow, shell } = require('electron');
const { getAppIconPath } = require('./icon-path');
const lifecycle = require('./app-lifecycle');

let settingsWindow = null;

function windowIconPath() {
  return getAppIconPath();
}

function showWindowFromTray() {
  const w = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : null;
  if (!w) return;
  w.show();
  w.setSkipTaskbar(false);
  if (w.isMinimized()) w.restore();
  w.focus();
}

function hideWindowToTray() {
  const w = getSettingsWindow();
  if (!w || w.isDestroyed()) return;
  w.hide();
  w.setSkipTaskbar(true);
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    showWindowFromTray();
    return settingsWindow;
  }

  const ver = typeof app.getVersion === 'function' ? app.getVersion() : '';
  const winOpts = {
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
  };
  const icon = windowIconPath();
  if (icon) winOpts.icon = icon;
  settingsWindow = new BrowserWindow(winOpts);

  settingsWindow.on('close', (e) => {
    if (!lifecycle.isQuitting()) {
      e.preventDefault();
      hideWindowToTray();
    }
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
  showWindowFromTray();
}

function getSettingsWindow() {
  return settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : null;
}

module.exports = {
  createSettingsWindow,
  showSettingsWindow,
  getSettingsWindow,
  showWindowFromTray,
  hideWindowToTray,
};
