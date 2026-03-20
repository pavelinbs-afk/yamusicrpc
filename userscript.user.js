// ==UserScript==
// @name         Yandex Music → Discord RPC
// @namespace    http://tampermonkey.net/
// @version      2.0.0
// @description  Отправляет текущий трек в программу Discord RPC (HTTP, обход CSP)
// @match        *://*/*
// @connect      localhost
// @connect      127.0.0.1
// @connect      *
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
// патч с кнопкой
  // Ограничиваем запуск только страницами Яндекс.Музыки,
  // а в @match оставляем широкий шаблон, чтобы обойти хитрые редиректы/поддомены.
  const href = window.location.href;
  const host = window.location.host;
  const isYandexMusicHost = /music\.yandex\./.test(host);
  const isYaRuMusic = /^https:\/\/(www\.)?ya\.ru\/music/.test(href);
  if (!isYandexMusicHost && !isYaRuMusic) {
    console.error('[Yandex Music RPC] not Yandex Music page, skip', { href, host });
    return;
  }
  console.error('[Yandex Music RPC] userscript started on', href);

  const API_URL = 'http://localhost:8765/track';
  const POLL_MS = 500;            // проверка каждые 0.5 сек
  const PLAY_UPDATE_MS = 300;   // при воспроизведении — отправка на сервер раз в 0.3 сек
  const PAUSE_UPDATE_MS = 30 * 1000;  // при паузе — обновление раз в 30 сек
  const PAUSE_MS = 5 * 60 * 1000;     // сколько держать статус паузы перед сбросом (5 минут)

  let connectedOnce = false;
  let connectFailCount = 0;
  let connectFailFirstAt = 0;
  let lastTrackKey = null;
  let pauseSince = null;
  let lastPlaySentAt = 0;
  let lastPauseSentAt = 0;

  function showToast(text, isError) {
    const id = 'yandex-music-rpc-toast';
    const old = document.getElementById(id);
    if (old) old.remove();
    const el = document.createElement('div');
    el.id = id;
    el.textContent = text;
    el.style.cssText = 'position:fixed;bottom:80px;right:20px;z-index:99999;padding:10px 14px;border-radius:8px;font-size:13px;font-family:system-ui,sans-serif;background:' + (isError ? '#c62828' : '#2e7d32') + ';color:#fff;box-shadow:0 2px 10px rgba(0,0,0,.3);';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  function findAudio() {
    let audio = document.querySelector('audio');
    if (!audio) {
      const iframe = document.querySelector('iframe');
      if (iframe && iframe.contentDocument) {
        audio = iframe.contentDocument.querySelector('audio');
      }
    }
    return audio;
  }

  function getTrackInfo() {
    let title = '';
    let artist = '';
    let positionSec = null;
    let durationSec = null;
    let url = null;

    // Если мы прямо на странице трека — берём url из адресной строки.
    // Это надёжнее, чем парсить ссылку из DOM, который может меняться.
    {
      const href = (window.location && window.location.href) ? window.location.href : '';
      if (/\/track\//i.test(href)) {
        url = href.split(/[?#]/)[0];
      }
    }

    function normalizeHref(rawHref) {
      if (!rawHref || typeof rawHref !== 'string') return null;
      const href = rawHref.trim();
      if (!href) return null;
      if (/^https?:\/\//i.test(href)) return href;
      if (href.startsWith('//')) return 'https:' + href;
      if (href.startsWith('/')) return 'https://music.yandex.ru' + href;
      return 'https://music.yandex.ru/' + href.replace(/^\/+/, '');
    }

    // 1) Заголовок вкладки: "Трек — Артист | Яндекс.Музыка" или "Трек – Артист" и т.д.
    const rawTitle = (document.title || '').trim();
    if (rawTitle.length > 2) {
      const beforePipe = rawTitle.split('|')[0].trim().split(' - Яндекс')[0].trim();
      const sep = beforePipe.includes(' — ') ? ' — ' : beforePipe.includes(' – ') ? ' – ' : ' - ';
      const parts = beforePipe.split(sep).map(s => s.trim());
      if (parts.length >= 2 && parts[0] && parts[1]) {
        const candidateTitle = parts[0];
        const candidateArtist = parts.slice(1).join(sep);
        if (candidateTitle && !/^яндекс|музыка|yandex|music$/i.test(candidateTitle)) {
          title = candidateTitle;
          artist = candidateArtist;
        }
      }
    }

    // 2) Селекторы в DOM плеера (могут меняться при обновлении сайта)
    const titleSelectors = [
      '.player-bar .track__title a',
      '.player-bar__track-title',
      '[class*="PlayerBar"] [class*="title"]',
      '[class*="player-bar"] [class*="title"]',
      '.sidebar__track-title',
      '.d-generic-track__title',
      '[data-bem*="track"] .track__title',
      'a[href*="/track/"]',
    ];
    const artistSelectors = [
      '.player-bar .track__artists a',
      '.player-bar__track-artist',
      '[class*="PlayerBar"] [class*="artist"]',
      '[class*="player-bar"] [class*="artist"]',
      '.sidebar__track-artist',
      '.d-generic-track__artists a',
      '[data-bem*="track"] .track__artists a',
    ];

    const playerRoot = document.querySelector('.player-bar, [class*="PlayerBar"], [class*="player-bar"], [class*="PlayerBarWrapper"]') || document.body;

    for (const sel of titleSelectors) {
      const el = playerRoot.querySelector(sel);
      if (el) {
        const t = (el.textContent || '').trim();
        if (t && !/яндекс|yandex|музыка|music/i.test(t)) {
          title = t;
          break;
        }
      }
    }
    if (!title) {
      const playerLink = playerRoot.querySelector('a[href*="/track/"]');
      if (playerLink) title = (playerLink.textContent || '').trim();
    }

    // Ссылка на трек (для кнопки в Discord)
    {
      if (!url) {
        const linkEls = playerRoot.querySelectorAll('a[href*="/track/"], a[href*="music.yandex.ru/track/"]');
        const linkEl = (linkEls && linkEls.length) ? linkEls[0] : null
          || document.querySelector('a[href*="/track/"], a[href*="music.yandex.ru/track/"]');
        if (linkEl) url = normalizeHref(linkEl.getAttribute('href') || linkEl.href);
      }
    }

    for (const sel of artistSelectors) {
      const el = playerRoot.querySelector(sel);
      if (el) {
        const a = (el.textContent || '').trim();
        if (a) {
          artist = a;
          break;
        }
      }
    }

    // 3) Текущее время и длительность трека
    // 3a) HTML5 audio — самый надёжный способ (Яндекс.Музыка использует audio)
    const audio = findAudio();
    if (audio && audio.readyState >= 1) {
      const dur = audio.duration;
      if (Number.isFinite(dur) && dur > 0) {
        durationSec = Math.round(dur);
        positionSec = Math.round(Math.max(0, audio.currentTime));
      }
    }

    // 3b) Парсинг текста из DOM — позиция = min, длительность = max (интерфейс показывает 0:42 / 2:25)
    {
      function parseTimeToSeconds(text) {
        if (!text) return null;
        const parts = text.trim().split(':').map((p) => parseInt(p, 10));
        if (parts.some((n) => Number.isNaN(n))) return null;
        if (parts.length === 2) {
          const [m, s] = parts;
          return m * 60 + s;
        }
        if (parts.length === 3) {
          const [h, m, s] = parts;
          return h * 3600 + m * 60 + s;
        }
        return null;
      }
      const timeSelectors = [
        '.player-controls__time span',
        '.player-bar [class*="time"] span',
        '[class*="progress"] span',
        '[class*="Progress"] span',
        '.player-bar span',
        '[class*="PlayerBar"] span',
        '[class*="player-bar"] span',
      ];
      const seen = new Set();
      const parsed = [];
      for (const sel of timeSelectors) {
        playerRoot.querySelectorAll(sel).forEach((el) => {
          const t = (el.textContent || '').trim();
          if ((/^\d{1,2}:\d{2}$/.test(t) || /^\d{1,2}:\d{2}:\d{2}$/.test(t)) && t.length <= 8) {
            const sec = parseTimeToSeconds(t);
            if (sec != null && !seen.has(sec)) {
              seen.add(sec);
              parsed.push(sec);
            }
          }
        });
      }
      if (parsed.length >= 2) {
        const domPos = Math.min(...parsed);
        const domDur = Math.max(...parsed);
        if (domDur > domPos) {
          durationSec = domDur;
          if (positionSec == null) positionSec = domPos;
        }
      } else if (parsed.length === 1) {
        const v = parsed[0];
        if (v > 60 && (durationSec == null || durationSec <= (positionSec ?? 0))) {
          durationSec = v; // одно большое значение — скорее total
        } else if (positionSec == null) {
          positionSec = v;
        }
      }
    }

    return { title, artist, positionSec, durationSec, url };
  }

  function isPlaying() {
    const audio = findAudio();
    if (audio && typeof audio.paused === 'boolean') {
      return !audio.paused;
    }
    const pauseSelectors = [
      'button[aria-label*=\"Пауза\"]',
      'button[title*=\"Пауза\"]',
      'button[aria-label*=\"Pause\"]',
      'button[title*=\"Pause\"]',
    ];
    for (const sel of pauseSelectors) {
      const btn = document.querySelector(sel);
      if (btn) return true;
    }
    return false;
  }

  function sendTrack(track) {
    console.log('[Yandex Music RPC] sendTrack()', track);
    GM_xmlhttpRequest({
      method: 'POST',
      url: API_URL,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(track),
      onload: function (res) {
        console.log('[Yandex Music RPC] response', res.status, res.responseText);
        if (res.status === 200 && !connectedOnce) {
          connectedOnce = true;
          connectFailCount = 0;
          connectFailFirstAt = 0;
          showToast('Discord RPC: подключено', false);
        } else if (res.status !== 200 && !connectedOnce) {
          // Non-200 counts as failure too; don't spam toast on first error.
          if (connectFailCount === 0) connectFailFirstAt = Date.now();
          connectFailCount += 1;
          const shouldToast = connectFailCount >= 3 && (Date.now() - connectFailFirstAt) >= 2500;
          if (shouldToast) {
            showToast('Discord RPC: запусти программу на ПК (npm start).', true);
          }
        }
      },
      onerror: function () {
        console.error('[Yandex Music RPC] request error');
        if (!connectedOnce) {
          if (connectFailCount === 0) connectFailFirstAt = Date.now();
          connectFailCount += 1;
          // Avoid toast on transient "connection refused" during restarts.
          const shouldToast = connectFailCount >= 3 && (Date.now() - connectFailFirstAt) >= 2500;
          if (shouldToast) {
            showToast('Discord RPC: запусти программу на ПК (npm start).', true);
          }
        }
      },
    });
  }

  function tick() {
    const now = Date.now();
    const track = getTrackInfo();
    const key = (track.title || '') + ' — ' + (track.artist || '');
    const hasTrack = !!(track.title || track.artist);
    const playingNow = hasTrack && isPlaying();

    if (hasTrack) {
      console.log('[Yandex Music RPC] tick', {
        key,
        playingNow,
        positionSec: track.positionSec,
        durationSec: track.durationSec,
      });
    }

    // Музыка играет
    if (playingNow) {
      lastTrackKey = key || lastTrackKey;
      pauseSince = null;
      lastPauseSentAt = 0;
      if (now - lastPlaySentAt >= PLAY_UPDATE_MS) {
        lastPlaySentAt = now;
        sendTrack(track);
      }
      return;
    }

    // Музыка на паузе: раньше что‑то играло, но сейчас не играет
    if (lastTrackKey) {
      if (!pauseSince) {
        pauseSince = now;  // таймер 5 минут стартует сразу при обнаружении паузы
      }
      const pausedFor = now - pauseSince;
      if (pausedFor < PAUSE_MS) {
        // в течение 5 минут — статус "Приостановлено", обновляем раз в 30 сек
        if (now - lastPauseSentAt >= PAUSE_UPDATE_MS || lastPauseSentAt === 0) {
          lastPauseSentAt = now;
          sendTrack({
            title: track.title || '',
            artist: track.artist || '',
            positionSec: track.positionSec,
            durationSec: track.durationSec,
            paused: true,
            url: track.url,
          });
        }
      } else {
        sendTrack({ clear: true });
        lastTrackKey = null;
        pauseSince = null;
        lastPauseSentAt = 0;
      }
      return;
    }

    // Ничего не играло и не стоит — ничего не отправляем
  }

  console.log('[Yandex Music RPC] Скрипт загружен (HTTP, обход CSP).');
  setInterval(tick, POLL_MS);
  setTimeout(tick, 1000);
})();
