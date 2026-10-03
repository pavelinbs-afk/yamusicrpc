/* YM_RPC_BRIDGE_START */
(function () {
  // Отложенный безопасный inject: не должен ронять main-процесс Яндекс.Музыки.
  try {
    setImmediate(function () {
      try {
        var electron = require('electron');
        var app = electron.app;
        if (!app) return;
        var fs = require('fs');
        var path = require('path');
        var bridgePath = path.join(__dirname, 'ym-rpc-bridge.js');
        var bridgeCode = '';
        try {
          if (!fs.existsSync(bridgePath)) {
            console.error('[ym-rpc-bridge] missing file:', bridgePath);
            return;
          }
          bridgeCode = fs.readFileSync(bridgePath, 'utf8');
        } catch (readErr) {
          console.error('[ym-rpc-bridge] read failed', readErr && readErr.message ? readErr.message : readErr);
          return;
        }
        if (!bridgeCode) return;

        var inject = function (wc) {
          try {
            if (!wc || wc.isDestroyed()) return;
            wc.executeJavaScript(bridgeCode, true).catch(function () {});
          } catch (_) {}
        };
        var hookContents = function (wc) {
          try {
            if (!wc || wc.__ymRpcBridgeHooked) return;
            wc.__ymRpcBridgeHooked = true;
            wc.on('dom-ready', function () { inject(wc); });
            wc.on('did-finish-load', function () { inject(wc); });
          } catch (_) {}
        };
        var hook = function () {
          try {
            app.on('web-contents-created', function (_e, wc) { hookContents(wc); });
            var BrowserWindow = electron.BrowserWindow;
            if (BrowserWindow) {
              BrowserWindow.getAllWindows().forEach(function (w) {
                try { hookContents(w.webContents); } catch (_) {}
              });
            }
            console.log('[ym-rpc-bridge] main inject ready');
          } catch (hookErr) {
            console.error('[ym-rpc-bridge] hook failed', hookErr && hookErr.message ? hookErr.message : hookErr);
          }
        };
        if (app.isReady()) hook();
        else app.whenReady().then(hook).catch(function () {});
      } catch (e) {
        console.error('[ym-rpc-bridge] main inject failed', e && e.message ? e.message : e);
      }
    });
  } catch (_) {}
})();
/* YM_RPC_BRIDGE_END */
