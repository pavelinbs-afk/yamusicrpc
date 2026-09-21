#!/usr/bin/env node
'use strict';

const { Client } = require('discord-rpc');
const { loadConfig } = require('../lib/config');
const { resolveDiscordClientId } = require('../lib/discord-client-id');

async function main() {
  const rpc = new Client({ transport: 'ipc' });
  const timeout = setTimeout(() => {
    try { rpc.destroy(); } catch (_) {}
    process.exit(1);
  }, 5000);

  try {
    let cfg = null;
    try { cfg = loadConfig(); } catch (_) {}
    await rpc.login({ clientId: resolveDiscordClientId(cfg) });
    await rpc.clearActivity();
  } finally {
    clearTimeout(timeout);
    try { rpc.destroy(); } catch (_) {}
  }
  process.exit(0);
}

main().catch(() => process.exit(1));
