const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { Auth } = require('../lib/auth');
const { Files } = require('../lib/files');
const { Shares } = require('../lib/shares');
const { DevicePairing } = require('../lib/pair');
const { createHandler } = require('../server');

let server;
let base;
let dataDir;
let cookie = '';
let shares;

async function req(method, url, { body, raw, authCookie = cookie } = {}) {
  const h = { 'X-Rdrive': '1' };
  if (authCookie) h.Cookie = authCookie;
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdrive-connect-ai-'));
  const auth = new Auth(dataDir);
  const files = new Files(dataDir);
  shares = new Shares(dataDir);
  const pairing = new DevicePairing();
  const handler = createHandler({ auth, files, shares, pairing });
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const setup = await req('POST', '/api/setup', {
    body: { username: 'elena', password: 'elena-super-password' },
    authCookie: '',
  });
  cookie = setup.setCookie.split(';')[0];
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('/llms.txt serves AI guidance with MCP instructions', async () => {
  const res = await req('GET', '/llms.txt', { authCookie: '' });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type').includes('text/markdown'));
  assert.ok(res.text.includes('# rdrive'));
  assert.ok(res.text.includes('claude mcp add'));
  assert.ok(res.text.includes('doc_read'));
  assert.ok(res.text.includes('doc_write'));
});

test('public share /s/<id>.md returns markdown for .rdoc documents', async () => {
  // Create an RDoc file
  const created = await req('POST', '/api/doc/create', { body: { path: '/', name: 'Project Roadmap' } });
  assert.equal(created.status, 200);

  // Write content into it
  const rdocJson = JSON.stringify({
    format: 'rdrive-doc',
    version: 1,
    html: '<h1>Roadmap 2026</h1><p>Our <strong>core</strong> goals.</p>',
  });
  await req('PUT', '/api/upload?path=/&name=Project Roadmap.rdoc&overwrite=1', { raw: rdocJson });

  // Create public share
  const sh = shares.create('elena', { path: '/Project Roadmap.rdoc', expiresInHours: 24 });

  // Fetch as markdown via /s/<id>.md
  const mdRes = await req('GET', `/s/${sh.id}.md`, { authCookie: '' });
  assert.equal(mdRes.status, 200);
  assert.ok(mdRes.headers.get('content-type').includes('text/markdown'));
  assert.ok(mdRes.text.includes('# Roadmap 2026'));
  assert.ok(mdRes.text.includes('**core** goals'));

  // Password protected share refuses markdown without unlock
  const pwShare = shares.create('elena', { path: '/Project Roadmap.rdoc', password: 'secret-code' });
  const pwRes = await req('GET', `/s/${pwShare.id}.md`, { authCookie: '' });
  assert.equal(pwRes.status, 401);

  // Non-document files have no Markdown version
  await req('PUT', '/api/upload?path=/&name=photo.jpg', { raw: 'not really a jpeg' });
  const imgShare = shares.create('elena', { path: '/photo.jpg' });
  assert.equal((await req('GET', `/s/${imgShare.id}.md`, { authCookie: '' })).status, 415);
});

test('a forged link token is refused and counts as a failed attempt', async () => {
  const res = await req('POST', '/api/pair/claim', { body: { token: 'f'.repeat(64) }, authCookie: '' });
  assert.equal(res.status, 400);
  assert.equal(res.setCookie, null);
});

test('device pairing flow: link/QR code generation and claim', async () => {
  // Unauthenticated link generation fails
  const fail = await req('POST', '/api/pair/link', { authCookie: '' });
  assert.equal(fail.status, 401);

  // Authenticated link generation succeeds
  const linkRes = await req('POST', '/api/pair/link');
  assert.equal(linkRes.status, 200);
  assert.ok(linkRes.json.token);
  assert.ok(linkRes.json.url.includes('/pair#' + linkRes.json.token));
  assert.ok(linkRes.json.appUri.includes('rdrive://pair'));

  // Claim link on a new device (unauthenticated)
  const claimRes = await req('POST', '/api/pair/claim', {
    body: { token: linkRes.json.token },
    authCookie: '',
  });
  assert.equal(claimRes.status, 200);
  assert.equal(claimRes.json.user, 'elena');
  assert.ok(claimRes.setCookie);

  // Claimed cookie works for authenticated requests
  const newCookie = claimRes.setCookie.split(';')[0];
  const list = await req('GET', '/api/list?path=/', { authCookie: newCookie });
  assert.equal(list.status, 200);

  // Re-claiming the same token fails (single use)
  const reuse = await req('POST', '/api/pair/claim', {
    body: { token: linkRes.json.token },
    authCookie: '',
  });
  assert.equal(reuse.status, 400);
});

test('device pairing flow: short code request and approval', async () => {
  // New device requests a code
  const codeReq = await req('POST', '/api/pair/request', { authCookie: '' });
  assert.equal(codeReq.status, 200);
  const { id, code } = codeReq.json;
  assert.ok(id);
  assert.ok(code);

  // Check pending status
  const pending = await req('GET', `/api/pair/status?id=${id}`, { authCookie: '' });
  assert.equal(pending.status, 200);
  assert.equal(pending.json.status, 'pending');

  // Approving without authentication fails
  const unauthApprove = await req('POST', '/api/pair/approve', {
    body: { code },
    authCookie: '',
  });
  assert.equal(unauthApprove.status, 401);

  // Approving with wrong code fails
  const wrongApprove = await req('POST', '/api/pair/approve', {
    body: { code: 'ZZZZ-9999' },
  });
  assert.equal(wrongApprove.status, 400);

  // Approving with correct code succeeds
  const approve = await req('POST', '/api/pair/approve', {
    body: { code },
  });
  assert.equal(approve.status, 200);
  assert.equal(approve.json.ok, true);

  // New device polls status again -> approved and receives session cookie
  const pollApproved = await req('GET', `/api/pair/status?id=${id}`, { authCookie: '' });
  assert.equal(pollApproved.status, 200);
  assert.equal(pollApproved.json.status, 'approved');
  assert.equal(pollApproved.json.user, 'elena');
  assert.ok(pollApproved.setCookie);

  const deviceCookie = pollApproved.setCookie.split(';')[0];
  const checkDrive = await req('GET', '/api/list?path=/', { authCookie: deviceCookie });
  assert.equal(checkDrive.status, 200);
});

test('/pair and /vendor/qrcode.js static routes are accessible', async () => {
  const pairPage = await req('GET', '/pair', { authCookie: '' });
  assert.equal(pairPage.status, 200);
  assert.ok(pairPage.headers.get('content-type').includes('text/html'));
  assert.ok(pairPage.text.includes('qrcode.js'));

  const qrcodeJs = await req('GET', '/vendor/qrcode.js', { authCookie: '' });
  assert.equal(qrcodeJs.status, 200);
  assert.ok(qrcodeJs.headers.get('content-type').includes('javascript'));
  assert.ok(qrcodeJs.text.includes('qrcode'));
});
