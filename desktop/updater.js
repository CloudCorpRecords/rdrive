// Updates the desktop app itself from GitHub Releases (scripts/release.js publishes them).
//
// rdrive asks GitHub for the latest release when it starts, every few hours, and from the tray's
// "Check for updates". A newer version downloads in the background and is checked against the release's
// SHA256SUMS.txt (and on a Mac, the app's bundle id, version and signature) before anything is installed.
//
//  - Host mode (the drive runs on this computer, usually around the clock): the checked update installs
//    right away and rdrive restarts. The drive is offline for under a minute.
//  - Connect mode: the tray offers "Restart to update"; otherwise it installs when you quit.
//
// Windows: the release's per-user NSIS installer (rdrive-<version>-x64-setup.exe) runs silently over the
// installed app and reopens it. Mac: Electron's built-in updater needs an Apple Developer ID signature and
// rdrive's .dmg is ad-hoc signed, so a small script swaps rdrive.app itself after the app quits (keeping the
// old one until the new one is in place). Your files and settings live outside the app, so updates never touch them.
//
// Automatic checks are off with "Update automatically" unchecked in the tray, RDRIVE_NO_UPDATE_CHECK=1, or when
// running from source. RDRIVE_UPDATE_FEED points the updater at another feed (https, or http on 127.0.0.1) for testing.
const { app, Notification, dialog, shell } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const REPO = 'CloudCorpRecords/rdrive';
const BUNDLE_ID = 'io.github.cloudcorprecords.rdrive';
const FIRST_CHECK_MS = 10 * 1000;
const CHECK_EVERY_MS = 4 * 3600 * 1000;
const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const WORK = path.join(os.tmpdir(), 'rdrive-updates');

// state: idle | checking | uptodate | available | downloading | ready | installing | manual | error
let S = { state: 'idle', current: app.getVersion(), latest: null, page: null, progress: 0, error: null, checkedAt: 0 };
let ready = null; // { version, file } once a checked update is staged
let rel = null; // the latest release, when it's newer
let staging = null;
let installAfterStage = false;
let installing = false;
let opts = { autoInstall: () => false, enabled: () => true, beforeInstall: async () => {} };
const listeners = [];

const ver = (v) => (String(v || '').match(/\d+/g) || [0]).slice(0, 3).map(Number);
const newer = (a, b) => {
  const x = ver(a);
  const y = ver(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
const log = (...a) => console.log('[updater]', ...a);

function set(patch) {
  S = { ...S, ...patch };
  for (const fn of listeners) {
    try {
      fn(S);
    } catch {}
  }
}

function feedUrl() {
  const custom = process.env.RDRIVE_UPDATE_FEED;
  if (custom && (/^https:\/\//.test(custom) || /^http:\/\/127\.0\.0\.1[:/]/.test(custom))) return custom;
  return `https://api.github.com/repos/${REPO}/releases/latest`;
}

// The asset this computer installs: the Windows setup .exe, or the .dmg for this Mac's processor.
function assetName(version) {
  if (WIN) return `rdrive-${version}-x64-setup.exe`;
  return `rdrive-${version}-${process.arch === 'arm64' ? 'arm64' : 'x64'}.dmg`;
}

async function latest() {
  const r = await fetch(feedUrl(), { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'rdrive-updater' }, signal: AbortSignal.timeout(15000) });
  if (r.status === 404) return { version: app.getVersion(), page: null }; // no releases yet
  if (!r.ok) throw new Error(r.status === 403 ? 'GitHub is limiting requests right now; try again later' : `GitHub said ${r.status}`);
  const d = await r.json();
  const version = String(d.tag_name || '').replace(/^v/, '');
  // The version ends up in file names and the Mac swap script's arguments: only plain x.y.z is accepted.
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version)) throw new Error(`the latest release has an unexpected version (${version.slice(0, 40)})`);
  const assets = d.assets || [];
  return {
    version,
    page: d.html_url,
    file: assets.find((a) => a.name === assetName(version)),
    sums: assets.find((a) => a.name === 'SHA256SUMS.txt'),
  };
}

async function download(url, dest, onBytes, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'rdrive-updater' }, redirect: 'follow', signal: AbortSignal.timeout(30 * 60 * 1000) });
      if (!r.ok || !r.body) throw new Error(`download failed (${r.status})`);
      const total = Number(r.headers.get('content-length')) || 0;
      let got = 0;
      const count = new Transform({
        transform(chunk, _e, cb) {
          got += chunk.length;
          if (onBytes) onBytes(got, total);
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(r.body), count, fs.createWriteStream(dest));
      return;
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((res) => setTimeout(res, 1000 * i)); // dropped connection: try again
    }
  }
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  return (r.stdout || '').trim();
}

function plist(appPath, key) {
  return run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')]);
}

// The running app bundle on a Mac: .../rdrive.app/Contents/MacOS/rdrive -> .../rdrive.app
function currentBundle() {
  return path.resolve(path.dirname(app.getPath('exe')), '..', '..');
}

function canReplace() {
  if (WIN) return true; // the installer replaces it wherever it is
  if (!MAC) return false;
  const bundle = currentBundle();
  if (!bundle.endsWith('.app') || bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) return false;
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    fs.accessSync(bundle, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Download and verify; returns the file to install (Windows installer, or the staged rdrive.app on a Mac).
async function stage(release, onProgress) {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  if (!release.sums) throw new Error('the release has no SHA256SUMS.txt to check the download against');
  const dest = path.join(WORK, assetName(release.version)); // built from the checked version, never the server's name
  log('downloading', path.basename(dest));
  await download(release.file.browser_download_url, dest, (got, total) => onProgress && total && onProgress(got / total));
  const sumsPath = path.join(WORK, 'SHA256SUMS.txt');
  await download(release.sums.browser_download_url, sumsPath);
  const line = fs.readFileSync(sumsPath, 'utf8').split(/\r?\n/).find((l) => l.trim().split(/\s+/).pop() === path.basename(dest));
  const want = line && line.trim().split(/\s+/)[0].toLowerCase();
  const got = await sha256(dest);
  if (!want || want !== got) throw new Error("the download's checksum doesn't match the release");
  if (WIN) return dest;
  const mnt = fs.mkdtempSync(path.join(os.tmpdir(), 'rdrive-update-'));
  const staged = path.join(WORK, 'rdrive.app');
  run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt, dest]);
  try {
    run('/usr/bin/ditto', [path.join(mnt, 'rdrive.app'), staged]);
  } finally {
    spawnSync('/usr/bin/hdiutil', ['detach', mnt, '-quiet']);
  }
  fs.rmSync(dest, { force: true });
  if (plist(staged, 'CFBundleIdentifier') !== BUNDLE_ID) throw new Error("the downloaded app isn't rdrive");
  const v = plist(staged, 'CFBundleShortVersionString');
  if (v !== release.version) throw new Error(`the downloaded app is version ${v}, not ${release.version}`);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]);
  spawnSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', staged]);
  return staged;
}

// Starts the installer (Windows) or a detached swap script (Mac); both wait for this process to exit.
function swap(relaunch) {
  if (!ready || installing) return false;
  installing = true;
  if (WIN) {
    const child = spawn(ready.file, relaunch ? ['/S', '--force-run'] : ['/S'], { detached: true, stdio: 'ignore' });
    child.unref();
    log('installing', ready.version, relaunch ? '(then reopening)' : '(on quit)');
    return true;
  }
  const script = path.join(WORK, 'install.sh');
  fs.writeFileSync(
    script,
    `#!/bin/bash
# Written by rdrive's updater (desktop/updater.js).
PID="$1"; NEW="$2"; OLD="$3"; RELAUNCH="$4"
for i in $(seq 1 120); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
BACKUP="$OLD.previous"
rm -rf "$BACKUP"
if mv "$OLD" "$BACKUP" && mv "$NEW" "$OLD"; then
  rm -rf "$BACKUP"
else
  [ -d "$OLD" ] || mv "$BACKUP" "$OLD"
fi
[ "$RELAUNCH" = "1" ] && open "$OLD"
`,
    { mode: 0o700 }
  );
  const child = spawn('/bin/bash', [script, String(process.pid), ready.file, currentBundle(), relaunch ? '1' : '0'], { detached: true, stdio: 'ignore' });
  child.unref();
  log('installing', ready.version, 'into', currentBundle(), relaunch ? '(then reopening)' : '(on quit)');
  return true;
}

async function restartInto() {
  set({ state: 'installing', progress: 1 });
  try {
    await opts.beforeInstall(ready.version);
  } catch {}
  if (swap(true)) setTimeout(() => app.quit(), 300);
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
  } catch {}
}

function startStaging() {
  if (staging || ready || !rel) return staging;
  set({ state: 'downloading', progress: 0, error: null });
  staging = stage(rel, (p) => set({ state: 'downloading', progress: p }))
    .then((file) => {
      ready = { version: rel.version, file };
      set({ state: 'ready', progress: 1 });
      if (installAfterStage || opts.autoInstall()) {
        notify('Updating rdrive', `Installing version ${rel.version}. rdrive restarts in a moment.`);
        restartInto();
      } else {
        notify(`rdrive ${rel.version} is ready`, 'Choose "Restart to update" in the tray, or it installs when you quit.');
      }
    })
    .catch((e) => {
      log('download failed:', e.message || e);
      installAfterStage = false;
      set({ state: 'error', error: `Couldn't download ${rel.version}: ${e.message || e}` });
    })
    .finally(() => {
      staging = null;
    });
  return staging;
}

let checking = null;
async function check({ manual = false } = {}) {
  if (!app.isPackaged && !process.env.RDRIVE_UPDATE_FEED) return S;
  if (installing || staging) return S;
  if (checking) return checking;
  if (ready) {
    set({ state: 'ready' });
    return S;
  }
  checking = (async () => {
    try {
      if (!manual && (process.env.RDRIVE_NO_UPDATE_CHECK || !opts.enabled())) return S;
      set({ state: 'checking', error: null });
      const r = await latest();
      const checkedAt = Date.now();
      if (!newer(r.version, app.getVersion())) {
        rel = null;
        set({ state: 'uptodate', latest: r.version, page: r.page, checkedAt });
        return S;
      }
      rel = r;
      if (!r.file || !canReplace()) {
        set({
          state: 'manual',
          latest: r.version,
          page: r.page,
          checkedAt,
          error: !r.file ? 'This release has no installer for this computer yet.' : 'rdrive can\'t replace itself where it\'s installed. Download it and drag it to Applications.',
        });
        return S;
      }
      set({ state: 'available', latest: r.version, page: r.page, checkedAt });
      startStaging(); // download in the background
      return S;
    } catch (e) {
      log('check failed:', e.message || e);
      set({ state: 'error', error: `Couldn't check for updates: ${e.message || e}`, checkedAt: Date.now() });
      return S;
    } finally {
      checking = null;
    }
  })();
  return checking;
}

// "Restart to update": install now, downloading first if needed.
async function install() {
  if (installing) return S;
  if (ready) return restartInto();
  if (S.state === 'manual' && S.page) return shell.openExternal(S.page);
  if (!rel) await check({ manual: true });
  if (ready) return restartInto();
  if (!rel || S.state === 'manual') return S;
  installAfterStage = true;
  startStaging();
  return S;
}

// The tray's "Check for updates": check now and say what happened.
async function menuCheck() {
  const st = await check({ manual: true });
  const show = (o) => dialog.showMessageBox(o);
  if (st.state === 'uptodate') return show({ type: 'info', message: 'rdrive is up to date', detail: `You have the newest version, ${S.current}.` });
  if (st.state === 'error') return show({ type: 'warning', message: "Couldn't check for updates", detail: st.error || '' });
  if (st.state === 'manual') {
    const { response } = await show({ type: 'info', buttons: ['Download', 'Later'], defaultId: 0, cancelId: 1, message: `rdrive ${st.latest} is out`, detail: st.error });
    if (response === 0) shell.openExternal(st.page);
    return;
  }
  if (st.state === 'available' || st.state === 'downloading' || st.state === 'ready') {
    const { response } = await show({
      type: 'info', buttons: ['Update now', 'Later'], defaultId: 0, cancelId: 1, message: `rdrive ${st.latest} is out`,
      detail: `You have ${S.current}. Update downloads it, checks it and restarts rdrive. Your files and settings stay as they are.`,
    });
    if (response === 0) install();
  }
}

// What the tray shows.
function statusLabel() {
  switch (S.state) {
    case 'checking': return 'Checking for updates…';
    case 'uptodate': return `Up to date (${S.current})`;
    case 'available': return `Version ${S.latest} found`;
    case 'downloading': return `Downloading ${S.latest}… ${Math.round((S.progress || 0) * 100)}%`;
    case 'ready': return `Version ${S.latest} is ready`;
    case 'installing': return `Installing ${S.latest}…`;
    case 'manual': return `Version ${S.latest} is out (download it)`;
    case 'error': return 'Update check failed';
    default: return `Version ${S.current}`;
  }
}

/**
 * options.autoInstall(): install as soon as an update is verified (host mode)
 * options.enabled():     automatic checks on/off
 * options.beforeInstall(version): e.g. stop the drive server cleanly
 */
function start(options) {
  opts = { ...opts, ...options };
  const live = app.isPackaged || !!process.env.RDRIVE_UPDATE_FEED;
  if (live) {
    setTimeout(() => check(), FIRST_CHECK_MS);
    setInterval(() => check(), CHECK_EVERY_MS).unref();
  }
  return {
    status: () => S,
    statusLabel,
    live,
    check: () => check({ manual: true }),
    menuCheck,
    install,
    onState: (fn) => listeners.push(fn),
    // Called from before-quit: a ready update installs on the way out.
    onQuit: () => (ready && !installing ? swap(false) : false),
  };
}

module.exports = { start, _test: { newer, assetName } };
