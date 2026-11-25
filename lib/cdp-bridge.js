'use strict';

/**
 * Мост через Chrome DevTools Protocol.
 * YM 5.128+: правка app.asar / Electron fuses ломает music-application://desktop.
 * Запуск клиента: --remote-debugging-port=<port> (см. install-client-bridge.js).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const DEFAULT_PORT = 9229;
const DEFAULT_HOST = '127.0.0.1';

function resolveBridgeCode() {
  const candidates = [];
  if (process.env.YM_RPC_BRIDGE_DIR) {
    candidates.push(path.join(process.env.YM_RPC_BRIDGE_DIR, 'ym-rpc-bridge.js'));
  }
  candidates.push(path.join(__dirname, '..', 'client-bridge', 'ym-rpc-bridge.js'));
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'client-bridge', 'ym-rpc-bridge.js'));
    candidates.push(
      path.join(process.resourcesPath, 'app.asar.unpacked', 'client-bridge', 'ym-rpc-bridge.js'),
    );
  }
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    } catch (_) {}
  }
  return null;
}

function httpJson(url, timeoutMs = 1200) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body || 'null'));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      try { req.destroy(); } catch (_) {}
      reject(new Error('timeout'));
    });
  });
}

async function listTargets(port = DEFAULT_PORT, host = DEFAULT_HOST) {
  try {
    const list = await httpJson(`http://${host}:${port}/json/list`);
    if (Array.isArray(list)) return list;
  } catch (_) {}
  const list = await httpJson(`http://${host}:${port}/json`);
  return Array.isArray(list) ? list : [];
}

function pickMusicTarget(targets) {
  const pages = (targets || []).filter((t) => t && (t.type === 'page' || t.type === 'webview'));
  const hit =
    pages.find((t) => /music-application:\/\//i.test(String(t.url || ''))) ||
    pages.find((t) => /yandex\.ru\/.*(music|play)/i.test(String(t.url || ''))) ||
    pages[0];
  return hit && hit.webSocketDebuggerUrl ? hit : null;
}

function cdpSession(wsUrl) {
  let id = 0;
  let socket = null;
  const pending = new Map();

  function send(method, params) {
    return new Promise((resolve, reject) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error('cdp not open'));
        return;
      }
      const msgId = ++id;
      const timer = setTimeout(() => {
        pending.delete(msgId);
        reject(new Error('cdp timeout ' + method));
      }, 5000);
      pending.set(msgId, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      socket.send(JSON.stringify({ id: msgId, method, params: params || {} }));
    });
  }

  function open() {
    return new Promise((resolve, reject) => {
      socket = new WebSocket(wsUrl, { maxPayload: 32 * 1024 * 1024 });
      socket.on('open', () => resolve());
      socket.on('error', reject);
      socket.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch (_) { return; }
        if (msg.id != null && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || 'cdp error'));
          else p.resolve(msg.result);
        }
      });
      socket.on('close', () => {
        for (const p of pending.values()) p.reject(new Error('cdp closed'));
        pending.clear();
      });
    });
  }

  function close() {
    try { if (socket) socket.close(); } catch (_) {}
    socket = null;
  }

  return { open, send, close };
}

function postTrack(payload, port = 8765) {
  return new Promise((resolve) => {
    try {
      const data = JSON.stringify(payload);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/track',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
          },
          timeout: 2500,
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
        },
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        try { req.destroy(); } catch (_) {}
        resolve(false);
      });
      req.write(data);
      req.end();
    } catch (_) {
      resolve(false);
    }
  });
}

/**
 * @param {{ port?: number, host?: string, rpcPort?: number, pollMs?: number, log?: Function }} opts
 */
function startCdpBridgePoller(opts = {}) {
  const port = opts.port || DEFAULT_PORT;
  const host = opts.host || DEFAULT_HOST;
  const rpcPort = opts.rpcPort || 8765;
  const pollMs = opts.pollMs || 500;
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  let stopped = false;
  let timer = null;
  let session = null;
  let injected = false;
  let bridgeCode = null;
  let lastDiagAt = 0;
  let inFlight = false;

  async function ensureSession() {
    if (session) return true;
    const targets = await listTargets(port, host);
    const target = pickMusicTarget(targets);
    if (!target) return false;
    session = cdpSession(target.webSocketDebuggerUrl);
    await session.open();
    injected = false;
    log('CDP: подключено к', target.url || target.id);
    return true;
  }

  async function ensureInjected() {
    if (!session) return false;
    if (!bridgeCode) {
      bridgeCode = resolveBridgeCode();
      if (!bridgeCode) throw new Error('нет client-bridge/ym-rpc-bridge.js');
    }
    if (injected) return true;
    await session.send('Runtime.enable');
    await session.send('Runtime.evaluate', {
      expression: bridgeCode,
      awaitPromise: false,
      returnByValue: false,
    });
    injected = true;
    log('CDP: bridge injected');
    return true;
  }

  async function readPlayer() {
    const res = await session.send('Runtime.evaluate', {
      expression:
        '(function(){try{' +
        'if(typeof window.__ymRpcReadPlayer!=="function")return {__diag:"no_reader"};' +
        'var p=window.__ymRpcReadPlayer();' +
        'return p||{__diag:"no_player"};' +
        '}catch(e){return {__diag:"err:"+String(e&&e.message||e)};}})()',
      awaitPromise: false,
      returnByValue: true,
    });
    return res && res.result ? res.result.value : null;
  }

  async function tick() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const ok = await ensureSession();
      if (!ok) {
        if (Date.now() - lastDiagAt > 15000) {
          lastDiagAt = Date.now();
          log('CDP: нет вкладки music-application (порт', port + ')');
        }
        return;
      }
      await ensureInjected();
      const payload = await readPlayer();
      if (!payload || payload.__diag) {
        if (Date.now() - lastDiagAt > 12000) {
          lastDiagAt = Date.now();
          log('CDP diag', payload && payload.__diag ? payload.__diag : 'empty');
        }
        // страница перезагрузилась — реинжект
        if (payload && payload.__diag === 'no_reader') injected = false;
        return;
      }
      if (!payload.title) return;
      payload.source = 'client';
      await postTrack(payload, rpcPort);
    } catch (e) {
      try { if (session) session.close(); } catch (_) {}
      session = null;
      injected = false;
      if (Date.now() - lastDiagAt > 10000) {
        lastDiagAt = Date.now();
        log('CDP ошибка:', e && e.message ? e.message : e);
      }
    } finally {
      inFlight = false;
    }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => {
      tick()
        .catch(() => {})
        .then(schedule);
    }, pollMs);
  }

  schedule();
  log('CDP poller started on', `${host}:${port}`);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      try { if (session) session.close(); } catch (_) {}
      session = null;
    },
    port,
  };
}

async function isCdpAvailable(port = DEFAULT_PORT, host = DEFAULT_HOST) {
  try {
    const targets = await listTargets(port, host);
    return !!pickMusicTarget(targets);
  } catch (_) {
    return false;
  }
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_HOST,
  resolveBridgeCode,
  listTargets,
  pickMusicTarget,
  startCdpBridgePoller,
  isCdpAvailable,
  postTrack,
};
