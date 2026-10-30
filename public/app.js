'use strict';

const $ = (sel) => document.querySelector(sel);

const state = {
  user: null,
  path: '/',
  entries: [],
  selected: new Set(),
  menuTarget: null,
};

// ---------- helpers ----------

async function api(method, url, body) {
  const opts = { method, headers: { 'X-Rdrive': '1' }, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.user) {
    state.user = null;
    showAuth();
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function joinPath(dir, name) {
  return (dir === '/' ? '' : dir) + '/' + name;
}

function parentOf(p) {
  const parts = p.split('/').filter(Boolean);
  parts.pop();
  return '/' + parts.join('/');
}

function formatSize(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function formatDate(iso) {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

function svgIcon(kind) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `icon icon-${kind}`);
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('fill', 'currentColor');
  p.setAttribute('d', kind === 'folder'
    ? 'M3 6.5A2.5 2.5 0 0 1 5.5 4h3.6c.6 0 1.2.3 1.6.7L12 6h6.5A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z'
    : 'M6.5 2h7.1c.4 0 .8.2 1.1.4l4.4 4.4c.3.3.4.7.4 1.1V19.5A2.5 2.5 0 0 1 17 22H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2zM13 3.5V7c0 .8.7 1.5 1.5 1.5H18z');
  svg.appendChild(p);
  return svg;
}

const PREVIEW = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp'],
  video: ['mp4', 'webm', 'mov', 'm4v'],
  audio: ['mp3', 'wav', 'ogg', 'm4a', 'flac'],
  text: ['txt', 'md', 'log', 'csv', 'json'],
  pdf: ['pdf'],
};
function previewKind(name) {
  const ext = name.split('.').pop().toLowerCase();
  return Object.keys(PREVIEW).find((k) => PREVIEW[k].includes(ext)) || null;
}

function downloadUrl(p, inline) {
  return `/api/download?path=${encodeURIComponent(p)}${inline ? '&inline=1' : ''}`;
}

// ---------- auth ----------

let authMode = 'login';
let serverStatus = {};

function showAuth(status = serverStatus) {
  $('#drive-view').hidden = true;
  $('#auth-view').hidden = false;
  const setup = status && status.needsSetup;
  $('#sso').hidden = !(status && status.github) || setup;
  authMode = setup ? 'setup' : 'login';
  const form = $('#auth-form');
  $('#auth-error').textContent = '';
  $('#confirm-row').hidden = !setup;
  form.confirm.required = setup;
  form.password.autocomplete = setup ? 'new-password' : 'current-password';
  $('#auth-title').textContent = setup ? 'Create your account' : 'Sign in';
  $('#auth-submit').textContent = setup ? 'Create account' : 'Sign in';
  if (setup && !status.setupAllowedHere) {
    $('#auth-hint').textContent = 'No account exists yet. For security, the first account must be created on the computer running rdrive (open https://localhost:8443 there).';
    $('#auth-submit').disabled = true;
  } else {
    $('#auth-hint').textContent = setup ? 'This will be the owner account. Use a strong password: it protects every file you store here.' : '';
    $('#auth-submit').disabled = false;
  }
  form.username.focus();
}

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const err = $('#auth-error');
  err.textContent = '';
  if (authMode === 'setup' && form.password.value !== form.confirm.value) {
    err.textContent = 'Passwords do not match.';
    return;
  }
  $('#auth-submit').disabled = true;
  try {
    const data = await api('POST', authMode === 'setup' ? '/api/setup' : '/api/login', {
      username: form.username.value.trim(),
      password: form.password.value,
    });
    form.reset();
    serverStatus.needsSetup = false;
    state.user = data.user;
    showDrive();
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    $('#auth-submit').disabled = false;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  state.user = null;
  showAuth();
});

// ---------- drive ----------

function pathFromHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  try {
    return '/' + raw.split('/').filter(Boolean).map(decodeURIComponent).join('/');
  } catch {
    return '/';
  }
}

function navigate(p) {
  const hash = '#/' + p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  if (location.hash === hash) load();
  else location.hash = hash;
}

function showDrive() {
  $('#auth-view').hidden = true;
  $('#drive-view').hidden = false;
  $('#whoami').textContent = state.user;
  load();
  refreshUsage();
}

async function load() {
  state.path = pathFromHash();
  state.selected.clear();
  try {
    const data = await api('GET', `/api/list?path=${encodeURIComponent(state.path)}`);
    state.entries = data.entries;
  } catch (ex) {
    if (!state.user) return;
    toast(ex.message);
    if (state.path !== '/') return navigate('/');
    state.entries = [];
  }
  render();
}

let usageTimer;
function refreshUsage() {
  clearTimeout(usageTimer);
  usageTimer = setTimeout(async () => {
    try {
      const u = await api('GET', '/api/usage');
      $('#usage').textContent = `${u.files} file${u.files === 1 ? '' : 's'} · ${formatSize(u.bytes)}`;
    } catch {}
  }, 300);
}

function renderCrumbs(container, p, onClick, dropTargets) {
  container.replaceChildren();
  const parts = p.split('/').filter(Boolean);
  const paths = ['/'].concat(parts.map((_, i) => '/' + parts.slice(0, i + 1).join('/')));
  paths.forEach((cp, i) => {
    if (i) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '›';
      container.appendChild(sep);
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = i ? parts[i - 1] : 'My Drive';
    b.addEventListener('click', () => onClick(cp));
    if (dropTargets && cp !== p) makeDropTarget(b, cp);
    container.appendChild(b);
  });
}

function render() {
  renderCrumbs($('#crumbs'), state.path, navigate, true);
  const rows = $('#rows');
  rows.replaceChildren();
  $('#empty').hidden = state.entries.length > 0;

  for (const entry of state.entries) {
    const p = joinPath(state.path, entry.name);
    const row = document.createElement('div');
    row.className = 'row';
    row.tabIndex = 0;
    row.draggable = true;
    row.dataset.name = entry.name;

    const check = document.createElement('span');
    check.className = 'cell-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.setAttribute('aria-label', `Select ${entry.name}`);
    cb.addEventListener('change', () => toggleSelect(entry.name, cb.checked));
    check.appendChild(cb);

    const name = document.createElement('span');
    name.className = 'cell-name';
    name.appendChild(svgIcon(entry.type === 'folder' ? 'folder' : 'file'));
    const link = document.createElement('a');
    link.className = 'name';
    link.textContent = entry.name;
    link.title = entry.name;
    link.addEventListener('click', () => openEntry(entry));
    name.appendChild(link);

    const size = document.createElement('span');
    size.className = 'cell-size';
    size.textContent = entry.type === 'folder' ? '—' : formatSize(entry.size);

    const date = document.createElement('span');
    date.className = 'cell-date';
    date.textContent = formatDate(entry.modified);

    const menuCell = document.createElement('span');
    menuCell.className = 'cell-menu';
    const menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.textContent = '⋯';
    menuBtn.setAttribute('aria-label', `Actions for ${entry.name}`);
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenu(entry, menuBtn);
    });
    menuCell.appendChild(menuBtn);

    row.append(check, name, size, date, menuCell);
    row.addEventListener('dblclick', () => openEntry(entry));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') openEntry(entry);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(entry, null, e.clientX, e.clientY);
    });
    row.addEventListener('dragstart', (e) => {
      const names = state.selected.has(entry.name) ? [...state.selected] : [entry.name];
      e.dataTransfer.setData('application/x-rdrive', JSON.stringify(names.map((n) => joinPath(state.path, n))));
      e.dataTransfer.effectAllowed = 'move';
    });
    if (entry.type === 'folder') makeDropTarget(row, p);
    rows.appendChild(row);
  }
  syncSelectionUi();
}

// ---------- selection ----------

function toggleSelect(name, on) {
  if (on) state.selected.add(name);
  else state.selected.delete(name);
  syncSelectionUi();
}

function syncSelectionUi() {
  for (const row of document.querySelectorAll('#rows .row')) {
    const on = state.selected.has(row.dataset.name);
    row.classList.toggle('selected', on);
    row.querySelector('input[type="checkbox"]').checked = on;
  }
  const n = state.selected.size;
  $('#selection-actions').hidden = n === 0;
  $('#selection-count').textContent = `${n} selected`;
  const all = $('#select-all');
  all.checked = n > 0 && n === state.entries.length;
  all.indeterminate = n > 0 && n < state.entries.length;
}

$('#select-all').addEventListener('change', (e) => {
  state.selected = new Set(e.target.checked ? state.entries.map((x) => x.name) : []);
  syncSelectionUi();
});

$('#delete-selected').addEventListener('click', () => deletePaths([...state.selected].map((n) => joinPath(state.path, n))));
$('#move-selected').addEventListener('click', () => moveDialog([...state.selected].map((n) => joinPath(state.path, n))));

document.addEventListener('keydown', (e) => {
  if ($('#drive-view').hidden || document.querySelector('dialog[open]') || e.target.matches('input')) return;
  if (e.key === 'Delete' && state.selected.size) deletePaths([...state.selected].map((n) => joinPath(state.path, n)));
  if (e.key === 'Escape') {
    state.selected.clear();
    syncSelectionUi();
  }
});

// ---------- actions ----------

function openEntry(entry) {
  const p = joinPath(state.path, entry.name);
  if (entry.type === 'folder') return navigate(p);
  const kind = previewKind(entry.name);
  if (kind === 'pdf') return window.open(downloadUrl(p, true), '_blank', 'noopener');
  if (kind) return preview(entry.name, p, kind);
  download(p);
}

function download(p) {
  const a = document.createElement('a');
  a.href = downloadUrl(p);
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function preview(name, p, kind) {
  const body = $('#preview-body');
  body.replaceChildren();
  $('#preview-name').textContent = name;
  $('#preview-download').href = downloadUrl(p);
  $('#preview-download').setAttribute('download', '');
  let el;
  if (kind === 'image') {
    el = document.createElement('img');
    el.alt = name;
    el.src = downloadUrl(p, true);
  } else if (kind === 'video' || kind === 'audio') {
    el = document.createElement(kind);
    el.controls = true;
    el.autoplay = true;
    el.src = downloadUrl(p, true);
  } else {
    el = document.createElement('pre');
    el.textContent = 'Loading…';
    fetch(downloadUrl(p, true))
      .then((r) => r.text())
      .then((t) => (el.textContent = t.length > 2_000_000 ? t.slice(0, 2_000_000) + '\n\n… (truncated, download to see the rest)' : t))
      .catch(() => (el.textContent = 'Could not load this file.'));
  }
  body.appendChild(el);
  $('#preview-dialog').showModal();
}

$('#preview-close').addEventListener('click', () => $('#preview-dialog').close());
$('#preview-dialog').addEventListener('close', () => $('#preview-body').replaceChildren());

function ask(title, value = '', okText = 'OK', validate) {
  return new Promise((resolve) => {
    const dlg = $('#prompt-dialog');
    const input = $('#prompt-input');
    $('#prompt-title').textContent = title;
    $('#prompt-ok').textContent = okText;
    $('#prompt-error').textContent = '';
    input.value = value;
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      resolve(dlg.returnValue === 'ok' ? input.value.trim() : null);
    };
    dlg.addEventListener('close', onClose);
    dlg.returnValue = '';
    dlg.showModal();
    input.focus();
    // Select the name part, not the extension, like most file managers.
    const dot = value.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : value.length);
  });
}

function confirmDialog(title, text, okText) {
  return new Promise((resolve) => {
    const dlg = $('#confirm-dialog');
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    $('#confirm-ok').textContent = okText;
    dlg.returnValue = '';
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
  });
}

$('#new-folder').addEventListener('click', async () => {
  const name = await ask('New folder', 'Untitled folder', 'Create');
  if (!name) return;
  try {
    await api('POST', '/api/mkdir', { path: state.path, name });
    await load();
  } catch (ex) {
    toast(ex.message);
  }
});

async function renameEntry(entry) {
  const name = await ask(`Rename "${entry.name}"`, entry.name, 'Rename');
  if (!name || name === entry.name) return;
  try {
    await api('POST', '/api/move', { from: joinPath(state.path, entry.name), to: joinPath(state.path, name) });
    await load();
  } catch (ex) {
    toast(ex.message);
  }
}

async function deletePaths(paths) {
  const label = paths.length === 1 ? `"${paths[0].split('/').pop()}"` : `${paths.length} items`;
  const ok = await confirmDialog(`Delete ${label}?`, 'Deleted items are moved to the trash folder inside rdrive\'s data folder on the server, where they can be recovered.', 'Delete');
  if (!ok) return;
  try {
    await api('POST', '/api/delete', { paths });
    toast(`Deleted ${label}.`);
  } catch (ex) {
    toast(ex.message);
  }
  await load();
  refreshUsage();
}

async function movePaths(paths, destDir) {
  let moved = 0;
  for (const from of paths) {
    if (parentOf(from) === destDir) continue;
    try {
      await api('POST', '/api/move', { from, to: joinPath(destDir, from.split('/').pop()) });
      moved++;
    } catch (ex) {
      toast(`${from.split('/').pop()}: ${ex.message}`);
    }
  }
  if (moved) toast(`Moved ${moved} item${moved === 1 ? '' : 's'}.`);
  await load();
}

// Folder picker for "Move to…"
function moveDialog(paths) {
  const dlg = $('#move-dialog');
  let dir = state.path;
  $('#move-title').textContent = paths.length === 1 ? `Move "${paths[0].split('/').pop()}" to…` : `Move ${paths.length} items to…`;
  $('#move-error').textContent = '';

  const show = async (d) => {
    dir = d;
    renderCrumbs($('#move-crumbs'), d, show, false);
    const list = $('#move-folders');
    list.replaceChildren();
    try {
      const data = await api('GET', `/api/list?path=${encodeURIComponent(d)}`);
      const folders = data.entries.filter((x) => x.type === 'folder' && !paths.includes(joinPath(d, x.name)));
      if (!folders.length) {
        const li = document.createElement('li');
        li.className = 'none';
        li.textContent = 'No folders here.';
        list.appendChild(li);
      }
      for (const f of folders) {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.append(svgIcon('folder'), document.createTextNode(f.name));
        b.addEventListener('click', () => show(joinPath(d, f.name)));
        li.appendChild(b);
        list.appendChild(li);
      }
    } catch (ex) {
      $('#move-error').textContent = ex.message;
    }
  };
  dlg.returnValue = '';
  dlg.addEventListener('close', () => {
    if (dlg.returnValue === 'ok') movePaths(paths, dir);
  }, { once: true });
  show(dir);
  dlg.showModal();
}

// ---------- row menu ----------

function openMenu(entry, anchor, x, y) {
  const menu = $('#menu');
  state.menuTarget = entry;
  menu.querySelector('[data-act="download"]').hidden = entry.type === 'folder';
  menu.hidden = false;
  const r = anchor ? anchor.getBoundingClientRect() : { left: x, right: x, bottom: y, top: y };
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
  menu.style.top = `${r.bottom + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
  menu.querySelector('button:not([hidden])').focus();
}

function closeMenu() {
  $('#menu').hidden = true;
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#menu')) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});

$('#menu').addEventListener('click', (e) => {
  const act = e.target.dataset.act;
  const entry = state.menuTarget;
  closeMenu();
  if (!act || !entry) return;
  const p = joinPath(state.path, entry.name);
  if (act === 'open') openEntry(entry);
  if (act === 'download') download(p);
  if (act === 'rename') renameEntry(entry);
  if (act === 'move') moveDialog([p]);
  if (act === 'delete') deletePaths([p]);
});

// ---------- drag to move ----------

function makeDropTarget(el, destDir) {
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('application/x-rdrive')) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', (e) => {
    const raw = e.dataTransfer.getData('application/x-rdrive');
    el.classList.remove('drop-target');
    if (!raw) return;
    e.preventDefault();
    e.stopPropagation();
    const paths = JSON.parse(raw).filter((p) => p !== destDir);
    if (paths.length) movePaths(paths, destDir);
  });
}

// ---------- uploads ----------

const uploadQueue = [];
let activeUploads = 0;
const MAX_PARALLEL = 3;

function queueUploads(items) {
  // items: [{ file, dir }]
  if (!items.length) return;
  $('#uploads').hidden = false;
  for (const it of items) {
    const li = document.createElement('li');
    const head = document.createElement('div');
    head.className = 'up-name';
    const n = document.createElement('span');
    n.textContent = it.file.name;
    n.title = joinPath(it.dir, it.file.name);
    const s = document.createElement('span');
    s.className = 'muted';
    s.textContent = 'Waiting';
    head.append(n, s);
    const bar = document.createElement('progress');
    bar.max = 1;
    bar.value = 0;
    li.append(head, bar);
    $('#uploads-list').prepend(li);
    uploadQueue.push({ ...it, status: s, bar });
  }
  pumpUploads();
}

function pumpUploads() {
  while (activeUploads < MAX_PARALLEL && uploadQueue.length) {
    const job = uploadQueue.shift();
    activeUploads++;
    uploadOne(job).finally(() => {
      activeUploads--;
      updateUploadsTitle();
      if (!uploadQueue.length && !activeUploads) {
        load();
        refreshUsage();
      } else pumpUploads();
    });
  }
  updateUploadsTitle();
}

function updateUploadsTitle() {
  const left = uploadQueue.length + activeUploads;
  $('#uploads-title').textContent = left ? `Uploading ${left} file${left === 1 ? '' : 's'}…` : 'Uploads complete';
}

function uploadOne(job) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/upload?path=${encodeURIComponent(job.dir)}&name=${encodeURIComponent(job.file.name)}`);
    xhr.setRequestHeader('X-Rdrive', '1');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      job.bar.value = e.loaded / e.total;
      job.status.textContent = `${Math.round((e.loaded / e.total) * 100)}%`;
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        job.bar.value = 1;
        const saved = JSON.parse(xhr.responseText).name;
        job.status.textContent = saved !== job.file.name ? `Saved as ${saved}` : 'Done';
      } else {
        let msg = 'Failed';
        try {
          msg = JSON.parse(xhr.responseText).error || msg;
        } catch {}
        job.status.textContent = msg;
        job.status.className = 'failed';
      }
      resolve();
    };
    xhr.onerror = () => {
      job.status.textContent = 'Connection lost';
      job.status.className = 'failed';
      resolve();
    };
    xhr.send(job.file);
  });
}

$('#uploads-close').addEventListener('click', () => {
  if (uploadQueue.length || activeUploads) return toast('Uploads are still running.');
  $('#uploads').hidden = true;
  $('#uploads-list').replaceChildren();
});

$('#file-input').addEventListener('change', (e) => {
  queueUploads([...e.target.files].map((file) => ({ file, dir: state.path })));
  e.target.value = '';
});

// Read every file inside a dropped folder, creating matching folders on the server.
async function collectEntry(entry, dir, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, dir });
  } else if (entry.isDirectory) {
    const sub = joinPath(dir, entry.name);
    try {
      await api('POST', '/api/mkdir', { path: dir, name: entry.name });
    } catch (ex) {
      if (!/already exists/.test(ex.message)) throw ex;
    }
    const reader = entry.createReader();
    // readEntries returns results in batches; keep calling until it returns none.
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) await collectEntry(child, sub, out);
    }
  }
}

let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && e.dataTransfer.types.includes('Files');

document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e) || !state.user) return;
  dragDepth++;
  $('#drop-overlay').hidden = false;
});
document.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('#drop-overlay').hidden = true;
});
document.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
document.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').hidden = true;
  if (!state.user) return;
  const target = state.path;
  const entries = [...e.dataTransfer.items].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
  const out = [];
  try {
    if (entries.every(Boolean)) {
      for (const entry of entries) await collectEntry(entry, target, out);
    } else {
      for (const file of e.dataTransfer.files) out.push({ file, dir: target });
    }
  } catch (ex) {
    toast(ex.message);
  }
  queueUploads(out);
  if (!out.length) load();
});

// ---------- account & devices ----------

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 600) return 'active now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

async function renderDevices() {
  const list = $('#device-list');
  const { sessions } = await api('GET', '/api/sessions');
  list.replaceChildren();
  for (const s of sessions) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'dev-name';
    name.textContent = s.device;
    if (s.current) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'This device';
      name.appendChild(badge);
    }
    const metaLine = document.createElement('div');
    metaLine.className = 'dev-meta';
    const via = s.method === 'github' ? 'GitHub' : 'password';
    metaLine.textContent = `${s.current ? 'active now' : timeAgo(s.lastSeen)} · ${s.ip || 'unknown IP'} · signed in with ${via} ${formatDate(s.created)}`;
    info.append(name, metaLine);
    li.appendChild(info);
    if (!s.current) {
      const b = document.createElement('button');
      b.className = 'btn small btn-danger';
      b.textContent = 'Sign out';
      b.addEventListener('click', async () => {
        try {
          await api('POST', '/api/sessions/revoke', { id: s.id });
          toast(`Signed out ${s.device}.`);
        } catch (ex) {
          toast(ex.message);
        }
        renderDevices();
      });
      li.appendChild(b);
    }
    list.appendChild(li);
  }
  $('#revoke-others').hidden = sessions.length < 2;
}

async function openAccount() {
  let acct;
  try {
    acct = await api('GET', '/api/account');
  } catch (ex) {
    return toast(ex.message);
  }
  $('#account-name').textContent = acct.user;
  $('#github-section').hidden = !acct.githubAvailable && !acct.github;
  $('#github-status').textContent = acct.github
    ? `Linked to GitHub account @${acct.github}. You can sign in with the GitHub button.`
    : 'Not linked. Link your GitHub account to sign in with one click on any device.';
  $('#github-link').hidden = !!acct.github || !acct.githubAvailable;
  $('#github-unlink').hidden = !acct.github;
  $('#github-unlink').disabled = !acct.hasPassword;
  $('#github-unlink').title = acct.hasPassword ? '' : 'Set a password first, or you would be locked out.';
  $('#password-title').textContent = acct.hasPassword ? 'Change password' : 'Set a password (optional)';
  $('#current-row').hidden = !acct.hasPassword;
  $('#password-form').current.required = acct.hasPassword;
  $('#password-form').reset();
  $('#password-error').textContent = '';
  $('#account-dialog').showModal();
  renderDevices().catch((ex) => toast(ex.message));
}

$('#whoami').addEventListener('click', openAccount);
$('#account-close').addEventListener('click', () => $('#account-dialog').close());

$('#revoke-others').addEventListener('click', async () => {
  const ok = await confirmDialog('Sign out all other devices?', 'Every other phone, computer or browser will need to sign in again.', 'Sign out others');
  if (!ok) return;
  try {
    await api('POST', '/api/sessions/revoke-others');
    toast('Signed out all other devices.');
  } catch (ex) {
    toast(ex.message);
  }
  renderDevices();
});

$('#github-unlink').addEventListener('click', async () => {
  const ok = await confirmDialog('Unlink GitHub?', 'You will only be able to sign in with your password.', 'Unlink');
  if (!ok) return;
  try {
    await api('POST', '/api/account/unlink-github');
    $('#account-dialog').close();
    toast('GitHub unlinked.');
  } catch (ex) {
    toast(ex.message);
  }
});

$('#password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = $('#password-error');
  err.textContent = '';
  if (f.next.value !== f.confirm.value) {
    err.textContent = 'New passwords do not match.';
    return;
  }
  try {
    await api('POST', '/api/account/password', { current: f.current.value, next: f.next.value });
    f.reset();
    $('#account-dialog').close();
    toast('Password saved. Other devices were signed out.');
  } catch (ex) {
    err.textContent = ex.message;
  }
});

// ---------- boot ----------

window.addEventListener('hashchange', () => {
  if (state.user) load();
});

(async function boot() {
  // Results of a GitHub sign-in round trip arrive as query parameters; show them, then tidy the URL.
  const params = new URLSearchParams(location.search);
  const authError = params.get('auth_error');
  const linked = params.get('linked');
  if (authError || linked) history.replaceState(null, '', '/' + location.hash);
  try {
    serverStatus = await api('GET', '/api/status');
  } catch {
    document.body.textContent = 'Could not reach the rdrive server.';
    return;
  }
  if (serverStatus.user) {
    state.user = serverStatus.user;
    showDrive();
    if (authError) toast(authError);
    if (linked === 'github') {
      toast('GitHub account linked. You can now sign in with GitHub.');
      openAccount();
    }
  } else {
    showAuth();
    if (authError) $('#auth-error').textContent = authError;
  }
})();
