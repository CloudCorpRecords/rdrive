// Desktop app settings, stored as JSON in Electron's per-user data folder.
const fs = require('node:fs');
const path = require('node:path');

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
};

class Settings {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'settings.json');
    this.values = { ...DEFAULTS, dataDir: path.join(userDataDir, 'data') };
    try {
      Object.assign(this.values, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      // First run, or unreadable settings: start from defaults.
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
      let u;
      try {
        u = new URL(v.serverUrl);
      } catch {
        return 'The drive address is not a valid URL.';
      }
      if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) {
        return 'The drive address must start with https:// so your password and files are encrypted.';
      }
      v.serverUrl = u.origin;
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
