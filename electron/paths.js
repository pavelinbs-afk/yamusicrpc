'use strict';

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

function projectRoot() {
  return path.join(__dirname, '..');
}

/** Папка со скриптами .ps1 (в сборке — app.asar.unpacked/scripts). */
function getScriptsDir() {
  const root = projectRoot();
  if (!app.isPackaged) {
    return path.join(root, 'scripts');
  }
  const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'scripts');
  if (fs.existsSync(unpacked)) return unpacked;
  return path.join(root, 'scripts');
}

module.exports = {
  projectRoot,
  getScriptsDir,
};
