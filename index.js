#!/usr/bin/env node
'use strict';

/**
 * Программа для отображения в Discord статуса "Слушает ... в Яндекс.Музыке".
 * Принимает данные о треке по HTTP POST от userscript в браузере (обход CSP).
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { Client } = require('discord-rpc');

const HTTP_PORT = 8765;
const CLOCK_SYNC_URL = 'https://worldtimeapi.org/api/timezone/Etc/UTC';
const CLOCK_SYNC_INTERVAL_MS = 5 * 60 * 1000; // сверка часов раз в 5 минут
const DEFAULT_CLIENT_ID = 'Задай свой Client_ID';
const IDLE_CLEAR_MS = 60 * 1000; // через минуту без обновлений — сбрасываем статус
const DISCORD_UPDATE_INTERVAL_MS = 500; // обновление раз в 0.5 сек; зелёный таймер = время трека

let rpc = null;
let idleTimer = null;
let browserEverConnected = false;
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

const LOG_DIR = path.join(__dirname, 'logs');
const LOG_PATH = path.join(LOG_DIR, 'discord-rpc.log');
const ERR_LOG_PATH = path.join(LOG_DIR, 'discord-rpc.err.log');
const SERVER_LOCK_PATH = path.join(LOG_DIR, 'server.lock');
const DISCORD_CLIENT_ID_FILE = path.join(LOG_DIR, 'discord-client-id.txt');
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (_) {}

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

function resolveClientId() {
  try {
    const envId = process.env.DISCORD_RPC_CLIENT_ID;
    if (envId && typeof envId === 'string' && envId.trim()) return envId.trim();
  } catch (_) {}
  try {
    if (fs.existsSync(DISCORD_CLIENT_ID_FILE)) {
      const v = fs.readFileSync(DISCORD_CLIENT_ID_FILE, 'utf8').trim();
      if (v) return v;
    }
  } catch (_) {}
  try {
    // fallback for convenient manual config
    const alt = path.join(__dirname, 'discord-client-id.txt');
    if (fs.existsSync(alt)) {
      const v2 = fs.readFileSync(alt, 'utf8').trim();
      if (v2) return v2;
    }
  } catch (_) {}
  return DEFAULT_CLIENT_ID;
}

const CLIENT_ID = resolveClientId();
const CLIENT_ID_IS_DEFAULT = CLIENT_ID === DEFAULT_CLIENT_ID;

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
    let existingPid = null;
    if (fs.existsSync(SERVER_LOCK_PATH)) {
      const raw = fs.readFileSync(SERVER_LOCK_PATH, 'utf8').trim();
      const pid = Number(raw);
      existingPid = Number.isFinite(pid) ? pid : null;
      if (existingPid && isProcessAlive(existingPid)) {
        // PID might be reused; use port listening as authoritative signal.
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
    process.on('SIGINT', () => process.exit(0));
    process.on('SIGTERM', () => process.exit(0));
  } catch (_) {}
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

function initLogFiles() {
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

initLogFiles();

process.on('exit', () => {
  try { archiveAndCleanupLogsOnExit(15); } catch {}
});

function log(...args) {
  const time = new Date().toLocaleTimeString('ru-RU');
  const line = `[${time}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  // Логи в файл (UTF-8), чтобы не было "кракозябр" при редиректе консоли.
  try {
    fs.appendFileSync(LOG_PATH, line + '\n', { encoding: 'utf8' });
  } catch (_) {}
  console.log(line);
}

function logErr(...args) {
  const time = new Date().toLocaleTimeString('ru-RU');
  const line = `[${time}] ERR ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  try {
    fs.appendFileSync(ERR_LOG_PATH, line + '\n', { encoding: 'utf8' });
  } catch (_) {}
  console.error(line);
}

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

async function setActivity(track, timestamps) {
  if (!rpc) return;
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
    const payload = {
      details,
      state,
      // Listening (type=2) — чаще всего показывает тайм‑бар/прогресс,
      // в отличие от "Playing" (type=0), который может показывать countdown.
      type: 2,
      startTimestamp: new Date(startAdjusted),
      endTimestamp: endAdjusted != null && Number.isFinite(endAdjusted) ? new Date(endAdjusted) : undefined,
      largeImageKey: 'yandex_music_icon',
      largeImageText: 'Яндекс.Музыка',
    };
    log('DEBUG payload type:', payload.type, 'endTimestamp?', !!payload.endTimestamp, 'startAdjusted=', Math.round(startAdjusted / 1000));
    // discord-rpc@4.x ожидает поля для кнопок в формате button1_label/button1_url
    if (trackUrl) {
      // На разных версиях библиотеки поддерживаются разные форматы.
      // Поэтому кладём оба, чтобы кнопка отобразилась в Discord.
      payload.buttons = [{ label: 'Слушать трек', url: trackUrl }];
      payload.button1_label = 'Слушать трек';
      payload.button1_url = trackUrl;
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
  if (!rpc) return;
  const { title = '', artist = '', positionSec, durationSec, url: trackUrl } = track;
  const mainLine = [title || '', artist || ''].filter(Boolean).join(' — ');
  const stateText = (mainLine || 'Яндекс.Музыка').slice(0, 128);
  try {
    const payload = {
      details: 'Приостановлено в Яндекс Музыке',
      state: stateText,
      type: 2,
      largeImageKey: 'yandex_music_icon',
      largeImageText: 'Яндекс.Музыка',
    };
    if (trackUrl) {
      payload.buttons = [{ label: 'Слушать трек', url: trackUrl }];
      payload.button1_label = 'Слушать трек';
      payload.button1_url = trackUrl;
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

function runHttpServer() {
  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
        browserEverConnected = true;
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
          suppressUntilMs = Date.now() + 15000; // после clear игнорируем обновления короткое время
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
          const title = msg.title || '';
          const artist = msg.artist || '';
          const album = msg.album || '';
          const trackUrl = normalizeTrackUrl(msg.url);
          const key = `${title} — ${artist}`.trim();

          if (!key) {
            await clearActivity();
            clearIdleTimer();
            currentTrackKey = null;
            currentTrackStart = null;
            currentTrackDurationSec = null;
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          const now = Date.now();
          const posSec = typeof msg.positionSec === 'number' && Number.isFinite(msg.positionSec)
            ? Math.max(0, msg.positionSec)
            : null;
          const durSec = typeof msg.durationSec === 'number' && Number.isFinite(msg.durationSec)
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
  server.listen(HTTP_PORT, () => {
    log(`HTTP сервер: http://localhost:${HTTP_PORT}/track`);
    log('Открой Яндекс.Музыку в браузере и установи userscript (см. README).');
  });

  return server;
}

async function main() {
  await tryAcquireServerLock();
  try { await checkDiscordIpcPipes(10); } catch (_) {}
  log('Яндекс.Музыка → Discord RPC');
  try {
    // Показываем версию установленного discord-rpc, чтобы было понятно
    // какая библиотека реально запущена после npm install.
    // eslint-disable-next-line global-require
    const vr = require('discord-rpc/package.json')?.version;
    if (vr) log('discord-rpc version:', vr);
  } catch (_) {}

  if (!CLIENT_ID || CLIENT_ID === 'YOUR_DISCORD_APPLICATION_ID') {
    log('Ошибка: укажи Client ID своего приложения Discord.');
    log('Создай приложение на https://discord.com/developers/applications и скопируй Application ID.');
    log('Затем в index.js замени YOUR_DISCORD_APPLICATION_ID или задай переменную DISCORD_RPC_CLIENT_ID.');
    process.exit(1);
  }
  log('Client ID:', CLIENT_ID);
  if (CLIENT_ID_IS_DEFAULT) {
    logErr(
      'WARN: Using DEFAULT_CLIENT_ID. Set your real Application ID in DISCORD_RPC_CLIENT_ID or in yandex-music-rpc/logs/discord-client-id.txt.'
    );
  }
  if (process.env.DISCORD_RPC_CLIENT_ID) {
    log('(Client ID взят из переменной DISCORD_RPC_CLIENT_ID)');
  }

  // If we lost a startup race, avoid crashing with EADDRINUSE.
  if (await isPortListening(HTTP_PORT)) {
    log('Port', HTTP_PORT, 'is already listening -> exiting to avoid EADDRINUSE.');
    process.exit(0);
  }

  runHttpServer();

  // Раз в 30 сек напоминаем, что ждём браузер (чтобы в логе было видно, что программа жива)
  setInterval(() => {
    if (!browserEverConnected) {
      log('Ожидаю подключения от браузера. Открой music.yandex.ru с установленным скриптом Tampermonkey.');
    }
  }, 30 * 1000);

  let shutdownStarted = false;
  const gracefulShutdown = (reason) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    log(`Выход (${reason}). Сбрасываю статус в Discord.`);
    (async () => {
      try {
        if (rpc) {
          await clearActivity();
          rpc.destroy();
        }
      } catch (e) {
        log('Ошибка при сбросе статуса:', e.message);
      } finally {
        process.exit(0);
      }
    })();
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGBREAK', () => gracefulShutdown('SIGBREAK'));

  // Discord connection can fail sometimes (Discord not ready / restarted).
  // We must not block HTTP server start, so userscript can still reach /track.
  startDiscordReconnectLoop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
