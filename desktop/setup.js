'use strict';

const form = document.getElementById('form');
const $ = (id) => document.getElementById(id);
let defaultDataDir = '';

function syncMode() {
  const mode = form.mode.value;
  $('host-fields').hidden = mode !== 'host';
  $('url-field').hidden = !mode;
  $('detect').hidden = mode !== 'host';
  if (mode !== 'host') $('detect-status').hidden = true;
  $('url-hint').textContent =
    mode === 'host'
      ? 'The https address your other devices use for this computer. Found automatically when Tailscale is running; leave it empty to use rdrive only on this computer.'
      : 'The https address of the computer hosting your drive, usually its Tailscale address. You can paste it with or without https://.';
}

function showStatus(text, { warn = false, serveButton = false } = {}) {
  $('detect-status').hidden = false;
  $('detect-status').classList.toggle('warn', warn);
  $('detect-text').textContent = text;
  $('enable-serve').hidden = !serveButton;
}

// Fills in what can be found: the Tailscale address, and an existing data folder / settings file.
async function runDetect({ overwrite = false } = {}) {
  showStatus('Looking for Tailscale…');
  const d = await window.rdrive.detect(form.port.value);
  if (!d) return;
  const ts = d.tailscale;
  if (ts.found) {
    if (overwrite || !form.serverUrl.value.trim()) form.serverUrl.value = ts.url;
    if (ts.serving) showStatus(`✓ Found ${ts.url.replace('https://', '')}. Tailscale is serving rdrive to your devices.`);
    else showStatus(`Found ${ts.url.replace('https://', '')}. Tailscale isn't sharing rdrive with your devices yet.`, { warn: true, serveButton: true });
  } else {
    showStatus(`${ts.message} You can still use rdrive on this computer, or paste an address.`, { warn: true });
  }
  if (d.dataDirs.length && (!form.dataDir.value || form.dataDir.value === defaultDataDir) && d.dataDirs[0] !== form.dataDir.value) {
    form.dataDir.value = d.dataDirs[0];
    $('data-hint').innerHTML = '';
    $('data-hint').append(Object.assign(document.createElement('span'), { className: 'found', textContent: '✓ Found your existing rdrive data (accounts and files) here.' }));
  }
  if (d.envFile && !form.envFile.value) form.envFile.value = d.envFile;
}

(async () => {
  const s = await window.rdrive.getSettings();
  if (s.mode) form.mode.value = s.mode;
  form.serverUrl.value = s.serverUrl || '';
  form.dataDir.value = s.dataDir || '';
  defaultDataDir = s.dataDir || '';
  form.envFile.value = s.envFile || '';
  form.port.value = s.port;
  form.startAtLogin.checked = s.startAtLogin;
  syncMode();
  if (form.mode.value === 'host') runDetect();
})();

for (const r of form.mode) {
  r.addEventListener('change', () => {
    syncMode();
    if (form.mode.value === 'host') runDetect();
  });
}

$('detect').addEventListener('click', () => runDetect({ overwrite: true }));
$('enable-serve').addEventListener('click', async () => {
  $('enable-serve').disabled = true;
  showStatus('Turning on Tailscale HTTPS…', { warn: true });
  const r = await window.rdrive.enableServe(form.port.value);
  $('enable-serve').disabled = false;
  if (r && r.ok) return runDetect();
  showStatus(r && r.approveUrl ? `${r.message} A Tailscale page opened in your browser: approve it, then click Turn on again.` : `Couldn't turn it on: ${(r && r.message) || 'unknown error'}`, { warn: true, serveButton: true });
});

$('pick-data').addEventListener('click', async () => {
  const dir = await window.rdrive.chooseFolder();
  if (dir) form.dataDir.value = dir;
});
$('pick-env').addEventListener('click', async () => {
  const file = await window.rdrive.chooseFile();
  if (file) form.envFile.value = file;
});
$('clear-env').addEventListener('click', () => (form.envFile.value = ''));

form.serverUrl.addEventListener('input', () => {
  const val = form.serverUrl.value.trim();
  if (val.includes('/pair')) {
    form.mode.value = 'connect';
    syncMode();
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('error').textContent = '';
  const error = await window.rdrive.save({
    mode: form.mode.value,
    serverUrl: form.serverUrl.value,
    dataDir: form.dataDir.value,
    envFile: form.envFile.value,
    port: form.port.value,
    startAtLogin: form.startAtLogin.checked,
  });
  if (error) $('error').textContent = error;
});
