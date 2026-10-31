// Fills in the setup screen for you: this computer's Tailscale address (and whether Tailscale is already
// serving rdrive over HTTPS), and an existing rdrive data folder and settings file to keep using.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tailscaleExe() {
  const candidates =
    process.platform === 'win32'
      ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe')]
      : process.platform === 'darwin'
        ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale']
        : ['/usr/bin/tailscale', '/usr/local/bin/tailscale'];
  return candidates.find((p) => fs.existsSync(p)) || 'tailscale';
}

function tailscale(args, timeout = 8000) {
  const r = spawnSync(tailscaleExe(), args, { encoding: 'utf8', timeout, windowsHide: true });
  if (r.error) return { ok: false, out: '', err: r.error.code === 'ENOENT' ? 'not-installed' : r.error.message };
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// { found, url, serving, message }
function detectTailscale(port) {
  const st = tailscale(['status', '--json']);
  if (!st.ok) {
    return { found: false, message: st.err === 'not-installed' ? 'Tailscale isn\'t installed on this computer.' : 'Tailscale isn\'t running or isn\'t signed in.' };
  }
  let info;
  try {
    info = JSON.parse(st.out);
  } catch {
    return { found: false, message: 'Couldn\'t read Tailscale\'s status.' };
  }
  const name = String((info.Self && info.Self.DNSName) || '').replace(/\.$/, '');
  if (!name) return { found: false, message: 'Tailscale has no address for this computer yet (is MagicDNS on?).' };
  const serve = tailscale(['serve', 'status']);
  const serving = serve.ok && new RegExp(`(127\\.0\\.0\\.1|localhost):${port}\\b`).test(serve.out);
  return { found: true, url: `https://${name}`, serving };
}

// Runs "tailscale serve --bg <port>". If Serve still needs approving for the tailnet, returns the link to do it.
function enableServe(port) {
  const r = tailscale(['serve', '--bg', String(port)], 20000);
  const text = `${r.out}\n${r.err}`;
  const link = /https:\/\/login\.tailscale\.com\/\S+/.exec(text);
  if (r.ok && !link) return { ok: true };
  if (link) return { ok: false, approveUrl: link[0], message: 'Tailscale needs you to allow HTTPS for your devices first.' };
  return { ok: false, message: (r.err || r.out || 'tailscale serve failed').slice(0, 300) };
}

// An rdrive data folder that already has accounts in it (e.g. from running rdrive with Node before).
function existingDataDirs(currentDataDir) {
  const home = os.homedir();
  const candidates = [currentDataDir, path.join(home, 'Documents', 'rdrive', 'data'), path.join(home, 'rdrive', 'data')];
  return [...new Set(candidates.filter(Boolean))].filter((d) => fs.existsSync(path.join(d, 'users.json')));
}

function existingEnvFile(dataDir) {
  const candidates = [path.join(path.dirname(dataDir || ''), '.env'), path.join(os.homedir(), 'Documents', 'rdrive', '.env')];
  return candidates.find((f) => f && fs.existsSync(f)) || '';
}

// "my-pc.tail1234.ts.net", "https://my-pc.tail1234.ts.net/" or "https://my-pc…/s/abc" -> "https://my-pc.tail1234.ts.net"
function normalizeAddress(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  try {
    return new URL(s).origin;
  } catch {
    return null;
  }
}

module.exports = { detectTailscale, enableServe, existingDataDirs, existingEnvFile, normalizeAddress };
