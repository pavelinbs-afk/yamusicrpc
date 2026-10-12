'use strict';

/**
 * Основные Application ID + свой в настройках.
 * Приоритет: DISCORD_RPC_CLIENT_ID (env) → config.discordClientId → первый пресет.
 */
const DISCORD_CLIENT_ID_PRESETS = [
  { id: '1551603734243704933', label: 'Основной' },
  { id: '1475270523733807104', label: 'Альтернатива 1' },
  { id: '1509556524299587624', label: 'Альтернатива 2' },
];

const BUILTIN_DISCORD_CLIENT_ID = DISCORD_CLIENT_ID_PRESETS[0].id;

/** Discord Application ID — snowflake (обычно 17–19 цифр). */
function normalizeClientId(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s) return '';
  if (!/^\d{16,20}$/.test(s)) return null;
  return s;
}

function isPresetClientId(id) {
  const n = normalizeClientId(id);
  if (!n) return false;
  return DISCORD_CLIENT_ID_PRESETS.some((p) => p.id === n);
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
  DISCORD_CLIENT_ID_PRESETS,
  normalizeClientId,
  resolveDiscordClientId,
  clientIdSource,
  isPresetClientId,
};
