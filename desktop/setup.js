'use strict';

const form = document.getElementById('form');
const $ = (id) => document.getElementById(id);

function syncMode() {
  const mode = form.mode.value;
  $('host-fields').hidden = mode !== 'host';
  $('url-field').hidden = !mode;
  $('url-hint').textContent =
    mode === 'host'
      ? 'Optional: the https address your other devices use for this computer, usually its Tailscale address. Leave empty to use rdrive only on this computer.'
      : 'The https address of the computer hosting your drive, usually its Tailscale address.';
}

(async () => {
  const s = await window.rdrive.getSettings();
  if (s.mode) form.mode.value = s.mode;
  form.serverUrl.value = s.serverUrl || '';
  form.dataDir.value = s.dataDir || '';
  form.envFile.value = s.envFile || '';
  form.port.value = s.port;
  form.startAtLogin.checked = s.startAtLogin;
  syncMode();
})();

for (const r of form.mode) r.addEventListener('change', syncMode);

$('pick-data').addEventListener('click', async () => {
  const dir = await window.rdrive.chooseFolder();
  if (dir) form.dataDir.value = dir;
});
$('pick-env').addEventListener('click', async () => {
  const file = await window.rdrive.chooseFile();
  if (file) form.envFile.value = file;
});
$('clear-env').addEventListener('click', () => (form.envFile.value = ''));

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
