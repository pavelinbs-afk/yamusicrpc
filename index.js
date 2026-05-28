#!/usr/bin/env node
'use strict';

/**
 * Программа для отображения в Discord статуса «Слушает … в Яндекс.Музыке».
 * Источник трека по умолчанию — десктопный клиент Windows (заголовок окна, см. scripts/read-yandex-desktop-title.ps1).
 * HTTP POST /track оставлен для совместимости; в сборке Electron веб-версия не используется.
 * Discord Application ID встроен (lib/discord-client-id.js), переопределение: DISCORD_RPC_CLIENT_ID.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { Client } = require('discord-rpc');
const { loadConfig, saveConfig, getConfigDir } = require('./lib/config');
const { createLogger } = require('./lib/logging');
const { resolveDiscordClientId, clientIdSource } = require('./lib/discord-client-id');

/** Заголовок окна нашего Electron-приложения не должен уходить в Discord как название трека. */
function isRpcAppWindowTitle(t) {
  if (!t || typeof t !== 'string') return false;
  const s = t.trim();
  return /^Yandex\s*Music\s*RPC$/i.test(s) || /^Яндекс\s*Музыка\s*RPC$/i.test(s);
}

/** Discord ограничивает поля по длине; режем по кодовым точкам, не посередине суррогатной пары. */
function discordClampText(s, maxChars = 128) {
  if (s == null || s === '') return '';
  const chars = Array.from(String(s));
  return chars.length <= maxChars ? chars.join('') : chars.slice(0, maxChars).join('');
}

/** Число из JSON (PowerShell ConvertTo-Json иногда отдаёт строку). */
function parseFiniteNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Заголовок окна на экране без трека: слоган, только бренд и т.п. — не Rich Presence. */
function isYandexAppMarketingTitle(title, artist, album) {
  const t = (title || '').trim();
  const a = (artist || '').trim();
  const al = (album || '').trim();
  const blob = `${t}\n${a}\n${al}`;
  if (/собираем\s+музыку|музыку\s+для\s+вас/i.test(blob)) return true;
  if (/^яндекс[.\u00A0\s]*музыка$/i.test(t) || /^яндекс[.\u00A0\s]*музыка$/i.test(a)) return true;
  if (/^яндекс\.музыка$/i.test(t) || /^яндекс\.музыка$/i.test(a) || /^яндекс\.музыка$/i.test(al)) return true;
  if (/^yandex\s*music$/i.test(t) || /^yandex\s*music$/i.test(a)) return true;
  return false;
}


const DISCORD_FIXED_TRACK_BTN_LABEL = '🎵 Открыть трек';
const DISCORD_FIXED_MOD_BTN_LABEL = '💻 Яндекс Музыка Мод';
const DISCORD_FIXED_MOD_BTN_URL = 'https://github.com/pavelinbs-afk/yamusicrpc';

const HTTP_PORT = 8765;
const CLOCK_SYNC_URL = 'https://worldtimeapi.org/api/timezone/Etc/UTC'; 
const CLOCK_SYNC_INTERVAL_MS = 5 * 60 * 1000; // сверка часов раз в 5 минут
/** Нет входящих обновлений трека (приложение закрыто и т.п.) — сброс статуса */
const IDLE_CLEAR_MS = 5 * 60 * 1000;
/** Пауза: один раз при входе в паузу; не сбрасывать при каждом тике поллера */
const PAUSED_CLEAR_MS = 5 * 60 * 1000;
// Частые updatePresence могут приводить к очистке/залипанию RPC (discord-api-docs#668), поэтому
// обычный playing-апдейт шлём редко: прогресс-бар анимируется на стороне Discord сам.
const DISCORD_UPDATE_INTERVAL_MS = 900;
// В paused-состоянии не нужно спамить одинаковым payload на каждом тике поллера.
const DISCORD_PAUSED_UPDATE_INTERVAL_MS = 15000;
/** Если Discord не отвечает на SET_ACTIVITY, иначе Promise висит навсегда и вся очередь RPC замирает. */
const RPC_WRITE_TIMEOUT_MS = 15000;

let rpc = null;
let idleTimer = null;
let pausedClearTimer = null;
/** Последовательная очередь записей в Discord RPC (защита от гонок set/clear при частых POST). */
let rpcWriteChain = Promise.resolve();
let currentTrackKey = null;
let currentTrackStart = null;
let currentTrackDurationSec = null; // фиксируем длительность трека один раз при старте
let lastSentTrackKey = null;
let lastSentButtonUrl = null;
let lastDiscordActivityAt = 0;
let hasLoggedFirstMsg = false;
/** Разница локальных часов и UTC в мс: localNow - realUtc. Коррекция таймштампов для Discord. */
let clockOffsetMs = 0;
/** Какой presence должен быть активен после реконнекта Discord RPC. */
let desiredPresence = { kind: 'clear', track: null };
let rpcTimeoutRecoveryInProgress = false;
/** Для таймстампов Rich Presence: сбой worldtimeapi не должен уводить start/end на часы. */
function clampedDiscordClockOffsetMs() {
  if (!Number.isFinite(clockOffsetMs)) return 0;
  const lim = 120000;
  if (clockOffsetMs > lim) return lim;
  if (clockOffsetMs < -lim) return -lim;
  return clockOffsetMs;
}
let suppressUntilMs = 0;
let discordReconnectInProgress = false;
/** Для корректного выхода при встраивании в Electron (без второго процесса). */
let rpcShutdownStarted = false;
let lastBrowserPostAt = 0;
let lastDesktopTrackKey = null;
/** GSMTC часто отдаёт «залипшую» позицию; для сглаживания таймера */
let lastGsmtcRawPosSec = null;
let lastGsmtcPollWallMs = null;
let gsmtcPosStableSinceMs = null;
/** Кандидат на loop/repeat: подтверждаем только если сырой pos начинает стабильно расти. */
let pendingLoopRestartRawSec = null;
let pendingLoopRestartAtMs = null;
/** Для полоски RPC в окне Electron */
let lastNowPlaying = { title: '', artist: '' };
/** Уже отправили в Discord режим «конец трека» без таймстампов (чтобы не блокировало DISCORD_UPDATE_INTERVAL_MS). */
let lastDiscordTimelineAtEnd = false;
/** После авто-сброса паузы блокируем повторный paused для этого же трека до resume/смены трека. */
let pausedClearBlockedTrackKey = null;
/** Последнее наблюдаемое положение таймлайна для детекта нового цикла repeat при том же key. */
let lastObservedTimelineKey = null;
let lastObservedElapsedSec = null;

const LOG_DIR = path.join(__dirname, 'logs');
const LOG_PATH = path.join(LOG_DIR, 'discord-rpc.log');
const ERR_LOG_PATH = path.join(LOG_DIR, 'discord-rpc.err.log');
const SERVER_LOCK_PATH = path.join(LOG_DIR, 'server.lock');
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (_) {}

let runtimeConfig = loadConfig();
const loggerApi = createLogger({ logPath: LOG_PATH, errLogPath: ERR_LOG_PATH });
function log(...args) {
  loggerApi.log(runtimeConfig, ...args);
}
function logErr(...args) {
  loggerApi.logErr(runtimeConfig, ...args);
}
function getMemoryLogSnapshot() {
  return loggerApi.getMemoryLines();
}
function reloadRuntimeConfig() {
  runtimeConfig = loadConfig();
}

function isProcessAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    // On Windows, process.kill(pid, 0) works as existence check.
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

const CLIENT_ID = resolveDiscordClientId();

function isPortListening(port, host = '127.0.0.1', timeoutMs = 250) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(timeoutMs, () => {
      try { socket.destroy(); } catch {}
      resolve(false);
    });
  });
}

async function checkDiscordIpcPipes(maxId = 10) {
  if (process.platform !== 'win32') return;
  const found = [];
  for (let id = 0; id <= maxId; id++) {
    const pipePath = `\\\\?\\pipe\\discord-ipc-${id}`;
    // Try to connect very briefly; if the pipe doesn't exist, it will error.
    /* eslint-disable no-await-in-loop */
    const ok = await new Promise((resolve) => {
      const sock = net.createConnection(pipePath);
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        try { sock.destroy(); } catch (_) {}
        resolve(v);
      };
      sock.once('connect', () => finish(true));
      sock.once('error', () => finish(false));
      sock.setTimeout(250, () => finish(false));
    });
    if (ok) found.push(id);
  }
  if (found.length) {
    log('IPC check: found discord-ipc pipes for ids:', found.join(','));
  } else {
    logErr('WARN: IPC check: discord-ipc pipes not found (discord-rpc ipc transport will fail).');
  }
}

async function tryAcquireServerLock() {
  try {
    // Внутри Electron уже есть single-instance; не даём «чужому» server.lock
    // прервать main() до runHttpServer() — иначе порт 8765 не поднимается и UI пустой.
    if (process.env.RPC_EMBEDDED_IN_ELECTRON === '1') {
      try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
      } catch (_) {}
      fs.writeFileSync(SERVER_LOCK_PATH, String(process.pid), 'utf8');
      process.on('exit', () => {
        try {
          const raw = fs.readFileSync(SERVER_LOCK_PATH, 'utf8').trim();
          if (Number(raw) === process.pid) fs.unlinkSync(SERVER_LOCK_PATH);
        } catch (_) {}
      });
      return true;
    }

    let existingPid = null;
    if (fs.existsSync(SERVER_LOCK_PATH)) {
      const raw = fs.readFileSync(SERVER_LOCK_PATH, 'utf8').trim();
      const pid = Number(raw);
      existingPid = Number.isFinite(pid) ? pid : null;
      if (existingPid && isProcessAlive(existingPid)) {
        const listening = await isPortListening(HTTP_PORT);
        if (listening) {
          log('server.lock: another instance seems alive (pid=', existingPid, '), exiting.');
          process.exit(0);
        }
        log('server.lock: pid is alive but port is closed -> stale lock, overwriting.', { pid: existingPid });
      }
    }

    fs.writeFileSync(SERVER_LOCK_PATH, String(process.pid), 'utf8');
    process.on('exit', () => {
      try {
        const raw = fs.readFileSync(SERVER_LOCK_PATH, 'utf8').trim();
        if (Number(raw) === process.pid) fs.unlinkSync(SERVER_LOCK_PATH);
      } catch (_) {}
    });
    return true;
  } catch (_) {
    return true;
  }
}

function rotateLogFile(filePath, kind) {
  try {
    if (!fs.existsSync(filePath)) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dst = `${filePath}.${kind}.bak.${ts}`;
    fs.renameSync(filePath, dst);
  } catch (_) {}
}

function formatLocalTimestampCompact(d = new Date()) {
  const pad2 = (n) => String(n).padStart(2, '0');
  const yyyy = d.getFullYear();
  const MM = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const HH = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  return `${yyyy}${MM}${dd}_${HH}${mm}${ss}`;
}

function cleanupLogSet(keepLatest, matcher) {
  try {
    const entries = fs.readdirSync(LOG_DIR)
      .filter((f) => matcher(f))
      .map((f) => {
        try {
          return { file: f, mtimeMs: fs.statSync(path.join(LOG_DIR, f)).mtimeMs };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    if (entries.length <= keepLatest) return;
    const toRemove = entries.slice(keepLatest);
    for (const e of toRemove) {
      try { fs.unlinkSync(path.join(LOG_DIR, e.file)); } catch (_) {}
    }
  } catch (_) {}
}

function archiveAndCleanupLogsOnExit(keepLatest = 15) {
  // Avoid re-archiving on multiple exit listeners.
  if (archiveAndCleanupLogsOnExit._didRun) return;
  archiveAndCleanupLogsOnExit._didRun = true;

  try {
    // Move current logs away so next startup won't create `.utf8.bak.*` for them.
    const ts = formatLocalTimestampCompact();
    if (fs.existsSync(LOG_PATH)) {
      const dst = path.join(LOG_DIR, `discord-rpc_exit_${ts}.log`);
      try { fs.renameSync(LOG_PATH, dst); } catch (_) {}
    }
    if (fs.existsSync(ERR_LOG_PATH)) {
      const dst2 = path.join(LOG_DIR, `discord-rpc_exit_${ts}.err.log`);
      try { fs.renameSync(ERR_LOG_PATH, dst2); } catch (_) {}
    }
  } catch (_) {}

  // Clean old archives/backups (keeps `logs/` directory size under control).
  try {
    cleanupLogSet(keepLatest, (f) => f.startsWith('discord-rpc_exit_') && f.endsWith('.log') && !f.endsWith('.err.log'));
    cleanupLogSet(keepLatest, (f) => f.startsWith('discord-rpc_exit_') && f.endsWith('.err.log'));
    cleanupLogSet(keepLatest, (f) => f.startsWith('discord-rpc.log.utf8.bak.'));
    cleanupLogSet(keepLatest, (f) => f.startsWith('discord-rpc.err.log.utf8.bak.'));
  } catch (_) {}
}

function initLogFilesIfNeeded() {
  const mode = runtimeConfig.logging && runtimeConfig.logging.mode;
  if (mode !== 'file' && mode !== 'both') return;
  try {
    rotateLogFile(LOG_PATH, 'utf8');
    rotateLogFile(ERR_LOG_PATH, 'utf8');
  } catch (_) {}
  try {
    const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
    fs.writeFileSync(LOG_PATH, bom, { encoding: 'utf8' });
    fs.writeFileSync(ERR_LOG_PATH, bom, { encoding: 'utf8' });
  } catch (_) {}
}

process.on('exit', () => {
  try { archiveAndCleanupLogsOnExit(15); } catch {}
});

process.on('uncaughtException', (err) => {
  logErr('uncaughtException', err && err.stack ? err.stack : String(err));
});
process.on('unhandledRejection', (reason) => {
  logErr('unhandledRejection', reason && reason.stack ? reason.stack : String(reason));
});

function clearIdleTimerOnly() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function clearPausedClearTimerOnly() {
  if (pausedClearTimer) {
    clearTimeout(pausedClearTimer);
    pausedClearTimer = null;
  }
}

function clearAllPresenceTimers() {
  clearIdleTimerOnly();
  clearPausedClearTimerOnly();
}

function resetTrackSessionState() {
  currentTrackKey = null;
  currentTrackStart = null;
  currentTrackDurationSec = null;
  lastGsmtcRawPosSec = null;
  lastGsmtcPollWallMs = null;
  gsmtcPosStableSinceMs = null;
  pendingLoopRestartRawSec = null;
  pendingLoopRestartAtMs = null;
  lastSentTrackKey = null;
  lastSentButtonUrl = null;
  lastDiscordActivityAt = 0;
  lastNowPlaying = { title: '', artist: '' };
  lastDiscordTimelineAtEnd = false;
  lastObservedTimelineKey = null;
  lastObservedElapsedSec = null;
}

async function clearActivityAndResetTrackSession(opts = {}) {
  try {
    await clearActivity(opts);
  } catch (_) {}
  resetTrackSessionState();
}

/** Таймаут «нет входящих /track с воспроизведением» — не привязывать к setActivity, иначе сброс никогда не наступит при залипшем треке. */
function schedulePlayingIdleFromHttp() {
  clearIdleTimerOnly();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    (async () => {
      try {
        await clearActivityAndResetTrackSession({ silent: false });
        log('Статус сброшен: нет данных о треке (воспроизведение) дольше', Math.round(IDLE_CLEAR_MS / 60000), 'мин.');
      } catch (_) {}
    })();
  }, IDLE_CLEAR_MS);
}

function schedulePausedClear() {
  const blockedKey = currentTrackKey || null;
  clearAllPresenceTimers();
  pausedClearTimer = setTimeout(() => {
    pausedClearTimer = null;
    (async () => {
      try {
        await clearActivityAndResetTrackSession({ silent: false });
        pausedClearBlockedTrackKey = blockedKey;
        log('Статус сброшен: пауза без возобновления дольше', Math.round(PAUSED_CLEAR_MS / 60000), 'мин.');
      } catch (_) {}
    })();
  }, PAUSED_CLEAR_MS);
}

/** Получает поправку к системным часам (NTP/UTC), чтобы тайм-бар в Discord совпадал у всех. */
function fetchClockOffset() {
  const before = Date.now();
  const req = https.get(CLOCK_SYNC_URL, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      try {
        const j = JSON.parse(data);
        const unixSec = j && typeof j.unixtime === 'number' ? j.unixtime : null;
        if (unixSec == null) return;
        const realUtcMs = unixSec * 1000;
        const after = Date.now();
        const rtt = after - before;
        const localAtMid = before + rtt / 2;
        const newOffset = localAtMid - realUtcMs;
        if (Number.isFinite(newOffset)) {
          clockOffsetMs = newOffset;
          const sec = (clockOffsetMs / 1000).toFixed(1);
          log('Часы: поправка', clockOffsetMs >= 0 ? `+${sec}` : sec, 'сек (относительно UTC)');
        }
      } catch (_) {}
    });
  });
  req.on('error', () => {});
  req.setTimeout(5000, () => { req.destroy(); });
}

function formatTime(sec) {
  if (sec == null || !Number.isFinite(sec)) return null;
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}:${rs.toString().padStart(2, '0')}`;
}

function runSerializedRpcWrite(task) {
  const gated = async () => {
    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error('RPC_WRITE_TIMEOUT')), RPC_WRITE_TIMEOUT_MS);
      if (timer.unref) timer.unref();
    });
    try {
      return await Promise.race([Promise.resolve().then(task), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const next = rpcWriteChain.then(gated, gated);
  rpcWriteChain = next.catch((e) => {
    if (e && e.message === 'RPC_WRITE_TIMEOUT') {
      logErr(
        'Discord RPC: таймаут записи',
        RPC_WRITE_TIMEOUT_MS,
        'мс — запускаю переподключение RPC и восстановление статуса.',
      );
      forceRpcReconnectFromTimeout();
    }
    return undefined;
  });
  return next;
}

function forceRpcReconnectFromTimeout() {
  if (rpcTimeoutRecoveryInProgress || rpcShutdownStarted) return;
  rpcTimeoutRecoveryInProgress = true;
  try {
    const oldRpc = rpc;
    rpc = null;
    if (oldRpc) {
      try { oldRpc.destroy(); } catch (_) {}
    }
    // Если предыдущий write завис, очередь уже сломана — начинаем чистую цепочку.
    rpcWriteChain = Promise.resolve();
    startDiscordReconnectLoop();
  } finally {
    setTimeout(() => { rpcTimeoutRecoveryInProgress = false; }, 2500);
  }
}

function normalizeTrackUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const u = rawUrl.trim();
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('//')) return `https:${u}`;
  if (u.startsWith('/')) return `https://music.yandex.ru${u}`;
  if (/^music\.yandex\.ru\//i.test(u)) return `https://${u}`;
  return `https://music.yandex.ru/${u.replace(/^\/+/, '')}`;
}

function isAllowedCoverUrl(u) {
  if (!u || typeof u !== 'string') return false;
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return (
      host.endsWith('yandex.ru') ||
      host.endsWith('yandex.net') ||
      host.endsWith('yandex.com') ||
      host.endsWith('yandex.by') ||
      host.endsWith('yandex.kz') ||
      host.endsWith('dzcdn.net')       // Deezer CDN
    );
  } catch (_) {
    return false;
  }
}

/** Хранилище сессионных кук для Яндекс.Музыки (один сессионный jar на все запросы) */
const yandexCookieJar = new Map();
let yandexSessionWarmedUp = false;

/** «Прогрев» сессии: заходим на главную Яндекс.Музыки, получаем куки */
function warmupYandexSession() {
  if (yandexSessionWarmedUp) return Promise.resolve();
  return httpsGetWithRedirects('https://music.yandex.ru/', {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9',
  }, 5).then(({ statusCode, data }) => {
    yandexSessionWarmedUp = true;
    log('DEBUG yandex session warmup:', statusCode, 'bodyLen:', data.length);
    // Если ответ не капча — сессия установлена успешно
    if (!data.includes('showcaptcha') && !data.includes('Вы не робот')) {
      log('DEBUG yandex session warmup OK');
    } else {
      log('DEBUG yandex session warmup got captcha, will retry later');
      yandexSessionWarmedUp = false;
    }
  }).catch((e) => {
    log('DEBUG yandex session warmup error:', e.message);
    yandexSessionWarmedUp = false;
  });
}

/**
 * HTTPS GET с автоматическим следованием редиректам (до maxRedirects) и сбором кук.
 * Возвращает Promise<{ statusCode, data, finalUrl }>.
 */
function httpsGetWithRedirects(url, headers, maxRedirects) {
  const max = maxRedirects || 5;
  return new Promise((resolve, reject) => {
    // Собираем куки в заголовок Cookie
    const cookieHeader = Array.from(yandexCookieJar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    const reqHeaders = { ...headers };
    if (cookieHeader) reqHeaders['Cookie'] = cookieHeader;

    let settled = false;
    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    function doRequest(currentUrl, redirectsLeft) {
      const req = https.get(currentUrl, { headers: reqHeaders }, (res) => {
        // Сохраняем куки из ответа
        const setCookie = res.headers['set-cookie'];
        if (setCookie && Array.isArray(setCookie)) {
          for (const c of setCookie) {
            const parts = c.split(';')[0].split('=');
            if (parts.length === 2) {
              const key = parts[0].trim();
              const val = parts[1].trim();
              if (!['Domain', 'Path', 'Expires', 'Max-Age', 'Secure', 'HttpOnly', 'SameSite'].includes(key)) {
                yandexCookieJar.set(key, val);
              }
            }
          }
        }

        // Редирект?
        if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && redirectsLeft > 0) {
          const loc = res.headers.location;
          if (loc) {
            // Коротко дренируем тело ответа
            res.resume();
            // Строим абсолютный URL если location относительный
            let nextUrl = loc;
            if (loc.startsWith('/')) {
              const u = new URL(currentUrl);
              nextUrl = `${u.protocol}//${u.host}${loc}`;
            } else if (!loc.startsWith('http')) {
              const u = new URL(currentUrl);
              nextUrl = `${u.protocol}//${u.host}/${loc}`;
            }
            return doRequest(nextUrl, redirectsLeft - 1);
          }
        }

        // Не редирект — собираем тело
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({ statusCode: res.statusCode, data, finalUrl: currentUrl });
        });
      });
      req.on('error', (e) => settleReject(e));
      req.setTimeout(8000, () => { req.destroy(); settleReject(new Error('timeout')); });
    }

    doRequest(url, max);
  });
}

/** Кеш обложек: key → { url, ts } */
const coverCache = new Map();
const COVER_CACHE_TTL_MS = 30 * 60 * 1000; // успешный результат — 30 минут
const COVER_CACHE_NULL_TTL_MS = 30 * 1000; // null — 30 сек (ретрай при временном фейле)

/** Дедупликация одновременных запросов обложек: key → Promise */
const pendingCoverFetches = new Map();

/** Установить URL в кеш (без перезаписи валидного url на null) */
function coverCacheSetSafe(cacheKey, url, ts) {
  if (url) {
    coverCache.set(cacheKey, { url, ts });
    return;
  }
  // Не перезаписываем валидный кеш null'ом
  const existing = coverCache.get(cacheKey);
  if (existing && existing.url && Date.now() - existing.ts < COVER_CACHE_TTL_MS) {
    return;
  }
  coverCache.set(cacheKey, { url: null, ts });
}

/**
 * Извлекает сбалансированный JSON-объект начиная с позиции startPos.
 * Отслеживает глубину скобок и состояние кавычек.
 */
function extractBalancedJson(str, startPos) {
  const openIdx = str.indexOf('{', startPos);
  if (openIdx === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = openIdx; i < str.length; i++) {
    const ch = str[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return str.slice(openIdx, i + 1);
    }
  }
  return null;
}

/**
 * Ищет coverUri во вложенных полях объекта (рекурсивно, но с ограничением глубины).
 * Возвращает первый найденный URI или null.
 */
function findCoverUriInJson(obj, maxDepth) {
  if (!obj || typeof obj !== 'object' || maxDepth <= 0) return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = findCoverUriInJson(item, maxDepth - 1);
      if (r) return r;
    }
    return null;
  }
  // Прямые поля
  const direct = obj.coverUri || obj.ogImage;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  // Вложенные альбомы
  if (obj.albums && Array.isArray(obj.albums) && obj.albums[0]) {
    const albumCover = obj.albums[0].coverUri || obj.albums[0].ogImage;
    if (typeof albumCover === 'string' && albumCover.trim()) return albumCover.trim();
  }
  // Обходим значения
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') {
      const r = findCoverUriInJson(val, maxDepth - 1);
      if (r) return r;
    }
  }
  return null;
}

function finishParse(raw, resolve, cacheKey) {
  try {
    let j;
    // Пробуем чистый JSON
    try {
      j = JSON.parse(raw);
    } catch (_) {
      // Стратегия 1: <script id="store-state" type="application/json">
      let m = raw.match(/<script[^>]*\bid\s*=\s*["']store-state["'][^>]*>([\s\S]*?)<\/script>/i)
           || raw.match(/<script[^>]*\btype\s*=\s*["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i);

      // Стратегия 2: window.__INITIAL_STATE__ = {...} — ищем сбалансированный JSON
      if (!m) {
        const initMatch = raw.match(/window\.__INITIAL_STATE__\s*=\s*/);
        if (initMatch) {
          const json = extractBalancedJson(raw, initMatch.index + initMatch[0].length);
          if (json) m = ['__init__', json];
        }
      }

      // Стратегия 3: data-state="..." — сбалансированный JSON
      if (!m) {
        const dsMatch = raw.match(/data-state\s*=\s*["']/i);
        if (dsMatch) {
          const json = extractBalancedJson(raw, dsMatch.index + dsMatch[0].length);
          if (json) m = ['__datastate__', json];
        }
      }

      // Стратегия 4: window.__PRELOADED_STATE__ = {...}
      if (!m) {
        const psMatch = raw.match(/window\.__PRELOADED_STATE__\s*=\s*/);
        if (psMatch) {
          const json = extractBalancedJson(raw, psMatch.index + psMatch[0].length);
          if (json) m = ['__preloaded__', json];
        }
      }

      if (m && m[1]) {
        try { j = JSON.parse(m[1].trim().replace(/&quot;/g, '"')); } catch (_2) {}
      }
    }

    if (j) {
      // Ищем coverUri в JSON — сначала items, потом рекурсивно во всём объекте
      let uri = null;
      const items = (j.tracks && j.tracks.items) || [];
      if (items.length > 0) {
        for (const item of items) {
          uri = item.coverUri
            || (item.albums && item.albums[0] && item.albums[0].coverUri)
            || item.ogImage;
          if (uri) break;
        }
      }
      if (!uri) {
        uri = findCoverUriInJson(j, 8);
      }
      if (uri) {
        const coverUrl = `https://${uri.replace(/^\/+/, '')}`;
        log('DEBUG cover FOUND:', { cacheKey, coverUrl });
        coverCacheSetSafe(cacheKey, coverUrl, Date.now());
        return resolve(coverUrl);
      }
      log('DEBUG cover: JSON parsed but no coverUri found', { cacheKey });
    }

    // Фолбек: ищем coverUri или og:image прямо в сыром HTML
    const htmlCoverMatch = raw.match(/coverUri["']?\s*:\s*["']([^"']+\.(?:jpg|png|jpeg|webp)[^"']*)/i)
      || raw.match(/["']coverUri["']\s*:\s*["']([^"']+)["']/i)
      || raw.match(/<meta\s+[^>]*property\s*=\s*["']og:image["'][^>]*content\s*=\s*["']([^"']+)["'][^>]*\/?>/i)
      || raw.match(/<meta\s+[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:image["'][^>]*\/?>/i);
    if (htmlCoverMatch && htmlCoverMatch[1]) {
      let coverUrl = htmlCoverMatch[1].trim();
      if (coverUrl.startsWith('//')) coverUrl = 'https:' + coverUrl;
      else if (!/^https?:\/\//i.test(coverUrl)) coverUrl = 'https://' + coverUrl.replace(/^\/+/, '');
      // Заменяем размер на 600x600 для единообразия
      coverUrl = coverUrl.replace(/\/\d+x\d+(?=\/|$)/, '/600x600');
      if (isAllowedCoverUrl(coverUrl)) {
        log('DEBUG cover from HTML fallback:', { cacheKey, coverUrl });
        coverCacheSetSafe(cacheKey, coverUrl, Date.now());
        return resolve(coverUrl);
      }
    }

    log('DEBUG cover parse FAIL:', { cacheKey, rawLen: raw.length, rawPrefix: raw.slice(0, 200) });
    coverCacheSetSafe(cacheKey, null, Date.now());
    resolve(null);
  } catch (_) {
    coverCacheSetSafe(cacheKey, null, Date.now());
    resolve(null);
  }
}

/**
 * Ищет обложку трека: Яндекс.Музыка и Deezer — одновременно (параллельно).
 * Яндекс — приоритетный источник; если он медленный / капча / ошибка — Deezer.
 * Возвращает HTTPS-URL или null.
 */
function fetchCoverFromYandexApi(title, artist) {
  const q = `${title} ${artist}`.trim();
  if (!q) return Promise.resolve(null);
  const cacheKey = q.toLowerCase();
  const cached = coverCache.get(cacheKey);
  if (cached) {
    const ttl = cached.url ? COVER_CACHE_TTL_MS : COVER_CACHE_NULL_TTL_MS;
    if (Date.now() - cached.ts < ttl) {
      return Promise.resolve(cached.url);
    }
  }

  // Дедупликация: если запрос для этого же cacheKey уже в процессе — ждём его
  const inFlight = pendingCoverFetches.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  // Прогреваем сессию Яндекса при первой возможности
  if (!yandexSessionWarmedUp) {
    warmupYandexSession();
  }

  const promise = (async () => {
    // Запускаем Яндекс и Deezer параллельно
    const yandexPromise = fetchCoverWithRetries(q, cacheKey, Date.now() + 20000);
    const deezerPromise = fetchCoverFromDeezerApi(title, artist, cacheKey);

    // Приоритет: Яндекс → Deezer.
    // Даём Яндексу фору (8 сек — хватит на 1-2 ретрая при капче).
    const YANDEX_PRIORITY_TIMEOUT_MS = 8000;

    const yandexWithTimeout = Promise.race([
      yandexPromise,
      new Promise((r) => {
        const t = setTimeout(() => r('__timeout__'), YANDEX_PRIORITY_TIMEOUT_MS);
        if (t.unref) t.unref();
      }),
    ]);

    const yandexResult = await yandexWithTimeout;

    if (yandexResult === '__timeout__') {
      // Яндекс не ответил за отведённое время (капча/медленный) — берём Deezer
      const deezerResult = await deezerPromise;
      if (deezerResult) {
        log('DEBUG cover: Yandex too slow, using Deezer for', cacheKey);
        // Яндекс продолжает искаться в фоне — если найдёт, обновим кеш для следующих запросов
        yandexPromise.then((url) => {
          if (url) {
            log('DEBUG cover: Yandex found later, updating cache for', cacheKey);
            coverCacheSetSafe(cacheKey, url, Date.now());
          }
        }).catch(() => {});
        return deezerResult;
      }
      // Deezer тоже не дал результат — ждём Яндекс до конца
      log('DEBUG cover: both slow, waiting for Yandex to finish for', cacheKey);
      const yandexLate = await yandexPromise;
      return yandexLate; // url или null
    }

    if (yandexResult) {
      // Яндекс нашёл обложку — лучший результат
      return yandexResult;
    }

    // Яндекс вернул null (не нашёл) — пробуем Deezer
    log('DEBUG cover: Yandex returned null, trying Deezer for', cacheKey);
    const deezerResult = await deezerPromise;
    return deezerResult;
  })().finally(() => {
    pendingCoverFetches.delete(cacheKey);
  });
  pendingCoverFetches.set(cacheKey, promise);
  return promise;
}

/** Фолбек: поиск обложки через публичное API Deezer */
function fetchCoverFromDeezerApi(title, artist, cacheKey) {
  const q = encodeURIComponent(`${title} ${artist}`.trim());
  const url = `https://api.deezer.com/search?q=${q}&limit=1`;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const req = https.get(url, {
      headers: { 'User-Agent': 'YandexMusicRPC/2.0' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          log('DEBUG deezer API status:', res.statusCode);
          coverCacheSetSafe(cacheKey, null, Date.now());
          finish(null);
          return;
        }
        try {
          const j = JSON.parse(data);
          const track = j.data && j.data[0];
          const coverUrl = track && track.album && track.album.cover_big;
          if (coverUrl && /^https?:\/\//i.test(coverUrl)) {
            log('DEBUG cover from Deezer:', { cacheKey, coverUrl });
            coverCacheSetSafe(cacheKey, coverUrl, Date.now());
            finish(coverUrl);
          } else {
            log('DEBUG deezer: no cover in response for', cacheKey);
            coverCacheSetSafe(cacheKey, null, Date.now());
            finish(null);
          }
        } catch (_) {
          log('DEBUG deezer parse error for', cacheKey);
          coverCacheSetSafe(cacheKey, null, Date.now());
          finish(null);
        }
      });
    });
    req.on('error', (e) => {
      log('DEBUG deezer API error:', e.message);
      coverCacheSetSafe(cacheKey, null, Date.now());
      finish(null);
    });
    req.setTimeout(5000, () => {
      req.destroy();
      log('DEBUG deezer API timeout for', cacheKey);
      coverCacheSetSafe(cacheKey, null, Date.now());
      finish(null);
    });
  });
}

/** Пытаемся достать обложку из поисковой страницы. Повторяем каждые 5 сек, пока не истечёт deadline (20 сек от старта трека). */
function fetchCoverWithRetries(q, cacheKey, deadline, attemptNum) {
  const attempt = attemptNum || 0;
  const searchUrl = `https://music.yandex.ru/search?text=${encodeURIComponent(q)}`;
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) YandexMusicRPC/2.0' };

  return new Promise((resolve) => {
    httpsGetWithRedirects(searchUrl, headers, 5)
      .then(({ statusCode, data }) => {
        if (attempt === 0) {
          log('DEBUG cover search page #0 status:', statusCode, 'bodyLen:', data.length, 'prefix:', data.slice(0, 300));
        }

        // Проверяем не капча ли
        if (data.includes('showcaptcha') || data.includes('captcha')) {
          if (Date.now() < deadline) {
            const left = Math.round((deadline - Date.now()) / 1000);
            log('DEBUG cover retry (captcha):', { cacheKey, secLeft: left, status: statusCode });
            setTimeout(() => fetchCoverWithRetries(q, cacheKey, deadline, attempt + 1).then(resolve), 5000);
          } else {
            log('DEBUG cover: deadline expired (captcha loop), trying API for', cacheKey);
            tryApiSearch(q, cacheKey, resolve);
          }
          return;
        }

        // Ищем URL обложки в HTML
        let m = data.match(/avatars\.(?:yandex\.net|yandex\.ru|mds\.yandex\.net)\/get-music-content\/[^\s"'><]+/i);
        if (!m) {
          m = data.match(/<meta\s+[^>]*property\s*=\s*["']og:image["'][^>]*content\s*=\s*["']([^"']+)["'][^>]*\/?>/i)
           || data.match(/<meta\s+[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:image["'][^>]*\/?>/i);
        }
        if (!m) {
          m = data.match(/https?:\/\/avatars\.(?:yandex\.net|yandex\.ru)\/[^\s"'><]+/i);
        }

        if (m) {
          let coverUrl;
          if (m[1] !== undefined) {
            coverUrl = m[1].trim();
          } else {
            coverUrl = m[0].replace(/[,;]+$/, '');
          }
          if (!/^https?:\/\//i.test(coverUrl)) coverUrl = 'https://' + coverUrl.replace(/^\/+/, '');
          coverUrl = coverUrl.replace(/\/\d+x\d+(?=\/|$)/, '/600x600');
          if (isAllowedCoverUrl(coverUrl)) {
            log('DEBUG cover from search page:', { cacheKey, coverUrl });
            coverCacheSetSafe(cacheKey, coverUrl, Date.now());
            return resolve(coverUrl);
          }
        }

        if (Date.now() < deadline) {
          const left = Math.round((deadline - Date.now()) / 1000);
          log('DEBUG cover retry:', { cacheKey, secLeft: left, status: statusCode });
          setTimeout(() => fetchCoverWithRetries(q, cacheKey, deadline, attempt + 1).then(resolve), 5000);
        } else {
          log('DEBUG cover: deadline expired, trying API for', cacheKey);
          tryApiSearch(q, cacheKey, resolve);
        }
      })
      .catch((e) => {
        log('DEBUG cover search error:', e.message);
        if (Date.now() < deadline) {
          setTimeout(() => fetchCoverWithRetries(q, cacheKey, deadline, attempt + 1).then(resolve), 5000);
        } else {
          tryApiSearch(q, cacheKey, resolve);
        }
      });
  });
}

function tryApiSearch(q, cacheKey, resolve) {
  const apiUrl = `https://music.yandex.ru/handlers/music-search.jsx?text=${encodeURIComponent(q)}&type=track&page=0`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) YandexMusicRPC/2.0',
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://music.yandex.ru/search',
    'Accept-Language': 'ru-RU,ru;q=0.9',
  };

  httpsGetWithRedirects(apiUrl, headers, 3)
    .then(({ statusCode, data }) => {
      if (statusCode === 200 && data.length > 100) {
        finishParse(data, (result) => {
          if (result) {
            resolve(result);
          } else {
            log('DEBUG cover: .jsx parsed but no coverUri, bodyLen:', data.length);
            tryDirectTrackPage(q, cacheKey, resolve);
          }
        }, cacheKey);
      } else {
        log('DEBUG cover: .jsx API status', statusCode, 'bodyLen:', data.length);
        tryDirectTrackPage(q, cacheKey, resolve);
      }
    })
    .catch((e) => {
      log('DEBUG cover: .jsx API error:', e.message);
      tryDirectTrackPage(q, cacheKey, resolve);
    });
}

/** Прямой запрос страницы поиска для извлечения обложек из HTML */
function tryDirectTrackPage(q, cacheKey, resolve) {
  const searchUrl = `https://music.yandex.ru/search?text=${encodeURIComponent(q)}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) YandexMusicRPC/2.0',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9',
  };

  httpsGetWithRedirects(searchUrl, headers, 3)
    .then(({ statusCode, data }) => {
      log('DEBUG cover: direct search page status', statusCode, 'bodyLen:', data.length);
      if (statusCode === 200 && data.length > 200) {
        finishParse(data, resolve, cacheKey);
      } else {
        log('DEBUG cover: all strategies exhausted for', cacheKey, '(status:', statusCode, 'bodyLen:', data.length, ')');
        coverCacheSetSafe(cacheKey, null, Date.now());
        resolve(null);
      }
    })
    .catch((e) => {
      log('DEBUG cover: all strategies exhausted for', cacheKey, '(error:', e.message, ')');
      coverCacheSetSafe(cacheKey, null, Date.now());
      resolve(null);
    });
}

function pickLargeImage(track) {
  const cover = track && track.coverUrl;
  if (runtimeConfig.coverArtEnabled && cover && isAllowedCoverUrl(cover)) {
    const junk = isYandexAppMarketingTitle(track.title, track.artist, track.album);
    const text = discordClampText(
      junk ? 'Яндекс.Музыка' : (track.album || track.title || 'Яндекс.Музыка'),
      128,
    );
    return { key: cover.slice(0, 512), text };
  }
  if (cover) {
    log('DEBUG cover rejected:', { coverArtEnabled: runtimeConfig.coverArtEnabled, coverLen: cover.length, coverPrefix: cover.slice(0, 80) });
  }
  return { key: 'yandex_music_icon', text: 'Яндекс.Музыка' };
}

function applyDiscordButtonsToPayload(payload, trackUrl) {
  if (!trackUrl) return;
  const cfg = runtimeConfig;
  const label1 = DISCORD_FIXED_TRACK_BTN_LABEL.slice(0, 32);
  const buttons = [{ label: label1, url: trackUrl }];
  if (cfg.discordShowModButton !== false) {
    const l2 = DISCORD_FIXED_MOD_BTN_LABEL.slice(0, 32);
    const u2 = DISCORD_FIXED_MOD_BTN_URL.trim();
    if (u2 && /^https?:\/\//i.test(u2)) {
      buttons.push({ label: l2, url: u2 });
    }
  }
  payload.buttons = buttons;
  payload.button1_label = buttons[0].label;
  payload.button1_url = buttons[0].url;
  if (buttons[1]) {
    payload.button2_label = buttons[1].label;
    payload.button2_url = buttons[1].url;
  }
}

/**
 * Таймстампы для Discord Listening (type=2): нужна пара start/end (см. discord-rpc #227, Lachee).
 *
 * Два режима: (1) стабильные start/end с сервера (`discordStartMs` / `discordEndMs` = сессия трека) —
 * Discord интерполирует полоску между вызовами setActivity; постоянно пересчитывать start от
 * `Date.now() − position` на каждом тике даёт «дёрганую» привязку и в ряде клиентов — залипание UI.
 * (2) Если end уже в прошлом или якорь не сходится с позицией (repeat/баги) — fallback:
 * `start = now − position`, `end = start + duration` с поджатием конца в будущее.
 */
function computeDiscordListeningTimestamps(elapsedSec, durationSec, nowMs, offsetMs) {
  if (
    !Number.isFinite(durationSec) ||
    durationSec < 0.5 ||
    !Number.isFinite(elapsedSec) ||
    !Number.isFinite(nowMs) ||
    !Number.isFinite(offsetMs)
  ) {
    return { startAdjusted: null, endAdjusted: null };
  }
  const durMs = Math.max(durationSec * 1000, 2000);
  const posMs = Math.min(Math.max(0, elapsedSec * 1000), durMs);
  const startLocal = nowMs - posMs;
  const endLocal = startLocal + durMs;
  const startAdjusted = startLocal - offsetMs;
  const endAdjusted = endLocal - offsetMs;
  if (!Number.isFinite(startAdjusted) || !Number.isFinite(endAdjusted)) {
    return { startAdjusted: null, endAdjusted: null };
  }
  if (endAdjusted - startAdjusted < 1500) {
    return { startAdjusted: null, endAdjusted: null };
  }
  return { startAdjusted, endAdjusted };
}

function resolveDiscordListeningTimestamps(track, elapsedSec, totalSec, nowMs, offsetMs) {
  const s = track && track.discordStartMs;
  const e = track && track.discordEndMs;
  if (
    typeof s === 'number' &&
    typeof e === 'number' &&
    Number.isFinite(s) &&
    Number.isFinite(e) &&
    Number.isFinite(offsetMs) &&
    Number.isFinite(elapsedSec) &&
    Number.isFinite(nowMs)
  ) {
    const durMs = e - s;
    const startAdjusted = s - offsetMs;
    const endAdjusted = e - offsetMs;
    const nowAdj = nowMs - offsetMs;
    if (durMs >= 1500 && endAdjusted > nowAdj + 400) {
      const elapsedFromAnchorSec = (nowMs - s) / 1000;
      const impliedStart = nowMs - elapsedSec * 1000;
      /*
       * Якорь currentTrackStart после repeat/багов GSMTC может жить своей жизнью: end ещё в будущем,
       * но позиция из источника уже не совпадает с (now − start). Тогда сессионные timestamps
       * «замораживают» полоску в Discord — сбрасываем на пересчёт от now+position.
       */
      if (
        Math.abs(elapsedFromAnchorSec - elapsedSec) <= 3.25 &&
        Math.abs(s - impliedStart) < 8000
      ) {
        return { startAdjusted, endAdjusted };
      }
    }
  }
  return computeDiscordListeningTimestamps(elapsedSec, totalSec, nowMs, offsetMs);
}

async function setActivity(track) {
  if (!rpc || !runtimeConfig.rpcEnabled) return;
  desiredPresence = { kind: 'playing', track: { ...track } };
  const { title = '', artist = '', album = '', url: trackUrl, positionSec, durationSec } = track;

  const p = typeof positionSec === 'number' && Number.isFinite(positionSec) ? Math.max(0, positionSec) : 0;
  const d = typeof durationSec === 'number' && Number.isFinite(durationSec) ? Math.max(0, durationSec) : 0;
  const elapsedSec = d > 0 ? Math.min(p, d) : p;
  const totalSec = d > 0 ? d : Math.max(p, d);

  const posStr = formatTime(elapsedSec);
  const durStr = totalSec > 0 ? formatTime(totalSec) : null;
  const timePart = posStr && durStr ? `${posStr}/${durStr}` : posStr || '';
  const details = discordClampText(title || 'Яндекс.Музыка', 128);
  const stateBase = [artist || '', album || ''].filter(Boolean).join(' — ');
  const state = stateBase ? discordClampText(stateBase, 128) : undefined;
  const img = pickLargeImage(track);
  try {
    const now = Date.now();
    const off = clampedDiscordClockOffsetMs();
    const { startAdjusted, endAdjusted } = resolveDiscordListeningTimestamps(
      track,
      elapsedSec,
      totalSec,
      now,
      off,
    );
    const hasValidEnd = startAdjusted != null && endAdjusted != null;
    const payload = {
      details,
      state,
      // Listening (type=2) — чаще всего показывает тайм‑бар/прогресс,
      // в отличие от "Playing" (type=0), который может показывать countdown.
      type: 2,
      startTimestamp: hasValidEnd ? new Date(startAdjusted) : undefined,
      endTimestamp: hasValidEnd ? new Date(endAdjusted) : undefined,
      largeImageKey: img.key,
      largeImageText: img.text,
    };
    if (!hasValidEnd) {
      log('DEBUG skip timestamps: нет валидной пары start/end для Discord');
    }
    if (trackUrl) {
      applyDiscordButtonsToPayload(payload, trackUrl);
      if (trackUrl !== lastSentButtonUrl) {
        log('Кнопка в Discord:', trackUrl);
        lastSentButtonUrl = trackUrl;
      }
    }
    await runSerializedRpcWrite(() => rpc.setActivity(payload));
    log('Статус обновлён в Discord', `(${timePart || '—'})`, '(тайм-бар = трек, start/end)');
  } catch (e) {
    log('Ошибка setActivity:', e.message);
  }
}

async function setPausedActivity(track) {
  if (!rpc || !runtimeConfig.rpcEnabled) return;
  desiredPresence = { kind: 'paused', track: { ...track } };
  const { title = '', artist = '', positionSec, durationSec, url: trackUrl } = track;
  const mainLine = [title || '', artist || ''].filter(Boolean).join(' — ');
  const stateText = discordClampText(mainLine || 'Яндекс.Музыка', 128);
  try {
    const img = pickLargeImage(track);
    const payload = {
      details: 'Приостановлено в Яндекс Музыке',
      state: stateText,
      type: 2,
      largeImageKey: img.key,
      largeImageText: img.text,
    };
    if (trackUrl) {
      applyDiscordButtonsToPayload(payload, trackUrl);
      if (trackUrl !== lastSentButtonUrl) {
        log('Кнопка в Discord:', trackUrl);
        lastSentButtonUrl = trackUrl;
      }
    }
    await runSerializedRpcWrite(() => rpc.setActivity(payload));
    log('Статус обновлён в Discord (пауза)', stateText || '—');
  } catch (e) {
    log('Ошибка setActivity (пауза):', e.message);
  }
  // Не вызывать setIdleTimer здесь: поллер шлёт паузу каждые ~2 с — таймер бы сбрасывался бесконечно.
}

async function clearActivity(opts = {}) {
  desiredPresence = { kind: 'clear', track: null };
  if (!rpc) return;
  const silent = opts && opts.silent === true;
  try {
    await runSerializedRpcWrite(() => rpc.clearActivity());
    if (!silent) log('Статус сброшен.');
    lastSentButtonUrl = null;
  } catch (e) {
    logErr('clearActivity error', e && e.message ? e.message : String(e));
    log('Ошибка clearActivity:', e.message);
  }
}

async function restoreDesiredPresenceAfterReconnect() {
  if (!rpc || !runtimeConfig.rpcEnabled) return;
  const snap = desiredPresence || { kind: 'clear', track: null };
  try {
    if (snap.kind === 'playing' && snap.track) {
      await setActivity(snap.track);
      return;
    }
    if (snap.kind === 'paused' && snap.track) {
      await setPausedActivity(snap.track);
      return;
    }
    await clearActivity({ silent: true });
  } catch (e) {
    logErr('restoreDesiredPresenceAfterReconnect error', e && e.message ? e.message : String(e));
  }
}

function initDiscordRpc(timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    // reset rpc reference for each attempt
    rpc = null;

    const client = new Client({ transport: 'ipc' });
    rpc = client;

    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { client.destroy(); } catch (_) {}
      rpc = null;
      reject(new Error(`Discord RPC ready timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const finishResolve = (msg) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (msg) log(msg);
      else log('Discord RPC подключён.');
      resolve();
    };

    // Some discord-rpc versions may not emit "ready" reliably.
    // We'll also consider login() resolution as "connected".
    client.on('ready', () => finishResolve('Discord RPC ready event received.'));

    client.on('disconnected', () => {
      // When Discord closes, we should re-connect later.
      log('Discord RPC отключён.');
      startDiscordReconnectLoop();
    });

    client.login({ clientId: CLIENT_ID })
      .then(() => {
        finishResolve('Discord RPC login() resolved.');
      })
      .catch((err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try { client.destroy(); } catch (_) {}
        rpc = null;
        log('Не удалось подключиться к Discord. Убедись, что Discord запущен и CLIENT_ID верный.');
        reject(err);
      });
  });
}

async function connectDiscordWithRetry() {
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      await initDiscordRpc(20000);
      await restoreDesiredPresenceAfterReconnect();
      // keep process alive; HTTP server already running
      return;
    } catch (e) {
      logErr('Discord connect attempt failed:', e && e.message ? e.message : String(e));
      const delay = Math.min(15000, 1500 * attempt);
      log(`Retry Discord connect in ${delay}ms (attempt ${attempt})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

function startDiscordReconnectLoop() {
  if (discordReconnectInProgress) return;
  discordReconnectInProgress = true;
  connectDiscordWithRetry()
    .catch((e) => {
      logErr('connectDiscordWithRetry (reconnect loop) failed:', e && e.message ? e.message : String(e));
    })
    .finally(() => {
      discordReconnectInProgress = false;
    });
}

function publicConfigSnapshot() {
  const c = JSON.parse(JSON.stringify(runtimeConfig));
  if (c.logging && c.logging.remoteUrl) {
    c.logging.remoteUrl = '(указан)';
  }
  delete c.discordTrackButtonLabel;
  delete c.discordModButtonLabel;
  delete c.discordModButtonUrl;
  return c;
}

function mergeConfigPatch(patch) {
  const base = loadConfig();
  const p = { ...patch };
  delete p.discordTrackButtonLabel;
  delete p.discordModButtonLabel;
  delete p.discordModButtonUrl;
  const out = { ...base, ...p };
  if (p.logging && typeof p.logging === 'object') {
    out.logging = { ...base.logging, ...p.logging };
  }
  return out;
}

function resolveScriptPath(filename) {
  if (process.env.RPC_SCRIPTS_DIR) {
    const p = path.join(process.env.RPC_SCRIPTS_DIR, filename);
    if (fs.existsSync(p)) return p;
  }
  const rel = path.join(__dirname, 'scripts', filename);
  const unpacked = rel.replace(/app\.asar([\\/])/g, 'app.asar.unpacked$1');
  if (fs.existsSync(unpacked)) return unpacked;
  return rel;
}

function getPsScriptPath() {
  return resolveScriptPath('read-yandex-desktop-title.ps1');
}

function getGsmtcScriptPath() {
  return resolveScriptPath('read-yandex-gsmtc.ps1');
}

function runPowerShellFile(scriptPath, timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (!fs.existsSync(scriptPath)) return resolve(null);
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (ps.exitCode === null) ps.kill(); } catch (_) {}
      resolve(val);
    };
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-STA', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true },
    );
    let out = '';
    ps.stdout.on('data', (d) => { out += d.toString('utf8'); });
    ps.stderr.on('data', () => {});
    ps.on('close', () => {
      try {
        const line = out.trim().split(/\r?\n/).filter(Boolean).pop();
        if (!line) return finish(null);
        finish(JSON.parse(line));
      } catch (_) {
        finish(null);
      }
    });
    ps.on('error', () => finish(null));
    const timer = setTimeout(() => {
      if (!settled) {
        logErr('PowerShell script timed out after', timeoutMs, 'ms:', scriptPath);
      }
      finish(null);
    }, timeoutMs);
    if (timer.unref) timer.unref();
  });
}

async function desktopPollOnce() {
  if (process.platform !== 'win32') return null;
  const gsmtcPath = getGsmtcScriptPath();
  if (fs.existsSync(gsmtcPath)) {
    const g = await runPowerShellFile(gsmtcPath);
    if (g && g.ok && (g.title || g.artist)) {
      const album = typeof g.album === 'string' ? g.album : '';
      if (!isYandexAppMarketingTitle(g.title || '', g.artist || '', album)) {
        const pos = parseFiniteNumber(g.positionSec);
        const dur = parseFiniteNumber(g.durationSec);
        const hasTimeline =
          pos != null &&
          dur != null &&
          dur > 0.5 &&
          pos >= 0 &&
          pos <= dur + 2;
        return {
          ok: true,
          title: g.title || '',
          artist: g.artist || '',
          album,
          source: 'desktop',
          positionSec: hasTimeline ? pos : undefined,
          durationSec: hasTimeline ? dur : undefined,
          paused: g.paused === true,
          coverPath: typeof g.coverPath === 'string' ? g.coverPath : undefined,
        };
      }
    }
  }
  return runPowerShellFile(getPsScriptPath());
}

function postLocalTrackJson(payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: HTTP_PORT,
        path: '/track',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body, 'utf8'),
        },
      },
      (r) => {
        try {
          r.resume();
        } catch (_) {}
        resolve();
      },
    );
    req.on('error', () => resolve());
    req.write(body);
    req.end();
  });
}

function startDesktopPoller() {
  let busy = false;
  /** Момент когда busy стал true – для детекта зависания */
  let busySinceMs = 0;
  const POLLER_HANG_TIMEOUT_MS = 30000;

  const tick = async () => {
    if (busy) {
      // Страховка: если поллер висит дольше лимита — принудительно сбрасываем
      if (busySinceMs && Date.now() - busySinceMs >= POLLER_HANG_TIMEOUT_MS) {
        logErr('DESKTOP POLLER: busy >', POLLER_HANG_TIMEOUT_MS, 'ms — force reset (PowerShell hang?).');
        busy = false;
        busySinceMs = 0;
      }
      return;
    }
    if (!runtimeConfig.desktopPollingEnabled || process.platform !== 'win32') return;
    if (runtimeConfig.preferredSource === 'browser') return;
    busy = true;
    busySinceMs = Date.now();
    try {
      const data = await desktopPollOnce();
      const browserFresh = Date.now() - lastBrowserPostAt < runtimeConfig.desktopBrowserPriorityMs;
      const shouldOwnDesktop =
        runtimeConfig.preferredSource === 'desktop' ||
        (runtimeConfig.preferredSource === 'auto' && !browserFresh);
      if (!data || !data.ok) {
        if (shouldOwnDesktop && lastDesktopTrackKey) {
          lastDesktopTrackKey = null;
          await postLocalTrackJson({ clear: true, source: 'desktop' });
        }
        return;
      }
      if (runtimeConfig.preferredSource === 'auto' && browserFresh) {
        return;
      }
      if (isRpcAppWindowTitle(data.title)) {
        if (lastDesktopTrackKey) {
          lastDesktopTrackKey = null;
          await postLocalTrackJson({ clear: true, source: 'desktop' });
        }
        return;
      }
      const key = `${data.title} — ${data.artist || ''}`.trim();
      lastDesktopTrackKey = key;
      const payload = {
        title: data.title,
        artist: data.artist || '',
        album: typeof data.album === 'string' ? data.album : '',
        source: 'desktop',
        paused: data.paused === true,
        coverPath: data.coverPath,
      };
      if (typeof data.positionSec === 'number' && Number.isFinite(data.positionSec)) {
        payload.positionSec = data.positionSec;
      }
      if (typeof data.durationSec === 'number' && Number.isFinite(data.durationSec)) {
        payload.durationSec = data.durationSec;
      }
      await postLocalTrackJson(payload);
    } finally {
      busy = false;
      busySinceMs = 0;
    }
  };
  const pollMs = Math.max(250, Number(runtimeConfig.desktopPollIntervalMs) || 500);
  setInterval(tick, pollMs);
  setTimeout(tick, 400);
}

function runHttpServer() {
  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (req.method === 'POST' && req.url === '/shutdown') {
      log('HTTP /shutdown received. Clearing activity and exiting process.');
      (async () => {
        try {
          await clearActivity();
          clearAllPresenceTimers();
        } catch (_) {}
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        setTimeout(() => {
          try { if (rpc) rpc.destroy(); } catch {}
          try { process.exit(0); } catch {}
        }, 80);
      })();
      return;
    }
    if (req.method === 'GET' && req.url === '/api/status') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        rpcEnabled: runtimeConfig.rpcEnabled,
        discordConnected: !!rpc,
        port: HTTP_PORT,
        preferredSource: runtimeConfig.preferredSource,
        discordClientIdSource: clientIdSource(),
        config: publicConfigSnapshot(),
        configDir: getConfigDir(),
        nowPlaying: lastNowPlaying,
      }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/config') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, config: runtimeConfig }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/logs') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, lines: getMemoryLogSnapshot() }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/config') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const patch = JSON.parse(body || '{}');
          const merged = mergeConfigPatch(patch);
          saveConfig(merged);
          reloadRuntimeConfig();
          initLogFilesIfNeeded();
          if (!runtimeConfig.rpcEnabled) {
            await clearActivity();
          }
          res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, config: publicConfigSnapshot() }));
        } catch (e) {
          res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }));
        }
      });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/track') {
      res.writeHead(404, { ...cors, 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const msg = JSON.parse(body || '{}');
        if (!hasLoggedFirstMsg && (msg && (msg.title !== undefined || msg.artist !== undefined || msg.paused))) {
          hasLoggedFirstMsg = true;
          log(
            'DEBUG first msg keys:',
            Object.keys(msg || {}),
            'msg.url =',
            Object.prototype.hasOwnProperty.call(msg, 'url') ? msg.url : '(no url field)'
          );
        }
        if (msg.clear) {
          log('HTTP clear received');
          suppressUntilMs = msg.source === 'desktop' ? 0 : Date.now() + 15000;
          lastNowPlaying = { title: '', artist: '' };
          await clearActivity();
          clearAllPresenceTimers();
          resetTrackSessionState();
          res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          // Если пришёл shutdown, завершаем процесс, чтобы новые POST от браузера
          // больше не поднимали активность.
          if (msg.shutdown) {
            log('HTTP shutdown received. Exiting process.');
            // Минимизируем задержку, чтобы порт 8765 точно освободился
            setTimeout(() => {
              try { if (rpc) rpc.destroy(); } catch {}
              try { process.exit(0); } catch {}
            }, 100);
          }
          return;
        }
        if (msg.title !== undefined || msg.artist !== undefined) {
          if (Date.now() < suppressUntilMs) {
            log('IGNORE track update due to recent clear');
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ignored: true }));
            return;
          }
          const src = msg.source || 'browser';
          if (src === 'browser' || src === 'web') {
            lastBrowserPostAt = Date.now();
          }
          if (runtimeConfig.preferredSource === 'desktop' && (src === 'browser' || src === 'web')) {
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ignored: true }));
            return;
          }
          if (runtimeConfig.preferredSource === 'browser' && src === 'desktop') {
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ignored: true }));
            return;
          }
          if (runtimeConfig.preferredSource === 'auto' && src === 'desktop') {
            if (Date.now() - lastBrowserPostAt < runtimeConfig.desktopBrowserPriorityMs) {
              res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, ignored: true }));
              return;
            }
          }
          if (!runtimeConfig.rpcEnabled) {
            await clearActivity();
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, rpcDisabled: true }));
            return;
          }
          const title = msg.title || '';
          const artist = msg.artist || '';
          if (msg.source === 'desktop' && isRpcAppWindowTitle(title)) {
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ignored: true }));
            return;
          }
          const album = msg.album || '';
          let coverUrl = typeof msg.coverUrl === 'string' ? msg.coverUrl.trim() : '';
          // Для десктопа без готового URL — ищем обложку через API Яндекс.Музыки (HTTPS).
          if (!coverUrl && src === 'desktop' && title) {
            const cacheKey = `${title} ${artist}`.toLowerCase();
            const cached = coverCache.get(cacheKey);
            if (cached && cached.url && Date.now() - cached.ts < COVER_CACHE_TTL_MS) {
              coverUrl = cached.url;
            } else {
              // Гонка: ждём до 400 мс — если API успел, обложка в этом же тике
              const pending = fetchCoverFromYandexApi(title, artist);
              coverUrl = (await Promise.race([
                pending,
                new Promise((r) => setTimeout(() => r(null), 400)),
              ])) || '';
            }
          }
          if (src === 'desktop' && isYandexAppMarketingTitle(title, artist, album)) {
            lastNowPlaying = { title: '', artist: '' };
            // Не вызывать clearActivity на каждом тике поллера (2 с), иначе спам «Статус сброшен»
            // и лишняя нагрузка на Discord IPC. Сбрасываем только если до этого был активный трек.
            if (currentTrackKey) {
              await clearActivity();
              clearAllPresenceTimers();
              resetTrackSessionState();
            }
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ignored: true, reason: 'yandex_idle_ui' }));
            return;
          }
          let trackUrl = normalizeTrackUrl(msg.url);
          if (!trackUrl && src === 'desktop') {
            const q = `${title} ${artist}`.trim();
            if (q) {
              trackUrl = `https://music.yandex.ru/search?text=${encodeURIComponent(q)}`;
            }
          }
          const key = `${title} — ${artist}`.trim();

          if (pausedClearBlockedTrackKey && key && key !== pausedClearBlockedTrackKey) {
            pausedClearBlockedTrackKey = null;
          }

          if (!key) {
            lastNowPlaying = { title: '', artist: '' };
            await clearActivity();
            clearAllPresenceTimers();
            resetTrackSessionState();
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          lastNowPlaying = { title: title || '', artist: artist || '' };

          const now = Date.now();
          const posParsed = parseFiniteNumber(msg.positionSec);
          const durParsed = parseFiniteNumber(msg.durationSec);
          let posSec = posParsed != null ? Math.max(0, posParsed) : null;
          let durSec = durParsed != null ? Math.max(0, durParsed) : null;

          const gsmtcTimeline =
            src === 'desktop' &&
            posSec != null &&
            durSec != null &&
            durSec > 0.5 &&
            posSec >= 0 &&
            posSec <= durSec + 2;

          if (!currentTrackKey || key !== currentTrackKey) {
            currentTrackKey = key;
            lastDiscordTimelineAtEnd = false;
            lastGsmtcRawPosSec = null;
            lastGsmtcPollWallMs = null;
            gsmtcPosStableSinceMs = null;
            pendingLoopRestartRawSec = null;
            pendingLoopRestartAtMs = null;
            log('Добавлен трек:', title, artist || '(без названия)');
            if (Object.prototype.hasOwnProperty.call(msg, 'url')) {
              log(
                'URL для кнопки:',
                msg.url ? msg.url : '(пусто)',
                '=>',
                trackUrl ? trackUrl : '(null после normalize)'
              );
            } else {
              log('URL для кнопки: поле msg.url отсутствует');
            }
            if (posSec != null) {
              currentTrackStart = now - posSec * 1000;
            } else {
              currentTrackStart = now;
            }
            // новая песня — берём durationSec только если он > posSec (иначе это ошибка: duration = elapsed)
            currentTrackDurationSec = (durSec != null && (posSec == null || durSec > posSec)) ? durSec : null;
          } else {
            // тот же трек: при перемотке подстраиваем currentTrackStart (не для GSMTC — там «сырая» позиция часто врёт)
            if (!gsmtcTimeline && posSec != null && currentTrackStart != null) {
              const expectedPosSec = (now - currentTrackStart) / 1000;
              if (Math.abs(expectedPosSec - posSec) > 4) {
                currentTrackStart = now - posSec * 1000;
              }
            }
            if (durSec != null && (posSec == null || durSec > posSec)) {
              if (currentTrackDurationSec == null || durSec > currentTrackDurationSec) {
                currentTrackDurationSec = durSec;
              }
            }
            if (!currentTrackStart) {
              currentTrackStart = now;
            }
          }

          /* Десктоп без таймлайна GSMTC: время по локальным часам; длительность — оценка из конфига. */
          let gsmtcDidResetToStart = false;
          if (src === 'desktop' && !gsmtcTimeline) {
            if (currentTrackStart != null) {
              posSec = Math.floor((Date.now() - currentTrackStart) / 1000);
            }
            const assume = runtimeConfig.desktopAssumedDurationSec;
            if (assume > 0 && (durSec == null || durSec <= 0)) {
              durSec = assume;
              if (currentTrackDurationSec == null) {
                currentTrackDurationSec = assume;
              }
            }
          } else if (src === 'desktop' && gsmtcTimeline) {
            const raw = posSec;
            const dur = durSec;
            durSec = dur;
            currentTrackDurationSec = dur;

            const expectedForGlitch =
              currentTrackStart != null ? (now - currentTrackStart) / 1000 : raw;
            const gsmtcJumpToStartAfterEnd =
              dur > 0.5 &&
              lastGsmtcRawPosSec != null &&
              lastGsmtcRawPosSec >= dur - 3 &&
              raw < 3 &&
              lastGsmtcRawPosSec - raw > 5 &&
              expectedForGlitch >= dur - 2.5 &&
              expectedForGlitch <= dur + 10;

            if (gsmtcJumpToStartAfterEnd) {
              /*
               * Прыжок с конца в начало — повтор трека.
               * Сразу сбрасываем позицию и currentTrackStart на реальное значение raw (~0),
               * чтобы таймер перезапустился с 00:00, а не завис на конце.
               * pendingLoopRestart* оставлен как страховка от GSMTC-глитчей.
               */
              pendingLoopRestartRawSec = raw;
              pendingLoopRestartAtMs = now;
              posSec = raw;
              currentTrackStart = now - raw * 1000;
              gsmtcDidResetToStart = true;
              gsmtcPosStableSinceMs = null;
              lastGsmtcRawPosSec = raw;
              lastGsmtcPollWallMs = now;
            } else {
              const loopRestartConfirmed =
                pendingLoopRestartAtMs != null &&
                pendingLoopRestartRawSec != null &&
                now - pendingLoopRestartAtMs <= 3000 &&
                raw >= pendingLoopRestartRawSec + 0.8;
              if (loopRestartConfirmed) {
                currentTrackStart = now - raw * 1000;
                pendingLoopRestartRawSec = null;
                pendingLoopRestartAtMs = null;
              } else if (pendingLoopRestartAtMs != null && now - pendingLoopRestartAtMs > 3000) {
                pendingLoopRestartRawSec = null;
                pendingLoopRestartAtMs = null;
                // Таймаут подтверждения повтора: сбрасываем currentTrackStart,
                // чтобы позиция не залипла на конце трека навсегда.
                currentTrackStart = now - raw * 1000;
              }
              const expectedSec = expectedForGlitch;

              if (lastGsmtcRawPosSec != null && Math.abs(raw - lastGsmtcRawPosSec) < 0.5) {
                if (gsmtcPosStableSinceMs == null && lastGsmtcPollWallMs != null) {
                  gsmtcPosStableSinceMs = lastGsmtcPollWallMs;
                }
              } else {
                gsmtcPosStableSinceMs = null;
              }

              const stale =
                gsmtcPosStableSinceMs != null &&
                now - gsmtcPosStableSinceMs >= 1200 &&
                expectedSec > raw + 1.25;

              /* Перемотка только по скачку сырой позиции между опросами; не сравнивать с expected — иначе цикл 0→4→сброс */
              const seek =
                !stale &&
                lastGsmtcRawPosSec != null &&
                Math.abs(raw - lastGsmtcRawPosSec) > 3.5;

              if (stale) {
                // Если GSMTC залип на 0, а стенные часы ушли за длительность —
                // симулируем повтор трека: позиция = остаток от деления (expectedSec % dur)
                if (raw < 1 && dur > 0.5 && expectedSec > dur + 0.5) {
                  const loopPos = expectedSec % dur;
                  if (loopPos < 5) {
                    // Только что пересекли границу цикла — форсируем апдейт Discord
                    gsmtcDidResetToStart = true;
                  }
                  posSec = loopPos;
                  currentTrackStart = now - posSec * 1000;
                } else {
                  posSec = dur > 0
                    ? Math.min(Math.max(0, expectedSec), dur)
                    : Math.max(0, expectedSec);
                }
              } else if (seek) {
                currentTrackStart = now - raw * 1000;
                posSec = dur > 0 ? Math.min(raw, dur) : raw;
                // Сброс позиции через seek (скачок > 3.5 сек) на начало — повтор трека
                if (raw < dur - 10) gsmtcDidResetToStart = true;
              } else {
                posSec = dur > 0
                  ? Math.min(Math.max(0, expectedSec), dur)
                  : Math.max(0, expectedSec);
              }

              lastGsmtcRawPosSec = raw;
              lastGsmtcPollWallMs = now;
              // DEBUG: сводка GSMTC-тика
              log('GSMTC tick:', {
                raw: raw.toFixed(1),
                dur,
                posSec: posSec != null ? posSec.toFixed(1) : 'null',
                expectedSec: expectedSec != null ? expectedSec.toFixed(1) : 'null',
                jump: gsmtcJumpToStartAfterEnd,
                seek,
                stale,
                didReset: gsmtcDidResetToStart,
                pendingAge: pendingLoopRestartAtMs ? (now - pendingLoopRestartAtMs) : null,
              });
            }
          }

          // для таймера Discord и для текста — длительность; не используем durSec если он <= posSec (ошибка)
          const durSecValid = durSec != null && (posSec == null || durSec > posSec);
          const effectiveDurSec = currentTrackDurationSec != null
            ? currentTrackDurationSec
            : (durSecValid ? durSec : null);

          let endsAtMs = null;
          if (effectiveDurSec != null && currentTrackStart != null && Number.isFinite(currentTrackStart)) {
            endsAtMs = currentTrackStart + effectiveDurSec * 1000;
          }

          // время для логов и для текстового отображения в Discord:
          // elapsed/total считаем из позиции/длительности трека, без привязки к таймстемпам
          const pForDisplay = posSec != null ? posSec : 0;
          const dForDisplay = durSec != null ? durSec : 0;
          let elapsedForDisplaySec = dForDisplay > 0 ? Math.min(pForDisplay, dForDisplay) : pForDisplay;
          const totalForDisplaySec = dForDisplay > 0 ? dForDisplay : Math.max(pForDisplay, dForDisplay);
          const cycleRestartDetected =
            !msg.paused &&
            totalForDisplaySec > 8 &&
            lastObservedTimelineKey === key &&
            typeof lastObservedElapsedSec === 'number' &&
            lastObservedElapsedSec >= totalForDisplaySec - 18 &&
            elapsedForDisplaySec <= 5;
          if (cycleRestartDetected && Number.isFinite(pForDisplay)) {
            currentTrackStart = now - pForDisplay * 1000;
            if (effectiveDurSec != null && Number.isFinite(effectiveDurSec)) {
              endsAtMs = currentTrackStart + effectiveDurSec * 1000;
            }
            lastDiscordTimelineAtEnd = false;
          }
          /*
           * Если по часам «уже после endsAtMs», а сырая позиция в начале трека — endsAtMs
           * относится к прошлому циклу repeat. Иначе wallClockPastTrackEnd залипает true,
           * timelineAtEnd не сбрасывается и Discord перестаёт нормально обновляться.
           */
          const staleEndWhileAtTrackStart =
            !msg.paused &&
            totalForDisplaySec > 15 &&
            pForDisplay < 12 &&
            endsAtMs != null &&
            now >= endsAtMs - 500;
          if (staleEndWhileAtTrackStart && Number.isFinite(pForDisplay) && effectiveDurSec != null) {
            currentTrackStart = now - pForDisplay * 1000;
            endsAtMs = currentTrackStart + effectiveDurSec * 1000;
            lastDiscordTimelineAtEnd = false;
          }
          const positionSaysNearEnd =
            totalForDisplaySec <= 0 || pForDisplay >= totalForDisplaySec - 18;
          const wallClockPastTrackEnd =
            endsAtMs != null &&
            now >= endsAtMs - 120 &&
            positionSaysNearEnd;
          if (wallClockPastTrackEnd && totalForDisplaySec > 0) {
            elapsedForDisplaySec = totalForDisplaySec;
          }
          const timelineAtEnd =
            wallClockPastTrackEnd ||
            (totalForDisplaySec > 0 &&
              elapsedForDisplaySec >= totalForDisplaySec - 1);
          const wasTimelineAtEnd = lastDiscordTimelineAtEnd;
          if (!timelineAtEnd) {
            lastDiscordTimelineAtEnd = false;
          }
          const posStrLog = formatTime(elapsedForDisplaySec);
          const durStrLog = totalForDisplaySec > 0 ? formatTime(totalForDisplaySec) : null;
          const timePartLog = posStrLog && durStrLog ? `${posStrLog}/${durStrLog}` : (posStrLog || '—');
          log('Статус обновлён на сервере', `(${timePartLog})`, '(скорость обновления раз в 0.3 сек)');

          if (msg.paused) {
            if (pausedClearBlockedTrackKey && key === pausedClearBlockedTrackKey) {
              if (lastSentTrackKey !== '__paused_blocked__') {
                log('Пауза после авто-сброса: ожидаю возобновление/смену трека, не поднимаю статус повторно.');
              }
              lastSentTrackKey = '__paused_blocked__';
              lastDiscordActivityAt = now;
            } else {
              const shouldUpdatePaused =
                lastSentTrackKey !== '__paused__' ||
                now - lastDiscordActivityAt >= DISCORD_PAUSED_UPDATE_INTERVAL_MS;
              if (lastSentTrackKey !== '__paused__') {
                schedulePausedClear();
              }
              if (shouldUpdatePaused) {
                const durationForPauseSec = effectiveDurSec != null ? effectiveDurSec : durSec;
                await setPausedActivity({
                  title,
                  artist,
                  album,
                  coverUrl,
                  positionSec: posSec,
                  durationSec: durationForPauseSec,
                  url: trackUrl,
                });
                lastSentTrackKey = '__paused__';
                lastDiscordActivityAt = now;
              }
            }
          } else {
            pausedClearBlockedTrackKey = null;
            if (lastSentTrackKey === '__paused__') {
              clearPausedClearTimerOnly();
            }
            // Резум с паузы — пересчитываем currentTrackStart, чтобы таймер шёл с правильной позиции
            if (lastSentTrackKey === '__paused__' && posSec != null) {
              currentTrackStart = now - posSec * 1000;
            }
            // Первый кадр «конец трека» — форсим обновление (троттлинг), без omitTimestamps:
            // в setActivity конец сдвигается в будущее, чтобы не было «просроченного» end.
            const needTimelineEndFix = timelineAtEnd && !lastDiscordTimelineAtEnd;
            // Важно для repeat: после режима "конец трека без timestamps" некоторые клиенты Discord
            // могут залипнуть на зелёном elapsed. Перед возвратом тайм-бара делаем clearActivity.
            const needTimelineRestoreFix = !timelineAtEnd && wasTimelineAtEnd;
            const needCycleRestartFix = cycleRestartDetected;
            const canUpdate =
              key !== lastSentTrackKey ||
              now - lastDiscordActivityAt >= DISCORD_UPDATE_INTERVAL_MS ||
              needTimelineEndFix ||
              needTimelineRestoreFix ||
              needCycleRestartFix ||
              gsmtcDidResetToStart;
            if (!canUpdate && !msg.paused) {
              log('DEBUG throttled:', {
                elapsed: elapsedForDisplaySec.toFixed(1),
                total: totalForDisplaySec,
                sinceLast: now - lastDiscordActivityAt,
                cycleRestart: cycleRestartDetected,
                gsmtcReset: gsmtcDidResetToStart,
                lastObserved: lastObservedElapsedSec != null ? lastObservedElapsedSec.toFixed(1) : 'null',
              });
            }
            if (canUpdate) {
              if (key !== lastSentTrackKey) {
                log('DEBUG timing for activity:',
                  { positionSec: elapsedForDisplaySec, durationSecPassed: effectiveDurSec != null ? effectiveDurSec : totalForDisplaySec, rawDurationSec: durSec },
                  'endsAtMs=', endsAtMs != null ? Math.round(endsAtMs / 1000) : null
                );
              }
              if (needTimelineRestoreFix || needCycleRestartFix || gsmtcDidResetToStart) {
                try {
                  await clearActivity({ silent: true });
                } catch (_) {}
              }
              await setActivity({
                title,
                artist,
                album,
                coverUrl,
                positionSec: elapsedForDisplaySec,
                durationSec: effectiveDurSec != null ? effectiveDurSec : totalForDisplaySec,
                url: trackUrl,
                discordStartMs:
                  currentTrackStart != null && Number.isFinite(currentTrackStart)
                    ? currentTrackStart
                    : undefined,
                discordEndMs:
                  endsAtMs != null && Number.isFinite(endsAtMs) ? endsAtMs : undefined,
              });
              if (timelineAtEnd) {
                lastDiscordTimelineAtEnd = true;
              }
              lastSentTrackKey = key;
              lastDiscordActivityAt = now;
            }
            schedulePlayingIdleFromHttp();
          }
          lastObservedTimelineKey = key || null;
          lastObservedElapsedSec = elapsedForDisplaySec;
        }
      } catch (_) {
        log('Неверный формат сообщения.');
      }
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  server.on('error', (err) => {
    logErr('HTTP server error', err && err.message ? err.message : String(err));
  });

  log('Starting HTTP server on port', HTTP_PORT);
  server.listen(HTTP_PORT, '127.0.0.1', () => {
    log(`HTTP сервер: http://127.0.0.1:${HTTP_PORT}/track`);
    log('Десктопный клиент (Windows): GSMTC (таймлайн) и при необходимости заголовок окна.');
  });

  return server;
}

async function gracefulShutdown(reason, opts = {}) {
  if (rpcShutdownStarted) return;
  rpcShutdownStarted = true;
  log(`Выход (${reason}). Сбрасываю статус в Discord.`);
  try {
    if (rpc) {
      await clearActivity();
      rpc.destroy();
    }
  } catch (e) {
    log('Ошибка при сбросе статуса:', e.message);
  }
  clearAllPresenceTimers();
  if (process.env.RPC_EMBEDDED_IN_ELECTRON === '1') {
    if (!opts.fromElectronBeforeQuit) {
      try {
        const { app } = require('electron');
        if (app && typeof app.quit === 'function') app.quit();
      } catch (_) {}
    }
    return;
  }
  process.exit(0);
}

async function main() {
  const locked = await tryAcquireServerLock();
  if (locked === false) return;
  initLogFilesIfNeeded();
  try { await checkDiscordIpcPipes(10); } catch (_) {}
  log('Яндекс.Музыка → Discord RPC');
  try {
    // eslint-disable-next-line global-require
    const vr = require('discord-rpc/package.json')?.version;
    if (vr) log('discord-rpc version:', vr);
  } catch (_) {}

  log('Discord Application ID:', CLIENT_ID, `(${clientIdSource() === 'env' ? 'переменная DISCORD_RPC_CLIENT_ID' : 'встроенный в проект'})`);

  if (clientIdSource() === 'builtin') {
    log('⚠ Внимание: встроенное приложение Discord НЕ верифицировано.');
    log('  Статус будет виден только вам. Другие пользователи его не увидят.');
    log('  Чтобы друзья тоже видели статус (без верификации):');
    log('  1. Создайте своё приложение на https://discord.com/developers/applications');
    log('  2. В разделе Rich Presence → Art Assets загрузите иконку (любую картинку)');
    log('  3. В App Settings → App Testers добавьте Discord-юзернеймы друзей');
    log('  4. Запускайте с переменной: DISCORD_RPC_CLIENT_ID=ваш_app_id');
    log('  Верификация приложения не нужна — достаточно добавить друзей в тестеры.');
  }

  if (process.env.RPC_EMBEDDED_IN_ELECTRON !== '1') {
    if (await isPortListening(HTTP_PORT)) {
      log('Port', HTTP_PORT, 'is already listening -> exiting to avoid EADDRINUSE.');
      process.exit(0);
    }
  }

  runHttpServer();
  startDesktopPoller();

  setInterval(() => {
    if (!hasLoggedFirstMsg) {
      log(
        'Ожидаю трек: запустите приложение Яндекс.Музыки для Windows (не веб-версию) и включите воспроизведение.',
      );
    }
  }, 30 * 1000);

  process.on('SIGINT', () => { gracefulShutdown('SIGINT'); });
  process.on('SIGTERM', () => { gracefulShutdown('SIGTERM'); });
  process.on('SIGBREAK', () => { gracefulShutdown('SIGBREAK'); });

  startDiscordReconnectLoop();
}

module.exports = { main, gracefulShutdown };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
