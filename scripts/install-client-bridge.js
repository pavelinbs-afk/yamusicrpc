#!/usr/bin/env node
'use strict';

/**
 * Мост RPC → Яндекс.Музыка.
 *
 * У Яндекс.Музыки в exe включена asar integrity: простая перезапись app.asar
 * ломает запуск. Поэтому установщик:
 *  1) бэкапит exe + app.asar
 *  2) отключает Fuse EnableEmbeddedAsarIntegrityValidation / OnlyLoadAppFromAsar
 *  3) патчит app.asar (bootstrap + hook + bridge), не трогая оригинальный index.js
 *
 * Usage:
 *   node scripts/install-client-bridge.js
 *   node scripts/install-client-bridge.js --uninstall
 *   node scripts/install-client-bridge.js --status
 */

const fs = (() => {
  try {
    return require('original-fs');
  } catch (_) {
    return require('fs');
  }
})();
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const BRIDGE_FILE = 'ym-rpc-bridge.js';
const HOOK_FILE = 'ym-rpc-hook.js';
const BOOTSTRAP_FILE = 'ym-rpc-bootstrap.js';
const BAK_ASAR = '.bak-ymrpc';
const BAK_EXE = '.bak-ymrpc';
const FUSES_MARK = '.ymrpc-fuses';

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function candidateBridgeDirs() {
  const dirs = [];
  if (process.env.YM_RPC_BRIDGE_DIR) dirs.push(process.env.YM_RPC_BRIDGE_DIR);
  dirs.push(path.join(__dirname, '..', 'client-bridge'));
  dirs.push(path.join(__dirname, 'client-bridge'));
  if (process.resourcesPath) {
    dirs.push(path.join(process.resourcesPath, 'client-bridge'));
    dirs.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'client-bridge'));
  }
  try {
    dirs.push(path.join(path.dirname(process.execPath), 'resources', 'client-bridge'));
  } catch (_) {}
  return uniq(dirs);
}

function resolveBridgeFile(filename) {
  for (const dir of candidateBridgeDirs()) {
    const p = path.join(dir, filename);
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Нет файла моста: ' + filename + ' (ожидался в client-bridge/)');
}

function candidateAsarPaths() {
  const local = process.env.LOCALAPPDATA || '';
  const pf = process.env.ProgramFiles || '';
  const pf86 = process.env['ProgramFiles(x86)'] || '';
  const home = os.homedir();
  const bases = uniq([
    local && path.join(local, 'Programs', 'YandexMusic'),
    local && path.join(local, 'Programs', 'Yandex Music'),
    local && path.join(local, 'Programs', 'Яндекс Музыка'),
    local && path.join(local, 'YandexMusic'),
    pf && path.join(pf, 'YandexMusic'),
    pf86 && path.join(pf86, 'YandexMusic'),
    path.join(home, 'AppData', 'Local', 'Programs', 'YandexMusic'),
  ]);
  const out = [];
  for (const b of bases) {
    out.push(path.join(b, 'resources', 'app.asar'));
    out.push(path.join(b, 'app.asar'));
  }
  return out;
}

function findYandexMusicExeDirs() {
  if (process.platform !== 'win32') return [];
  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$names = @('Y.Music.exe','YandexMusic.exe','Яндекс Музыка.exe')",
    '$dirs = New-Object System.Collections.Generic.HashSet[string]',
    'foreach ($n in $names) {',
    '  Get-Process | Where-Object { $_.Path } | ForEach-Object {',
    '    try {',
    '      $leaf = [IO.Path]::GetFileName($_.Path)',
    '      if ($names -contains $leaf) { [void]$dirs.Add([IO.Path]::GetDirectoryName($_.Path)) }',
    '    } catch {}',
    '  }',
    '}',
    '$dirs | ForEach-Object { $_ }',
  ].join('\n');
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      encoding: 'utf8', timeout: 20000, windowsHide: true,
    });
    return (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function resolveAsarPath(explicit) {
  if (explicit) {
    const p = path.resolve(explicit);
    if (fs.existsSync(p)) return p;
    throw new Error('app.asar не найден: ' + explicit);
  }
  for (const p of candidateAsarPaths()) {
    if (fs.existsSync(p)) return p;
  }
  for (const dir of findYandexMusicExeDirs()) {
    const a = path.join(dir, 'resources', 'app.asar');
    if (fs.existsSync(a)) return a;
  }
  return null;
}

function findYandexExe(asarPath) {
  const root = path.dirname(path.dirname(asarPath)); // .../YandexMusic
  try {
    const names = fs.readdirSync(root);
    for (const n of names) {
      if (!/\.exe$/i.test(n)) continue;
      if (/uninstall|elevate/i.test(n)) continue;
      return path.join(root, n);
    }
  } catch (_) {}
  return null;
}

function loadAsar() {
  try {
    return require('@electron/asar');
  } catch (_) {
    throw new Error('Нужен @electron/asar. Выполните: pnpm install');
  }
}

async function loadElectronFuses() {
  // v1 — CommonJS; v2 — ESM-only (require падает с ERR_REQUIRE_ESM).
  try {
    return require('@electron/fuses');
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (!/ERR_REQUIRE_ESM|ES Module/i.test(msg) && e && e.code !== 'ERR_REQUIRE_ESM') {
      throw e;
    }
    return import('@electron/fuses');
  }
}

async function disableAsarIntegrity(exePath) {
  const fuses = await loadElectronFuses();
  const { flipFuses, FuseVersion, FuseV1Options } = fuses;
  const bak = exePath + BAK_EXE;
  if (!fs.existsSync(bak)) fs.copyFileSync(exePath, bak);
  await flipFuses(exePath, {
    version: FuseVersion.V1,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: false,
  });
  try {
    fs.writeFileSync(exePath + FUSES_MARK, new Date().toISOString(), 'utf8');
  } catch (_) {}
}

async function createAsarPackage(asar, srcDir, destFile) {
  const ret = asar.createPackage(srcDir, destFile);
  if (ret && typeof ret.then === 'function') await ret;
  if (!fs.existsSync(destFile)) throw new Error('Не удалось собрать asar: ' + destFile);
}

async function replaceAsar(asar, extractDir, asarPath) {
  const tmpAsar = path.join(os.tmpdir(), `ym-rpc-bridge-${process.pid}-${Date.now()}.asartmp`);
  try {
    await createAsarPackage(asar, extractDir, tmpAsar);
    fs.copyFileSync(tmpAsar, asarPath);
  } catch (e) {
    const code = e && e.code ? e.code : '';
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
      throw new Error('Не удалось записать app.asar — закройте Яндекс.Музыку полностью и повторите.');
    }
    throw e;
  } finally {
    try { if (fs.existsSync(tmpAsar)) fs.unlinkSync(tmpAsar); } catch (_) {}
  }
}

function patchExtractedApp(extractDir) {
  const bridgeSrc = resolveBridgeFile(BRIDGE_FILE);
  const hookSrc = resolveBridgeFile(HOOK_FILE);
  const bootSrc = resolveBridgeFile(BOOTSTRAP_FILE);
  fs.copyFileSync(bridgeSrc, path.join(extractDir, BRIDGE_FILE));
  fs.copyFileSync(hookSrc, path.join(extractDir, HOOK_FILE));
  fs.copyFileSync(bootSrc, path.join(extractDir, BOOTSTRAP_FILE));

  const pkgPath = path.join(extractDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (!pkg.__ymRpcOriginalMain) pkg.__ymRpcOriginalMain = pkg.main || './index.js';
  pkg.main = './' + BOOTSTRAP_FILE;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');
}

function isPatchedAsar(asar, asarPath) {
  try {
    const pkgRaw = asar.extractFile(asarPath, 'package.json').toString('utf8');
    const pkg = JSON.parse(pkgRaw);
    return pkg.main === './' + BOOTSTRAP_FILE || pkg.main === BOOTSTRAP_FILE;
  } catch (_) {
    return false;
  }
}

async function install(asarPath) {
  const asar = loadAsar();
  const exePath = findYandexExe(asarPath);
  if (!exePath) throw new Error('Не найден exe Яндекс.Музыки рядом с resources');

  // Убрать остатки старого unpacked-режима
  const legacyApp = path.join(path.dirname(asarPath), 'app');
  const legacyDisabled = asarPath + '.ymrpc-disabled';
  if (fs.existsSync(legacyApp)) {
    try { fs.rmSync(legacyApp, { recursive: true, force: true }); } catch (_) {}
  }
  if (fs.existsSync(legacyDisabled) && !fs.existsSync(asarPath)) {
    fs.renameSync(legacyDisabled, asarPath);
  } else if (fs.existsSync(legacyDisabled)) {
    try { fs.unlinkSync(legacyDisabled); } catch (_) {}
  }

  const bakAsar = asarPath + BAK_ASAR;
  if (!fs.existsSync(bakAsar)) fs.copyFileSync(asarPath, bakAsar);

  await disableAsarIntegrity(exePath);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ym-rpc-bridge-'));
  try {
    // Всегда патчим от чистого бэкапа
    asar.extractAll(bakAsar, tmp);
    patchExtractedApp(tmp);
    await replaceAsar(asar, tmp, asarPath);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }

  return {
    ok: true,
    asarPath,
    exePath,
    backupAsar: bakAsar,
    backupExe: exePath + BAK_EXE,
    installed: true,
    mode: 'asar+fuses',
  };
}

async function uninstall(asarPath) {
  const bakAsar = asarPath + BAK_ASAR;
  const exePath = findYandexExe(asarPath);
  const legacyApp = path.join(path.dirname(asarPath), 'app');
  const legacyDisabled = asarPath + '.ymrpc-disabled';

  if (fs.existsSync(legacyApp)) {
    try { fs.rmSync(legacyApp, { recursive: true, force: true }); } catch (_) {}
  }
  if (fs.existsSync(legacyDisabled)) {
    if (!fs.existsSync(asarPath)) fs.renameSync(legacyDisabled, asarPath);
    else try { fs.unlinkSync(legacyDisabled); } catch (_) {}
  }

  if (fs.existsSync(bakAsar)) {
    fs.copyFileSync(bakAsar, asarPath);
  } else if (!isPatchedAsar(loadAsar(), asarPath)) {
    return { ok: true, asarPath, installed: false, message: 'Мост не был установлен' };
  } else {
    throw new Error('Нет app.asar.bak-ymrpc для восстановления');
  }

  if (exePath && fs.existsSync(exePath + BAK_EXE)) {
    try {
      fs.copyFileSync(exePath + BAK_EXE, exePath);
      try { fs.unlinkSync(exePath + FUSES_MARK); } catch (_) {}
    } catch (e) {
      // exe может быть занят
    }
  }

  return { ok: true, asarPath, exePath, installed: false, restoredFromBackup: true };
}

function status(asarPath) {
  if (!asarPath || !fs.existsSync(asarPath)) {
    // legacy unpacked?
    const maybe = asarPath || candidateAsarPaths()[0];
    const legacyApp = maybe ? path.join(path.dirname(maybe), 'app') : null;
    if (legacyApp && fs.existsSync(legacyApp)) {
      return {
        ok: true,
        asarPath: maybe,
        installed: true,
        mode: 'legacy-unpacked-app-dir',
        warning: 'Старый режим unpacked — удалите мост и установите заново',
      };
    }
    return { ok: false, installed: false, error: 'app.asar не найден' };
  }
  const asar = loadAsar();
  const installed = isPatchedAsar(asar, asarPath);
  const exePath = findYandexExe(asarPath);
  return {
    ok: true,
    asarPath,
    installed,
    mode: installed ? 'asar+fuses' : 'stock',
    backupPresent: fs.existsSync(asarPath + BAK_ASAR),
    exeBackupPresent: !!(exePath && fs.existsSync(exePath + BAK_EXE)),
    fusesMarked: !!(exePath && fs.existsSync(exePath + FUSES_MARK)),
    packageMain: (() => {
      try {
        return JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8')).main;
      } catch (_) { return null; }
    })(),
  };
}

function parseArgs(argv) {
  const out = { uninstall: false, status: false, asar: null };
  for (const a of argv) {
    if (a === '--uninstall') out.uninstall = true;
    else if (a === '--status') out.status = true;
    else if (a.startsWith('--asar=')) out.asar = a.slice('--asar='.length);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const asarPath = resolveAsarPath(args.asar);

  if (args.status) {
    const st = status(asarPath);
    console.log(JSON.stringify(st, null, 2));
    process.exit(st.ok ? 0 : 1);
  }
  if (!asarPath) {
    console.error('Не найден app.asar Яндекс.Музыки.');
    process.exit(2);
  }
  console.log('asar:', asarPath);

  if (args.uninstall) {
    console.log(JSON.stringify(await uninstall(asarPath), null, 2));
    console.log('Готово. Запустите Яндекс.Музыку.');
    process.exit(0);
  }

  console.log(JSON.stringify(await install(asarPath), null, 2));
  console.log('Мост установлен. Запустите Яндекс.Музыку и Yandex Music RPC.');
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e && e.message ? e.message : e);
    process.exit(1);
  });
}

module.exports = {
  resolveAsarPath,
  install,
  uninstall,
  status,
  candidateAsarPaths,
};
