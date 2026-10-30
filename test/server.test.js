const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { Auth } = require('../lib/auth');
const { Files } = require('../lib/files');
const { createHandler } = require('../server');

let server;
let base;
let dataDir;
let cookie = '';

async function req(method, url, { body, raw, headers = {}, auth = true } = {}) {
  const h = { 'X-Rdrive': '1', ...headers };
  if (auth && cookie) h.Cookie = cookie;
  let payload = raw;
  if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + url, { method, headers: h, body: payload });
  const setCookie = res.headers.get('set-cookie');
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, setCookie };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdrive-test-'));
  const handler = createHandler({ auth: new Auth(dataDir), files: new Files(dataDir) });
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('first-run setup creates the owner and signs in', async () => {
  const s = await req('GET', '/api/status');
  assert.equal(s.json.needsSetup, true);
  assert.equal(s.json.setupAllowedHere, true);

  const weak = await req('POST', '/api/setup', { body: { username: 'me', password: 'short' } });
  assert.equal(weak.status, 400);

  const r = await req('POST', '/api/setup', { body: { username: 'me', password: 'correct horse battery' } });
  assert.equal(r.status, 200);
  assert.match(r.setCookie, /HttpOnly/);
  assert.match(r.setCookie, /SameSite=Strict/);
  cookie = r.setCookie.split(';')[0];

  const again = await req('POST', '/api/setup', { body: { username: 'x', password: 'another password' } });
  assert.equal(again.status, 409);
});

test('setup is refused through a proxy', async () => {
  const s = await req('GET', '/api/status', { headers: { 'X-Forwarded-For': '1.2.3.4' }, auth: false });
  assert.equal(s.json.setupAllowedHere, false);
});

test('requests without a session are rejected', async () => {
  const r = await req('GET', '/api/list?path=/', { auth: false });
  assert.equal(r.status, 401);
});

test('mutating requests need the X-Rdrive header (CSRF)', async () => {
  const res = await fetch(base + '/api/mkdir', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/', name: 'evil' }),
  });
  assert.equal(res.status, 403);
});

test('upload, list, download, rename, delete', async () => {
  const up = await req('PUT', '/api/upload?path=/&name=hello.txt', { raw: 'hello world' });
  assert.equal(up.status, 200);
  assert.equal(up.json.name, 'hello.txt');

  const dup = await req('PUT', '/api/upload?path=/&name=hello.txt', { raw: 'second' });
  assert.equal(dup.json.name, 'hello (1).txt');

  assert.equal((await req('POST', '/api/mkdir', { body: { path: '/', name: 'Docs' } })).status, 200);
  const list = await req('GET', '/api/list?path=/');
  assert.deepEqual(list.json.entries.map((e) => e.name), ['Docs', 'hello (1).txt', 'hello.txt']);

  const dl = await req('GET', '/api/download?path=/hello.txt');
  assert.equal(dl.text, 'hello world');

  const range = await fetch(base + '/api/download?path=/hello.txt', { headers: { Cookie: cookie, Range: 'bytes=6-' } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), 'world');

  assert.equal((await req('POST', '/api/move', { body: { from: '/hello.txt', to: '/Docs/hi.txt' } })).status, 200);
  const docs = await req('GET', '/api/list?path=/Docs');
  assert.deepEqual(docs.json.entries.map((e) => e.name), ['hi.txt']);

  const intoSelf = await req('POST', '/api/move', { body: { from: '/Docs', to: '/Docs/inner' } });
  assert.equal(intoSelf.status, 400);

  assert.equal((await req('POST', '/api/delete', { body: { paths: ['/Docs/hi.txt'] } })).status, 200);
  assert.equal((await req('GET', '/api/list?path=/Docs')).json.entries.length, 0);
  assert.equal(fs.readdirSync(path.join(dataDir, 'trash', 'me')).length, 1);
});

test('HTML is never served inline', async () => {
  await req('PUT', '/api/upload?path=/&name=page.html', { raw: '<script>alert(1)</script>' });
  const res = await fetch(base + '/api/download?path=/page.html&inline=1', { headers: { Cookie: cookie } });
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.match(res.headers.get('content-disposition'), /^attachment/);
});

test('path traversal is blocked', async () => {
  for (const p of ['/../users.json', '/..\\users.json', '/a/../../x', '/C:/Windows', '/file.txt:stream']) {
    const r = await req('GET', `/api/list?path=${encodeURIComponent(p)}`);
    assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
  }
  const up = await req('PUT', `/api/upload?path=/&name=${encodeURIComponent('../escape.txt')}`, { raw: 'x' });
  assert.equal(up.status, 400);
  assert.equal(fs.existsSync(path.join(dataDir, 'files', 'escape.txt')), false);
});

test('users cannot see each other\'s files', async () => {
  const auth = new Auth(dataDir);
  auth.addUser('other', 'other users password');
  // The running server holds its own Auth instance, so log in through a fresh handler on the same data dir.
  const handler = createHandler({ auth, files: new Files(dataDir) });
  const s2 = http.createServer(handler);
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const login = await fetch(b2 + '/api/login', {
    method: 'POST',
    headers: { 'X-Rdrive': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'other', password: 'other users password' }),
  });
  const c2 = login.headers.get('set-cookie').split(';')[0];
  const list = await (await fetch(b2 + '/api/list?path=/', { headers: { Cookie: c2 } })).json();
  assert.deepEqual(list.entries, []);
  s2.close();
});

test('repeated failed logins lock the IP out', async () => {
  for (let i = 0; i < 5; i++) {
    const r = await req('POST', '/api/login', { body: { username: 'me', password: 'wrong' }, auth: false });
    assert.equal(r.status, 401);
  }
  const locked = await req('POST', '/api/login', { body: { username: 'me', password: 'correct horse battery' }, auth: false });
  assert.equal(locked.status, 429);
});

test('logout ends the session', async () => {
  await req('POST', '/api/logout');
  assert.equal((await req('GET', '/api/list?path=/')).status, 401);
});
