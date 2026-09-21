'use strict';

/**
 * Встроенный Application ID (своё приложение в Discord).
 * Приоритет: DISCORD_RPC_CLIENT_ID (env) → config.discordClientId → встроенный.
 */
const BUILTIN_DISCORD_CLIENT_ID = '1509556524299587624';

/** Discord Application ID — snowflake (обычно 17–19 цифр). */
function normalizeClientId(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s) return '';
  if (!/^\d{16,20}$/.test(s)) return null;
  return s;
}

/**
 * @param {{ discordClientId?: string } | null | undefined} [cfg]
 * @returns {string}
 */
function resolveDiscordClientId(cfg) {
  try {
    const envId = process.env.DISCORD_RPC_CLIENT_ID;
    if (envId && typeof envId === 'string' && envId.trim()) {
      const n = normalizeClientId(envId);
      if (n) return n;
      return envId.trim();
    }
  } catch (_) {}
  try {
    if (cfg && cfg.discordClientId != null) {
      const n = normalizeClientId(cfg.discordClientId);
      if (n) return n;
    }
  } catch (_) {}
  return BUILTIN_DISCORD_CLIENT_ID;
}

/**
 * @param {{ discordClientId?: string } | null | undefined} [cfg]
 * @returns {'env'|'config'|'builtin'}
 */
function clientIdSource(cfg) {
  try {
    if (process.env.DISCORD_RPC_CLIENT_ID && String(process.env.DISCORD_RPC_CLIENT_ID).trim()) {
      return 'env';
    }
  } catch (_) {}
  try {
    if (cfg && normalizeClientId(cfg.discordClientId)) {
      return 'config';
    }
  } catch (_) {}
  return 'builtin';
}

module.exports = {
  BUILTIN_DISCORD_CLIENT_ID,
  normalizeClientId,
  resolveDiscordClientId,
  clientIdSource,
};
