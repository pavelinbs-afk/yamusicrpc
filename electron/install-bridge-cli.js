'use strict';

/**
 * Тихая установка моста (для NSIS/MSI/--install-client-bridge).
 * Запускает scripts/install-client-bridge.js через тот же Electron как Node.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function resolveBridgeInstallScript() {
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'scripts', 'install-client-bridge.js'));
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'scripts', 'install-client-bridge.js'));
  }
  candidates.push(path.join(__dirname, '..', 'scripts', 'install-client-bridge.js'));
  return candidates.find((p) => {
    try { return fs.existsSync(p); } catch (_) { return false; }
  }) || null;
}

function resolveBridgeDir() {
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'client-bridge'));
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'client-bridge'));
  }
  candidates.push(path.join(__dirname, '..', 'client-bridge'));
  return candidates.find((p) => {
    try { return fs.existsSync(path.join(p, 'ym-rpc-bridge.js')); } catch (_) { return false; }
  }) || null;
}

function buildNodePath() {
  const parts = [];
  parts.push(path.join(__dirname, '..', 'node_modules'));
  if (process.resourcesPath) {
    parts.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules'));
    parts.push(path.join(process.resourcesPath, 'app.asar', 'node_modules'));
    parts.push(path.join(process.resourcesPath, 'node_modules'));
  }
  const existing = process.env.NODE_PATH ? String(process.env.NODE_PATH) : '';
  return uniq([...parts, ...existing.split(path.delimiter)].filter((p) => {
    try { return p && fs.existsSync(p); } catch (_) { return false; }
  })).join(path.delimiter);
}

/**
 * @returns {Promise<number>} exit code
 */
function runInstallClientBridgeCli() {
  return new Promise((resolve) => {
    const script = resolveBridgeInstallScript();
    const bridgeDir = resolveBridgeDir();
    if (!script) {
      console.error('[install-bridge] нет scripts/install-client-bridge.js');
      resolve(1);
      return;
    }
    if (!bridgeDir) {
      console.error('[install-bridge] нет client-bridge/');
      resolve(1);
      return;
    }

    const child = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        YM_RPC_BRIDGE_DIR: bridgeDir,
        YM_RPC_BRIDGE_INSTALL_SOFT: '1',
        NODE_PATH: buildNodePath(),
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', (e) => {
      console.error('[install-bridge]', e && e.message ? e.message : e);
      resolve(1);
    });
    child.on('close', (code) => {
      if (out.trim()) process.stdout.write(out);
      if (err.trim()) process.stderr.write(err);
      resolve(code == null ? 1 : code);
    });
  });
}

module.exports = {
  runInstallClientBridgeCli,
  wantsInstallClientBridgeFlag() {
    return process.argv.includes('--install-client-bridge');
  },
};
