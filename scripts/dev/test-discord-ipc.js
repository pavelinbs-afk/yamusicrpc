#!/usr/bin/env node
'use strict';

const { Client } = require('discord-rpc');
const { resolveDiscordClientId } = require('../../lib/discord-client-id');

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
    const CLIENT_ID = resolveDiscordClientId();
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

