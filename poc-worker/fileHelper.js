const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeFileName(s) {
  return String(s).replace(/[^a-z0-9-_\.]/gi, '_').slice(0, 120);
}

function screenshotFilePath({ dir = 'screenshots', prefix = 'page', term = '', ext = 'png' } = {}) {
  ensureDir(dir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${prefix}_${safeFileName(term)}_${ts}.${ext}`;
  return path.join(dir, name);
}

// fileHelper.js (export)
module.exports = { screenshotFilePath };