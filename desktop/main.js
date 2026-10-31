// rdrive desktop app.
// Host mode: runs the rdrive server in the background on this computer, starts at login,
// and lives in the tray. Connect mode: a window onto a drive hosted on another computer.
const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, session, shell } = require('electron');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Settings, readEnvFile } = require('./settings');
const updater = require('./updater');
const detect = require('./detect');

const HIDDEN = process.argv.includes('--hidden');
let settings;
let mainWindow = null;
let setupWindow = null;
let tray = null;
let server = null; // child process in host mode
let serverState = 'stopped'; // stopped | starting | running | crashed
let restartDelay = 1000;
let quitting = false;
let usingLocalFallback = false;
let updates = null; // desktop/updater.js

function handlePairUri(uri) {
  try {
    if (!uri) return false;
    let url, token;
    // Only on first setup: an rdrive:// link must never silently move an already set-up app to another drive.
    if (settings.values.serverUrl || settings.values.mode === 'host') return false;
    if (uri.startsWith('rdrive://pair')) {
      const parsed = new URL(uri);
      url = detect.normalizeAddress(parsed.searchParams.get('url'));
      token = parsed.searchParams.get('token');
    }
    if (url && /^https:/.test(url) && /^[0-9a-f]{64}$/.test(token || '')) {
      settings.update({ mode: 'connect', serverUrl: url });
      if (setupWindow) setupWindow.close();
      showMain();
      if (mainWindow) mainWindow.loadURL(`${url}/pair#${token}`);
      return true;
    }
  } catch {}
  return false;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (e, argv) => {
    const pairArg = argv && argv.find((a) => typeof a === 'string' && a.startsWith('rdrive://pair'));
    if (pairArg && handlePairUri(pairArg)) return;
    showMain();
  });
}

app.on('open-url', (e, uri) => {
  e.preventDefault();
  handlePairUri(uri);
});

// ---------- paths ----------

// In development the server lives in the repo next to desktop/; in the installed app it's in resources/server.
function serverEntry() {
  return app.isPackaged ? path.join(process.resourcesPath, 'server', 'server.js') : path.join(__dirname, '..', 'server.js');
}

function asset(name) {
  return path.join(__dirname, 'assets', name);
}

function logFile() {
  return path.join(app.getPath('userData'), 'logs', 'server.log');
}

function localUrl() {
  return `http://127.0.0.1:${settings.values.port}`;
}

// The address the window opens: your Tailscale (or other HTTPS) address when set.
function driveUrl() {
  if (settings.values.mode === 'host' && (!settings.values.serverUrl || usingLocalFallback)) return localUrl();
  return settings.values.serverUrl;
}

// ---------- server (host mode) ----------

function openLog() {
  fs.mkdirSync(path.dirname(logFile()), { recursive: true });
  try {
    if (fs.statSync(logFile()).size > 5 * 1024 * 1024) fs.renameSync(logFile(), logFile() + '.old');
  } catch {}
  return fs.createWriteStream(logFile(), { flags: 'a' });
}

function startServer() {
  if (server) return;
  const v = settings.values;
  fs.mkdirSync(v.dataDir, { recursive: true });
  const env = {
    ...process.env,
    ...readEnvFile(v.envFile),
    // The app always serves on this computer only; Tailscale (or a proxy) provides HTTPS to other devices.
    RDRIVE_DATA: v.dataDir,
    RDRIVE_HTTP: '1',
    RDRIVE_TRUST_PROXY: '1',
    HOST: '127.0.0.1',
    PORT: String(v.port),
    ELECTRON_RUN_AS_NODE: '1',
  };
  if (v.serverUrl) env.RDRIVE_PUBLIC_URL = v.serverUrl;

  const log = openLog();
  log.write(`\n--- ${new Date().toISOString()} starting rdrive server ---\n`);
  serverState = 'starting';
  updateTray();
  server = fork(serverEntry(), [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], cwd: path.dirname(serverEntry()) });
  server.stdout.pipe(log, { end: false });
  server.stderr.pipe(log, { end: false });
  server.on('exit', (code) => {
    log.write(`--- server exited with code ${code} ---\n`);
    log.end();
    server = null;
    if (quitting) return;
    serverState = 'crashed';
    updateTray();
    // Restart with backoff so a persistent error (e.g. port in use) doesn't spin.
    setTimeout(startServer, restartDelay);
    restartDelay = Math.min(restartDelay * 2, 60_000);
  });
  waitForServer().then((ok) => {
    if (!ok || !server) return;
    serverState = 'running';
    restartDelay = 1000;
    updateTray();
    if (mainWindow && mainWindow.webContents.getURL().startsWith('data:')) loadDrive();
  });
}

function stopServer() {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.once('exit', resolve);
    server.kill();
  });
}

function waitForServer(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const req = http.get(`${localUrl()}/api/status`, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve(true);
        retry();
      });
      req.on('error', retry);
      req.setTimeout(2000, () => req.destroy());
    };
    const retry = () => (Date.now() > deadline ? resolve(false) : setTimeout(attempt, 300));
    attempt();
  });
}

// ---------- windows ----------

function secureWebPreferences(extra = {}) {
  return { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, ...extra };
}

function statusPage(title, text) {
  const html = `<!doctype html><meta charset="utf-8"><title>rdrive</title>
  <style>body{font:15px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f6f7f9;color:#1b1f24}
  @media(prefers-color-scheme:dark){body{background:#121418;color:#e7e9ec}}div{max-width:440px;padding:24px;text-align:center}p{opacity:.75}</style>
  <div><h2>${title}</h2><p>${text}</p></div>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 380,
    minHeight: 500,
    show: false,
    title: 'rdrive',
    icon: asset('icon.png'),
    autoHideMenuBar: true,
    webPreferences: secureWebPreferences(),
  });
  mainWindow.once('ready-to-show', () => {
    if (!HIDDEN) mainWindow.show();
  });
  guardNavigation(mainWindow.webContents);
  mainWindow.on('close', (e) => {
    // In host mode, closing the window keeps the drive running in the tray.
    if (!quitting && settings.values.mode === 'host') {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => (mainWindow = null));
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = aborted (e.g. a download)
    if (settings.values.mode === 'host' && settings.values.serverUrl && !usingLocalFallback && serverState === 'running') {
      // Tailscale might be off or still connecting; open the drive directly on this computer instead.
      usingLocalFallback = true;
      return loadDrive();
    }
    mainWindow.loadURL(statusPage("Can't reach your drive", `${desc} while opening ${url}. Check that the computer hosting rdrive is on and that Tailscale is connected, then choose View → Reload.`));
  });
  loadDrive();
}

function loadDrive() {
  if (!mainWindow) return;
  if (settings.values.mode === 'host' && serverState !== 'running') {
    mainWindow.loadURL(statusPage('Starting your drive…', 'This only takes a moment.'));
    return;
  }
  mainWindow.loadURL(driveUrl());
}

function showMain() {
  if (!settings.configured) return showSetup();
  if (!mainWindow) createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function showSetup() {
  if (setupWindow) return setupWindow.focus();
  setupWindow = new BrowserWindow({
    width: 620,
    height: 720,
    resizable: true,
    title: 'Set up rdrive',
    icon: asset('icon.png'),
    autoHideMenuBar: true,
    webPreferences: secureWebPreferences({ preload: path.join(__dirname, 'preload.js') }),
  });
  setupWindow.loadFile(path.join(__dirname, 'setup.html'));
  setupWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  setupWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  setupWindow.on('closed', () => (setupWindow = null));
}

// The drive window may only show your drive and GitHub's sign-in pages; everything else opens in your browser.
function guardNavigation(contents) {
  const allowed = (url) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.protocol === 'data:') return true;
    const drive = [settings.values.serverUrl, localUrl()].filter(Boolean).map((s) => new URL(s).origin);
    if (drive.includes(u.origin)) return true;
    return u.origin === 'https://github.com' && /^\/(login|session|sessions)\b/.test(u.pathname);
  };
  contents.on('will-navigate', (e, url) => {
    if (!allowed(url)) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });
  contents.on('will-redirect', (e, url) => {
    if (!allowed(url)) e.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    // PDFs open in their own window; everything else goes to the browser.
    if (allowed(url) && !url.startsWith('data:')) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: secureWebPreferences() } };
    }
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---------- tray ----------

function updateTray() {
  if (!tray) return;
  const v = settings.values;
  const host = v.mode === 'host';
  const stateLabel = { stopped: 'Stopped', starting: 'Starting…', running: 'Running', crashed: 'Restarting after an error…' }[serverState];
  const items = [
    { label: 'Open rdrive', click: showMain },
    { type: 'separator' },
  ];
  if (host) {
    items.push(
      { label: `Drive: ${stateLabel}`, enabled: false },
      { label: v.serverUrl ? `Address: ${v.serverUrl}` : 'Address: this computer only', enabled: false },
      { label: 'Open files folder', click: () => shell.openPath(path.join(v.dataDir, 'files')) },
      { label: 'Show server log', click: () => shell.openPath(logFile()) },
      {
        label: 'Start when I log in',
        type: 'checkbox',
        checked: v.startAtLogin,
        click: (item) => {
          settings.update({ startAtLogin: item.checked });
          applyLoginItem();
        },
      },
      { type: 'separator' }
    );
  } else if (v.serverUrl) {
    items.push({ label: `Drive: ${v.serverUrl}`, enabled: false }, { type: 'separator' });
  }
  if (updates && updates.live) {
    const st = updates.status();
    items.push({ label: updates.statusLabel(), enabled: false });
    if (st.state === 'ready' || st.state === 'available' || st.state === 'downloading') {
      items.push({ label: `Restart to update to ${st.latest}`, enabled: st.state !== 'installing', click: () => updates.install() });
    } else if (st.state === 'manual') {
      items.push({ label: `Download ${st.latest}…`, click: () => updates.install() });
    } else {
      items.push({ label: 'Check for updates…', enabled: st.state !== 'checking' && st.state !== 'installing', click: () => updates.menuCheck() });
    }
    items.push(
      {
        label: 'Update automatically',
        type: 'checkbox',
        checked: v.autoUpdate !== false,
        click: (item) => {
          if (settings.configured) settings.update({ autoUpdate: item.checked });
          else settings.values.autoUpdate = item.checked;
        },
      },
      { type: 'separator' }
    );
  }
  items.push(
    { label: 'Settings…', click: showSetup },
    { label: host ? 'Quit (stops the drive)' : 'Quit', click: () => app.quit() }
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.setToolTip(host ? `rdrive: ${stateLabel}` : 'rdrive');
}

function createTray() {
  const img = nativeImage.createFromPath(asset(process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
  if (process.platform === 'darwin') img.setTemplateImage(true);
  tray = new Tray(img);
  tray.on('click', showMain);
  updateTray();
}

function applyLoginItem() {
  const open = settings.values.mode === 'host' && settings.values.startAtLogin;
  app.setLoginItemSettings({ openAtLogin: open, openAsHidden: open, args: open ? ['--hidden'] : [] });
}

// ---------- settings IPC (only the local setup window has the preload) ----------

function fromSetupWindow(e) {
  return setupWindow && e.sender === setupWindow.webContents;
}

ipcMain.handle('settings:get', (e) => (fromSetupWindow(e) ? { ...settings.values, platform: process.platform } : null));

// Suggestions for the setup screen: Tailscale address, existing data folder and settings file.
ipcMain.handle('settings:detect', (e, port) => {
  if (!fromSetupWindow(e)) return null;
  const p = Number(port) || settings.values.port;
  const dataDirs = detect.existingDataDirs(settings.values.dataDir);
  return { tailscale: detect.detectTailscale(p), dataDirs, envFile: detect.existingEnvFile(dataDirs[0] || settings.values.dataDir) };
});

// "Turn on" in setup: make Tailscale serve rdrive over HTTPS to your devices.
ipcMain.handle('settings:enable-serve', (e, port) => {
  if (!fromSetupWindow(e)) return null;
  const r = detect.enableServe(Number(port) || settings.values.port);
  if (r.approveUrl) shell.openExternal(r.approveUrl);
  return r;
});

ipcMain.handle('settings:choose-folder', async (e) => {
  if (!fromSetupWindow(e)) return null;
  const r = await dialog.showOpenDialog(setupWindow, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('settings:choose-file', async (e) => {
  if (!fromSetupWindow(e)) return null;
  const r = await dialog.showOpenDialog(setupWindow, { properties: ['openFile', 'showHiddenFiles'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('settings:save', async (e, next) => {
  if (!fromSetupWindow(e)) return 'Not allowed.';
  const before = { ...settings.values };
  const error = settings.update({
    mode: next.mode,
    serverUrl: String(next.serverUrl || '').trim(),
    dataDir: String(next.dataDir || '').trim(),
    envFile: String(next.envFile || '').trim(),
    port: next.port,
    startAtLogin: !!next.startAtLogin,
  });
  if (error) return error;
  usingLocalFallback = false;
  const hostChanged = ['mode', 'dataDir', 'envFile', 'port', 'serverUrl'].some((k) => before[k] !== settings.values[k]);
  if (hostChanged) await stopServer();
  if (settings.values.mode === 'host') startServer();
  applyLoginItem();
  updateTray();
  // A pasted "Connect a device" link (https://drive/pair#token) also signs this computer in.
  const pairToken = /\/pair#([0-9a-f]{64})$/.exec(String(next.serverUrl || '').trim());
  const pairUrl = pairToken && settings.values.mode === 'connect' ? `${settings.values.serverUrl}/pair#${pairToken[1]}` : null;
  setupWindow.close();
  showMain();
  if (pairUrl && mainWindow) mainWindow.loadURL(pairUrl);
  else if (mainWindow) loadDrive();
  return null;
});

// ---------- app lifecycle ----------

// A short record of each start (version, how it was launched, mode), next to the server log.
function appLog(line) {
  try {
    const f = path.join(app.getPath('userData'), 'logs', 'app.log');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (fs.existsSync(f) && fs.statSync(f).size > 1024 * 1024) fs.renameSync(f, f + '.old');
    fs.appendFileSync(f, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

app.whenReady().then(() => {
  settings = new Settings(app.getPath('userData'));
  appLog(`start ${app.getVersion()} pid=${process.pid} args=${JSON.stringify(process.argv.slice(1))} settings=${settings.file} configured=${settings.configured} mode=${settings.values.mode} loadError=${settings.loadError || ''}`);
  // The drive never needs camera, microphone, location, notifications, etc.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
    ])
  );
  updates = updater.start({
    // A drive hosted here runs unattended, so verified updates install straight away.
    autoInstall: () => settings.values.mode === 'host',
    enabled: () => settings.values.autoUpdate !== false,
    beforeInstall: async () => {
      quitting = true;
      await stopServer();
    },
  });
  updates.onState(() => updateTray());
  createTray();
  if (!settings.configured) return showSetup();
  if (settings.values.mode === 'host') startServer();
  applyLoginItem();
  if (!HIDDEN) showMain();
});

app.on('activate', showMain); // macOS dock click

// Keep running in the tray when windows close (host mode); quit otherwise.
app.on('window-all-closed', () => {
  if (settings && settings.values.mode !== 'host' && process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (e) => {
  // An update that's downloaded and checked installs on the way out.
  if (updates) updates.onQuit();
  if (quitting) return;
  quitting = true;
  if (server) {
    e.preventDefault();
    stopServer().then(() => app.quit());
  }
});
