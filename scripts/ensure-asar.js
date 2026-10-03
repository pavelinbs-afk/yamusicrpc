'use strict';

/** Проверяет, что @electron/asar доступен после pnpm install (нужен установщику моста). */
try {
  require('@electron/asar');
  console.log('[ensure-asar] @electron/asar OK');
} catch (e) {
  console.error(
    '[ensure-asar] Не найден @electron/asar. Выполните: pnpm install\n',
    e && e.message ? e.message : e,
  );
  process.exitCode = 1;
}
