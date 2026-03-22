'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function getAppIconPath() {
  if (app.isPackaged) {
    const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'icon.ico');
    if (fs.existsSync(unpacked)) return unpacked;
  }
  const p = path.join(__dirname, 'icon.ico');
  if (fs.existsSync(p)) return p;
  return undefined;
}

module.exports = { getAppIconPath };
