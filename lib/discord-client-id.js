'use strict';

/**
 * Встроенный Application ID (своё приложение в Discord).
 * Переопределение: переменная окружения DISCORD_RPC_CLIENT_ID.
 */
const BUILTIN_DISCORD_CLIENT_ID = '1475270523733807104';

function resolveDiscordClientId() {
  try {
    const envId = process.env.DISCORD_RPC_CLIENT_ID;
    if (envId && typeof envId === 'string' && envId.trim()) return envId.trim();
  } catch (_) {}
  return BUILTIN_DISCORD_CLIENT_ID;
}

function clientIdSource() {
  try {
    if (process.env.DISCORD_RPC_CLIENT_ID && String(process.env.DISCORD_RPC_CLIENT_ID).trim()) {
      return 'env';
    }
  } catch (_) {}
  return 'builtin';
}

module.exports = {
  BUILTIN_DISCORD_CLIENT_ID,
  resolveDiscordClientId,
  clientIdSource,
};
