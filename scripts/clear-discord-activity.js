#!/usr/bin/env node
'use strict';

const { Client } = require('discord-rpc');
const { resolveDiscordClientId } = require('../lib/discord-client-id');

async function main() {
  const rpc = new Client({ transport: 'ipc' });
  const timeout = setTimeout(() => {
    try { rpc.destroy(); } catch (_) {}
    process.exit(1);
  }, 5000);

  try {
    await rpc.login({ clientId: resolveDiscordClientId() });
    await rpc.clearActivity();
  } finally {
    clearTimeout(timeout);
    try { rpc.destroy(); } catch (_) {}
  }
  process.exit(0);
}

main().catch(() => process.exit(1));
