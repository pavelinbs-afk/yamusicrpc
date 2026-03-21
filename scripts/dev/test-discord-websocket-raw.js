#!/usr/bin/env node
'use strict';

const WebSocket = require('ws');

const clientIdDefault = '1475270523733807104';
const clientId = process.env.DISCORD_RPC_CLIENT_ID || clientIdDefault;
const port = 6463;
const originCandidates = ['https://localhost'];
const clientIdCandidates = [clientId];

let originIdx = 0;
let clientIdx = 0;
function run() {
  if (originIdx >= originCandidates.length) return;
  const origin = originCandidates[originIdx];
  const cid = clientIdCandidates[clientIdx];
  // keep clientIdx
  originIdx += 1;
  const url = `ws://127.0.0.1:${port}/?v=1&client_id=${cid}`;
  console.log('[raw] try cid=', cid, 'origin=', origin, 'url=', url);

  const ws = new WebSocket(url, { origin });
  ws.on('open', () => {
    console.log('[raw] open');
  });
  ws.on('message', (data) => {
    const s = data && data.toString ? data.toString() : String(data);
    console.log('[raw] message:', s.slice(0, 200));
    try { ws.close(); } catch {}
  });
  ws.on('close', (code, reason) => {
    const r = reason ? reason.toString() : '';
    console.log('[raw] close:', code, r);
    if (code !== 4001) {
      setTimeout(() => process.exit(0), 200);
      return;
    }
    setTimeout(run, 600);
  });
  ws.on('error', (err) => {
    console.log('[raw] error:', err && err.message ? err.message : String(err));
    setTimeout(run, 600);
  });
}

run();

// Keep process alive for all candidates.
setTimeout(() => process.exit(0), 12000);
// (This will exit earlier if we find a working origin.)

