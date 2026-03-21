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

/** Подписи и URL кнопок Rich Presence заданы в приложении, не в настройках. */
const DISCORD_FIXED_TRACK_BTN_LABEL = '🎵 Открыть';
const DISCORD_FIXED_MOD_BTN_LABEL = '💻 Yandex Music Mod';
const DISCORD_FIXED_MOD_BTN_URL = 'https://github.com/Stephanzion/YandexMusicBetaMod';

const HTTP_PORT = 8765;
const CLOCK_SYNC_URL = 'https://worldtimeapi.org/api/timezone/Etc/UTC';
const CLOCK_SYNC_INTERVAL_MS = 5 * 60 * 1000; // сверка часов раз в 5 минут
const IDLE_CLEAR_MS = 60 * 1000; // через минуту без обновлений — сбрасываем статус
const DISCORD_UPDATE_INTERVAL_MS = 500; // обновление раз в 0.5 сек; зелёный таймер = время трека

let rpc = null;
let idleTimer = null;
let currentTrackKey = null;
let currentTrackStart = null;
let currentTrackDurationSec = null; // фиксируем длительность трека один раз при старте
let lastSentTrackKey = null;
let lastSentButtonUrl = null;
let lastDiscordActivityAt = 0;
let hasLoggedFirstMsg = false;
/** Разница локальных часов и UTC в мс: localNow - realUtc. Коррекция таймштампов для Discord. */
let clockOffsetMs = 0;
let suppressUntilMs = 0;
let discordReconnectInProgress = false;
/** Для корректного выхода при встраивании в Electron (без второго процесса). */
let rpcShutdownStarted = false;
let lastBrowserPostAt = 0;
let lastDesktopTrackKey = null;
/** Для полоски RPC в окне Electron */
let lastNowPlaying = { title: '', artist: '' };

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

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function setIdleTimer() {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    clearActivity();
    idleTimer = null;
  }, IDLE_CLEAR_MS);
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
      host.endsWith('yandex.kz')
    );
  } catch (_) {
    return false;
  }
}

function pickLargeImage(track) {
  const cover = track && track.coverUrl;
  if (runtimeConfig.coverArtEnabled && cover && isAllowedCoverUrl(cover)) {
    const text = (track.album || track.title || 'Яндекс.Музыка').slice(0, 128);
    return { key: cover.slice(0, 512), text };
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

async function setActivity(track, timestamps) {
  if (!rpc || !runtimeConfig.rpcEnabled) return;
  const { title = '', artist = '', album = '', url: trackUrl, positionSec, durationSec } = track;

  const p = typeof positionSec === 'number' && Number.isFinite(positionSec) ? Math.max(0, positionSec) : 0;
  const d = typeof durationSec === 'number' && Number.isFinite(durationSec) ? Math.max(0, durationSec) : 0;
  const elapsedSec = d > 0 ? Math.min(p, d) : p;
  const totalSec = d > 0 ? d : Math.max(p, d);

  const posStr = formatTime(elapsedSec);
  const durStr = totalSec > 0 ? formatTime(totalSec) : null;
  const timePart = posStr && durStr ? `${posStr}/${durStr}` : posStr || '';
  const details = (title || 'Яндекс.Музыка').slice(0, 128);
  const stateBase = [artist || '', album || ''].filter(Boolean).join(' — ');
  const state = stateBase ? stateBase.slice(0, 128) : undefined;
  try {
    // Если сервер уже посчитал абсолютные timestamps трека — используем их,
    // чтобы у всех зрителей Discord тайм‑бар был строго привязан к одному старту.
    const now = Date.now();
    const passed = timestamps || {};
    const startedAtMs = typeof passed.startedAtMs === 'number' && Number.isFinite(passed.startedAtMs)
      ? passed.startedAtMs
      : now - elapsedSec * 1000;
    const endsAtMs = typeof passed.endsAtMs === 'number' && Number.isFinite(passed.endsAtMs)
      ? passed.endsAtMs
      : (totalSec > 0 ? startedAtMs + totalSec * 1000 : undefined);
    // Коррекция по UTC, чтобы у зрителей (другие ПК) тайм-бар совпадал с реальным воспроизведением
    const startAdjusted = startedAtMs - clockOffsetMs;
    const endAdjusted = endsAtMs != null ? endsAtMs - clockOffsetMs : undefined;
    const img = pickLargeImage(track);
    const payload = {
      details,
      state,
      // Listening (type=2) — чаще всего показывает тайм‑бар/прогресс,
      // в отличие от "Playing" (type=0), который может показывать countdown.
      type: 2,
      startTimestamp: new Date(startAdjusted),
      endTimestamp: endAdjusted != null && Number.isFinite(endAdjusted) ? new Date(endAdjusted) : undefined,
      largeImageKey: img.key,
      largeImageText: img.text,
    };
    log('DEBUG payload type:', payload.type, 'endTimestamp?', !!payload.endTimestamp, 'startAdjusted=', Math.round(startAdjusted / 1000));
    if (trackUrl) {
      applyDiscordButtonsToPayload(payload, trackUrl);
      if (trackUrl !== lastSentButtonUrl) {
        log('Кнопка в Discord:', trackUrl);
        lastSentButtonUrl = trackUrl;
      }
    }
    await rpc.setActivity(payload);
    log('Статус обновлён в Discord', `(${timePart || '—'})`, '(раз в 0.5 сек, тайм-бар = трек)');
  } catch (e) {
    log('Ошибка setActivity:', e.message);
  }
  setIdleTimer();
}

async function setPausedActivity(track) {
  if (!rpc || !runtimeConfig.rpcEnabled) return;
  const { title = '', artist = '', positionSec, durationSec, url: trackUrl } = track;
  const mainLine = [title || '', artist || ''].filter(Boolean).join(' — ');
  const stateText = (mainLine || 'Яндекс.Музыка').slice(0, 128);
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
    await rpc.setActivity(payload);
    log('Статус обновлён в Discord (пауза)', stateText || '—');
  } catch (e) {
    log('Ошибка setActivity (пауза):', e.message);
  }
  setIdleTimer();
}

async function clearActivity() {
  if (!rpc) return;
  try {
    await rpc.clearActivity();
    log('Статус сброшен.');
    lastSentButtonUrl = null;
  } catch (e) {
    logErr('clearActivity error', e && e.message ? e.message : String(e));
    log('Ошибка clearActivity:', e.message);
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

function getPsScriptPath() {
  if (process.env.RPC_SCRIPTS_DIR) {
    const p = path.join(process.env.RPC_SCRIPTS_DIR, 'read-yandex-desktop-title.ps1');
    if (fs.existsSync(p)) return p;
  }
  const rel = path.join(__dirname, 'scripts', 'read-yandex-desktop-title.ps1');
  const unpacked = rel.replace(/app\.asar([\\/])/g, 'app.asar.unpacked$1');
  if (fs.existsSync(unpacked)) return unpacked;
  return rel;
}

function desktopPollOnce() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    const scriptPath = getPsScriptPath();
    if (!fs.existsSync(scriptPath)) return resolve(null);
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true },
    );
    let out = '';
    ps.stdout.on('data', (d) => { out += d.toString('utf8'); });
    ps.stderr.on('data', () => {});
    ps.on('close', () => {
      try {
        const line = out.trim().split(/\r?\n/).filter(Boolean).pop();
        if (!line) return resolve(null);
        resolve(JSON.parse(line));
      } catch (_) {
        resolve(null);
      }
    });
    ps.on('error', () => resolve(null));
  });
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
  const tick = async () => {
    if (busy) return;
    if (!runtimeConfig.desktopPollingEnabled || process.platform !== 'win32') return;
    if (runtimeConfig.preferredSource === 'browser') return;
    busy = true;
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
      await postLocalTrackJson({
        title: data.title,
        artist: data.artist || '',
        source: 'desktop',
        paused: false,
      });
    } finally {
      busy = false;
    }
  };
  setInterval(tick, 2000);
  setTimeout(tick, 1200);
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
          clearIdleTimer();
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
          clearIdleTimer();
          currentTrackKey = null;
          currentTrackStart = null;
          currentTrackDurationSec = null;
          lastSentTrackKey = null;
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
          const coverUrl = typeof msg.coverUrl === 'string' ? msg.coverUrl.trim() : '';
          let trackUrl = normalizeTrackUrl(msg.url);
          if (!trackUrl && src === 'desktop') {
            const q = `${title} ${artist}`.trim();
            if (q) {
              trackUrl = `https://music.yandex.ru/search?text=${encodeURIComponent(q)}`;
            }
          }
          const key = `${title} — ${artist}`.trim();

          if (!key) {
            lastNowPlaying = { title: '', artist: '' };
            await clearActivity();
            clearIdleTimer();
            currentTrackKey = null;
            currentTrackStart = null;
            currentTrackDurationSec = null;
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          lastNowPlaying = { title: title || '', artist: artist || '' };

          const now = Date.now();
          let posSec = typeof msg.positionSec === 'number' && Number.isFinite(msg.positionSec)
            ? Math.max(0, msg.positionSec)
            : null;
          let durSec = typeof msg.durationSec === 'number' && Number.isFinite(msg.durationSec)
            ? Math.max(0, msg.durationSec)
            : null;

          if (!currentTrackKey || key !== currentTrackKey) {
            currentTrackKey = key;
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
            // тот же трек: при перемотке подстраиваем currentTrackStart, чтобы тайм-бар сдвинулся
            if (posSec != null && currentTrackStart != null) {
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

          /* Десктоп не отдаёт позицию/длительность: считаем прошедшее время сами; длительность — из конфига (оценка для таймбара). */
          if (src === 'desktop') {
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
          }

          // для таймера Discord и для текста — длительность; не используем durSec если он <= posSec (ошибка)
          const durSecValid = durSec != null && (posSec == null || durSec > posSec);
          const effectiveDurSec = currentTrackDurationSec != null
            ? currentTrackDurationSec
            : (durSecValid ? durSec : null);

          let endsAtMs = null;
          if (effectiveDurSec != null) {
            const durMs = effectiveDurSec * 1000;
            endsAtMs = currentTrackStart + durMs;
          }

          // время для логов и для текстового отображения в Discord:
          // elapsed/total считаем из позиции/длительности трека, без привязки к таймстемпам
          const pForDisplay = posSec != null ? posSec : 0;
          const dForDisplay = durSec != null ? durSec : 0;
          const elapsedForDisplaySec = dForDisplay > 0 ? Math.min(pForDisplay, dForDisplay) : pForDisplay;
          const totalForDisplaySec = dForDisplay > 0 ? dForDisplay : Math.max(pForDisplay, dForDisplay);
          const posStrLog = formatTime(elapsedForDisplaySec);
          const durStrLog = totalForDisplaySec > 0 ? formatTime(totalForDisplaySec) : null;
          const timePartLog = posStrLog && durStrLog ? `${posStrLog}/${durStrLog}` : (posStrLog || '—');
          log('Статус обновлён на сервере', `(${timePartLog})`, '(скорость обновления раз в 0.3 сек)');

          if (msg.paused) {
            const durationForPauseSec = effectiveDurSec != null ? effectiveDurSec : durSec;
            setPausedActivity({
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
          } else {
            // Резум с паузы — пересчитываем currentTrackStart, чтобы таймер шёл с правильной позиции
            if (lastSentTrackKey === '__paused__' && posSec != null) {
              currentTrackStart = now - posSec * 1000;
            }
            // Зелёный таймер = время трека; обновляем раз в 0.5 сек
            const canUpdate = key !== lastSentTrackKey || now - lastDiscordActivityAt >= DISCORD_UPDATE_INTERVAL_MS;
            if (canUpdate) {
              if (key !== lastSentTrackKey) {
                log('DEBUG timing for activity:',
                  { positionSec: elapsedForDisplaySec, durationSecPassed: effectiveDurSec != null ? effectiveDurSec : totalForDisplaySec, rawDurationSec: durSec },
                  'endsAtMs=', endsAtMs != null ? Math.round(endsAtMs / 1000) : null
                );
              }
              setActivity(
                {
                  title,
                  artist,
                  album,
                  coverUrl,
                  positionSec: elapsedForDisplaySec,
                  durationSec: effectiveDurSec != null ? effectiveDurSec : totalForDisplaySec,
                  url: trackUrl,
                },
                { startedAtMs: currentTrackStart, endsAtMs },
              );
              lastSentTrackKey = key;
              lastDiscordActivityAt = now;
            }
          }
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
    log('Десктопный клиент Яндекс.Музыки (Windows): трек из заголовка окна.');
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
