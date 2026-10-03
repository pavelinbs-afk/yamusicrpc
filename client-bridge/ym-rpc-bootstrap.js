'use strict';
/**
 * Точка входа вместо package.json main.
 * Оригинальный index.js не меняем — так надёжнее для Electron.
 */
try {
  require('./ym-rpc-hook.js');
} catch (e) {
  try {
    console.error('[ym-rpc-bridge] hook load failed', e && e.message ? e.message : e);
  } catch (_) {}
}
require('./index.js');
