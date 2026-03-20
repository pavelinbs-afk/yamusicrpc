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
  const client = new Client({ transport: 'ipc' });

  client.on('ready', () => {
    // eslint-disable-next-line no-console
    console.log('[test] ready event');
  });
  client.on('disconnected', () => {
    // eslint-disable-next-line no-console
    console.log('[test] disconnected event');
  });

  // Hard timeout for login
  const timeoutMs = 15000;
  const t = setTimeout(() => {
    try { client.destroy(); } catch {}
    // eslint-disable-next-line no-console
    console.error('[test] login timeout after', timeoutMs, 'ms');
    process.exit(2);
  }, timeoutMs);

  try {
    const CLIENT_ID = resolveClientId();
    // eslint-disable-next-line no-console
    console.log('[test] login start. clientId=', CLIENT_ID);
    await client.login({ clientId: CLIENT_ID });
    clearTimeout(t);
    // eslint-disable-next-line no-console
    console.log('[test] login resolved');
    // Give it a moment to emit ready.
    setTimeout(() => {
      try { client.destroy(); } catch {}
      process.exit(0);
    }, 1500);
  } catch (e) {
    clearTimeout(t);
    // eslint-disable-next-line no-console
    console.error('[test] login failed:', e && e.message ? e.message : String(e));
    process.exit(1);
  }
}

main();

