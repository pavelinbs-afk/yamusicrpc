'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function getConfigDir() {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'yandex-music-rpc');
  }
  return path.join(os.homedir(), '.config', 'yandex-music-rpc');
}

const CONFIG_PATH = path.join(getConfigDir(), 'config.json');

const DEFAULTS = {
  rpcEnabled: true,
  /**
   * auto — мост в клиенте (source=client) приоритетнее GSMTC/заголовка;
   * desktop — только внешний опрос; browser — устаревшее, мигрирует в auto.
   */
  preferredSource: 'auto',
  desktopPollingEnabled: true,
  /** Опрос десктопа (GSMTC / заголовок окна); чаще — плавнее полоска в Discord. */
  desktopPollIntervalMs: 500,
  /** Сколько мс после поста от моста/браузера не перебивать источником desktop. */
  desktopBrowserPriorityMs: 12000,
  coverArtEnabled: true,
  /** Вторая кнопка (фиксированная ссылка в коде, не настраивается в UI) */
  discordShowModButton: true,
  /**
   * Свой Discord Application ID (snowflake). Пусто = встроенный ID проекта.
   * Переменная окружения DISCORD_RPC_CLIENT_ID имеет приоритет выше.
   */
  discordClientId: '',
  /**
   * Имя ассета из Discord Developer Portal → Rich Presence → Art Assets.
   * Пусто = HTTPS-обложка трека, иначе для встроенного ID — yandex_music_icon.
   */
  discordLargeImageKey: '',
  theme: 'dark',
  fontFamily: 'system-ui, "Segoe UI", sans-serif',
  fontSizePx: 14,
  /**
   * Десктоп не сообщает длительность трека — для таймбара Discord берётся оценка (сек).
   * 0 = не задавать конец трека (полоса прогресса может не показаться).
   */
  desktopAssumedDurationSec: 210,
  logging: {
    mode: 'none',
    remoteUrl: '',
    remoteThrottleMs: 8000,
  },
};

function omitDiscordButtonCustomization(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const o = { ...obj };
  delete o.discordTrackButtonLabel;
  delete o.discordModButtonLabel;
  delete o.discordModButtonUrl;
  return o;
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = { ...base };
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function loadConfig() {
  try {
    fs.mkdirSync(getConfigDir(), { recursive: true });
  } catch (_) {}
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const j = JSON.parse(raw);
      let cfg = deepMerge(DEFAULTS, j);
      if (cfg.preferredSource === 'browser') {
        cfg.preferredSource = 'auto';
      }
      if (!['auto', 'desktop'].includes(cfg.preferredSource)) {
        cfg.preferredSource = 'auto';
      }
      cfg = omitDiscordButtonCustomization(cfg);
      return cfg;
    }
  } catch (_) {}
  return { ...DEFAULTS, logging: { ...DEFAULTS.logging } };
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(getConfigDir(), { recursive: true });
    const toSave = omitDiscordButtonCustomization(cfg);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(toSave, null, 2), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  getConfigDir,
  CONFIG_PATH,
  DEFAULTS,
  loadConfig,
  saveConfig,
};
