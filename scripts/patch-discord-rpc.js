/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const path = require('path');

function fileExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch (_) {
    return false;
  }
}

const root = path.join(__dirname, '..', 'node_modules', 'discord-rpc', 'src');
const clientPath = path.join(root, 'client.js');
const ipcPath = path.join(root, 'transports', 'ipc.js');

function patchClientType() {
  if (!fileExists(clientPath)) {
    console.log('[patch-discord-rpc] discord-rpc client.js not found, skip:', clientPath);
    return;
  }

  let content = fs.readFileSync(clientPath, 'utf8');

  // Idempotent: если уже добавили тип, ничего не делаем.
  if (content.includes('type: args.type')) {
    console.log('[patch-discord-rpc] client.js activity.type already patched');
    return;
  }

  // Добавляем поле activity.type = args.type, чтобы Discord показывал "Слушает" и корректный тайм-бар.
  const re = /(activity:\s*{\s*\n)([ \t]*)state:\s*args\.state,/m;
  if (!re.test(content)) {
    console.log('[patch-discord-rpc] client.js pattern not found, skip');
    return;
  }

  content = content.replace(re, `$1$2type: args.type,\n$2state: args.state,`);
  fs.writeFileSync(clientPath, content, 'utf8');
  console.log('[patch-discord-rpc] patched activity.type:', clientPath);
}

/**
 * При неудачном connect socket=null; close()/send() падают на this.socket.write
 * → unhandledRejection. Глушим безопасным no-op.
 */
function patchIpcNullSocket() {
  if (!fileExists(ipcPath)) {
    console.log('[patch-discord-rpc] ipc.js not found, skip');
    return;
  }

  let content = fs.readFileSync(ipcPath, 'utf8');
  if (content.includes('/* ym-rpc:null-socket */')) {
    console.log('[patch-discord-rpc] ipc.js null-socket already patched');
    return;
  }

  const sendRe = /send\(data, op = OPCodes\.FRAME\) \{\s*\n\s*this\.socket\.write\(encode\(op, data\)\);\s*\n\s*\}/;
  if (!sendRe.test(content)) {
    console.log('[patch-discord-rpc] ipc.js send() pattern not found, skip');
    return;
  }

  content = content.replace(
    sendRe,
    `send(data, op = OPCodes.FRAME) {\n` +
      `    /* ym-rpc:null-socket */\n` +
      `    if (!this.socket) return;\n` +
      `    this.socket.write(encode(op, data));\n` +
      `  }`,
  );

  const closeRe = /async close\(\) \{\s*\n\s*return new Promise\(\(r\) => \{\s*\n\s*this\.once\('close', r\);\s*\n\s*this\.send\(\{\}, OPCodes\.CLOSE\);\s*\n\s*this\.socket\.end\(\);\s*\n\s*\}\);\s*\n\s*\}/;
  if (!closeRe.test(content)) {
    console.log('[patch-discord-rpc] ipc.js close() pattern not found (send patched)');
    fs.writeFileSync(ipcPath, content, 'utf8');
    return;
  }

  content = content.replace(
    closeRe,
    `async close() {\n` +
      `    return new Promise((r) => {\n` +
      `      /* ym-rpc:null-socket */\n` +
      `      if (!this.socket) {\n` +
      `        r();\n` +
      `        return;\n` +
      `      }\n` +
      `      this.once('close', r);\n` +
      `      try {\n` +
      `        this.send({}, OPCodes.CLOSE);\n` +
      `        this.socket.end();\n` +
      `      } catch (_) {\n` +
      `        r();\n` +
      `      }\n` +
      `    });\n` +
      `  }`,
  );

  fs.writeFileSync(ipcPath, content, 'utf8');
  console.log('[patch-discord-rpc] patched ipc null-socket:', ipcPath);
}

patchClientType();
patchIpcNullSocket();
