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
    width: 720,
    height: 640,
    minWidth: 560,
    minHeight: 420,
    maxHeight: 900,
    show: false,
    frame: false,
    backgroundColor: '#000000',
    title: ver ? `Yandex Music RPC v${ver}` : 'Yandex Music RPC',
    titleBarStyle: 'hidden',
    skipTaskbar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
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

  const htmlPath = path.join(__dirname, 'renderer', 'index.html');
  const wc = settingsWindow.webContents;
  wc.on('did-fail-load', (_e, code, desc, url) => {
    try {
      console.error('settings did-fail-load', code, desc, url);
    } catch (_) {}
    setTimeout(() => {
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        try { wc.reload(); } catch (_) {}
      }
    }, 500);
  });
  wc.on('render-process-gone', (_e, details) => {
    try {
      console.error('settings render-process-gone', details && details.reason, details && details.exitCode);
    } catch (_) {}
    setTimeout(() => {
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        try { wc.reload(); } catch (_) {}
      }
    }, 800);
  });
  settingsWindow.loadFile(htmlPath).catch((err) => {
    try {
      console.error('settings window loadFile failed:', err && err.message ? err.message : err);
    } catch (_) {}
  });
  settingsWindow.once('ready-to-show', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.show();
  });
  // Если ready-to-show не пришёл — всё равно показать через 1.5с.
  setTimeout(() => {
    if (settingsWindow && !settingsWindow.isDestroyed() && !settingsWindow.isVisible()) {
      settingsWindow.show();
    }
  }, 1500);
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
