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

  /** Не поднимаемся к корню страницы — иначе ловим entityMeta плейлиста вместо трека. */
  function getPlayerScopedFiber(fiber, maxUp) {
    let current = fiber;
    let steps = 0;
    const limit = maxUp == null ? 14 : maxUp;
    while (current && current.return && steps < limit) {
      current = current.return;
      steps += 1;
    }
    return current || fiber;
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
    const scoped = getPlayerScopedFiber(fiberNode, 14);
    return traverseFiber(scoped, (fiber) => {
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
    const s = String(text || '');
    let m = s.match(/(\d+):(\d{2})\s*[\/|]\s*(\d+):(\d{2})/);
    if (m) {
      const position = Number(m[1]) * 60 + Number(m[2]);
      const duration = Number(m[3]) * 60 + Number(m[4]);
      if (Number.isFinite(position) && Number.isFinite(duration) && duration > 0.5) {
        return { position, duration };
      }
    }
    // Иногда "1:23 из 3:45" / "1:23 of 3:45"
    m = s.match(/(\d+):(\d{2})\s*(?:из|of|\/)\s*(\d+):(\d{2})/i);
    if (m) {
      const position = Number(m[1]) * 60 + Number(m[2]);
      const duration = Number(m[3]) * 60 + Number(m[4]);
      if (Number.isFinite(position) && Number.isFinite(duration) && duration > 0.5) {
        return { position, duration };
      }
    }
    return null;
  }

  function normalizeProgress(duration, position) {
    if (!Number.isFinite(duration) || !Number.isFinite(position) || duration <= 0.5) return null;
    // Иногда приходят миллисекунды.
    if (duration > 10000) {
      duration = duration / 1000;
      if (position > 500) position = position / 1000;
    }
    if (position < 0) return null;
    return {
      duration,
      position: Math.max(0, Math.min(position, duration)),
    };
  }

  function progressFromObject(obj, fallbackDurationSec) {
    if (!obj || typeof obj !== 'object') return null;
    let duration = NaN;
    if (obj.duration != null) duration = Number(obj.duration);
    else if (obj.durationSec != null) duration = Number(obj.durationSec);
    else if (obj.durationMs != null) duration = Number(obj.durationMs) / 1000;
    else if (fallbackDurationSec != null) duration = Number(fallbackDurationSec);

    let position = NaN;
    if (obj.position != null) position = Number(obj.position);
    else if (obj.currentTime != null) position = Number(obj.currentTime);
    else if (obj.positionSec != null) position = Number(obj.positionSec);
    else if (obj.positionMs != null) position = Number(obj.positionMs) / 1000;
    else if (obj.progress != null && Number.isFinite(duration)) {
      const pr = Number(obj.progress);
      if (!Number.isFinite(pr)) position = NaN;
      else if (pr >= 0 && pr <= 1) position = pr * (duration > 10000 ? duration / 1000 : duration);
      else position = pr;
    }
    return normalizeProgress(duration, position);
  }

  function deepFindProgress(node, depth, seen, fallbackDurationSec) {
    if (!node || depth > 10 || seen.has(node)) return null;
    if (typeof node !== 'object') return null;
    seen.add(node);
    const direct = progressFromObject(node, fallbackDurationSec);
    // Не принимаем «пустые» прогрессы без явных полей времени.
    if (
      direct &&
      (node.duration != null ||
        node.durationSec != null ||
        node.durationMs != null ||
        node.position != null ||
        node.currentTime != null ||
        node.positionSec != null ||
        node.timecodeClassName != null ||
        node.currentTimecodeClassName != null)
    ) {
      return direct;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < Math.min(node.length, 50); i++) {
        const found = deepFindProgress(node[i], depth + 1, seen, fallbackDurationSec);
        if (found) return found;
      }
      return null;
    }
    const keys = Object.keys(node);
    for (let i = 0; i < Math.min(keys.length, 80); i++) {
      const k = keys[i];
      if (k === 'stateNode' || k === 'ref' || k === '_owner' || k === 'children') continue;
      try {
        const found = deepFindProgress(node[k], depth + 1, seen, fallbackDurationSec);
        if (found) return found;
      } catch (_) {}
    }
    return null;
  }

  function getProgressFromFiberDeep(player, fallbackDurationSec) {
    const fiberNode = findFiberNode(player);
    if (!fiberNode) return null;
    const scoped = getPlayerScopedFiber(fiberNode, 14);
    return traverseFiber(
      scoped,
      (f) => {
        const buckets = [f.memoizedProps, f.memoizedState, f.pendingProps];
        for (let b = 0; b < buckets.length; b++) {
          const hit = deepFindProgress(buckets[b], 0, new Set(), fallbackDurationSec);
          if (hit) return hit;
        }
        return null;
      },
      0
    );
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

  function getProgressFromDomText(player) {
    const combined = parseTimecode(player.innerText || player.textContent || '');
    if (combined) return combined;
    const times = [];
    const re = /\b(\d{1,2}):([0-5]\d)\b/g;
    const src = String(player.innerText || '');
    let m;
    while ((m = re.exec(src)) && times.length < 10) {
      times.push(Number(m[1]) * 60 + Number(m[2]));
    }
    if (times.length >= 2) {
      const position = times[0];
      let duration = times[1];
      for (let i = 1; i < times.length; i++) {
        if (times[i] >= position && times[i] > duration) duration = times[i];
      }
      // Типичный playerbar: текущее, затем длительность (>= текущего).
      for (let i = 1; i < times.length; i++) {
        if (times[i] >= position) {
          duration = times[i];
          break;
        }
      }
      return normalizeProgress(duration, position);
    }
    return null;
  }

  function getProgressFromSliders(player, fallbackDurationSec) {
    const sliders = player.querySelectorAll(
      '[data-test-id="VIBE_PLAYERBAR_TIMECODE_SLIDER"], [role="slider"][aria-valuenow], input[type="range"]'
    );
    for (let i = 0; i < sliders.length; i++) {
      const slider = sliders[i];
      const max = Number(
        slider.getAttribute('aria-valuemax') != null
          ? slider.getAttribute('aria-valuemax')
          : slider.max
      );
      const now = Number(
        slider.getAttribute('aria-valuenow') != null
          ? slider.getAttribute('aria-valuenow')
          : slider.value
      );
      const fromText = parseTimecode(
        slider.getAttribute('aria-valuetext') || slider.getAttribute('aria-label') || ''
      );
      if (fromText) return fromText;
      if (Number.isFinite(max) && Number.isFinite(now) && max > 0.5) {
        // Секунды
        if (max > 1.5) {
          const norm = normalizeProgress(max, now);
          if (norm) return norm;
        }
        // Доля 0..1 или проценты 0..100 → нужна длительность трека
        if (fallbackDurationSec != null && fallbackDurationSec > 0.5) {
          const frac = max <= 1.0001 ? now / (max || 1) : now / max;
          const norm = normalizeProgress(fallbackDurationSec, frac * fallbackDurationSec);
          if (norm) return norm;
        }
      }
    }
    return null;
  }

  function getProgress(player, fallbackDurationSec) {
    // 1) Как BetaMod: timecodeClassName / currentTimecodeClassName
    const fiber = searchAnyProperty(player, ['timecodeClassName', 'currentTimecodeClassName']);
    if (fiber) {
      const norm = progressFromObject(fiber, fallbackDurationSec);
      if (norm) return norm;
    }

    // 2) Глубокий обход fiber — Vibe часто прячет duration/position глубже
    const deep = getProgressFromFiberDeep(player, fallbackDurationSec);
    if (deep) return deep;

    // 3) HTMLMediaElement
    const fromMedia = getProgressFromMediaElements();
    if (fromMedia) return fromMedia;

    // 4) Слайдеры / aria
    const fromSlider = getProgressFromSliders(player, fallbackDurationSec);
    if (fromSlider) return fromSlider;

    // 5) Текст таймкода в playerbar (в т.ч. раздельные mm:ss)
    const tc =
      player.querySelector('[data-test-id="VIBE_PLAYERBAR_TIMECODE"]') ||
      player.querySelector('[data-test-id="VIBE_PLAYERBAR_TIMECODE_SLIDER"]') ||
      player.querySelector('[data-test-id*="TIMECODE"]');
    if (tc) {
      const fromDom = parseTimecode(tc.textContent || tc.getAttribute('aria-valuetext') || '');
      if (fromDom) return fromDom;
    }
    return getProgressFromDomText(player);
  }

  function isUiChromeTitle(title) {
    const t = String(title || '').trim();
    if (!t) return true;
    if (t === 'Промокод Upgrade') return true;
    return /^(коллекция|моя\s*волна|главная|главное|поиск|подкасты|детям|для\s*вас|волна|радио|концерты|тренды|новинки|collection|podcasts?|radio)$/i.test(
      t
    );
  }

  /** Заголовки плейлистов/разделов, которые не должны попадать в Discord. */
  function isPlaylistOrSectionTitle(title) {
    const t = String(title || '').trim();
    if (!t) return true;
    if (isUiChromeTitle(t)) return true;
    if (/^лучшее\s*:/i.test(t)) return true;
    if (/^(плейлист|playlist|альбом|album|сборник|микс|wave|волна)\b/i.test(t)) return true;
    if (/^best of\b/i.test(t)) return true;
    return false;
  }

  function trackMetaScore(obj) {
    if (!obj || typeof obj !== 'object') return -1;
    if (typeof obj.title !== 'string' || !obj.title) return -1;
    if (isPlaylistOrSectionTitle(obj.title)) return -1;
    const type = obj.type != null ? String(obj.type).toLowerCase() : '';
    if (type && /^(playlist|album|artist|user|podcast|various|brand|clip)$/.test(type)) return -1;
    if (type && type !== 'music' && type !== 'track' && type !== 'audio') {
      // Неизвестные типы — только если есть явные признаки трека.
    }
    const cover = String(obj.coverUri || obj.ogImage || '');
    if (/get-music-user-playlist|\/users\/[^/]+\/playlists\//i.test(cover)) return -1;
    const hasArtists = Array.isArray(obj.artists) && obj.artists.length > 0;
    const durationMs = Number(obj.durationMs);
    const hasDuration = Number.isFinite(durationMs) && durationMs > 1000;
    // Как BetaMod zod: трек обычно имеет artists + durationMs (+ id).
    if (!hasArtists || !hasDuration) return -1;
    let score = 10;
    if (type === 'music' || type === 'track' || type === 'audio') score += 5;
    if (obj.id != null) score += 3;
    if (obj.albums && obj.albums[0]) score += 2;
    if (cover && !/playlist/i.test(cover)) score += 1;
    return score;
  }

  function looksLikeTrackMeta(obj) {
    return trackMetaScore(obj) >= 10;
  }

  function deepFindTrackMeta(node, depth, seen, best) {
    if (!node || depth > 8 || seen.has(node)) return best;
    if (typeof node !== 'object') return best;
    seen.add(node);
    const score = trackMetaScore(node);
    if (score > (best ? best.score : -1)) {
      best = { meta: node, score };
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < Math.min(node.length, 40); i++) {
        best = deepFindTrackMeta(node[i], depth + 1, seen, best);
      }
      return best;
    }
    const keys = Object.keys(node);
    for (let i = 0; i < Math.min(keys.length, 60); i++) {
      const k = keys[i];
      if (k === 'stateNode' || k === 'ref' || k === '_owner' || k === 'children') continue;
      try {
        best = deepFindTrackMeta(node[k], depth + 1, seen, best);
      } catch (_) {}
    }
    return best;
  }

  function cloneMeta(meta) {
    try {
      return JSON.parse(JSON.stringify(meta));
    } catch (_) {
      return meta;
    }
  }

  function getTrackMeta(player) {
    let best = null;

    const fiber = searchAnyProperty(player, [
      'entityMeta',
      'track',
      'currentTrack',
      'fullscreenPlayerEntityMeta',
    ]);
    if (fiber) {
      const candidates = [
        fiber.entityMeta,
        fiber.track,
        fiber.currentTrack,
        fiber.fullscreenPlayerEntityMeta,
        fiber.title ? fiber : null,
      ];
      for (let i = 0; i < candidates.length; i++) {
        const meta = candidates[i];
        const score = trackMetaScore(meta);
        if (score > (best ? best.score : -1)) best = { meta, score };
      }
    }

    // Только в поддереве playerbar (не весь документ — иначе заголовок плейлиста).
    const fiberNode = findFiberNode(player);
    if (fiberNode) {
      const scoped = getPlayerScopedFiber(fiberNode, 14);
      traverseFiber(
        scoped,
        (f) => {
          const buckets = [f.memoizedProps, f.memoizedState, f.pendingProps];
          for (let b = 0; b < buckets.length; b++) {
            const hit = deepFindTrackMeta(buckets[b], 0, new Set(), null);
            if (hit && hit.score > (best ? best.score : -1)) best = hit;
          }
          return null;
        },
        0
      );
    }

    return best && best.meta ? cloneMeta(best.meta) : null;
  }

  function readPlayerbarDomTrack(player) {
    const nameEl =
      player.querySelector('[data-test-id="VIBE_PLAYERBAR_TRACK_NAME"]') ||
      player.querySelector('[data-test-id="TRACK_TITLE"]') ||
      player.querySelector('a[href*="/track/"]');
    let raw = nameEl ? (nameEl.textContent || '').trim() : '';
    raw = dedupeRepeatedText(raw);
    if (!raw || isPlaylistOrSectionTitle(raw)) return null;

    let title = raw;
    let artist = '';
    const artistEl =
      player.querySelector('[data-test-id="VIBE_PLAYERBAR_TRACK_ARTIST"]') ||
      player.querySelector('[data-test-id="TRACK_ARTIST"]') ||
      player.querySelector('a[href*="/artist/"]');
    if (artistEl) {
      artist = dedupeRepeatedText((artistEl.textContent || '').trim());
    }
    if (!artist) {
      const parts = raw.split(/\s+[—–-]\s+/);
      if (parts.length >= 2) {
        artist = dedupeRepeatedText(parts[0]);
        title = dedupeRepeatedText(parts.slice(1).join(' — '));
      }
    }
    if (isPlaylistOrSectionTitle(title)) return null;

    const link = nameEl && nameEl.closest('a');
    const href = link && link.href ? String(link.href) : '';
    return {
      title,
      artist,
      url: /\/track\//i.test(href) ? href : '',
      coverUrl: coverFromDom(player),
    };
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

  function attachProgress(payload, player, meta) {
    const fallbackDur =
      meta && meta.durationMs != null && Number.isFinite(Number(meta.durationMs))
        ? Number(meta.durationMs) / 1000
        : payload.durationSec != null
          ? Number(payload.durationSec)
          : null;
    const progress = getProgress(player, fallbackDur);
    if (progress) {
      payload.positionSec = progress.position;
      payload.durationSec = progress.duration;
    } else if (
      payload.durationSec == null &&
      fallbackDur != null &&
      Number.isFinite(fallbackDur) &&
      fallbackDur > 0.5
    ) {
      payload.durationSec = fallbackDur;
    }
    return payload;
  }

  function readFromDomFallback(player) {
    const dom = readPlayerbarDomTrack(player);
    const ms = readMediaSession();
    let title = dom && dom.title ? dom.title : '';
    let artist = dom && dom.artist ? dom.artist : '';
    let album = '';
    let url = dom && dom.url ? dom.url : '';
    let coverUrl = (dom && dom.coverUrl) || '';

    if (ms) {
      // Media Session обычно точнее страницы плейлиста.
      if (ms.title && !isPlaylistOrSectionTitle(ms.title)) title = ms.title;
      if (ms.artist && !isPlaylistOrSectionTitle(ms.artist)) artist = ms.artist;
      if (ms.album && !isPlaylistOrSectionTitle(ms.album) && ms.album !== title) album = ms.album;
      if (ms.coverUrl) coverUrl = coverUrl || ms.coverUrl;
    }

    if (!title || isPlaylistOrSectionTitle(title)) return null;
    if (artist && (artist === title || isPlaylistOrSectionTitle(artist))) artist = '';
    if (album && (album === title || isPlaylistOrSectionTitle(album))) album = '';

    return attachProgress(
      {
        source: 'client',
        title: dedupeRepeatedText(title),
        artist: dedupeRepeatedText(artist),
        album: dedupeRepeatedText(album),
        paused: isPlaying(player) === false,
        url,
        coverUrl,
      },
      player,
      null
    );
  }

  function readPlayerState() {
    const player = findPlayer();
    if (!player) return null;

    const playing = isPlaying(player);
    if (playing == null) return null;

    const dom = readPlayerbarDomTrack(player);
    const ms = readMediaSession();
    const meta = getTrackMeta(player);

    // Приоритет: DOM playerbar / Media Session > fiber meta (meta часто = открытый плейлист).
    let title = '';
    let artist = '';
    let album = '';
    let url = '';
    let coverUrl = '';

    if (dom && dom.title) {
      title = dom.title;
      artist = dom.artist || '';
      url = dom.url || '';
      coverUrl = dom.coverUrl || '';
    }
    if (ms && ms.title && !isPlaylistOrSectionTitle(ms.title)) {
      title = ms.title;
      if (ms.artist && !isPlaylistOrSectionTitle(ms.artist)) artist = ms.artist;
      if (ms.album && !isPlaylistOrSectionTitle(ms.album) && ms.album !== title) album = ms.album;
      if (ms.coverUrl) coverUrl = coverUrl || ms.coverUrl;
    }

    if (meta && looksLikeTrackMeta(meta)) {
      const metaTitle = meta.version
        ? String(meta.title) + ' ' + String(meta.version)
        : String(meta.title);
      const metaArtist = artistsFromMeta(meta);
      // Fiber meta берём, только если DOM/MS пусты или согласованы с треком.
      if (!title || !isPlaylistOrSectionTitle(metaTitle)) {
        if (!title || title === metaTitle || !dom) {
          title = metaTitle;
          if (metaArtist) artist = metaArtist;
        } else if (dom && metaTitle === dom.title) {
          title = metaTitle;
          if (metaArtist) artist = metaArtist;
        }
      }
      if (!album && meta.albums && meta.albums[0] && meta.albums[0].title) {
        const alb = String(meta.albums[0].title);
        if (!isPlaylistOrSectionTitle(alb) && alb !== title) album = alb;
      }
      coverUrl = coverUrl || coverUrlFromMeta(meta);
      url = url || trackUrlFromMeta(meta);
    }

    if (!title || isPlaylistOrSectionTitle(title)) {
      return readFromDomFallback(player);
    }
    if (artist && (artist === title || isPlaylistOrSectionTitle(artist))) artist = '';
    if (album && (album === title || isPlaylistOrSectionTitle(album))) album = '';

    return attachProgress(
      {
        source: 'client',
        title: dedupeRepeatedText(title),
        artist: dedupeRepeatedText(artist),
        album: dedupeRepeatedText(album),
        paused: !playing,
        url,
        coverUrl: coverUrl || coverFromDom(player),
      },
      player,
      meta
    );
  }

  function collectPropKeys(element) {
    const fiberNode = findFiberNode(element);
    if (!fiberNode) return { fiber: false, keys: [] };
    const scoped = getPlayerScopedFiber(fiberNode, 14);
    const keys = [];
    const seen = Object.create(null);
    traverseFiber(scoped, (fiber) => {
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
    const fallbackDur =
      meta && meta.durationMs != null && Number.isFinite(Number(meta.durationMs))
        ? Number(meta.durationMs) / 1000
        : null;
    const sliders = [];
    p.querySelectorAll('[role="slider"], input[type="range"], [data-test-id*="TIMECODE"]').forEach((el) => {
      sliders.push({
        id: el.getAttribute('data-test-id') || el.tagName,
        now: el.getAttribute('aria-valuenow') || el.value || '',
        max: el.getAttribute('aria-valuemax') || el.max || '',
        text: (el.getAttribute('aria-valuetext') || el.textContent || '').slice(0, 60),
      });
    });
    return {
      sel: p.getAttribute('data-test-id'),
      playing: isPlaying(p),
      hasMeta: !!meta,
      metaTitle: meta && meta.title,
      metaDurMs: meta && meta.durationMs,
      metaCover: meta && (meta.coverUri || meta.ogImage || ''),
      prog: getProgress(p, fallbackDur),
      fiberTc: !!searchAnyProperty(p, ['timecodeClassName', 'currentTimecodeClassName']),
      media: getProgressFromMediaElements(),
      domText: getProgressFromDomText(p),
      sliders: sliders.slice(0, 6),
      props: collectPropKeys(p),
      nameText: ((p.querySelector('[data-test-id="VIBE_PLAYERBAR_TRACK_NAME"]') || {}).textContent || '').slice(0, 120),
      timeSnippet: String(p.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
    };
  };
  try {
    console.info('[ym-rpc-bridge] reader ready (VIBE_PLAYERBAR)');
  } catch (_) {}
})();
