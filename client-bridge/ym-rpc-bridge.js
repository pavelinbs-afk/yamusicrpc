/**
 * Тонкий мост: читает плеер Яндекс.Музыки в renderer.
 * Отправку в RPC делает ym-rpc-hook.js из main process (Node http) —
 * так обходим CSP, который блокирует fetch на 127.0.0.1 из страницы.
 */
(function ymRpcBridge() {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.__ymRpcBridgeInstalled) return;
  window.__ymRpcBridgeInstalled = true;

  // YM 5.12x: VIBE_PLAYERBAR; старые сборки — PLAYERBAR_DESKTOP
  const PLAYER_SELECTORS = [
    '[data-test-id="VIBE_PLAYERBAR"]',
    'section[data-test-id="VIBE_PLAYERBAR"]',
    '[data-test-id="BAR_BELOW"]',
    'section[data-test-id="PLAYERBAR_DESKTOP"]',
    '[data-test-id="PLAYERBAR_DESKTOP"]',
    'section[data-test-id="PLAYERBAR"]',
  ];
  const PLAY_BUTTON_SELECTOR = 'button[data-test-id="PLAY_BUTTON"], [data-test-id="PLAY_BUTTON"]';
  const PAUSE_BUTTON_SELECTOR = 'button[data-test-id="PAUSE_BUTTON"], [data-test-id="PAUSE_BUTTON"]';
  const PLAYING_ANIM_SELECTOR = '[data-test-id="PLAYING_ANIMATION"]';

  function findFiberNode(element) {
    if (!element) return null;
    const fiberKey = Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
    return fiberKey ? element[fiberKey] : null;
  }

  function getRootFiber(fiber) {
    let current = fiber;
    while (current && current.return) current = current.return;
    return current || null;
  }

  function traverseFiber(fiber, isFoundCallback, depth) {
    if (!fiber || depth > 100) return null;
    const result = isFoundCallback(fiber, depth);
    if (result != null) return result;
    const childResult = traverseFiber(fiber.child, isFoundCallback, depth + 1);
    if (childResult != null) return childResult;
    return traverseFiber(fiber.sibling, isFoundCallback, depth);
  }

  function searchProperty(element, property) {
    const fiberNode = findFiberNode(element);
    if (!fiberNode) return null;
    const rootFiber = getRootFiber(fiberNode);
    return traverseFiber(rootFiber, (fiber) => {
      if (fiber.memoizedProps && Object.prototype.hasOwnProperty.call(fiber.memoizedProps, property)) {
        return fiber.memoizedProps;
      }
      return null;
    }, 0);
  }

  function searchAnyProperty(element, properties) {
    for (let i = 0; i < properties.length; i++) {
      const found = searchProperty(element, properties[i]);
      if (found) return found;
    }
    return null;
  }

  function findPlayer() {
    for (let i = 0; i < PLAYER_SELECTORS.length; i++) {
      const el = document.querySelector(PLAYER_SELECTORS[i]);
      if (el) return el;
    }
    return null;
  }

  function isPlaying(player) {
    // Vibe: анимация играет только во время playback — самый надёжный сигнал.
    if (player.querySelector(PLAYING_ANIM_SELECTOR)) return true;
    const pauseButton = player.querySelector(PAUSE_BUTTON_SELECTOR);
    if (pauseButton) return true;
    try {
      const ps = navigator.mediaSession && navigator.mediaSession.playbackState;
      if (ps === 'playing') return true;
      if (ps === 'paused') return false;
    } catch (_) {}
    const playButton = player.querySelector(PLAY_BUTTON_SELECTOR);
    if (playButton) {
      const pressed = playButton.getAttribute('aria-pressed');
      if (pressed === 'true') return true;
      if (pressed === 'false') return false;
      const label = (playButton.getAttribute('aria-label') || playButton.getAttribute('title') || '').toLowerCase();
      if (/пауза|pause/.test(label)) return true;
      if (/игра|play|воспроизв/.test(label)) return false;
      // Кнопка PLAY в DOM без анимации/паузы → скорее пауза.
      return false;
    }
    return null;
  }

  function parseTimecode(text) {
    const m = String(text || '').match(/(\d+):(\d{2})\s*[\/|]\s*(\d+):(\d{2})/);
    if (!m) return null;
    const position = Number(m[1]) * 60 + Number(m[2]);
    const duration = Number(m[3]) * 60 + Number(m[4]);
    if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0.5) return null;
    return { position, duration };
  }

  function normalizeProgress(duration, position) {
    if (!Number.isFinite(duration) || !Number.isFinite(position) || duration <= 0.5) return null;
    // Иногда приходят миллисекунды.
    if (duration > 10000) {
      duration = duration / 1000;
      position = position / 1000;
    }
    return {
      duration,
      position: Math.max(0, Math.min(position, duration)),
    };
  }

  function getProgressFromMediaElements() {
    try {
      const medias = document.querySelectorAll('audio, video');
      let best = null;
      for (let i = 0; i < medias.length; i++) {
        const m = medias[i];
        const duration = Number(m.duration);
        const position = Number(m.currentTime);
        const norm = normalizeProgress(duration, position);
        if (!norm) continue;
        const paused = !!m.paused;
        if (!best) {
          best = { duration: norm.duration, position: norm.position, paused };
        } else if (!paused && best.paused) {
          best = { duration: norm.duration, position: norm.position, paused };
        } else if (paused === best.paused && norm.duration > best.duration) {
          best = { duration: norm.duration, position: norm.position, paused };
        }
      }
      return best ? { duration: best.duration, position: best.position } : null;
    } catch (_) {
      return null;
    }
  }

  function getProgress(player) {
    // Как BetaMod: сначала fiber (timecodeClassName), затем DOM/media.
    const fiber = searchAnyProperty(player, [
      'timecodeClassName',
      'currentTimecodeClassName',
      'position',
      'progress',
    ]);
    if (fiber) {
      const duration = Number(fiber.duration != null ? fiber.duration : fiber.durationSec);
      const position = Number(
        fiber.position != null
          ? fiber.position
          : fiber.currentTime != null
            ? fiber.currentTime
            : fiber.progress
      );
      const norm = normalizeProgress(duration, position);
      if (norm) return norm;
    }

    const fromMedia = getProgressFromMediaElements();
    if (fromMedia) return fromMedia;

    const slider =
      player.querySelector('[data-test-id="VIBE_PLAYERBAR_TIMECODE_SLIDER"]') ||
      player.querySelector('[role="slider"][aria-valuenow]');
    if (slider) {
      const max = Number(slider.getAttribute('aria-valuemax'));
      const now = Number(slider.getAttribute('aria-valuenow'));
      const fromAria = normalizeProgress(max, now);
      if (fromAria) return fromAria;
      const fromText = parseTimecode(slider.getAttribute('aria-valuetext') || '');
      if (fromText) return fromText;
    }

    const tc =
      player.querySelector('[data-test-id="VIBE_PLAYERBAR_TIMECODE"]') ||
      player.querySelector('[data-test-id="VIBE_PLAYERBAR_TIMECODE_SLIDER"]');
    if (tc) {
      const fromDom = parseTimecode(tc.textContent || tc.getAttribute('aria-valuetext') || '');
      if (fromDom) return fromDom;
    }
    return null;
  }

  function isUiChromeTitle(title) {
    const t = String(title || '').trim();
    if (!t) return true;
    if (t === 'Промокод Upgrade') return true;
    return /^(коллекция|моя\s*волна|главная|главное|поиск|подкасты|детям|для\s*вас|волна|радио|концерты|тренды|новинки|collection|podcasts?|radio)$/i.test(
      t
    );
  }

  function looksLikeTrackMeta(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (typeof obj.title !== 'string' || !obj.title) return false;
    if (isUiChromeTitle(obj.title)) return false;
    // Навигационные сущности часто без артистов/обложки трека.
    const hasArtists = Array.isArray(obj.artists) && obj.artists.length > 0;
    const hasCover = Boolean(obj.coverUri || obj.ogImage);
    return Boolean(hasCover || hasArtists || (obj.id != null && hasArtists));
  }

  function deepFindTrackMeta(node, depth, seen) {
    if (!node || depth > 8 || seen.has(node)) return null;
    if (typeof node !== 'object') return null;
    seen.add(node);
    if (looksLikeTrackMeta(node)) return node;
    if (Array.isArray(node)) {
      for (let i = 0; i < Math.min(node.length, 40); i++) {
        const found = deepFindTrackMeta(node[i], depth + 1, seen);
        if (found) return found;
      }
      return null;
    }
    const keys = Object.keys(node);
    for (let i = 0; i < Math.min(keys.length, 60); i++) {
      const k = keys[i];
      if (k === 'stateNode' || k === 'ref' || k === '_owner') continue;
      try {
        const found = deepFindTrackMeta(node[k], depth + 1, seen);
        if (found) return found;
      } catch (_) {}
    }
    return null;
  }

  function getTrackMeta(player) {
    const fiber = searchAnyProperty(player, [
      'entityMeta',
      'track',
      'currentTrack',
      'meta',
      'queue',
      'playerState',
      'fullscreenPlayerEntityMeta',
    ]);
    if (fiber) {
      let meta = fiber.entityMeta || fiber.track || fiber.currentTrack || fiber.meta || fiber.fullscreenPlayerEntityMeta;
      if (!meta || typeof meta !== 'object') {
        if (fiber.title) meta = fiber;
      }
      if (looksLikeTrackMeta(meta)) {
        try {
          return JSON.parse(JSON.stringify(meta));
        } catch (_) {
          return meta;
        }
      }
    }

    // Глубокий обход fiber-дерева (новый Vibe UI часто прячет meta глубже).
    const fiberNode = findFiberNode(player);
    if (fiberNode) {
      const root = getRootFiber(fiberNode);
      const found = traverseFiber(root, (f) => {
        const buckets = [f.memoizedProps, f.memoizedState, f.pendingProps];
        for (let b = 0; b < buckets.length; b++) {
          const hit = deepFindTrackMeta(buckets[b], 0, new Set());
          if (hit) return hit;
        }
        return null;
      }, 0);
      if (found) {
        try {
          return JSON.parse(JSON.stringify(found));
        } catch (_) {
          return found;
        }
      }
    }
    return null;
  }

  function readMediaSession() {
    try {
      const md = navigator.mediaSession && navigator.mediaSession.metadata;
      if (!md || !md.title) return null;
      const artwork = md.artwork && md.artwork[0] && md.artwork[0].src;
      return {
        title: String(md.title || ''),
        artist: String(md.artist || ''),
        album: String(md.album || ''),
        coverUrl: artwork && /^https?:\/\//i.test(artwork) ? artwork : '',
      };
    } catch (_) {
      return null;
    }
  }

  function coverFromDom(player) {
    const imgs = player.querySelectorAll('img');
    for (let i = 0; i < imgs.length; i++) {
      const src = imgs[i].currentSrc || imgs[i].src || '';
      if (/avatars\.yandex\.net|get-music-content|%%|cover/i.test(src)) {
        return src.replace(/\/\d+x\d+/g, '/300x300');
      }
    }
    return '';
  }

  function dedupeRepeatedText(s) {
    const t = (s || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    if (t.length >= 6 && t.length % 2 === 0) {
      const half = t.slice(0, t.length / 2);
      if (half === t.slice(t.length / 2)) return half.trim();
    }
    // тройное повторение
    if (t.length >= 9 && t.length % 3 === 0) {
      const third = t.slice(0, t.length / 3);
      if (third + third + third === t) return third.trim();
    }
    return t;
  }

  function coverUrlFromMeta(meta) {
    const uri = meta && (meta.coverUri || meta.ogImage || meta.cover);
    if (!uri || typeof uri !== 'string') return '';
    let u = uri.trim();
    if (!u) return '';
    u = u.replace(/%%/g, '300x300');
    if (u.startsWith('//')) return 'https:' + u;
    if (/^https?:\/\//i.test(u)) return u;
    return 'https://' + u.replace(/^\/+/, '');
  }

  function trackUrlFromMeta(meta) {
    if (!meta || meta.id == null) return '';
    const id = String(meta.id);
    const albumId =
      meta.albumId != null
        ? meta.albumId
        : meta.albums && meta.albums[0] && meta.albums[0].id != null
          ? meta.albums[0].id
          : null;
    if (albumId != null) {
      return 'https://music.yandex.ru/album/' + albumId + '/track/' + id;
    }
    return 'https://music.yandex.ru/track/' + id;
  }

  function artistsFromMeta(meta) {
    if (Array.isArray(meta.artists)) {
      return meta.artists.map((a) => (a && a.name ? a.name : '')).filter(Boolean).join(', ');
    }
    if (typeof meta.artist === 'string') return meta.artist;
    if (meta.artist && meta.artist.name) return String(meta.artist.name);
    return '';
  }

  function readFromDomFallback(player) {
    const nameEl = player.querySelector('[data-test-id="VIBE_PLAYERBAR_TRACK_NAME"]');
    let raw = nameEl ? (nameEl.textContent || '').trim() : '';
    raw = dedupeRepeatedText(raw);
    let title = raw;
    let artist = '';
    // Часто в одной строке: "artist — title" (повторённой)
    const parts = raw.split(/\s+[—–-]\s+/);
    if (parts.length >= 2) {
      artist = dedupeRepeatedText(parts[0]);
      title = dedupeRepeatedText(parts.slice(1).join(' — '));
    }
    const ms = readMediaSession();
    if (ms) {
      if (ms.title && !isUiChromeTitle(ms.title)) title = ms.title;
      if (ms.artist) artist = ms.artist;
    }
    if (!title || isUiChromeTitle(title)) return null;
    const link = nameEl && nameEl.closest('a');
    const href = link && link.href ? String(link.href) : '';
    return {
      source: 'client',
      title,
      artist,
      album: ms && ms.album && !isUiChromeTitle(ms.album) ? ms.album : '',
      paused: isPlaying(player) === false,
      url: /music\.yandex\./i.test(href) ? href : '',
      coverUrl: coverFromDom(player) || (ms && ms.coverUrl) || '',
    };
  }

  function readPlayerState() {
    const player = findPlayer();
    if (!player) return null;

    const playing = isPlaying(player);
    if (playing == null) return null;

    const meta = getTrackMeta(player);
    if (!meta || !meta.title || isUiChromeTitle(meta.title)) {
      return readFromDomFallback(player);
    }

    const progress = getProgress(player);
    const title = meta.version ? String(meta.title) + ' ' + String(meta.version) : String(meta.title);
    if (isUiChromeTitle(title)) return readFromDomFallback(player);
    const album =
      meta.albums && meta.albums[0] && meta.albums[0].title
        ? String(meta.albums[0].title)
        : meta.album
          ? String(meta.album)
          : '';

    let coverUrl = coverUrlFromMeta(meta) || coverFromDom(player);
    if (!coverUrl) {
      const ms = readMediaSession();
      if (ms && ms.coverUrl) coverUrl = ms.coverUrl;
    }

    const payload = {
      source: 'client',
      title: dedupeRepeatedText(title),
      artist: artistsFromMeta(meta),
      album,
      paused: !playing,
      url: trackUrlFromMeta(meta),
      coverUrl,
    };

    if (progress) {
      payload.positionSec = progress.position;
      payload.durationSec = progress.duration;
    } else if (meta.durationMs != null && Number.isFinite(Number(meta.durationMs))) {
      payload.durationSec = Number(meta.durationMs) / 1000;
    }

    return payload;
  }

  function collectPropKeys(element) {
    const fiberNode = findFiberNode(element);
    if (!fiberNode) return { fiber: false, keys: [] };
    const root = getRootFiber(fiberNode);
    const keys = [];
    const seen = Object.create(null);
    traverseFiber(root, (fiber) => {
      if (fiber.memoizedProps && typeof fiber.memoizedProps === 'object') {
        Object.keys(fiber.memoizedProps).forEach((k) => {
          if (!seen[k]) {
            seen[k] = 1;
            keys.push(k);
          }
        });
      }
      return null;
    }, 0);
    return { fiber: true, keys: keys.slice(0, 100) };
  }

  let lastPosSec = null;
  let lastPosAt = 0;
  let lastInferredPlaying = null;

  function inferPlayingFromProgress(progress, uiPlaying) {
    // Явная пауза в UI важнее «инерции» прошлой позиции.
    if (uiPlaying === false) {
      lastInferredPlaying = false;
      if (progress) {
        lastPosSec = progress.position;
        lastPosAt = Date.now();
      }
      return false;
    }
    if (!progress) return uiPlaying;
    const now = Date.now();
    const pos = progress.position;
    if (lastPosSec != null && now - lastPosAt > 400) {
      const delta = pos - lastPosSec;
      const dt = (now - lastPosAt) / 1000;
      // Позиция растёт ≈ в реальном времени — трек играет, даже если UI врёт.
      if (delta > 0.35 && delta < dt * 2.5 + 1.5) {
        lastInferredPlaying = true;
      } else if (Math.abs(delta) < 0.25 && dt > 1.5) {
        // Таймкод стоит — пауза (в т.ч. если опрос реже 8с).
        lastInferredPlaying = false;
      }
    }
    lastPosSec = pos;
    lastPosAt = now;
    if (lastInferredPlaying != null) return lastInferredPlaying;
    return uiPlaying;
  }

  const rawReadPlayerState = readPlayerState;
  function readPlayerStateWithInfer() {
    const payload = rawReadPlayerState();
    if (!payload) return null;
    const progress =
      payload.positionSec != null && payload.durationSec != null
        ? { position: payload.positionSec, duration: payload.durationSec }
        : null;
    const playing = inferPlayingFromProgress(progress, payload.paused === false);
    payload.paused = !playing;
    return payload;
  }

  window.__ymRpcReadPlayer = readPlayerStateWithInfer;
  window.__ymRpcProbe = function () {
    const p = findPlayer();
    if (!p) return { no: 1 };
    const meta = getTrackMeta(p);
    return {
      sel: p.getAttribute('data-test-id'),
      playing: isPlaying(p),
      hasMeta: !!meta,
      metaTitle: meta && meta.title,
      metaCover: meta && (meta.coverUri || meta.ogImage || ''),
      prog: getProgress(p),
      props: collectPropKeys(p),
      nameText: ((p.querySelector('[data-test-id="VIBE_PLAYERBAR_TRACK_NAME"]') || {}).textContent || '').slice(0, 120),
    };
  };
  try {
    console.info('[ym-rpc-bridge] reader ready (VIBE_PLAYERBAR)');
  } catch (_) {}
})();
