'use strict';

const fs = require('fs');
const https = require('https');
const http = require('http');

const MAX_MEMORY_LINES = 600;

function createLogger({ logPath, errLogPath }) {
  const memory = [];
  let lastRemotePost = 0;

  function pushMemory(line) {
    memory.push(line);
    if (memory.length > MAX_MEMORY_LINES) {
      memory.splice(0, memory.length - MAX_MEMORY_LINES);
    }
  }

  function appendFileSafe(filePath, line) {
    if (!filePath) return;
    try {
      fs.appendFileSync(filePath, line + '\n', { encoding: 'utf8' });
    } catch (_) {}
  }

  function postRemote(url, payload, throttleMs) {
    const now = Date.now();
    if (now - lastRemotePost < throttleMs) return;
    lastRemotePost = now;
    try {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const body = Buffer.from(JSON.stringify(payload), 'utf8');
      const req = lib.request(
        {
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + (u.search || ''),
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': body.length,
          },
          timeout: 8000,
        },
        (res) => {
          try {
            res.resume();
          } catch (_) {}
        },
      );
      req.on('error', () => {});
      req.write(body);
      req.end();
    } catch (_) {}
  }

  function log(cfg, ...args) {
    const time = new Date().toLocaleTimeString('ru-RU');
    const line = `[${time}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
    pushMemory({ t: Date.now(), level: 'info', line });
    const mode = cfg && cfg.logging ? cfg.logging.mode : 'none';
    if (mode === 'file' || mode === 'both') {
      appendFileSafe(logPath, line);
    }
    if (mode === 'remote' || mode === 'both') {
      const ru = cfg && cfg.logging && cfg.logging.remoteUrl;
      if (ru) {
        postRemote(
          ru,
          { level: 'info', message: line, ts: new Date().toISOString() },
          (cfg.logging && cfg.logging.remoteThrottleMs) || 8000,
        );
      }
    }
    console.log(line);
  }

  function logErr(cfg, ...args) {
    const time = new Date().toLocaleTimeString('ru-RU');
    const line = `[${time}] ERR ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
    pushMemory({ t: Date.now(), level: 'err', line });
    const mode = cfg && cfg.logging ? cfg.logging.mode : 'none';
    if (mode === 'file' || mode === 'both') {
      appendFileSafe(errLogPath || logPath, line);
    }
    if (mode === 'remote' || mode === 'both') {
      const ru = cfg && cfg.logging && cfg.logging.remoteUrl;
      if (ru) {
        postRemote(
          ru,
          { level: 'error', message: line, ts: new Date().toISOString() },
          Math.min((cfg.logging && cfg.logging.remoteThrottleMs) || 8000, 15000),
        );
      }
    }
    console.error(line);
  }

  function getMemoryLines() {
    return memory.slice();
  }

  return { log, logErr, getMemoryLines };
}

module.exports = { createLogger, MAX_MEMORY_LINES };
