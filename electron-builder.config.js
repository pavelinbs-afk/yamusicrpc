'use strict';

/**
 * Конфиг electron-builder: build из package.json + хук MSI
 * (тихая установка моста после InstallFinalize).
 *
 * msiProjectCreated получает каталог WiX-проекта, не путь к .wxs.
 */

const fs = require('fs');
const path = require('path');
const pkg = require('./package.json');

/** @param {string} wixProjectPath */
function injectMsiBridgeInstall(wixProjectPath) {
  const dir = wixProjectPath;
  let wxsPath = path.join(dir, 'installer.wxs');
  if (!fs.existsSync(wxsPath)) {
    const found = fs.readdirSync(dir).find((f) => f.endsWith('.wxs'));
    if (!found) {
      console.warn('[msiProjectCreated] .wxs не найден в', dir);
      return;
    }
    wxsPath = path.join(dir, found);
  }

  let xml = fs.readFileSync(wxsPath, 'utf8');
  if (xml.includes('InstallClientBridge')) return;

  const ca =
    '<CustomAction Id="InstallClientBridge" FileKey="mainExecutable" '
    + 'ExeCommand="--install-client-bridge" Execute="immediate" '
    + 'Impersonate="yes" Return="asyncNoWait"/>';

  if (xml.includes('Id="runAfterFinish"')) {
    xml = xml.replace(
      /<CustomAction Id="runAfterFinish"[^>]*\/>/,
      (m) => `${ca}\n    ${m}`,
    );
  } else if (xml.includes('</Product>')) {
    xml = xml.replace('</Product>', `    ${ca}\n  </Product>`);
  } else {
    console.warn('[msiProjectCreated] некуда вставить CustomAction:', wxsPath);
    return;
  }

  if (!xml.includes('Action="InstallClientBridge"')) {
    if (xml.includes('<InstallExecuteSequence>')) {
      xml = xml.replace(
        '<InstallExecuteSequence>',
        '<InstallExecuteSequence>\n      <Custom Action="InstallClientBridge" After="InstallFinalize"/>',
      );
    } else {
      xml = xml.replace(
        '</Product>',
        '    <InstallExecuteSequence>\n'
        + '      <Custom Action="InstallClientBridge" After="InstallFinalize"/>\n'
        + '    </InstallExecuteSequence>\n'
        + '  </Product>',
      );
    }
  }

  fs.writeFileSync(wxsPath, xml);
  console.log('[msiProjectCreated] добавлен InstallClientBridge →', wxsPath);
}

const build = { ...pkg.build };

// Хук на верхнем уровне Configuration (electron-builder).
build.msiProjectCreated = injectMsiBridgeInstall;

module.exports = build;
