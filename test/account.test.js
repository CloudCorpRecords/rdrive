// GitHub sign-in (against a fake GitHub), device/session management and password changes.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { Auth } = require('../lib/auth');
const { Files } = require('../lib/files');
const { GitHubAuth } = require('../lib/github');
const { createHandler } = require('../server');

let dataDir;
let server;
let fakeGithub;
let base;
let ghBase;
let auth;
let ghUser = { id: 4242, login: 'octo' };
const challenges = new Map(); // code -> code_challenge, to check PKCE

function listen(srv) {
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
}

const cookieOf = (res, name) => {
  for (const c of res.headers.getSetCookie()) if (c.startsWith(name + '=')) return c.split(';')[0];
  return null;
};

async function call(method, url, { cookie, body, headers = {} } = {}) {
  const h = { 'X-Rdrive': '1', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0', ...headers };
  if (cookie) h.Cookie = cookie;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  return { res, status: res.status, json: await res.json().catch(() => null) };
}

// Runs the whole browser round trip: start -> (pretend GitHub approves) -> callback.
async function githubRoundTrip({ mode = 'login', sessionCookie, code = 'good', tamperNonce = false } = {}) {
  const start = await fetch(`${base}/auth/github${mode === 'link' ? '?mode=link' : ''}`, {
    headers: sessionCookie ? { Cookie: sessionCookie } : {},
    redirect: 'manual',
  });
  assert.equal(start.status, 302);
  const loc = new URL(start.headers.get('location'), base);
  if (!loc.href.startsWith(ghBase)) return { location: loc.pathname + loc.search };
  const state = loc.searchParams.get('state');
  challenges.set(code, loc.searchParams.get('code_challenge'));
  let nonce = cookieOf(start, 'rdrive_oauth');
  if (tamperNonce) nonce = 'rdrive_oauth=wrong';
  const cb = await fetch(`${base}/auth/github/callback?code=${code}&state=${state}`, {
    headers: { Cookie: nonce, 'User-Agent': 'Mozilla/5.0 (iPhone) Safari/605.1' },
    redirect: 'manual',
  });
  return { status: cb.status, location: cb.headers.get('location'), session: cookieOf(cb, 'rdrive_session'), state };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdrive-acct-'));

  fakeGithub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/login/oauth/access_token' && req.method === 'POST') {
        const { code, code_verifier: verifier, client_secret: secret } = JSON.parse(body);
        const expected = challenges.get(code);
        const pkceOk = expected && crypto.createHash('sha256').update(verifier).digest('base64url') === expected;
        res.setHeader('Content-Type', 'application/json');
        if (secret !== 'test-secret' || code === 'bad' || !pkceOk) return res.end(JSON.stringify({ error: 'bad_verification_code' }));
        return res.end(JSON.stringify({ access_token: 'gho_test', token_type: 'bearer' }));
      }
      if (req.url === '/user' && req.headers.authorization === 'Bearer gho_test') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(ghUser));
      }
      res.writeHead(404).end();
    });
  });
  ghBase = await listen(fakeGithub);

  auth = new Auth(dataDir);
  auth.addUser('owner', 'owner password 1');
  const github = new GitHubAuth({
    clientId: 'test-client',
    clientSecret: 'test-secret',
    publicUrl: 'http://127.0.0.1',
    authorizeUrl: `${ghBase}/login/oauth/authorize`,
    tokenUrl: `${ghBase}/login/oauth/access_token`,
    apiUrl: ghBase,
  });
  server = http.createServer(createHandler({ auth, files: new Files(dataDir), github, secureCookies: false }));
  base = await listen(server);
});

after(() => {
  server.close();
  fakeGithub.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let ownerCookie;

test('status advertises GitHub sign-in', async () => {
  const { json } = await call('GET', '/api/status');
  assert.equal(json.github, true);
});

test('an unlinked GitHub account is refused', async () => {
  const r = await githubRoundTrip();
  assert.equal(r.status, 302);
  assert.match(decodeURIComponent(r.location), /isn't allowed on this rdrive/);
  assert.equal(r.session, null);
});

test('the authorize URL carries state, PKCE and the right callback', async () => {
  const start = await fetch(`${base}/auth/github`, { redirect: 'manual' });
  const loc = new URL(start.headers.get('location'));
  assert.equal(loc.searchParams.get('client_id'), 'test-client');
  assert.equal(loc.searchParams.get('redirect_uri'), 'http://127.0.0.1/auth/github/callback');
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(loc.searchParams.get('state').length >= 32);
  const nonceCookie = start.headers.getSetCookie().find((c) => c.startsWith('rdrive_oauth='));
  assert.match(nonceCookie, /HttpOnly/);
  assert.match(nonceCookie, /SameSite=Lax/);
});

test('linking requires being signed in', async () => {
  const r = await githubRoundTrip({ mode: 'link' });
  assert.match(decodeURIComponent(r.location), /Sign in first/);
});

test('a signed-in user can link GitHub, then sign in with it', async () => {
  const login = await call('POST', '/api/login', { body: { username: 'owner', password: 'owner password 1' } });
  ownerCookie = cookieOf(login.res, 'rdrive_session');
  assert.ok(ownerCookie);

  const link = await githubRoundTrip({ mode: 'link', sessionCookie: ownerCookie });
  assert.equal(link.location, '/?linked=github');
  const acct = await call('GET', '/api/account', { cookie: ownerCookie });
  assert.equal(acct.json.github, 'octo');

  const r = await githubRoundTrip();
  assert.equal(r.location, '/');
  assert.ok(r.session);
  const status = await call('GET', '/api/status', { cookie: r.session });
  assert.equal(status.json.user, 'owner');
});

test('the callback must finish in the same browser, and state is single-use', async () => {
  const wrongBrowser = await githubRoundTrip({ tamperNonce: true });
  assert.match(decodeURIComponent(wrongBrowser.location), /same browser/);
  assert.equal(wrongBrowser.session, null);

  // Replay the (now consumed) state.
  const replay = await fetch(`${base}/auth/github/callback?code=good&state=${wrongBrowser.state}`, { redirect: 'manual' });
  assert.match(decodeURIComponent(replay.headers.get('location')), /expired/);
});

test('a bad code from GitHub is rejected', async () => {
  const r = await githubRoundTrip({ code: 'bad' });
  assert.match(decodeURIComponent(r.location), /GitHub sign-in failed/);
  assert.equal(r.session, null);
});

test('a GitHub account cannot be linked to two users', () => {
  auth.addUser('second', 'second password');
  assert.throws(() => auth.linkGithub('second', { id: 4242, login: 'octo' }), /already linked/);
});

test('signed-in devices are listed and can be signed out remotely', async () => {
  const { json } = await call('GET', '/api/sessions', { cookie: ownerCookie });
  assert.ok(json.sessions.length >= 2);
  assert.equal(json.sessions[0].current, true);
  assert.equal(json.sessions[0].device, 'Chrome on Windows');
  const phone = json.sessions.find((s) => s.device === 'Safari on iOS');
  assert.ok(phone, 'GitHub sign-in from the phone shows up');
  assert.equal(phone.method, 'github');

  assert.equal((await call('POST', '/api/sessions/revoke', { cookie: ownerCookie, body: { id: phone.id } })).status, 200);
  const after = await call('GET', '/api/sessions', { cookie: ownerCookie });
  assert.equal(after.json.sessions.some((s) => s.id === phone.id), false);
});

test('one user cannot sign out another user\'s devices', async () => {
  const other = await call('POST', '/api/login', { body: { username: 'second', password: 'second password' } });
  const otherCookie = cookieOf(other.res, 'rdrive_session');
  const mine = (await call('GET', '/api/sessions', { cookie: ownerCookie })).json.sessions[0];
  const r = await call('POST', '/api/sessions/revoke', { cookie: otherCookie, body: { id: mine.id } });
  assert.equal(r.status, 404);
  assert.equal((await call('GET', '/api/status', { cookie: ownerCookie })).json.user, 'owner');
});

test('"sign out all others" keeps only this device', async () => {
  const extra = await call('POST', '/api/login', { body: { username: 'owner', password: 'owner password 1' } });
  const extraCookie = cookieOf(extra.res, 'rdrive_session');
  await call('POST', '/api/sessions/revoke-others', { cookie: ownerCookie });
  assert.equal((await call('GET', '/api/status', { cookie: extraCookie })).json.user, null);
  assert.equal((await call('GET', '/api/sessions', { cookie: ownerCookie })).json.sessions.length, 1);
});

test('changing the password needs the current one and signs out other devices', async () => {
  const extra = await call('POST', '/api/login', { body: { username: 'owner', password: 'owner password 1' } });
  const extraCookie = cookieOf(extra.res, 'rdrive_session');

  const wrong = await call('POST', '/api/account/password', { cookie: ownerCookie, body: { current: 'nope', next: 'brand new password' } });
  assert.equal(wrong.status, 403);

  const ok = await call('POST', '/api/account/password', { cookie: ownerCookie, body: { current: 'owner password 1', next: 'brand new password' } });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/api/status', { cookie: ownerCookie })).json.user, 'owner');
  assert.equal((await call('GET', '/api/status', { cookie: extraCookie })).json.user, null);
});

test('GitHub-only accounts cannot sign in with a password and cannot unlink', async () => {
  auth.addUser('ghonly', null, { github: { id: 777, login: 'someone' } });
  const r = await call('POST', '/api/login', { body: { username: 'ghonly', password: '' } });
  assert.equal(r.status, 401);
  assert.throws(() => auth.unlinkGithub('ghonly'), /Set a password/);
});
