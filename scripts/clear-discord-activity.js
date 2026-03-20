#!/usr/bin/env node
'use strict';

const { Client } = require('discord-rpc');
const fs = require('fs');
const path = require('path');

const DEFAULT_CLIENT_ID = '1475270523733807104';
const LOG_DIR = path.join(__dirname, '..', 'logs');
const CLIENT_ID_FILE = path.join(LOG_DIR, 'discord-client-id.txt');

function resolveClientId() {
  try {
    const envId = process.env.DISCORD_RPC_CLIENT_ID;
    if (envId && typeof envId === 'string' && envId.trim()) return envId.trim();
  } catch (_) {}
  try {
    if (fs.existsSync(CLIENT_ID_FILE)) {
      const v = fs.readFileSync(CLIENT_ID_FILE, 'utf8').trim();
      if (v) return v;
    }
  } catch (_) {}
  try {
    const alt = path.join(__dirname, '..', 'discord-client-id.txt');
    if (fs.existsSync(alt)) {
      const v2 = fs.readFileSync(alt, 'utf8').trim();
      if (v2) return v2;
    }
  } catch (_) {}
  return DEFAULT_CLIENT_ID;
}

async function main() {
  const rpc = new Client({ transport: 'ipc' });
  const timeout = setTimeout(() => {
    try { rpc.destroy(); } catch (_) {}
    process.exit(1);
  }, 5000);

  try {
    await rpc.login({ clientId: resolveClientId() });
    await rpc.clearActivity();
    try { rpc.destroy(); } catch (_) {}
    clearTimeout(timeout);
    process.exit(0);
  } catch (_) {
    try { rpc.destroy(); } catch (_) {}
    clearTimeout(timeout);
    process.exit(1);
  }
}

main();
