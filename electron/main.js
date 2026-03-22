'use strict';

const net = require('net');
const path = require('path');
const { app, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const { projectRoot, getScriptsDir } = require('./paths');
const { getAppIconPath } = require('./icon-path');
const lifecycle = require('./app-lifecycle');
const {
  createSettingsWindow,
  showSettingsWindow,
  getSettingsWindow,
  showWindowFromTray,
  hideWindowToTray,
} = require('./settings-window');

const indexEntryPath = path.join(projectRoot(), 'index.js');

/** @type {Electron.Tray | null} */
let tray = null;

function waitForLocalPort(port, opts = {}) {
  const host = opts.host || '127.0.0.1';
  const timeoutMs = opts.timeoutMs ?? 20000;
  const intervalMs = opts.intervalMs ?? 120;
  return new Promise((resolve) => {
    const t0 = Date.now();
    function attempt() {
      const socket = net.createConnection({ host, port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => {
        try {
          socket.destroy();
        } catch (_) {}
        if (Date.now() - t0 >= timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(attempt, intervalMs);
      });
    }
    attempt();
  });
}

function destroyTray() {
  if (!tray) return;
  try {
    tray.destroy();
  } catch (_) {}
  tray = null;
}

function createTray() {
  destroyTray();
  const iconPath = getAppIconPath();
  if (!iconPath) return;
  let img;
  try {
    img = nativeImage.createFromPath(iconPath);
    if (img.isEmpty()) return;
  } catch (_) {
    return;
  }
  tray = new Tray(img);
  tray.setToolTip('Yandex Music RPC');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Показать окно',
        click: () => showWindowFromTray(),
      },
      { type: 'separator' },
      {
        label: 'Выход',
        click: () => {
          lifecycle.setQuitting(true);
          app.quit();
        },
      },
    ]),
  );
  tray.on('double-click', () => showWindowFromTray());
}

ipcMain.handle('ym-rpc:set-expanded', (_e, expanded) => {
  const win = getSettingsWindow();
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const w = Math.max(b.width, 520);
  const h = expanded ? 640 : 64;
  win.setBounds({ x: b.x, y: b.y, width: w, height: h }, true);
});

ipcMain.handle('ym-rpc:hide-to-tray', () => {
  hideWindowToTray();
});

ipcMain.handle('ym-rpc:quit', () => {
  lifecycle.setQuitting(true);
  app.quit();
});

ipcMain.handle('ym-rpc:app-version', () => {
  try {
    return typeof app.getVersion === 'function' ? app.getVersion() : '';
  } catch (_) {
    return '';
  }
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.yandexmusic.discordrpc');
  }

  app.on('second-instance', () => {
    showSettingsWindow();
  });

  let beforeQuitDone = false;
  app.on('before-quit', (e) => {
    if (beforeQuitDone) return;
    beforeQuitDone = true;
    destroyTray();
    e.preventDefault();
    try {
      const rpcMod = require(indexEntryPath);
      Promise.resolve(
        typeof rpcMod.gracefulShutdown === 'function'
          ? rpcMod.gracefulShutdown('app', { fromElectronBeforeQuit: true })
          : null,
      ).finally(() => {
        try {
          app.exit(0);
        } catch (_) {}
      });
    } catch (_) {
      try {
        app.exit(0);
      } catch (_) {}
    }
  });

  app.whenReady().then(async () => {
    process.env.RPC_EMBEDDED_IN_ELECTRON = '1';
    process.env.RPC_SCRIPTS_DIR = getScriptsDir();

    let rpcStarted = false;
    try {
      const rpcMod = require(indexEntryPath);
      if (typeof rpcMod.main !== 'function') {
        throw new Error('index.js не экспортирует main()');
      }
      await rpcMod.main();
      rpcStarted = true;
    } catch (e) {
      const text = e && e.message ? e.message : String(e);
      try {
        dialog.showErrorBox('Yandex Music RPC', `Не удалось запустить локальный сервис статуса:\n${text}`);
      } catch (_) {}
    }

    const ok = await waitForLocalPort(8765);
    if (!ok && rpcStarted) {
      try {
        await dialog.showMessageBox({
          type: 'warning',
          title: 'Yandex Music RPC',
          message: 'Сервис статуса не ответил на порту 8765.',
          detail: 'Попробуйте перезапустить приложение. Если ошибка повторяется — переустановите программу.',
        });
      } catch (_) {}
    }

    const win = createSettingsWindow();
    win.center();
    createTray();
  });
}
