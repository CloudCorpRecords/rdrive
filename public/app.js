'use strict';

const $ = (sel) => document.querySelector(sel);

const state = {
  user: null,
  path: '/',
  view: 'drive', // 'drive' | 'trash' | 'search'
  searchQuery: '',
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
window.rdriveToast = toast;

async function copyText(text, label = 'Copied to clipboard.') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    prompt('Copy this address:', text);
  }
}
window.rdriveCopy = copyText;

function extOf(name) {
  return String(name || '').split('.').pop().toLowerCase();
}

function isSheetFile(name) {
  return ['rsheet', 'csv', 'tsv', 'xlsx', 'ods'].includes(extOf(name));
}

function isDocFile(name) {
  return ['rdoc', 'docx', 'odt'].includes(extOf(name));
}

function iconFor(entry) {
  if (entry.type === 'folder') return 'folder';
  if (isSheetFile(entry.name)) return 'sheet';
  if (isDocFile(entry.name)) return 'doc';
  return 'file';
}

// Files that can be turned into an editable RDoc / RDrive Sheet copy.
const TO_RDOC = ['docx', 'odt', 'md', 'markdown', 'txt', 'html', 'htm'];
const TO_RSHEET = ['xlsx', 'ods'];

function svgIcon(kind) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `icon icon-${kind}`);
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('fill', 'currentColor');
  if (kind === 'folder') {
    p.setAttribute('d', 'M3 6.5A2.5 2.5 0 0 1 5.5 4h3.6c.6 0 1.2.3 1.6.7L12 6h6.5A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z');
  } else if (kind === 'sheet') {
    p.setAttribute('d', 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 4v3h6V7H5zm8 0v3h6V7h-6zm-8 5v3h6v-3H5zm8 0v3h6v-3h-6zm-8 5v2h6v-2H5zm8 0v2h6v-2h-6z');
  } else if (kind === 'doc') {
    p.setAttribute('d', 'M6.5 2h7.1c.4 0 .8.2 1.1.4l4.4 4.4c.3.3.4.7.4 1.1V19.5A2.5 2.5 0 0 1 17 22H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2zM7.5 11v1.6h9V11zm0 3.2v1.6h9v-1.6zm0 3.2V19h6v-1.6zM13 3.5V7c0 .8.7 1.5 1.5 1.5H18z');
  } else {
    p.setAttribute('d', 'M6.5 2h7.1c.4 0 .8.2 1.1.4l4.4 4.4c.3.3.4.7.4 1.1V19.5A2.5 2.5 0 0 1 17 22H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2zM13 3.5V7c0 .8.7 1.5 1.5 1.5H18z');
  }
  svg.appendChild(p);
  return svg;
}

const PREVIEW = {
  sheet: ['rsheet', 'csv', 'tsv'],
  doc: ['rdoc'],
  officeDoc: ['docx', 'odt'],
  officeSheet: ['xlsx', 'ods'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp'],
  video: ['mp4', 'webm', 'mov', 'm4v'],
  audio: ['mp3', 'wav', 'ogg', 'm4a', 'flac'],
  text: ['txt', 'md', 'log', 'json'],
  pdf: ['pdf'],
};
// ---------- Night garden: line icons, file tiles, details line ----------

// Outline icons (24px grid, drawn with the current text color).
const UI_ICONS = {
  plus: 'M12 5v14M5 12h14',
  folder: 'M4 7.5A2.5 2.5 0 0 1 6.5 5H9l2 2h6.5A2.5 2.5 0 0 1 20 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z',
  search: 'M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.2-4.2',
  trash: 'M4.5 7h15M10 11v6M14 11v6M6 7l.8 11.2A2 2 0 0 0 8.8 20h6.4a2 2 0 0 0 2-1.8L18 7M9.5 7V4.5h5V7',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM5 20a7 7 0 0 1 14 0',
  doc: 'M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8zM14 3.5V8h4.5M9 13h6M9 16.5h6',
  sheet: 'M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2zM4.5 10h15M4.5 14.5h15M10 4.5v15',
  image: 'M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2zM9 11a1.75 1.75 0 1 0 0-3.5A1.75 1.75 0 0 0 9 11zM19.5 15l-4.5-4.5-8.5 9',
  note: 'M6 4.5h12a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V6A1.5 1.5 0 0 1 6 4.5zM8.5 9h7M8.5 12.5h7M8.5 16h4',
  pdf: 'M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8zM14 3.5V8h4.5M8.5 16.5c2-1.5 3.5-4 4-7 .5 3 2 4.8 3.5 5.5',
  media: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM10 8.5l5 3.5-5 3.5z',
  file: 'M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8zM14 3.5V8h4.5',
  upload: 'M12 15.5V4.5M7.5 9 12 4.5 16.5 9M5 19.5h14',
  camera: 'M4.5 8.5a2 2 0 0 1 2-2h2l1.5-2h4l1.5 2h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2zM12 10a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  zip: 'M6.5 4.5h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2zM12 4.5v2M12 8.5v2M11 12.5h2v3h-2z',
  open: 'M13.5 4.5h6v6M19.5 4.5l-8 8M17.5 13.5v4a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h4',
  share: 'M7 10a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM17 4a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM17 16a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM9.2 11.3l5.6-3.1M9.2 13.7l5.6 3.1',
  download: 'M12 4.5v11M7.5 11l4.5 4.5 4.5-4.5M5 19.5h14',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  edit: 'M4.5 19.5h4l10-10-4-4-10 10zM13 7l4 4',
  move: 'M4 7.5A2.5 2.5 0 0 1 6.5 5H9l2 2h6.5A2.5 2.5 0 0 1 20 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5zM9.5 13h6M13 10.5l2.5 2.5-2.5 2.5',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  cloud: 'M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z',
  backup: 'M12 18v-8m-4 4 4-4 4 4M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25',
  phone: 'M7 4.5h10a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2zM11 17.5h2',
};

function uiIcon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', UI_ICONS[name] || UI_ICONS.file);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', name === 'more' ? '3' : '1.8');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(p);
  return svg;
}

// Fill every <span data-icon="…"> placeholder in the page with its icon.
function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (!el.firstElementChild) el.appendChild(uiIcon(el.dataset.icon));
  }
}

const KINDS = {
  doc: ['rdoc', 'docx', 'odt', 'doc', 'rtf'],
  sheet: ['rsheet', 'csv', 'tsv', 'xlsx', 'ods', 'xls'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'heic', 'svg'],
  pdf: ['pdf'],
  media: ['mp4', 'webm', 'mov', 'm4v', 'mp3', 'wav', 'ogg', 'm4a', 'flac'],
  note: ['txt', 'md', 'markdown', 'log', 'json', 'html', 'htm'],
};
const KIND_LABEL = { folder: 'Folder', backup: 'Backup', doc: 'Doc', sheet: 'Sheet', image: 'Photo', pdf: 'PDF', media: 'Media', note: 'Note', file: 'File' };

function kindOf(entry) {
  if (entry.type === 'folder') {
    if (entry.name.toLowerCase() === 'backups' || (state.path && state.path.startsWith('/Backups'))) return 'backup';
    return 'folder';
  }
  const ext = extOf(entry.name);
  return Object.keys(KINDS).find((k) => KINDS[k].includes(ext)) || 'file';
}

// The colored square (or photo thumbnail) in front of a file name.
function fileTile(entry, clientPath) {
  const kind = kindOf(entry);
  const tile = document.createElement('span');
  tile.className = `tile tile-${kind}`;
  // Thumbnails only for formats the server will show inline (never SVG, which could carry scripts).
  if (kind === 'image' && clientPath && !['svg', 'heic'].includes(extOf(entry.name))) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = downloadUrl(clientPath, true);
    img.addEventListener('error', () => img.replaceWith(uiIcon('image')), { once: true });
    tile.appendChild(img);
  } else {
    tile.appendChild(uiIcon(kind));
  }
  return tile;
}

function relativeDay(iso) {
  const d = new Date(iso);
  const today = new Date();
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days === 0) return `today ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  if (days === 1) return 'yesterday';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

// "Photo · 51 KB · today 4:40 PM" (shown under the name on phones).
function metaLine(entry, when) {
  const parts = [KIND_LABEL[kindOf(entry)]];
  if (entry.type !== 'folder' && entry.size != null) parts.push(formatSize(entry.size));
  if (when) parts.push(relativeDay(when));
  return parts.join(' · ');
}

// Name plus details line, used by every list.
function nameBlock(nameEl, meta) {
  const wrap = document.createElement('span');
  wrap.className = 'name-wrap';
  const m = document.createElement('span');
  m.className = 'meta';
  m.textContent = meta;
  wrap.append(nameEl, m);
  return wrap;
}

const isPhoneLayout = () => window.matchMedia('(max-width: 700px)').matches;

function previewKind(name) {
  const ext = name.split('.').pop().toLowerCase();
  return Object.keys(PREVIEW).find((k) => PREVIEW[k].includes(ext)) || null;
}

function downloadUrl(p, inline) {
  return `/api/download?path=${encodeURIComponent(p)}${inline ? '&inline=1' : ''}`;
}

function zipUrl(p) {
  return `/api/zip?path=${encodeURIComponent(p)}`;
}

// ---------- auth ----------

let authMode = 'login';
let serverStatus = {};

function showAuth(status = serverStatus) {
  $('#drive-view').hidden = true;
  $('#public-share-view').hidden = true;
  $('#auth-view').hidden = false;
  $('#auth-form').hidden = false;
  $('#pair-request-card').hidden = true;
  $('#pair-claim-card').hidden = true;
  if (pairPollInterval) clearInterval(pairPollInterval);
  pairPollInterval = null;
  const setup = status && status.needsSetup;
  $('#auth-pair-opt').hidden = !!setup;
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

// ---------- drive, search & trash ----------

function pathFromHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  try {
    return '/' + raw.split('/').filter(Boolean).map(decodeURIComponent).join('/');
  } catch {
    return '/';
  }
}

function navigate(p) {
  state.view = 'drive';
  state.searchQuery = '';
  $('#search-input').value = '';
  const hash = '#/' + p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  if (location.hash === hash) load();
  else location.hash = hash;
}

function showDrive() {
  $('#auth-view').hidden = true;
  $('#public-share-view').hidden = true;
  $('#drive-view').hidden = false;
  // Full name on wide screens, a one-letter avatar on phones.
  const full = Object.assign(document.createElement('span'), { className: 'full', textContent: state.user });
  const initial = Object.assign(document.createElement('span'), { className: 'initial', textContent: state.user.slice(0, 1) });
  $('#whoami').replaceChildren(full, initial);
  $('#whoami').setAttribute('aria-label', `Account: ${state.user}`);
  load();
  refreshUsage();
}

async function load() {
  state.selected.clear();
  setNav(state.view === 'trash' ? 'trash' : state.view === 'search' ? 'search' : 'files');
  $('#drive-actions').hidden = state.view === 'trash';
  $('#trash-actions').hidden = state.view !== 'trash';
  $('#trash-btn').classList.toggle('btn-primary', state.view === 'trash');
  $('#trash-btn').classList.toggle('btn-ghost', state.view !== 'trash');

  if (state.view === 'trash') {
    try {
      const data = await api('GET', '/api/trash');
      state.entries = data.items;
    } catch (ex) {
      toast(ex.message);
      state.entries = [];
    }
    renderTrash();
    return;
  }

  if (state.view === 'search' && state.searchQuery) {
    try {
      const data = await api('GET', `/api/search?q=${encodeURIComponent(state.searchQuery)}`);
      state.entries = data.results;
    } catch (ex) {
      toast(ex.message);
      state.entries = [];
    }
    renderSearch();
    return;
  }

  state.view = 'drive';
  state.path = pathFromHash();
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

let searchTimer;
$('#search-input').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  searchTimer = setTimeout(() => {
    if (!q) {
      state.view = 'drive';
      state.searchQuery = '';
      load();
    } else {
      state.view = 'search';
      state.searchQuery = q;
      load();
    }
  }, 180);
});

$('#trash-btn').addEventListener('click', () => {
  state.view = state.view === 'trash' ? 'drive' : 'trash';
  $('#search-input').value = '';
  state.searchQuery = '';
  load();
});

$('#trash-back').addEventListener('click', () => {
  state.view = 'drive';
  load();
});

$('#empty-trash').addEventListener('click', async () => {
  if (!state.entries.length) return toast('Trash is already empty.');
  const ok = await confirmDialog('Empty trash?', 'All items in your trash will be permanently deleted and cannot be recovered.', 'Empty trash');
  if (!ok) return;
  try {
    await api('POST', '/api/trash/empty');
    toast('Trash emptied.');
    load();
  } catch (ex) {
    toast(ex.message);
  }
});

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
    // On phones only the parent (as a back link) and the current folder (as the title) show.
    if (i === paths.length - 1) b.classList.add('is-current');
    if (i === paths.length - 2) b.classList.add('is-parent');
    b.addEventListener('click', () => onClick(cp));
    if (dropTargets && cp !== p) makeDropTarget(b, cp);
    container.appendChild(b);
  });
}

function render() {
  renderCrumbs($('#crumbs'), state.path, navigate, true);
  $('#select-all').disabled = false;
  const rows = $('#rows');
  rows.replaceChildren();
  $('#empty').hidden = state.entries.length > 0;
  $('#empty-title').textContent = 'This folder is empty.';
  $('#empty-sub').textContent = 'Drop files or folders here, create a Spreadsheet, or use Upload.';

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
    name.appendChild(fileTile(entry, p));
    const link = document.createElement('a');
    link.className = 'name';
    link.textContent = entry.name;
    link.title = entry.name;
    link.addEventListener('click', (e) => {
      if (document.body.classList.contains('selecting')) return; // the row handles taps while selecting
      e.stopPropagation();
      openEntry(entry);
    });
    name.appendChild(nameBlock(link, metaLine(entry, entry.modified)));

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
    menuBtn.replaceChildren(uiIcon('more'));
    attachTouch(row, entry, () => openEntry(entry));
    row.addEventListener('dblclick', () => openEntry(entry));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') openEntry(entry);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!isPhoneLayout()) openMenu(entry, null, e.clientX, e.clientY);
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

function renderSearch() {
  const crumbs = $('#crumbs');
  crumbs.replaceChildren();
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'is-current';
  b.textContent = `Search results for "${state.searchQuery}" (${state.entries.length})`;
  crumbs.appendChild(b);

  $('#select-all').disabled = true;
  const rows = $('#rows');
  rows.replaceChildren();
  $('#empty').hidden = state.entries.length > 0;
  $('#empty-title').textContent = 'No matching files or folders.';
  $('#empty-sub').textContent = 'Try another search term.';

  for (const entry of state.entries) {
    const row = document.createElement('div');
    row.className = 'row';
    row.tabIndex = 0;

    const check = document.createElement('span');
    check.className = 'cell-check';

    const name = document.createElement('span');
    name.className = 'cell-name';
    name.appendChild(fileTile(entry, entry.path || joinPath(entry.dir, entry.name)));
    const link = document.createElement('a');
    link.className = 'name';
    link.textContent = entry.name;
    link.title = entry.path;
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      openEntry(entry, entry.dir);
    });
    const loc = document.createElement('span');
    loc.className = 'muted small';
    loc.textContent = entry.dir === '/' ? '' : `in ${entry.dir}`;
    name.append(nameBlock(link, `${metaLine(entry)} · ${entry.dir === '/' ? 'My Drive' : `in ${entry.dir}`}`), loc);

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
    menuBtn.setAttribute('aria-label', `Actions for ${entry.name}`);
    menuBtn.appendChild(uiIcon('more'));
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenu({ ...entry, dir: entry.dir }, menuBtn);
    });
    menuCell.appendChild(menuBtn);

    row.append(check, name, size, date, menuCell);
    row.addEventListener('click', () => {
      if (isPhoneLayout()) openEntry(entry, entry.dir);
    });
    row.addEventListener('dblclick', () => openEntry(entry, entry.dir));
    rows.appendChild(row);
  }
}

function renderTrash() {
  const crumbs = $('#crumbs');
  crumbs.replaceChildren();
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'is-current';
  b.textContent = 'Trash';
  crumbs.appendChild(b);

  $('#select-all').disabled = true;
  const rows = $('#rows');
  rows.replaceChildren();
  $('#empty').hidden = state.entries.length > 0;
  $('#empty-title').textContent = 'Trash is empty.';
  $('#empty-sub').textContent = 'Items you delete from your drive appear here so you can restore them.';

  for (const item of state.entries) {
    const row = document.createElement('div');
    row.className = 'row';

    const check = document.createElement('span');
    check.className = 'cell-check';

    const name = document.createElement('span');
    name.className = 'cell-name';
    name.appendChild(fileTile(item, null)); // no thumbnails: trashed files aren't downloadable by path
    const label = document.createElement('span');
    label.className = 'name';
    label.textContent = item.name;
    const orig = document.createElement('span');
    orig.className = 'muted small';
    orig.textContent = `from ${item.originalDir || '/'}`;
    name.append(nameBlock(label, `Deleted ${relativeDay(item.deletedAt)} · from ${item.originalDir || '/'}`), orig);

    const size = document.createElement('span');
    size.className = 'cell-size';
    size.textContent = item.type === 'folder' ? '—' : formatSize(item.size);

    const date = document.createElement('span');
    date.className = 'cell-date';
    date.textContent = formatDate(item.deletedAt);

    const actCell = document.createElement('span');
    actCell.className = 'cell-menu trash-row-actions';
    const restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.className = 'btn small';
    restoreBtn.textContent = 'Restore';
    restoreBtn.addEventListener('click', async () => {
      try {
        const { restored } = await api('POST', '/api/trash/restore', { id: item.id });
        toast(`Restored "${restored.name}" to ${restored.dir}.`);
        load();
        refreshUsage();
      } catch (ex) {
        toast(ex.message);
      }
    });
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn small btn-danger';
    delBtn.textContent = '×';
    delBtn.title = 'Delete permanently';
    delBtn.addEventListener('click', async () => {
      const ok = await confirmDialog(`Permanently delete "${item.name}"?`, 'This cannot be undone.', 'Delete forever');
      if (!ok) return;
      try {
        await api('POST', '/api/trash/delete', { id: item.id });
        toast(`Deleted "${item.name}".`);
        load();
      } catch (ex) {
        toast(ex.message);
      }
    });
    actCell.append(restoreBtn, delBtn);

    row.append(check, name, size, date, actCell);
    rows.appendChild(row);
  }
}

// ---------- selection ----------

// Phones: tap opens, long-press starts selecting; while selecting, taps toggle.
function attachTouch(row, entry, open) {
  let timer = null;
  let longPressed = false;
  let start = null;
  row.addEventListener('touchstart', (e) => {
    longPressed = false;
    start = e.touches[0];
    timer = setTimeout(() => {
      longPressed = true;
      if (navigator.vibrate) navigator.vibrate(12);
      toggleSelect(entry.name, !state.selected.has(entry.name));
    }, 450);
  }, { passive: true });
  const cancel = () => clearTimeout(timer);
  row.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (start && (Math.abs(t.clientX - start.clientX) > 10 || Math.abs(t.clientY - start.clientY) > 10)) cancel();
  }, { passive: true });
  row.addEventListener('touchend', cancel);
  row.addEventListener('touchcancel', cancel);
  row.addEventListener('contextmenu', (e) => {
    if (isPhoneLayout()) e.preventDefault(); // long-press is ours on phones
  });
  row.addEventListener('click', (e) => {
    if (!isPhoneLayout() || e.target.closest('.cell-menu, .cell-check')) return;
    if (longPressed) {
      longPressed = false;
      return;
    }
    if (document.body.classList.contains('selecting')) toggleSelect(entry.name, !state.selected.has(entry.name));
    else open();
  });
}

function toggleSelect(name, on) {
  if (on) state.selected.add(name);
  else state.selected.delete(name);
  syncSelectionUi();
}

function syncSelectionUi() {
  for (const row of document.querySelectorAll('#rows .row[data-name]')) {
    const on = state.selected.has(row.dataset.name);
    row.classList.toggle('selected', on);
    const cb = row.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = on;
  }
  const n = state.selected.size;
  document.body.classList.toggle('selecting', n > 0);
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
$('#clear-selected').addEventListener('click', () => {
  state.selected.clear();
  syncSelectionUi();
});

document.addEventListener('keydown', (e) => {
  if ($('#drive-view').hidden || document.querySelector('dialog[open]') || e.target.matches('input, select, textarea')) return;
  if (e.key === 'Delete' && state.selected.size && state.view === 'drive') {
    deletePaths([...state.selected].map((n) => joinPath(state.path, n)));
  }
  if (e.key === 'Escape') {
    state.selected.clear();
    syncSelectionUi();
  }
});

// ---------- actions ----------

function openEntry(entry, baseDir = state.path) {
  const p = entry.path || joinPath(baseDir, entry.name);
  if (entry.type === 'folder') return navigate(p);
  const kind = previewKind(entry.name);
  if (kind === 'sheet') return openSpreadsheet(entry.name, p);
  if (kind === 'doc') return openDocument(entry.name, p);
  if (kind === 'officeDoc') return viewOfficeDocument(entry.name, p);
  if (kind === 'officeSheet') return viewOfficeSpreadsheet(entry.name, p);
  if (kind === 'pdf') return window.open(downloadUrl(p, true), '_blank', 'noopener');
  if (kind) return preview(entry.name, p, kind);
  download(p);
}

function openSpreadsheet(name, clientPath) {
  const dir = parentOf(clientPath);
  const fileName = clientPath.split('/').pop();
  window.RDriveSheets.openSheetModal({
    name,
    path: clientPath,
    readOnly: false,
    loadContent: async () => {
      const res = await fetch(downloadUrl(clientPath, true), { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Could not load spreadsheet.');
      return await res.text();
    },
    saveContent: async (payload) => {
      const res = await fetch(`/api/upload?path=${encodeURIComponent(dir)}&name=${encodeURIComponent(fileName)}&overwrite=1`, {
        method: 'PUT',
        headers: { 'X-Rdrive': '1', 'Content-Type': 'application/octet-stream' },
        credentials: 'same-origin',
        body: payload,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Save failed');
      }
    },
    saveCopy: (fileName, blob) => saveBlobCopy(dir, fileName, blob),
    onSaved: () => {
      load();
      refreshUsage();
    },
  });
}

// ---------- RDocs and Office/OpenDocument files ----------

async function fetchFile(clientPath) {
  const res = await fetch(downloadUrl(clientPath, true), { credentials: 'same-origin' });
  if (!res.ok) throw new Error('Could not load the file.');
  return res;
}

async function putFile(dir, fileName, body, overwrite) {
  const res = await fetch(`/api/upload?path=${encodeURIComponent(dir)}&name=${encodeURIComponent(fileName)}${overwrite ? '&overwrite=1' : ''}`, {
    method: 'PUT',
    headers: { 'X-Rdrive': '1', 'Content-Type': 'application/octet-stream' },
    credentials: 'same-origin',
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Save failed');
  return data.name;
}

// Saves an exported file next to the original; the server adds " (1)" if the name is taken.
async function saveBlobCopy(dir, fileName, blob) {
  const saved = await putFile(dir, fileName, blob, false);
  load();
  refreshUsage();
  return saved;
}

function openDocument(name, clientPath) {
  const dir = parentOf(clientPath);
  const fileName = clientPath.split('/').pop();
  window.RDriveDocs.openDocModal({
    name,
    loadHtml: async () => window.RDriveInterop.parseDoc(await (await fetchFile(clientPath)).text()).html,
    saveHtml: (html) => putFile(dir, fileName, window.RDriveInterop.serializeDoc(html), true),
    saveCopy: (copyName, blob) => saveBlobCopy(dir, copyName, blob),
    onSaved: () => {
      load();
      refreshUsage();
    },
  });
}

// Turns a Word/OpenDocument/Markdown/text/HTML file into HTML for RDocs.
async function fileToHtml(clientPath) {
  const interop = window.RDriveInterop;
  const ext = extOf(clientPath);
  const res = await fetchFile(clientPath);
  if (ext === 'docx') return interop.docxToHtml(await res.arrayBuffer(), { ...(await interop.load('mammoth')), DOMParser });
  if (ext === 'odt') return interop.odtToHtml(await res.arrayBuffer(), { ...(await interop.load('JSZip')), DOMParser });
  const text = await res.text();
  if (ext === 'md' || ext === 'markdown') return interop.sanitizeHtml(interop.markdownToHtml(text));
  if (ext === 'html' || ext === 'htm') return interop.sanitizeHtml(text);
  return interop.textToHtml(text);
}

async function fileToWorkbook(clientPath) {
  const interop = window.RDriveInterop;
  const data = await (await fetchFile(clientPath)).arrayBuffer();
  if (extOf(clientPath) === 'xlsx') return interop.xlsxToWorkbook(data, await interop.load('ExcelJS'));
  return interop.odsToWorkbook(data, { ...(await interop.load('JSZip')), DOMParser });
}

function closeDialog(dlg) {
  if (!dlg.open) return Promise.resolve();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => setTimeout(resolve, 0), { once: true });
    dlg.close();
  });
}

// Makes an editable .rdoc / .rsheet copy next to the original (which is never changed) and opens it.
async function convertToEditable(name, clientPath) {
  const dir = parentOf(clientPath);
  const base = name.replace(/\.[^.]+$/, '') || name;
  const toDoc = TO_RDOC.includes(extOf(name));
  toast(`Making an editable copy of "${name}"…`);
  try {
    let saved;
    if (toDoc) {
      const html = await fileToHtml(clientPath);
      saved = await putFile(dir, `${base}.rdoc`, window.RDriveInterop.serializeDoc(html), false);
    } else {
      const wb = await fileToWorkbook(clientPath);
      saved = await putFile(dir, `${base}.rsheet`, JSON.stringify(wb, null, 2), false);
    }
    await load();
    refreshUsage();
    // Let the viewer's "close" event fire before the editor opens in the same dialog;
    // otherwise the editor would receive it and tear down its own event handlers.
    await closeDialog($('#doc-dialog'));
    await closeDialog($('#sheet-dialog'));
    const savedPath = joinPath(dir, saved);
    if (toDoc) openDocument(saved, savedPath);
    else openSpreadsheet(saved, savedPath);
  } catch (ex) {
    toast(ex.message || 'Could not convert the file.');
  }
}

function viewOfficeDocument(name, clientPath) {
  const label = extOf(name) === 'docx' ? 'Word document' : 'OpenDocument text';
  window.RDriveDocs.openDocModal({
    name,
    readOnly: true,
    loadHtml: () => fileToHtml(clientPath),
    saveCopy: (copyName, blob) => saveBlobCopy(parentOf(clientPath), copyName, blob),
    banner: {
      text: `${label}, view only. Make an editable RDocs copy to change it. The original stays as it is.`,
      actionLabel: 'Edit a copy',
      onAction: () => convertToEditable(name, clientPath),
    },
  });
}

function viewOfficeSpreadsheet(name, clientPath) {
  const label = extOf(name) === 'xlsx' ? 'Excel workbook' : 'OpenDocument spreadsheet';
  window.RDriveSheets.openSheetModal({
    name,
    path: clientPath,
    readOnly: true,
    loadWorkbook: () => fileToWorkbook(clientPath),
    saveCopy: (copyName, blob) => saveBlobCopy(parentOf(clientPath), copyName, blob),
    banner: {
      text: `${label}, view only. Make an editable RDrive Sheets copy to change it. The original stays as it is.`,
      actionLabel: 'Edit a copy',
      onAction: () => convertToEditable(name, clientPath),
    },
  });
}

async function createNewDocument() {
  const name = await ask('New document', 'Untitled document', 'Create & open');
  if (!name) return;
  try {
    const created = await api('POST', '/api/doc/create', { path: state.path, name });
    await load();
    refreshUsage();
    openDocument(created.name, created.path);
  } catch (ex) {
    toast(ex.message);
  }
}
window.rdriveCreateDocument = createNewDocument;

function download(p, isFolder = false) {
  const a = document.createElement('a');
  a.href = isFolder ? zipUrl(p) : downloadUrl(p);
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

$('#download-zip').addEventListener('click', () => download(state.path, true));

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

function ask(title, value = '', okText = 'OK') {
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

async function createNewSpreadsheet() {
  const name = await ask('New spreadsheet (.rsheet or .csv)', 'Untitled spreadsheet.rsheet', 'Create & open');
  if (!name) return;
  try {
    const created = await api('POST', '/api/sheet/create', { path: state.path, name });
    await load();
    refreshUsage();
    openSpreadsheet(created.name, created.path);
  } catch (ex) {
    toast(ex.message);
  }
}
window.rdriveCreateSpreadsheet = createNewSpreadsheet;

$('#new-sheet').addEventListener('click', createNewSpreadsheet);
$('#new-doc').addEventListener('click', createNewDocument);
window.rdriveAsk = ask;

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

async function renameEntry(entry, baseDir = state.path) {
  const name = await ask(`Rename "${entry.name}"`, entry.name, 'Rename');
  if (!name || name === entry.name) return;
  try {
    await api('POST', '/api/move', { from: joinPath(baseDir, entry.name), to: joinPath(baseDir, name) });
    await load();
  } catch (ex) {
    toast(ex.message);
  }
}

async function copyEntry(entry, baseDir = state.path) {
  const ext = entry.name.includes('.') ? '.' + entry.name.split('.').pop() : '';
  const stem = ext ? entry.name.slice(0, -ext.length) : entry.name;
  const copyName = `${stem} copy${ext}`;
  try {
    const res = await api('POST', '/api/copy', {
      from: joinPath(baseDir, entry.name),
      to: joinPath(baseDir, copyName),
    });
    toast(`Created "${res.name}".`);
    await load();
    refreshUsage();
  } catch (ex) {
    toast(ex.message);
  }
}

async function deletePaths(paths) {
  const label = paths.length === 1 ? `"${paths[0].split('/').pop()}"` : `${paths.length} items`;
  const ok = await confirmDialog(`Delete ${label}?`, 'Deleted items are moved to Trash, where you can restore them anytime.', 'Delete');
  if (!ok) return;
  try {
    await api('POST', '/api/delete', { paths });
    toast(`Moved ${label} to Trash.`);
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

// ---------- share links dialog ----------

let currentSharePath = null;

async function openShareDialog(entry, baseDir = state.path) {
  const p = entry.path || joinPath(baseDir, entry.name);
  currentSharePath = p;
  $('#share-item-name').textContent = entry.name;
  $('#share-form').reset();
  $('#share-error').textContent = '';
  $('#share-edit-row').hidden = !(entry.type === 'file' && ['rsheet', 'csv', 'tsv', 'rdoc'].includes(extOf(entry.name)));
  $('#share-dialog').showModal();
  await renderShareList();
}

async function renderShareList() {
  if (!currentSharePath) return;
  const list = $('#share-list');
  list.replaceChildren();
  const { shares } = await api('GET', `/api/shares?path=${encodeURIComponent(currentSharePath)}`);
  $('#share-empty').hidden = shares.length > 0;
  for (const s of shares) {
    const fullUrl = location.origin + s.url;
    const li = document.createElement('li');
    const info = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'dev-name mono small';
    title.textContent = fullUrl;
    const meta = document.createElement('div');
    meta.className = 'dev-meta';
    const parts = [
      s.expires ? `Expires ${formatDate(s.expires)}` : 'Never expires',
      s.hasPassword ? 'Password protected' : 'Public link',
      s.allowEdit ? 'Anyone with the link can edit' : 'View / download',
    ];
    meta.textContent = parts.join(' · ');
    info.append(title, meta);
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn small';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => copyText(fullUrl, 'Share link copied!'));
    actions.append(copyBtn);

    if (currentSharePath && currentSharePath.toLowerCase().endsWith('.rdoc')) {
      const copyMdBtn = document.createElement('button');
      copyMdBtn.type = 'button';
      copyMdBtn.className = 'btn small';
      copyMdBtn.textContent = 'Copy for AI (.md)';
      copyMdBtn.title = 'Copy direct Markdown link for AI assistants';
      copyMdBtn.addEventListener('click', () => copyText(`${location.origin}/s/${s.id}.md`, 'AI Markdown link copied!'));
      actions.append(copyMdBtn);
    }

    const revokeBtn = document.createElement('button');
    revokeBtn.type = 'button';
    revokeBtn.className = 'btn small btn-danger';
    revokeBtn.textContent = 'Revoke';
    revokeBtn.addEventListener('click', async () => {
      try {
        await api('POST', '/api/shares/revoke', { id: s.id });
        toast('Share link revoked.');
        renderShareList();
      } catch (ex) {
        toast(ex.message);
      }
    });
    actions.append(revokeBtn);
    li.append(info, actions);
    list.appendChild(li);
  }
}

$('#share-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#share-error').textContent = '';
  try {
    const { share } = await api('POST', '/api/shares', {
      path: currentSharePath,
      expiresInHours: Number(f.expiresInHours.value),
      password: f.password.value,
      allowEdit: f.allowEdit.checked,
    });
    f.password.value = '';
    const fullUrl = location.origin + share.url;
    await copyText(fullUrl, 'Share link created and copied!');
    await renderShareList();
  } catch (ex) {
    $('#share-error').textContent = ex.message;
  }
});

$('#share-close').addEventListener('click', () => $('#share-dialog').close());

// ---------- row menu ----------

function openMenu(entry, anchor, x, y) {
  const menu = $('#menu');
  state.menuTarget = entry;
  $('#menu-download').querySelector('.label').textContent = entry.type === 'folder' ? 'Download .zip' : 'Download';
  const ext = extOf(entry.name);
  const convert = $('#menu-convert');
  convert.hidden = entry.type === 'folder' || !(TO_RDOC.includes(ext) || TO_RSHEET.includes(ext));
  convert.querySelector('.label').textContent = TO_RSHEET.includes(ext) ? 'Edit a copy in RDrive Sheets' : 'Edit a copy in RDocs';
  // Phones show the menu as a bottom sheet titled with the file it acts on.
  const title = $('#menu-title');
  const titleText = document.createElement('span');
  titleText.textContent = entry.name;
  title.replaceChildren(fileTile(entry, entry.type === 'file' ? entry.path || joinPath(entry.dir || state.path, entry.name) : null), titleText);
  $('#sheet-backdrop').hidden = !isPhoneLayout();
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
  $('#new-menu').hidden = true;
  $('#sheet-backdrop').hidden = true;
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#menu, #new-menu, #fab')) closeMenu();
});

// ---------- phones: + button, "New" sheet, bottom bar ----------

$('#fab').appendChild(uiIcon('plus'));
$('#fab').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = $('#new-menu').hidden;
  closeMenu();
  if (!open) return;
  $('#new-menu').hidden = false;
  $('#sheet-backdrop').hidden = false;
});

$('#new-menu').addEventListener('click', (e) => {
  const item = e.target.closest('[data-new]');
  if (!item) return;
  closeMenu();
  const what = item.dataset.new;
  if (what === 'doc') createNewDocument();
  if (what === 'sheet') createNewSpreadsheet();
  if (what === 'folder') $('#new-folder').click();
  if (what === 'upload') $('#file-input').click();
  if (what === 'camera') $('#camera-input').click();
  if (what === 'zip') download(state.path, true);
});

$('#camera-input').addEventListener('change', (e) => {
  queueUploads([...e.target.files].map((file) => ({ file, dir: state.path })));
  e.target.value = '';
});

function setNav(which) {
  for (const b of document.querySelectorAll('#bottom-nav [data-nav]')) b.classList.toggle('active', b.dataset.nav === which);
  $('#fab').hidden = which === 'trash';
}

$('#bottom-nav').addEventListener('click', (e) => {
  const b = e.target.closest('[data-nav]');
  if (!b) return;
  const nav = b.dataset.nav;
  if (nav === 'files') {
    $('#search-input').value = '';
    state.searchQuery = '';
    state.view = 'drive';
    setNav('files');
    if (location.hash === '#/' || !location.hash) load();
    else navigate('/');
  } else if (nav === 'search') {
    setNav('search');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    $('#search-input').focus();
  } else if (nav === 'trash') {
    $('#search-input').value = '';
    state.searchQuery = '';
    state.view = 'trash';
    setNav('trash');
    load();
  } else if (nav === 'you') {
    openAccount();
  }
});

hydrateIcons();
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});

$('#menu').addEventListener('click', (e) => {
  const act = e.target.dataset.act;
  const entry = state.menuTarget;
  closeMenu();
  if (!act || !entry) return;
  const baseDir = entry.dir || state.path;
  const p = entry.path || joinPath(baseDir, entry.name);
  if (act === 'open') openEntry(entry, baseDir);
  if (act === 'convert') convertToEditable(entry.name, p);
  if (act === 'share') openShareDialog(entry, baseDir);
  if (act === 'download') download(p, entry.type === 'folder');
  if (act === 'copy') copyEntry(entry, baseDir);
  if (act === 'rename') renameEntry(entry, baseDir);
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
  if (!hasFiles(e) || !state.user || state.view !== 'drive') return;
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
  if (!state.user || state.view !== 'drive') return;
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

// ---------- account, WebDAV & devices ----------

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
  $('#you-avatar').textContent = acct.user.slice(0, 1);
  $('#you-name').textContent = acct.user;
  $('#you-usage').textContent = $('#usage').textContent;
  renderPhoneSection();
  const davUrl = `${location.origin}/dav/`;
  $('#webdav-url').textContent = davUrl;
  $('#copy-webdav').onclick = () => copyText(davUrl, 'WebDAV address copied!');
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
  $('#pair-box').hidden = true;
  $('#ai-connect-card').hidden = true;
  $('#mcp-token-form').hidden = true;
  $('#mcp-created-box').hidden = true;
  renderAgentTokens().catch((ex) => toast(ex.message));
  $('#sync-code').hidden = true;
  $('#sync-link-form').hidden = true;
  renderSync().catch((ex) => toast(ex.message));
}

async function renderAgentTokens() {
  const list = $('#mcp-token-list');
  const { tokens } = await api('GET', '/api/tokens');
  list.replaceChildren();
  for (const t of tokens) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'dev-name';
    name.textContent = t.label;
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = t.scope === 'read' ? 'read-only' : 'read & write';
    name.appendChild(badge);
    const meta = document.createElement('div');
    meta.className = 'dev-meta';
    const used = t.lastUsed ? `last used ${timeAgo(t.lastUsed)}` : 'never used';
    const exp = t.expires ? `expires ${formatDate(t.expires)}` : 'never expires';
    meta.textContent = `folder: ${t.rootPath} · ${used} · ${exp}`;
    info.append(name, meta);
    const b = document.createElement('button');
    b.className = 'btn small btn-danger';
    b.textContent = 'Revoke';
    b.addEventListener('click', async () => {
      try {
        await api('POST', '/api/tokens/revoke', { id: t.id });
        toast(`Revoked token "${t.label}".`);
        renderAgentTokens();
      } catch (ex) {
        toast(ex.message);
      }
    });
    li.append(info, b);
    list.appendChild(li);
  }
}

$('#you-signout').addEventListener('click', () => {
  $('#account-dialog').close();
  $('#logout').click();
});

// Inside the Android app, window.RDriveApp offers the phone's own settings (auto-upload, updates…).
function renderPhoneSection() {
  const phone = window.RDriveApp;
  $('#phone-section').hidden = !phone;
  if (!phone) return;
  let status = {};
  try {
    status = JSON.parse(phone.status());
  } catch {}
  const devName = status.deviceName || 'This phone';
  const folder = status.syncFolder;
  const backupPath = status.backupPath || `/Backups/${devName}`;
  const titleEl = $('#phone-backup-title');
  if (titleEl) titleEl.textContent = folder ? `Cloud backup: ${devName}` : 'Cloud backup';
  $('#phone-sync-status').textContent = folder ? `On for "${folder}" → ${backupPath}` : 'Off · Tap to back up Camera or a folder to /Backups';
  const pathEl = $('#phone-backup-path');
  if (pathEl) pathEl.textContent = backupPath;
  $('#phone-upload-now').hidden = !folder;
  const openBackupsBtn = $('#phone-open-backups');
  if (openBackupsBtn) openBackupsBtn.hidden = !folder;
  $('#phone-stop').hidden = !folder;
  $('#phone-version').textContent = status.version ? `You have ${status.version}` : '';
}

$('#phone-section').addEventListener('click', (e) => {
  const b = e.target.closest('[data-phone]');
  if (!b || !window.RDriveApp || typeof window.RDriveApp[b.dataset.phone] !== 'function') return;
  window.RDriveApp[b.dataset.phone]();
  if (b.dataset.phone !== 'checkForUpdates') $('#account-dialog').close();
  setTimeout(renderPhoneSection, 800);
});

$('#mcp-new-btn').addEventListener('click', () => {
  const f = $('#mcp-token-form');
  f.reset();
  f.rootPath.value = state.path || '/';
  $('#mcp-token-error').textContent = '';
  $('#mcp-created-box').hidden = true;
  f.hidden = !f.hidden;
  if (!f.hidden) f.label.focus();
});

$('#mcp-token-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#mcp-token-error').textContent = '';
  try {
    const { token } = await api('POST', '/api/tokens', {
      label: f.label.value,
      scope: f.scope.value,
      rootPath: f.rootPath.value || '/',
      expiresInDays: Number(f.expiresInDays.value),
    });
    f.hidden = true;
    $('#mcp-created-token').textContent = token;
    $('#mcp-created-box').hidden = false;
    $('#mcp-copy-token').onclick = () => copyText(token, 'Agent token copied!');
    const mcpConfig = JSON.stringify(
      {
        mcpServers: {
          rdrive: {
            url: `${location.origin}/mcp`,
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        },
      },
      null,
      2
    );
    $('#mcp-copy-config').onclick = () => copyText(mcpConfig, 'MCP JSON config copied!');
    await renderAgentTokens();
  } catch (ex) {
    $('#mcp-token-error').textContent = ex.message;
  }
});

// ---------- device pairing & AI connect ----------

let pairTimerInterval = null;
let pairPollInterval = null;
let cachedAiToken = null;

$('#pair-open-btn').addEventListener('click', async () => {
  const box = $('#pair-box');
  const willShow = box.hidden;
  box.hidden = !willShow;
  $('#pair-approve-error').textContent = '';
  if (!willShow) {
    if (pairTimerInterval) clearInterval(pairTimerInterval);
    return;
  }
  try {
    const res = await api('POST', '/api/pair/link');
    const fullUrl = res.url || `${location.origin}/pair#${res.token}`;
    $('#pair-link-input').value = fullUrl;
    $('#pair-link-copy').onclick = () => copyText(fullUrl, 'Pairing link copied!');

    const qrWrap = $('#pair-qr');
    qrWrap.replaceChildren();
    if (typeof window.qrcode === 'function') {
      try {
        const qr = window.qrcode(0, 'M');
        qr.addData(fullUrl);
        qr.make();
        qrWrap.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4 });
      } catch (e) {
        qrWrap.textContent = fullUrl;
      }
    }

    let remaining = res.expiresIn || 300;
    const updateTimer = () => {
      const mins = Math.floor(remaining / 60);
      const secs = String(remaining % 60).padStart(2, '0');
      $('#pair-timer').textContent = `Link and QR code expire in ${mins}:${secs}`;
      if (remaining <= 0) {
        clearInterval(pairTimerInterval);
        $('#pair-timer').textContent = 'This link has expired. Tap "+ Connect a device" again to generate a new one.';
      }
      remaining--;
    };
    if (pairTimerInterval) clearInterval(pairTimerInterval);
    updateTimer();
    pairTimerInterval = setInterval(updateTimer, 1000);
  } catch (err) {
    toast(err.message || 'Could not generate pairing link.');
    box.hidden = true;
  }
});

$('#pair-close-btn').addEventListener('click', () => {
  $('#pair-box').hidden = true;
  if (pairTimerInterval) clearInterval(pairTimerInterval);
});

$('#pair-approve-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const errEl = $('#pair-approve-error');
  errEl.textContent = '';
  const code = f.code.value.trim().replace(/[^a-zA-Z0-9]/g, '');
  try {
    const res = await api('POST', '/api/pair/approve', { code });
    toast('Approved. That device is signing in now.');
    f.reset();
    $('#pair-box').hidden = true;
    if (pairTimerInterval) clearInterval(pairTimerInterval);
    renderDevices();
  } catch (err) {
    errEl.textContent = err.message || 'Invalid or expired pairing code.';
  }
});

$('#auth-pair-btn').addEventListener('click', async () => {
  $('#auth-form').hidden = true;
  $('#pair-request-card').hidden = false;
  $('#pair-request-code').textContent = '----';
  $('#pair-request-status').innerHTML = '<span class="spinner-dot"></span> Requesting pairing code…';
  try {
    const res = await api('POST', '/api/pair/request');
    $('#pair-request-code').textContent = res.code;
    $('#pair-request-status').innerHTML = '<span class="spinner-dot"></span> Waiting for approval on your other device…';

    if (pairPollInterval) clearInterval(pairPollInterval);
    pairPollInterval = setInterval(async () => {
      try {
        const check = await api('GET', `/api/pair/status?id=${encodeURIComponent(res.id)}`);
        if (check.status === 'approved') {
          clearInterval(pairPollInterval);
          pairPollInterval = null;
          toast('Device approved! Signed in.');
          location.href = '/';
        } else if (check.status === 'expired') {
          clearInterval(pairPollInterval);
          pairPollInterval = null;
          $('#pair-request-status').textContent = 'Code expired. Tap "Use password instead" to retry.';
        }
      } catch (err) {
        clearInterval(pairPollInterval);
      }
    }, 2000);
  } catch (err) {
    $('#pair-request-status').textContent = err.message || 'Could not request code.';
  }
});

$('#pair-request-cancel').addEventListener('click', () => {
  if (pairPollInterval) clearInterval(pairPollInterval);
  pairPollInterval = null;
  $('#pair-request-card').hidden = true;
  $('#auth-form').hidden = false;
});

async function bootPair() {
  $('#drive-view').hidden = true;
  $('#public-share-view').hidden = true;
  $('#auth-view').hidden = false;
  $('#auth-form').hidden = true;
  $('#pair-request-card').hidden = true;
  $('#pair-claim-card').hidden = false;

  const hash = location.hash.replace(/^#/, '');
  const params = new URLSearchParams(location.search);
  const token = hash || params.get('token');

  if (!token) {
    $('#pair-claim-title').textContent = 'Invalid pairing link';
    $('#pair-claim-msg').textContent = 'No pairing token was provided in this URL.';
    $('#pair-claim-actions').hidden = false;
    $('#pair-claim-retry').onclick = () => { location.href = '/'; };
    return;
  }

  $('#pair-claim-title').textContent = 'Connecting this device…';
  $('#pair-claim-msg').textContent = 'Please wait while your session is established.';
  $('#pair-claim-actions').hidden = true;

  try {
    const res = await api('POST', '/api/pair/claim', { token });
    $('#pair-claim-title').textContent = 'Connected!';
    $('#pair-claim-msg').textContent = `Signed in as ${res.user}. Opening your drive…`;
    toast(`Connected as ${res.user}!`);
    setTimeout(() => {
      location.href = '/';
    }, 800);
  } catch (err) {
    $('#pair-claim-title').textContent = 'Pairing link expired or invalid';
    $('#pair-claim-msg').textContent = err.message || 'This pairing link has expired or has already been used.';
    $('#pair-claim-actions').hidden = false;
    $('#pair-claim-retry').onclick = () => { location.href = '/'; };
  }
}

// One click: pick what the AI may do, get a token, and copy a ready-made setup for your tool.
$('#ai-quick-connect-btn').addEventListener('click', () => {
  const card = $('#ai-connect-card');
  card.hidden = !card.hidden;
  if (card.hidden) return;
  $('#ai-connect-step1').hidden = !!cachedAiToken;
  $('#ai-tab-content-wrap').hidden = !cachedAiToken;
});

for (const btn of document.querySelectorAll('[data-ai-scope]')) {
  btn.addEventListener('click', async () => {
    try {
      const { token } = await api('POST', '/api/tokens', {
        label: btn.dataset.aiScope === 'read' ? 'AI assistant (read only)' : 'AI assistant',
        scope: btn.dataset.aiScope,
        rootPath: '/',
        expiresInDays: 90,
      });
      cachedAiToken = token;
      renderAgentTokens().catch(() => {});
      fillAiConnect(token);
      $('#ai-connect-step1').hidden = true;
      $('#ai-tab-content-wrap').hidden = false;
    } catch (err) {
      toast(err.message || 'Could not make a token for the AI.');
    }
  });
}

function fillAiConnect(token) {
  const mcpUrl = `${location.origin}/mcp`;
  const claudeCmd = `claude mcp add --transport http rdrive ${mcpUrl} --header "Authorization: Bearer ${token}"`;
  $('#ai-claude-code-cmd').textContent = claudeCmd;
  $('#ai-copy-claude-code').onclick = () => copyText(claudeCmd, 'Claude Code command copied!');

  // Claude Desktop's config file only runs local commands, so it reaches rdrive through mcp-remote.
  const claudeDesktopConfig = JSON.stringify({
    mcpServers: {
      rdrive: {
        command: 'npx',
        args: ['-y', 'mcp-remote', mcpUrl, '--header', 'Authorization:${RDRIVE_AUTH}'],
        env: { RDRIVE_AUTH: `Bearer ${token}` },
      },
    },
  }, null, 2);
  $('#ai-claude-desktop-cfg').textContent = claudeDesktopConfig;
  $('#ai-copy-claude-desktop').onclick = () => copyText(claudeDesktopConfig, 'Claude Desktop config copied!');

  const cursorConfig = JSON.stringify({
    mcpServers: {
      rdrive: {
        url: mcpUrl,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    },
  }, null, 2);
  $('#ai-cursor-cfg').textContent = cursorConfig;
  $('#ai-copy-cursor').onclick = () => copyText(cursorConfig, 'Cursor config copied!');

  const llmsUrl = `${location.origin}/llms.txt`;
  $('#ai-llms-url').textContent = llmsUrl;
  const brief =
    `You can use my rdrive (my own private file drive) through its MCP server at ${mcpUrl}.\n` +
    `Send the header "Authorization: Bearer ${token}" with every request.\n` +
    `Read ${llmsUrl} first: it lists every tool. Documents (.rdoc) are read and written as Markdown ` +
    `with doc_read, doc_write and doc_append; spreadsheets with sheet_read and sheet_update_cells.`;
  $('#ai-copy-llms').onclick = () => copyText(brief, 'Instructions for the AI copied!');
}

$('#ai-connect-close').addEventListener('click', () => {
  $('#ai-connect-card').hidden = true;
});

const aiTabs = [
  { btn: 'ai-tab-claude-code', pane: 'ai-pane-claude-code' },
  { btn: 'ai-tab-claude-desktop', pane: 'ai-pane-claude-desktop' },
  { btn: 'ai-tab-cursor', pane: 'ai-pane-cursor' },
  { btn: 'ai-tab-llms', pane: 'ai-pane-llms' },
];
for (const t of aiTabs) {
  $(`#${t.btn}`).addEventListener('click', () => {
    for (const other of aiTabs) {
      $(`#${other.btn}`).classList.toggle('active', other.btn === t.btn);
      $(`#${other.pane}`).hidden = other.pane !== t.pane;
    }
  });
}

// ---------- linked servers (sync) ----------

async function renderSync() {
  const s = await api('GET', '/api/sync');
  $('#sync-section').hidden = !s.available || (!s.owner && !s.peers.length);
  if (!s.available) return;
  $('#sync-owner').hidden = !s.owner;
  $('#sync-now').hidden = !s.peers.length;
  $('#sync-status').textContent = s.peers.length
    ? `Files of accounts that exist on both servers stay in sync. This server is "${s.name}".${s.syncing ? ' Syncing now…' : ''}`
    : `Link another rdrive server to keep the same accounts' files on both. This server is "${s.name}".`;
  const list = $('#peer-list');
  list.replaceChildren();
  for (const p of s.peers) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'dev-name';
    name.textContent = p.name;
    const metaLine = document.createElement('div');
    metaLine.className = 'dev-meta';
    const when = p.lastSync ? `synced ${timeAgo(p.lastSync).replace('active now', 'just now')}` : 'not synced yet';
    metaLine.textContent = `${p.url} · ${when}${p.fingerprint ? ` · certificate ${p.fingerprint.slice(0, 23)}…` : ''}`;
    info.append(name, metaLine);
    if (p.lastError) {
      const err = document.createElement('div');
      err.className = 'error';
      err.textContent = p.lastError;
      info.appendChild(err);
    }
    li.appendChild(info);
    if (s.owner) {
      const b = document.createElement('button');
      b.className = 'btn small btn-danger';
      b.textContent = 'Unlink';
      b.addEventListener('click', async () => {
        const ok = await confirmDialog(`Unlink ${p.name}?`, 'Files stop syncing with that server. Nothing is deleted on either one.', 'Unlink');
        if (!ok) return;
        try {
          await api('POST', '/api/sync/unlink', { id: p.id });
          toast(`Unlinked ${p.name}.`);
        } catch (ex) {
          toast(ex.message);
        }
        renderSync();
      });
      li.appendChild(b);
    }
    list.appendChild(li);
  }
}

$('#sync-now').addEventListener('click', async () => {
  try {
    await api('POST', '/api/sync/now');
    toast('Syncing with linked servers…');
    setTimeout(() => renderSync().catch(() => {}), 3000);
  } catch (ex) {
    toast(ex.message);
  }
});

$('#sync-code-btn').addEventListener('click', async () => {
  try {
    const c = await api('POST', '/api/sync/code');
    $('#sync-code-value').textContent = c.code;
    $('#sync-fp').textContent = c.fingerprint || 'none (certificate handled by a proxy)';
    $('#sync-code').hidden = false;
    $('#sync-link-form').hidden = true;
  } catch (ex) {
    toast(ex.message);
  }
});

$('#sync-link-btn').addEventListener('click', () => {
  const f = $('#sync-link-form');
  f.reset();
  f.selfUrl.value = location.origin;
  $('#sync-error').textContent = '';
  $('#sync-code').hidden = true;
  f.hidden = false;
  f.url.focus();
});

$('#sync-link-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#sync-error').textContent = '';
  try {
    const { peer } = await api('POST', '/api/sync/link', { url: f.url.value, code: f.code.value, selfUrl: f.selfUrl.value });
    f.hidden = true;
    toast(`Linked ${peer.name}. Files will start syncing shortly.`);
    renderSync();
  } catch (ex) {
    $('#sync-error').textContent = ex.message;
  }
});

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

// ---------- public share view (/s/:id) ----------

async function bootPublicShare(shareId, subPath = '/') {
  $('#auth-view').hidden = true;
  $('#drive-view').hidden = true;
  $('#public-share-view').hidden = false;

  let info;
  try {
    info = await api('GET', `/api/public/share?id=${encodeURIComponent(shareId)}&sub=${encodeURIComponent(subPath)}`);
  } catch (ex) {
    $('#public-share-lock').hidden = false;
    $('#public-share-content').hidden = true;
    $('#public-share-lock-title').textContent = 'Link unavailable';
    $('#public-share-lock-form').querySelector('label').hidden = true;
    $('#public-share-lock-form').querySelector('button').hidden = true;
    $('#public-share-lock-error').textContent = ex.message;
    return;
  }

  if (info.locked) {
    $('#public-share-lock').hidden = false;
    $('#public-share-content').hidden = true;
    $('#public-share-lock-title').textContent = `Unlock "${info.name}"`;
    $('#public-share-lock-form').onsubmit = async (e) => {
      e.preventDefault();
      $('#public-share-lock-error').textContent = '';
      try {
        await api('POST', '/api/public/share/unlock', { id: shareId, password: e.target.password.value });
        e.target.reset();
        bootPublicShare(shareId, subPath);
      } catch (ex) {
        $('#public-share-lock-error').textContent = ex.message;
      }
    };
    return;
  }

  $('#public-share-lock').hidden = true;
  $('#public-share-content').hidden = false;
  $('#public-share-badge').textContent = info.allowEdit ? (info.isDoc ? 'Shared document (editable)' : 'Shared spreadsheet (editable)') : 'Shared link';

  const dlUrl = `/api/public/share/download?id=${encodeURIComponent(shareId)}&sub=${encodeURIComponent(subPath)}`;
  $('#public-share-download').href = dlUrl;
  $('#public-share-download').textContent = info.type === 'folder' ? 'Download .zip' : 'Download';

  const openSheetBtn = $('#public-share-open-sheet');
  openSheetBtn.hidden = !info.isSheet && !info.isDoc;
  if (info.isDoc) openSheetBtn.textContent = info.allowEdit ? 'Open & edit document' : 'Open document';
  const saveShared = async (payload) => {
    const r = await fetch(`/api/public/share/save?id=${encodeURIComponent(shareId)}`, {
      method: 'PUT',
      headers: { 'X-Rdrive': '1', 'Content-Type': 'application/octet-stream' },
      credentials: 'same-origin',
      body: payload,
    });
    if (!r.ok) throw new Error('Could not save the shared file.');
  };
  const launchSharedDoc = () =>
    window.RDriveDocs.openDocModal({
      name: info.name,
      readOnly: !info.allowEdit,
      loadHtml: async () => {
        const r = await fetch(`${dlUrl}&inline=1`, { credentials: 'same-origin' });
        if (!r.ok) throw new Error('Could not load the shared document.');
        return window.RDriveInterop.parseDoc(await r.text()).html;
      },
      saveHtml: (html) => saveShared(window.RDriveInterop.serializeDoc(html)),
    });
  const launchSharedSheet = () => {
    if (info.isDoc) return launchSharedDoc();
    window.RDriveSheets.openSheetModal({
      name: info.name,
      path: info.name,
      readOnly: !info.allowEdit,
      loadContent: async () => {
        const r = await fetch(`${dlUrl}&inline=1`, { credentials: 'same-origin' });
        if (!r.ok) throw new Error('Could not load shared spreadsheet.');
        return await r.text();
      },
      saveContent: async (payload) => {
        const r = await fetch(`/api/public/share/save?id=${encodeURIComponent(shareId)}`, {
          method: 'PUT',
          headers: { 'X-Rdrive': '1', 'Content-Type': 'application/octet-stream' },
          credentials: 'same-origin',
          body: payload,
        });
        if (!r.ok) throw new Error('Could not save shared spreadsheet.');
      },
    });
  };
  openSheetBtn.onclick = launchSharedSheet;

  const crumbs = $('#public-share-crumbs');
  renderCrumbs(crumbs, subPath, (nextSub) => bootPublicShare(shareId, nextSub), false);
  if (crumbs.firstChild) crumbs.firstChild.textContent = info.name;

  const rows = $('#public-share-rows');
  rows.replaceChildren();
  if (info.type === 'file') {
    const row = document.createElement('div');
    row.className = 'row';
    const check = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'cell-name';
    name.append(svgIcon(info.isSheet ? 'sheet' : info.isDoc ? 'doc' : 'file'), document.createTextNode(info.name));
    const size = document.createElement('span');
    size.className = 'cell-size';
    size.textContent = formatSize(info.size);
    const date = document.createElement('span');
    date.className = 'cell-date';
    date.textContent = formatDate(info.modified);
    row.append(check, name, size, date, document.createElement('span'));
    rows.appendChild(row);
    if (info.isSheet || info.isDoc) launchSharedSheet();
  } else if (Array.isArray(info.entries)) {
    for (const entry of info.entries) {
      const entrySub = joinPath(subPath, entry.name);
      const row = document.createElement('div');
      row.className = 'row';
      const check = document.createElement('span');
      const name = document.createElement('span');
      name.className = 'cell-name';
      name.appendChild(svgIcon(iconFor(entry)));
      const link = document.createElement('a');
      link.className = 'name';
      link.textContent = entry.name;
      link.addEventListener('click', () => {
        if (entry.type === 'folder') bootPublicShare(shareId, entrySub);
        else window.location.href = `/api/public/share/download?id=${encodeURIComponent(shareId)}&sub=${encodeURIComponent(entrySub)}`;
      });
      name.appendChild(link);
      const size = document.createElement('span');
      size.className = 'cell-size';
      size.textContent = entry.type === 'folder' ? '—' : formatSize(entry.size);
      const date = document.createElement('span');
      date.className = 'cell-date';
      date.textContent = formatDate(entry.modified);
      row.append(check, name, size, date, document.createElement('span'));
      rows.appendChild(row);
    }
  }
}

// ---------- boot ----------

window.addEventListener('hashchange', () => {
  if (state.user) load();
});

(async function boot() {
  if (location.pathname === '/pair' || location.pathname.startsWith('/pair/')) {
    return bootPair();
  }
  const shareMatch = /^\/s\/([A-Za-z0-9_-]+)$/.exec(location.pathname);
  if (shareMatch) {
    return bootPublicShare(shareMatch[1]);
  }
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
