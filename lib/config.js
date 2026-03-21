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
  /** Только десктопный клиент Windows (заголовок окна); веб-версия не используется. */
  preferredSource: 'desktop',
  desktopPollingEnabled: true,
  desktopPollIntervalMs: 2000,
  desktopBrowserPriorityMs: 8000,
  coverArtEnabled: true,
  /** Вторая кнопка (фиксированная ссылка в коде, не настраивается в UI) */
  discordShowModButton: true,
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
      if (cfg.preferredSource === 'browser' || cfg.preferredSource === 'auto') {
        cfg.preferredSource = 'desktop';
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
