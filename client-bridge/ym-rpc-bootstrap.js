'use strict';
/**
 * Legacy asar entry (до YM 5.128).
 * На 5.128+ правка app.asar/fuses ломает music-application://desktop —
 * актуальный мост: CDP (--remote-debugging-port), см. scripts/install-client-bridge.js
 * и lib/cdp-bridge.js. Этот файл оставлен для старых клиентов.
 */
try {
  require('./ym-rpc-hook.js');
} catch (e) {
  try {
    console.error('[ym-rpc-bridge] hook load failed', e && e.message ? e.message : e);
  } catch (_) {}
}
require('./index.js');
