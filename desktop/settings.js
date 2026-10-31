// Desktop app settings, stored as JSON in Electron's per-user data folder.
const fs = require('node:fs');
const path = require('node:path');
const { normalizeAddress } = require('./detect');

const DEFAULTS = {
  // 'host' = run the drive on this computer; 'connect' = open a drive hosted elsewhere.
  mode: null,
  // The address you use for rdrive on every device, e.g. https://my-pc.my-tailnet.ts.net
  serverUrl: '',
  // Host mode only:
  dataDir: '',
  envFile: '', // optional .env with extra settings, e.g. the GitHub sign-in keys
  port: 8443,
  startAtLogin: true,
  autoUpdate: true, // check GitHub for new versions and install them (desktop/updater.js)
};

class Settings {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'settings.json');
    this.values = { ...DEFAULTS, dataDir: path.join(userDataDir, 'data') };
    this.loadError = null;
    try {
      Object.assign(this.values, JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^﻿/, '')));
    } catch (err) {
      // First run, or unreadable settings: start from defaults.
      if (err.code !== 'ENOENT') this.loadError = err.message;
    }
  }

  get configured() {
    return this.values.mode === 'host' || (this.values.mode === 'connect' && !!this.values.serverUrl);
  }

  // Validate and save. Returns an error message, or null on success.
  update(next) {
    const v = { ...this.values, ...next };
    if (!['host', 'connect'].includes(v.mode)) return 'Choose whether to host the drive here or connect to one.';
    if (v.serverUrl) {
      // Pasted addresses may lack "https://" or carry a path; keep just the origin.
      const origin = normalizeAddress(v.serverUrl);
      if (!origin) return 'The drive address doesn\'t look right. It should be like https://my-computer.my-tailnet.ts.net';
      const u = new URL(origin);
      if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) {
        return 'The drive address must use https:// so your password and files are encrypted.';
      }
      v.serverUrl = origin;
    } else if (v.mode === 'connect') {
      return 'Enter the address of your drive.';
    }
    if (v.mode === 'host') {
      if (!v.dataDir) return 'Choose a folder for your files.';
      v.port = Number(v.port) || 8443;
    }
    this.values = v;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(v, null, 2));
    return null;
  }
}

// Minimal .env reader: KEY=value lines; # comments and blank lines are ignored.
function readEnvFile(file) {
  const out = {};
  if (!file) return out;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

module.exports = { Settings, readEnvFile };
