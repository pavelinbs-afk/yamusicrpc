'use strict';
/**
 * Вешается на webContents Яндекс.Музыки:
 *  1) внедряет ym-rpc-bridge.js (чтение плеера) в renderer;
 *  2) из main process опрашивает состояние и POST на 127.0.0.1:8765/track.
 *
 * POST из Node обходит CSP страницы music.yandex.ru (fetch на localhost часто блокируется).
 */
(function () {
  try {
    var electron = require('electron');
    var app = electron && electron.app;
    if (!app) return;

    var fs = require('fs');
    var path = require('path');
    var http = require('http');
    var os = require('os');

    var bridgePath = path.join(__dirname, 'ym-rpc-bridge.js');
    var bridgeCode = '';
    var logPath = path.join(os.tmpdir(), 'ym-rpc-bridge.log');

    function dlog(msg) {
      try {
        fs.appendFileSync(logPath, new Date().toISOString() + ' ' + msg + '\n');
      } catch (_) {}
    }

    try {
      bridgeCode = fs.readFileSync(bridgePath, 'utf8');
    } catch (e) {
      dlog('cannot read bridge: ' + (e && e.message ? e.message : e));
      console.error('[ym-rpc-bridge] cannot read bridge:', bridgePath);
      return;
    }
    if (!bridgeCode) return;

    var RPC_HOST = '127.0.0.1';
    var RPC_PORT = 8765;
    // Как YandexMusicBetaMod discordRPC.js: опрос плеера каждые ~500 мс.
    var POLL_MS = 500;
    var POST_MIN_MS = 350;
    /** Пока играет — шлём позицию не реже этого интервала (сек → Discord seek/таймбар). */
    var POST_PLAYING_MS = 900;
    var POST_IDLE_MS = 2500;
    /** Скачок позиции (сек) = перемотка → POST сразу, без ожидания cooldown. */
    var SEEK_FORCE_SEC = 1.25;
    var lastPostAt = 0;
    var lastPayloadKey = '';
    var lastPostedPosSec = null;
    var pollTimer = null;
    var lastDiagAt = 0;
    var pollInFlight = false;

    function inject(wc) {
      try {
        if (!wc || wc.isDestroyed()) return;
        wc.executeJavaScript(bridgeCode, true)
          .then(function () { dlog('inject ok url=' + (wc.getURL ? wc.getURL() : '')); })
          .catch(function (e) { dlog('inject fail: ' + (e && e.message ? e.message : e)); });
      } catch (e) {
        dlog('inject throw: ' + (e && e.message ? e.message : e));
      }
    }

    function hookContents(wc) {
      try {
        if (!wc || wc.__ymRpcBridgeHooked) return;
        wc.__ymRpcBridgeHooked = true;
        dlog('hook contents id=' + (wc.id != null ? wc.id : '?'));
        wc.on('dom-ready', function () { inject(wc); });
        wc.on('did-finish-load', function () { inject(wc); });
        try {
          if (!wc.isLoadingMainFrame || !wc.isLoadingMainFrame()) inject(wc);
        } catch (_) {
          inject(wc);
        }
      } catch (e) {
        dlog('hookContents fail: ' + (e && e.message ? e.message : e));
      }
    }

    /** Ключ трека/паузы/обложки без позиции — позиция сравнивается отдельно. */
    function payloadKey(p) {
      if (!p) return '';
      return [
        p.title || '',
        p.artist || '',
        p.paused ? '1' : '0',
        p.coverUrl || '',
        Math.floor(Number(p.durationSec) || 0),
      ].join('|');
    }

    function shouldPost(payload, key, now) {
      if (!payload || !key) return false;
      var pos = Number(payload.positionSec);
      var hasPos = Number.isFinite(pos);
      var trackChanged = key !== lastPayloadKey;
      var seek =
        hasPos &&
        lastPostedPosSec != null &&
        Math.abs(pos - lastPostedPosSec) > SEEK_FORCE_SEC;
      if (trackChanged || seek) return true;
      if (now - lastPostAt < POST_MIN_MS) return false;
      if (!payload.paused && hasPos) {
        // Играет: обновляем позицию часто, даже если title/artist не менялись.
        if (lastPostedPosSec == null) return true;
        if (Math.abs(pos - lastPostedPosSec) >= 0.35) return true;
        if (now - lastPostAt >= POST_PLAYING_MS) return true;
        return false;
      }
      return now - lastPostAt >= POST_IDLE_MS;
    }

    function postTrack(body) {
      return new Promise(function (resolve) {
        try {
          var data = JSON.stringify(body);
          var req = http.request(
            {
              host: RPC_HOST,
              port: RPC_PORT,
              path: '/track',
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
              },
              timeout: 2500,
            },
            function (res) {
              res.on('data', function () {});
              res.on('end', function () {
                resolve(res.statusCode >= 200 && res.statusCode < 300);
              });
            }
          );
          req.on('error', function (e) {
            dlog('post error: ' + (e && e.message ? e.message : e));
            resolve(false);
          });
          req.on('timeout', function () {
            try { req.destroy(); } catch (_) {}
            resolve(false);
          });
          req.write(data);
          req.end();
        } catch (e) {
          dlog('post throw: ' + (e && e.message ? e.message : e));
          resolve(false);
        }
      });
    }

    function allWebContents() {
      try {
        if (electron.webContents && typeof electron.webContents.getAllWebContents === 'function') {
          return electron.webContents.getAllWebContents();
        }
      } catch (_) {}
      var out = [];
      try {
        var BrowserWindow = electron.BrowserWindow;
        if (BrowserWindow) {
          BrowserWindow.getAllWindows().forEach(function (w) {
            try {
              if (w && !w.isDestroyed() && w.webContents) out.push(w.webContents);
            } catch (_) {}
          });
        }
      } catch (_) {}
      return out;
    }

    function readFromWc(wc) {
      if (!wc || wc.isDestroyed()) return Promise.resolve(null);
      return wc
        .executeJavaScript(
          '(function(){try{' +
            'if(typeof window.__ymRpcReadPlayer!=="function")return {__diag:"no_reader"};' +
            'var p=window.__ymRpcReadPlayer();' +
            'if(p)return p;' +
            'var ids=[];' +
            'document.querySelectorAll("[data-test-id]").forEach(function(n){' +
              'var id=n.getAttribute("data-test-id")||"";' +
              'if(/play|player|bar|track|pause/i.test(id)&&ids.indexOf(id)<0)ids.push(id);' +
            '});' +
            'var frames=document.querySelectorAll("iframe").length;' +
            'var bodyLen=(document.body&&document.body.innerText||"").length;' +
            'return {__diag:"no_player", href:String(location.href||"").slice(0,120), ids:ids.slice(0,40), frames:frames, bodyLen:bodyLen, title:document.title||""};' +
          '}catch(e){return {__diag:"err:"+String(e&&e.message||e)};}})()',
          true
        )
        .catch(function (e) {
          return { __diag: 'exec:' + (e && e.message ? e.message : String(e)) };
        });
    }

    async function pollOnce() {
      if (pollInFlight) return;
      pollInFlight = true;
      try {
        var list = allWebContents();
        var now = Date.now();

        var diag = null;
        for (var i = 0; i < list.length; i++) {
          var wc = list[i];
          if (!wc || wc.isDestroyed()) continue;
          var payload = await readFromWc(wc);
          if (!payload) continue;
          if (payload.__diag) {
            if (!diag) diag = payload;
            continue;
          }
          if (!payload.title) continue;
          var key = payloadKey(payload);
          if (!shouldPost(payload, key, now)) return;
          var posNum = Number(payload.positionSec);
          var seek =
            Number.isFinite(posNum) &&
            lastPostedPosSec != null &&
            Math.abs(posNum - lastPostedPosSec) > SEEK_FORCE_SEC;
          var ok = await postTrack(payload);
          if (ok) {
            lastPostAt = Date.now();
            lastPayloadKey = key;
            if (Number.isFinite(posNum)) lastPostedPosSec = posNum;
            if (seek || now - lastDiagAt > 8000) {
              lastDiagAt = now;
              dlog(
                'posted ok title=' +
                  payload.title +
                  ' cover=' +
                  (payload.coverUrl ? 'yes' : 'no') +
                  ' paused=' +
                  (payload.paused ? '1' : '0') +
                  ' pos=' +
                  (Number.isFinite(posNum) ? posNum.toFixed(1) : '?') +
                  (seek ? ' SEEK' : '')
              );
            }
          }
          return;
        }
        if (now - lastDiagAt > 10000) {
          lastDiagAt = now;
          if (diag) dlog('diag wc=' + list.length + ' ' + JSON.stringify(diag));
          for (var j = 0; j < list.length; j++) {
            var wc2 = list[j];
            if (!wc2 || wc2.isDestroyed()) continue;
            try {
              var probe = await wc2.executeJavaScript(
                '(function(){try{return typeof window.__ymRpcProbe==="function"?window.__ymRpcProbe():null;}catch(e){return {err:String(e&&e.message||e)};}})()',
                true
              );
              if (probe) dlog('probe ' + JSON.stringify(probe));
            } catch (_) {}
          }
        }
      } catch (e) {
        dlog('poll throw: ' + (e && e.message ? e.message : e));
      } finally {
        pollInFlight = false;
      }
    }

    function startPolling() {
      if (pollTimer) return;
      // Рекурсивный setTimeout как в BetaMod — не копим тики, если executeJavaScript тормозит.
      var tick = function () {
        pollOnce()
          .catch(function () {})
          .then(function () {
            pollTimer = setTimeout(tick, POLL_MS);
          });
      };
      pollTimer = setTimeout(tick, 400);
      dlog('polling started (BetaMod-style ' + POLL_MS + 'ms)');
    }

    app.on('web-contents-created', function (_e, wc) {
      hookContents(wc);
    });

    var attachExisting = function () {
      try {
        allWebContents().forEach(function (wc) {
          try { hookContents(wc); } catch (_) {}
        });
      } catch (_) {}
      startPolling();
    };

    dlog('hook module loaded');
    if (app.isReady()) attachExisting();
    else app.whenReady().then(attachExisting).catch(function () {});

    console.log('[ym-rpc-bridge] hook registered (main→RPC)');
  } catch (e) {
    try {
      console.error('[ym-rpc-bridge] hook failed', e && e.message ? e.message : e);
    } catch (_) {}
  }
})();
