// Server side of RDocs: creating documents, serving them and the format libraries, and share links.
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

async function req(method, url, { body, raw, auth = true } = {}) {
  const h = { 'X-Rdrive': '1' };
  if (auth && cookie) h.Cookie = cookie;
  let payload = raw;
  if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + url, { method, headers: h, body: payload });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, json, text, setCookie: res.headers.get('set-cookie') };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdrive-docs-'));
  server = http.createServer(createHandler({ auth: new Auth(dataDir), files: new Files(dataDir) }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const setup = await req('POST', '/api/setup', { body: { username: 'dana', password: 'dana-strong-password' } });
  cookie = setup.setCookie.split(';')[0];
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('creating a document makes an empty .rdoc, never overwriting', async () => {
  const a = await req('POST', '/api/doc/create', { body: { path: '/', name: 'Plan' } });
  assert.equal(a.status, 200);
  assert.deepEqual(a.json, { name: 'Plan.rdoc', path: '/Plan.rdoc' });
  const b = await req('POST', '/api/doc/create', { body: { path: '/', name: 'Plan.rdoc' } });
  assert.equal(b.json.name, 'Plan (1).rdoc');

  const dl = await req('GET', '/api/download?path=/Plan.rdoc&inline=1');
  assert.equal(dl.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(dl.json, { format: 'rdrive-doc', version: 1, html: '<p><br></p>' });
});

test('the editor scripts and format libraries are served (and need no sign-in)', async () => {
  for (const p of ['/docs.js', '/interop.js', '/vendor/exceljs.min.js', '/vendor/jszip.min.js', '/vendor/mammoth.browser.min.js', '/vendor/docx.iife.js']) {
    const r = await req('GET', p, { auth: false });
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), /javascript/, p);
  }
  assert.equal((await req('GET', '/vendor/../server.js', { auth: false })).status, 404);
});

test('share links can make a document editable, but not a Word file', async () => {
  const doc = await req('POST', '/api/shares', { body: { path: '/Plan.rdoc', allowEdit: true } });
  const id = doc.json.share.id;
  const info = await req('GET', `/api/public/share?id=${id}`, { auth: false });
  assert.equal(info.json.isDoc, true);
  assert.equal(info.json.allowEdit, true);

  const edited = JSON.stringify({ format: 'rdrive-doc', version: 1, html: '<p>Edited by a guest</p>' });
  assert.equal((await req('PUT', `/api/public/share/save?id=${id}`, { raw: edited, auth: false })).status, 200);
  const after = await req('GET', '/api/download?path=/Plan.rdoc&inline=1');
  assert.equal(after.json.html, '<p>Edited by a guest</p>');

  await req('PUT', '/api/upload?path=/&name=Report.docx', { raw: 'PK fake docx' });
  const word = await req('POST', '/api/shares', { body: { path: '/Report.docx', allowEdit: true } });
  const wid = word.json.share.id;
  assert.equal((await req('GET', `/api/public/share?id=${wid}`, { auth: false })).json.allowEdit, false);
  assert.equal((await req('PUT', `/api/public/share/save?id=${wid}`, { raw: 'overwritten', auth: false })).status, 403);
});

test('a view-only document link cannot be saved to', async () => {
  const share = await req('POST', '/api/shares', { body: { path: '/Plan (1).rdoc', allowEdit: false } });
  const res = await req('PUT', `/api/public/share/save?id=${share.json.share.id}`, { raw: '{}', auth: false });
  assert.equal(res.status, 403);
});
