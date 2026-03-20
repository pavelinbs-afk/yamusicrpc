#!/usr/bin/env node
'use strict';

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const clientIdFile = path.join(__dirname, '..', 'logs', 'discord-client-id.txt');
let clientId = process.env.DISCORD_RPC_CLIENT_ID || '1475270523733807104';
try {
  if (fs.existsSync(clientIdFile)) {
    const v = fs.readFileSync(clientIdFile, 'utf8').trim();
    if (v) clientId = v;
  }
} catch {}

const port = 6463;
const url = `ws://127.0.0.1:${port}/?v=1&client_id=${clientId}`;
console.log('[raw-noorigin] connecting', url);

const ws = new WebSocket(url, { protocolVersion: 8 });

ws.on('open', () => console.log('[raw-noorigin] open'));
ws.on('message', (d) => {
  const s = d && d.toString ? d.toString() : String(d);
  console.log('[raw-noorigin] message:', s.slice(0, 200));
});
ws.on('error', (e) => console.log('[raw-noorigin] error:', e && e.message ? e.message : String(e)));
ws.on('close', (code, reason) => {
  console.log('[raw-noorigin] close:', code, reason ? reason.toString() : '');
  process.exit(0);
});

setTimeout(() => {
  try { ws.close(); } catch {}
  process.exit(0);
}, 5000);

