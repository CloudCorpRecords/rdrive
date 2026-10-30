// Two in-process rdrive servers ("alpha" and "beta") on temp data dirs, linked for sync.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { Auth } = require('../lib/auth');
const { Files } = require('../lib/files');
const { Sync, conflictName } = require('../lib/sync');
const { loadOrCreateCert } = require('../lib/tls');
const { createHandler } = require('../server');

const servers = [];
let A;
let B;

async function startServer(name) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `rdrive-sync-${name}-`));
  const tlsInfo = loadOrCreateCert(dataDir);
  const auth = new Auth(dataDir);
  const files = new Files(dataDir);
  const sync = new Sync({ dataDir, auth, files, name, certPem: tlsInfo.cert, auto: false });
  const s = { name, dataDir, tlsInfo, auth, files, sync, cookies: {}, ranges: [] };
  const handler = createHandler({ auth, files, sync });
  s.server = https.createServer({ cert: tlsInfo.cert, key: tlsInfo.key }, (req, res) => {
    if (req.url.startsWith('/sync/file')) s.ranges.push(req.headers.range || null);
    return s.handler ? s.handler(req, res, handler) : handler(req, res);
  });
  await new Promise((r) => s.server.listen(0, '127.0.0.1', r));
  s.url = `https://127.0.0.1:${s.server.address().port}`;
  sync.url = s.url;
  servers.push(s);
  return s;
}

// Browser-style API call to a server with a self-signed certificate.
function api(s, method, url, { body, user, headers = {} } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const h = { 'X-Rdrive': '1', ...headers };
  if (user) h.Cookie = s.cookies[user];
  if (payload !== undefined) h['Content-Type'] = 'application/json';
  return new Promise((resolve, reject) => {
    const r = https.request(s.url + url, { method, headers: h, rejectUnauthorized: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, json, text, headers: res.headers });
      });
    });
    r.on('error', reject);
    r.end(payload);
  });
}

async function login(s, user) {
  const res = await new Promise((resolve, reject) => {
    const r = https.request(s.url + '/api/login', { method: 'POST', headers: { 'X-Rdrive': '1', 'Content-Type': 'application/json' }, rejectUnauthorized: false }, resolve);
    r.on('error', reject);
    r.end(JSON.stringify({ username: user, password: 'correct horse battery' }));
  });
  res.resume();
  assert.equal(res.statusCode, 200);
  s.cookies[user] = res.headers['set-cookie'][0].split(';')[0];
}

const userFile = (s, user, p) => path.join(s.dataDir, 'files', user, ...p.split('/').filter(Boolean));
const read = (s, user, p) => fs.readFileSync(userFile(s, user, p), 'utf8');
const exists = (s, user, p) => fs.existsSync(userFile(s, user, p));
const trashNames = (s, user) => {
  try {
    return fs.readdirSync(path.join(s.dataDir, 'trash', user));
  } catch {
    return [];
  }
};

function write(s, user, p, content, mtime) {
  const full = userFile(s, user, p);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  if (mtime) fs.utimesSync(full, mtime, mtime);
}

// Upload through the web API, like the browser does.
function put(s, user, dir, name, content, overwrite = false) {
  const url = `${s.url}/api/upload?path=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}${overwrite ? '&overwrite=1' : ''}`;
  return new Promise((resolve, reject) => {
    const r = https.request(url, { method: 'PUT', headers: { 'X-Rdrive': '1', Cookie: s.cookies[user] }, rejectUnauthorized: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    r.on('error', reject);
    r.end(content);
  });
}

async function syncBoth() {
  const a = await A.sync.syncAll();
  const b = await B.sync.syncAll();
  const a2 = await A.sync.syncAll();
  return { a, b, a2 };
}

// Failed attempts in these tests all come from 127.0.0.1; don't let them lock the tests out.
function forgiveFailures() {
  for (const s of servers) s.auth.failures.clear();
}

before(async () => {
  A = await startServer('alpha');
  B = await startServer('beta');
  for (const s of [A, B]) {
    s.auth.addUser('me', 'correct horse battery'); // first account: the owner
    s.auth.addUser('ann', 'correct horse battery');
    await login(s, 'me');
    await login(s, 'ann');
  }
  A.auth.addUser('onlyalpha', 'correct horse battery');
});

after(() => {
  for (const s of servers) {
    s.server.close();
    fs.rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('the first account is the owner, and only the owner manages linked servers', async () => {
  assert.equal(A.auth.ownerName(), 'me');
  const asAnn = await api(A, 'POST', '/api/sync/code', { user: 'ann' });
  assert.equal(asAnn.status, 403);
  const status = await api(A, 'GET', '/api/sync', { user: 'ann' });
  assert.equal(status.json.owner, false);
  assert.deepEqual(status.json.peers, []);
});

test('a wrong pairing code links nothing and burns the code after 5 tries', async () => {
  const { json } = await api(A, 'POST', '/api/sync/code', { user: 'me' });
  assert.match(json.code, /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
  const wrong = await api(B, 'POST', '/api/sync/link', { user: 'me', body: { url: A.url, code: 'AAAAA-AAAAA-AAAAA-AAAAA', selfUrl: B.url } });
  assert.equal(wrong.status, 403);
  assert.equal(Object.keys(A.sync.peers).length, 0);
  assert.equal(Object.keys(B.sync.peers).length, 0);
  for (let i = 0; i < 4; i++) {
    await api(B, 'POST', '/api/sync/link', { user: 'me', body: { url: A.url, code: 'AAAAA-AAAAA-AAAAA-AAAAA', selfUrl: B.url } });
    forgiveFailures();
  }
  const right = await api(B, 'POST', '/api/sync/link', { user: 'me', body: { url: A.url, code: json.code, selfUrl: B.url } });
  assert.equal(right.status, 403, 'the code is burned after 5 wrong tries');
  forgiveFailures();
});

test('a pairing proof bound to a different certificate (man in the middle) is refused', async () => {
  const { json } = await api(A, 'POST', '/api/sync/code', { user: 'me' });
  const code = json.code.replace(/-/g, '');
  const nonce = crypto.randomBytes(16).toString('hex');
  const id = crypto.randomBytes(16).toString('hex');
  // The client saw some other certificate (B's here) instead of A's.
  const proof = A.sync.pairProof(code, { id, name: 'mitm', url: B.url, certFp: '', serverFp: B.sync.fingerprint, nonce });
  const r = await api(A, 'POST', '/sync/pair', { body: { id, name: 'mitm', url: B.url, cert: null, pinned: true, nonce, proof } });
  assert.equal(r.status, 403);
  assert.equal(Object.keys(A.sync.peers).length, 0);
  forgiveFailures();
});

test('pairing with a one-time code links both servers and pins certificates', async () => {
  const { json } = await api(A, 'POST', '/api/sync/code', { user: 'me' });
  assert.equal(json.fingerprint, A.sync.fingerprint);
  const r = await api(B, 'POST', '/api/sync/link', { user: 'me', body: { url: A.url, code: json.code.toLowerCase(), selfUrl: B.url } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.peer.name, 'alpha');
  assert.equal(r.json.peer.fingerprint, A.sync.fingerprint);

  const a = (await api(A, 'GET', '/api/sync', { user: 'me' })).json;
  assert.equal(a.peers.length, 1);
  assert.equal(a.peers[0].name, 'beta');
  assert.equal(a.peers[0].fingerprint, B.sync.fingerprint);
  assert.equal(A.sync.peers[B.sync.id].secret, B.sync.peers[A.sync.id].secret);

  const again = await api(B, 'POST', '/api/sync/link', { user: 'me', body: { url: A.url, code: json.code, selfUrl: B.url } });
  assert.equal(again.status, 403, 'a code works only once');
  forgiveFailures();
});

test('unpaired or unsigned requests to /sync are refused', async () => {
  const noAuth = await api(A, 'GET', '/sync/manifest?user=ann');
  assert.equal(noAuth.status, 401);

  // A server with its own identity that never paired, guessing a secret.
  const strangerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdrive-sync-stranger-'));
  const stranger = new Sync({ dataDir: strangerDir, auth: new Auth(strangerDir), files: new Files(strangerDir), name: 'stranger', auto: false });
  const fake = { url: A.url, cert: A.tlsInfo.cert, secret: crypto.randomBytes(32).toString('hex') };
  const res = await stranger.request(fake, 'GET', '/sync/manifest?user=ann');
  res.resume();
  assert.equal(res.statusCode, 401);

  // Claiming to be B without B's secret.
  stranger.id = B.sync.id;
  const res2 = await stranger.request(fake, 'GET', '/sync/manifest?user=ann');
  res2.resume();
  assert.equal(res2.statusCode, 401);
  fs.rmSync(strangerDir, { recursive: true, force: true });

  // A correctly signed request can't be replayed.
  const peerA = B.sync.peers[A.sync.id];
  const authz = B.sync.signature(peerA, 'GET', '/sync/manifest?user=ann', Buffer.alloc(0));
  const first = await api(A, 'GET', '/sync/manifest?user=ann', { headers: { Authorization: authz } });
  assert.equal(first.status, 200);
  const replay = await api(A, 'GET', '/sync/manifest?user=ann', { headers: { Authorization: authz } });
  assert.equal(replay.status, 401);

  // B refuses to talk to a server that presents a different certificate than the pinned one.
  const wrongCert = { ...peerA, cert: B.tlsInfo.cert };
  await assert.rejects(B.sync.request(wrongCert, 'GET', '/sync/manifest?user=ann'), /different certificate|self.signed|certificate/i);
  forgiveFailures();
});

test('creating files and folders propagates both ways, only for shared usernames', async () => {
  assert.equal(await put(A, 'ann', '/', 'hello.txt', 'hello from alpha'), 200);
  assert.equal((await api(A, 'POST', '/api/mkdir', { user: 'ann', body: { path: '/', name: 'Photos' } })).status, 200);
  assert.equal(await put(A, 'ann', '/Photos', 'cat.jpg', 'meow'), 200);
  assert.equal((await api(A, 'POST', '/api/mkdir', { user: 'ann', body: { path: '/', name: 'Empty' } })).status, 200);
  write(A, 'onlyalpha', '/private.txt', 'not for beta');
  write(B, 'me', '/from-beta.txt', 'hello from beta');

  const { b } = await syncBoth();
  assert.deepEqual(b[A.sync.id].errors, []);
  assert.equal(read(B, 'ann', '/hello.txt'), 'hello from alpha');
  assert.equal(read(B, 'ann', '/Photos/cat.jpg'), 'meow');
  assert.ok(fs.statSync(userFile(B, 'ann', '/Empty')).isDirectory());
  assert.equal(read(A, 'me', '/from-beta.txt'), 'hello from beta');
  assert.equal(fs.existsSync(path.join(B.dataDir, 'files', 'onlyalpha')), false);
});

test('edits propagate', async () => {
  assert.equal(await put(A, 'ann', '/', 'hello.txt', 'edited on alpha', true), 200);
  await syncBoth();
  assert.equal(read(B, 'ann', '/hello.txt'), 'edited on alpha');

  write(B, 'ann', '/Photos/cat.jpg', 'purr');
  await syncBoth();
  assert.equal(read(A, 'ann', '/Photos/cat.jpg'), 'purr');
});

test('renames and moves propagate without downloading again', async () => {
  assert.equal((await api(A, 'POST', '/api/move', { user: 'ann', body: { from: '/hello.txt', to: '/greeting.txt' } })).status, 200);
  assert.equal((await api(A, 'POST', '/api/move', { user: 'ann', body: { from: '/Photos', to: '/Pictures' } })).status, 200);
  const { b } = await syncBoth();
  const stats = b[A.sync.id];
  assert.deepEqual(stats.errors, []);
  assert.equal(stats.downloaded, 0);
  assert.equal(stats.moved, 2);
  assert.equal(read(B, 'ann', '/greeting.txt'), 'edited on alpha');
  assert.equal(read(B, 'ann', '/Pictures/cat.jpg'), 'purr');
  assert.equal(exists(B, 'ann', '/hello.txt'), false);
  assert.equal(exists(B, 'ann', '/Photos'), false);
});

test('deletes go to the trash on the other server', async () => {
  const before = trashNames(B, 'ann').length;
  assert.equal((await api(A, 'POST', '/api/delete', { user: 'ann', body: { paths: ['/greeting.txt', '/Pictures'] } })).status, 200);
  await syncBoth();
  assert.equal(exists(B, 'ann', '/greeting.txt'), false);
  assert.equal(exists(B, 'ann', '/Pictures'), false);
  const trash = trashNames(B, 'ann');
  assert.equal(trash.length, before + 2);
  assert.ok(trash.some((n) => n.endsWith('__greeting.txt')));
  const pics = trash.find((n) => n.endsWith('__Pictures'));
  assert.equal(fs.readFileSync(path.join(B.dataDir, 'trash', 'ann', pics, 'cat.jpg'), 'utf8'), 'purr');
  // And nothing comes back on the next round.
  await syncBoth();
  assert.equal(exists(A, 'ann', '/greeting.txt'), false);
});

test('edits on both sides keep both copies, identically on both servers', async () => {
  write(A, 'ann', '/notes.txt', 'v1');
  await syncBoth();
  assert.equal(read(B, 'ann', '/notes.txt'), 'v1');

  const older = new Date('2026-10-01T10:00:00Z');
  const newer = new Date('2026-10-02T10:00:00Z');
  write(A, 'ann', '/notes.txt', 'alpha edit', older);
  write(B, 'ann', '/notes.txt', 'beta edit', newer);
  await syncBoth();
  await syncBoth();

  const loser = conflictName('notes.txt', 'alpha', older.getTime());
  assert.equal(loser, 'notes (conflict from alpha 2026-10-01).txt');
  for (const s of [A, B]) {
    assert.equal(read(s, 'ann', '/notes.txt'), 'beta edit', `${s.name} keeps the newer edit under the original name`);
    assert.equal(read(s, 'ann', '/' + loser), 'alpha edit', `${s.name} keeps the other edit as a conflict copy`);
    const names = fs.readdirSync(path.join(s.dataDir, 'files', 'ann')).filter((n) => n.startsWith('notes'));
    assert.equal(names.length, 2, `${s.name}: ${names}`);
  }
});

test('an edit on one side beats a delete on the other', async () => {
  write(A, 'ann', '/keep.txt', 'v1');
  await syncBoth();
  assert.equal((await api(A, 'POST', '/api/delete', { user: 'ann', body: { paths: ['/keep.txt'] } })).status, 200);
  write(B, 'ann', '/keep.txt', 'edited on beta');
  await syncBoth();
  assert.equal(read(A, 'ann', '/keep.txt'), 'edited on beta');
  assert.equal(read(B, 'ann', '/keep.txt'), 'edited on beta');
});

test('an interrupted download resumes with a Range request', async () => {
  const big = crypto.randomBytes(1024 * 1024);
  const sha = crypto.createHash('sha256').update(big).digest('hex');
  write(A, 'ann', '/big.bin', big);
  // Pretend an earlier attempt got the first 300 KB.
  const partDir = path.join(B.dataDir, 'sync', 'partial', A.sync.id);
  fs.mkdirSync(partDir, { recursive: true });
  fs.writeFileSync(path.join(partDir, `${sha}.rdrive-part`), big.subarray(0, 300 * 1024));
  A.ranges.length = 0;
  await B.sync.syncAll();
  assert.deepEqual(A.ranges, [`bytes=${300 * 1024}-`]);
  assert.ok(fs.readFileSync(userFile(B, 'ann', '/big.bin')).equals(big));
  assert.equal(fs.existsSync(path.join(partDir, `${sha}.rdrive-part`)), false);
});

test('corrupted partial data is detected by the checksum and not used', async () => {
  const data = crypto.randomBytes(64 * 1024);
  const sha = crypto.createHash('sha256').update(data).digest('hex');
  write(A, 'ann', '/data.bin', data);
  const partDir = path.join(B.dataDir, 'sync', 'partial', A.sync.id);
  fs.writeFileSync(path.join(partDir, `${sha}.rdrive-part`), Buffer.alloc(1000, 7));
  const first = (await B.sync.syncAll())[A.sync.id];
  assert.equal(exists(B, 'ann', '/data.bin'), false);
  assert.match(first.errors.join('\n'), /checksum/);
  await B.sync.syncAll();
  assert.ok(fs.readFileSync(userFile(B, 'ann', '/data.bin')).equals(data));
});

test('path traversal in requests from a linked server is refused', async () => {
  write(A, 'me', '/secret.txt', 'owner only');
  const peerA = B.sync.peers[A.sync.id];
  const get = async (q) => {
    const res = await B.sync.request(peerA, 'GET', q);
    res.resume();
    return res.statusCode;
  };
  assert.equal(await get(`/sync/file?user=ann&path=${encodeURIComponent('/../me/secret.txt')}`), 400);
  assert.equal(await get(`/sync/file?user=ann&path=${encodeURIComponent('..\\me\\secret.txt')}`), 400);
  assert.equal(await get(`/sync/file?user=..&path=${encodeURIComponent('/files/me/secret.txt')}`), 400);
  assert.equal(await get(`/sync/file?user=${encodeURIComponent('../files/me')}&path=/secret.txt`), 400);
  assert.equal(await get(`/sync/manifest?user=..`), 400);
  assert.equal(await get(`/sync/manifest?user=nobody`), 404);
});

test('path traversal in a malicious peer manifest is refused', async () => {
  const content = 'pwned';
  const sha = crypto.createHash('sha256').update(content).digest('hex');
  const bad = (p) => ({ path: p, type: 'file', size: content.length, mtime: Date.now(), sha256: sha });
  const entries = [
    bad('/../../evil.txt'),
    bad('/a/../../../evil.txt'),
    bad('/..\\..\\evil.txt'),
    bad('\\..\\evil.txt'),
    bad('/C:/evil.txt'),
    bad('//evil.txt'),
    bad('/ok/./evil.txt'),
    bad('/evil.txt\u0000.jpg'),
    bad('/evil.txt.rdrive-part'),
    bad('/'),
    { path: '/fine.txt', type: 'file', size: content.length, mtime: Date.now(), sha256: sha },
  ];
  // A linked server that has turned hostile: it adds the entries above to its real list,
  // and serves the same bytes for any of them.
  const realEntries = await A.sync.manifest('ann');
  A.handler = (req, res, real) => {
    if (req.url.startsWith('/sync/manifest') && req.url.includes('user=ann')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ entries: [...realEntries, ...entries] }));
    }
    if (req.url.startsWith('/sync/file') && !req.url.includes('user=me')) {
      res.writeHead(200);
      return res.end(content);
    }
    return real(req, res);
  };
  try {
    const stats = (await B.sync.syncAll())[A.sync.id];
    assert.equal(stats.rejected, entries.length - 1);
  } finally {
    A.handler = null;
  }
  assert.equal(read(B, 'ann', '/fine.txt'), content);
  const found = [];
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory()) walk(path.join(dir, d.name));
      else if (d.name.includes('evil')) found.push(path.join(dir, d.name));
    }
  };
  walk(B.dataDir);
  assert.deepEqual(found, []);
  for (const outside of [path.join(path.dirname(B.dataDir), 'evil.txt'), path.join(B.dataDir, 'files', 'evil.txt'), path.join(B.dataDir, 'evil.txt')]) {
    assert.equal(fs.existsSync(outside), false, outside);
  }
  assert.equal(read(B, 'ann', '/keep.txt'), 'edited on beta');
});

test('unlinking removes the peer on both sides', async () => {
  const r = await api(B, 'POST', '/api/sync/unlink', { user: 'me', body: { id: A.sync.id } });
  assert.equal(r.status, 200);
  assert.equal(Object.keys(B.sync.peers).length, 0);
  assert.equal(Object.keys(A.sync.peers).length, 0);
});
