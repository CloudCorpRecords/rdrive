#!/usr/bin/env node
// rdrive: a small self-hosted file drive.
//   node server.js                          start the server
//   node server.js adduser NAME             create a user with a password
//   node server.js adduser-github NAME GH   create a user who signs in with GitHub account GH
//   node server.js link-github NAME GH      let an existing user also sign in with GitHub
//   node server.js unlink-github NAME       remove a user's GitHub sign-in
//   node server.js passwd NAME              set/change a password (signs that user out everywhere)
//   node server.js set-owner NAME           make NAME the owner (the account that can link servers)
//   node server.js deluser NAME             remove a user (their files stay on disk)
//   node server.js users                    list users
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const readline = require('node:readline');
const { Auth, SESSION_TTL_MS } = require('./lib/auth');
const { Files, HttpError } = require('./lib/files');
const { GitHubAuth, lookupGithubUser } = require('./lib/github');
const { loadOrCreateCert, lanAddresses } = require('./lib/tls');
const { Sync } = require('./lib/sync');

const DATA_DIR = path.resolve(process.env.RDRIVE_DATA || path.join(__dirname, 'data'));
const PORT = Number(process.env.PORT || 8443);
const HOST = process.env.HOST || '0.0.0.0';
// Plain HTTP is only for running behind something that already encrypts (e.g. `tailscale serve`).
const USE_HTTPS = process.env.RDRIVE_HTTP !== '1';
// Behind a reverse proxy, take the client address from X-Forwarded-For.
const TRUST_PROXY = process.env.RDRIVE_TRUST_PROXY === '1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE = 'rdrive_session';
const OAUTH_COOKIE = 'rdrive_oauth';
const MAX_JSON_BYTES = 64 * 1024;

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};

// Types that are safe to show inline in the browser. Everything else (notably
// HTML and SVG, which could run scripts on this origin) is always downloaded.
const INLINE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8', '.json': 'text/plain; charset=utf-8',
};

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_JSON_BYTES) {
        reject(new HttpError(413, 'Request too large.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJson(buf) {
  try {
    return buf.length ? JSON.parse(buf.toString('utf8')) : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

async function readJsonBody(req) {
  return parseJson(await readRawBody(req));
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        // Ignore malformed cookies rather than failing the request.
      }
    }
  }
  return out;
}

function isLoopback(req) {
  const ip = req.socket.remoteAddress || '';
  // A reverse proxy on the same machine also looks like loopback, so refuse if it forwarded the request.
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip) && !req.headers['x-forwarded-for'];
}

function contentDisposition(type, name) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function serveDownload(req, res, file, inline) {
  const ext = path.extname(file.name).toLowerCase();
  const inlineType = inline ? INLINE_TYPES[ext] : null;
  const headers = {
    'Content-Type': inlineType || 'application/octet-stream',
    'Content-Disposition': contentDisposition(inlineType ? 'inline' : 'attachment', file.name),
    'Accept-Ranges': 'bytes',
    'Last-Modified': file.mtime.toUTCString(),
    'Cache-Control': 'private, no-cache',
  };
  // Chrome's PDF viewer refuses to run inside a sandbox, so PDFs keep the normal page CSP.
  if (inlineType && ext !== '.pdf') headers['Content-Security-Policy'] = "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'";

  // Byte ranges let videos seek and large downloads resume.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && file.size > 0) {
    let start = range[1] === '' ? file.size - Number(range[2]) : Number(range[1]);
    let end = range[1] === '' || range[2] === '' ? file.size - 1 : Number(range[2]);
    start = Math.max(0, start);
    end = Math.min(end, file.size - 1);
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${file.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${file.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file.full, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': file.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file.full).pipe(res);
}

// options: { auth, files, github?, sync?, secureCookies?, trustProxy? }
function createHandler({ auth, files, github = null, sync = null, secureCookies = USE_HTTPS, trustProxy = TRUST_PROXY }) {
  const secure = secureCookies ? '; Secure' : '';
  const sessionCookie = (token, maxAgeSec) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
  // Lax, because GitHub's redirect back to us is a cross-site navigation and Strict cookies aren't sent on it.
  const oauthCookie = (nonce, maxAgeSec) => `${OAUTH_COOKIE}=${nonce}; Path=/auth/github; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;

  const clientIp = (req) => {
    if (trustProxy && req.headers['x-forwarded-for']) {
      const parts = String(req.headers['x-forwarded-for']).split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
    return req.socket.remoteAddress || 'unknown';
  };

  return async function handle(req, res) {
    securityHeaders(res);
    const url = new URL(req.url, 'http://x');
    const route = url.pathname;
    const q = url.searchParams;
    const ip = clientIp(req);
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[COOKIE];
    const meta = { ip, userAgent: req.headers['user-agent'] };

    try {
      if ((req.method === 'GET' || req.method === 'HEAD') && STATIC[route]) {
        const [file, type] = STATIC[route];
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        return res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(path.join(PUBLIC_DIR, file)));
      }

      // ---- GitHub sign-in (browser navigations, not API calls) ----
      if (route === '/auth/github' && req.method === 'GET') {
        if (!github) throw new HttpError(404, 'GitHub sign-in is not configured on this server.');
        const mode = q.get('mode') === 'link' ? 'link' : 'login';
        const user = mode === 'link' ? auth.userForToken(token) : null;
        if (mode === 'link' && !user) return redirect(res, '/?auth_error=' + encodeURIComponent('Sign in first, then link GitHub.'));
        const { url: ghUrl, browserNonce } = github.begin(mode, user);
        res.setHeader('Set-Cookie', oauthCookie(browserNonce, 600));
        return redirect(res, ghUrl);
      }
      if (route === '/auth/github/callback' && req.method === 'GET') {
        if (!github) throw new HttpError(404, 'GitHub sign-in is not configured on this server.');
        res.setHeader('Set-Cookie', [oauthCookie('', 0)]);
        const fail = (msg) => redirect(res, '/?auth_error=' + encodeURIComponent(msg));
        if (q.get('error')) return fail(q.get('error') === 'access_denied' ? 'GitHub sign-in was cancelled.' : 'GitHub sign-in failed.');
        if (auth.lockedFor(ip)) return fail('Too many failed attempts. Try again later.');
        let result;
        try {
          result = await github.complete(q.get('state'), q.get('code'), cookies[OAUTH_COOKIE]);
        } catch (err) {
          return fail(err.message);
        }
        if (result.mode === 'link') {
          try {
            auth.linkGithub(result.user, result.github);
          } catch (err) {
            return fail(err.message);
          }
          return redirect(res, '/?linked=github');
        }
        const username = auth.userByGithubId(result.github.id);
        if (!username) {
          // Count unknown accounts like wrong passwords so this can't be used to probe endlessly.
          auth.recordFailure(ip);
          return fail(`The GitHub account "${result.github.login}" isn't allowed on this rdrive. Ask the owner to add it.`);
        }
        auth.refreshGithubLogin(username, result.github.login);
        const t = auth.createSession(username, { ...meta, method: 'github' });
        res.setHeader('Set-Cookie', [oauthCookie('', 0), sessionCookie(t, SESSION_TTL_MS / 1000)]);
        return redirect(res, '/');
      }

      // ---- Server-to-server sync. Never uses cookies: every request is signed by a linked server. ----
      if (route.startsWith('/sync/')) {
        if (!sync) throw new HttpError(404, 'Not found.');
        const wait = auth.lockedFor(ip);
        if (wait) throw new HttpError(429, 'Too many failed attempts. Try again later.');
        const raw = req.method === 'POST' ? await readRawBody(req) : Buffer.alloc(0);
        if (route === '/sync/pair' && req.method === 'POST') return sendJson(res, 200, sync.acceptPair(parseJson(raw), ip));
        const peer = sync.authenticate(req, raw);
        if (!peer) {
          auth.recordFailure(ip);
          throw new HttpError(401, 'Not a linked server.');
        }
        if (route === '/sync/manifest' && req.method === 'GET') {
          return sendJson(res, 200, { entries: await sync.manifest(q.get('user')) });
        }
        if (route === '/sync/file' && (req.method === 'GET' || req.method === 'HEAD')) {
          return serveDownload(req, res, await sync.fileFor(q.get('user'), q.get('path'), q.get('sha256')), false);
        }
        if (route === '/sync/nudge' && req.method === 'POST') {
          sync.nudged(peer);
          return sendJson(res, 200, { ok: true });
        }
        if (route === '/sync/unpair' && req.method === 'POST') {
          sync.removePeer(peer.id);
          return sendJson(res, 200, { ok: true });
        }
        throw new HttpError(404, 'Not found.');
      }

      if (!route.startsWith('/api/')) throw new HttpError(404, 'Not found.');

      // CSRF protection: browsers won't let another site add a custom header to a
      // cross-origin request without a CORS preflight, which this server never grants.
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-rdrive'] !== '1') {
        throw new HttpError(403, 'Missing X-Rdrive header.');
      }

      const user = auth.userForToken(token);
      if (user) auth.touch(token, ip);

      // ---- Unauthenticated routes ----
      if (route === '/api/status' && req.method === 'GET') {
        return sendJson(res, 200, {
          user,
          needsSetup: !auth.hasUsers(),
          setupAllowedHere: !auth.hasUsers() && isLoopback(req),
          github: !!github,
        });
      }
      if (route === '/api/setup' && req.method === 'POST') {
        // The very first account can only be created from the machine running the server,
        // so nobody else on the network can claim it first.
        if (auth.hasUsers()) throw new HttpError(409, 'Setup is already done.');
        if (!isLoopback(req)) throw new HttpError(403, 'Create the first account from the computer running rdrive (open https://localhost:' + PORT + ').');
        const { username, password } = await readJsonBody(req);
        const problem = auth.validateNewCredentials(username, password);
        if (problem) throw new HttpError(400, problem);
        auth.addUser(username, password);
        const t = auth.createSession(username, { ...meta, method: 'password' });
        res.setHeader('Set-Cookie', sessionCookie(t, SESSION_TTL_MS / 1000));
        return sendJson(res, 200, { user: username });
      }
      if (route === '/api/login' && req.method === 'POST') {
        const wait = auth.lockedFor(ip);
        if (wait) throw new HttpError(429, `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`);
        const { username, password } = await readJsonBody(req);
        const t = auth.login(username, password, meta);
        if (!t) throw new HttpError(401, 'Wrong username or password.');
        res.setHeader('Set-Cookie', sessionCookie(t, SESSION_TTL_MS / 1000));
        return sendJson(res, 200, { user: username });
      }
      if (route === '/api/logout' && req.method === 'POST') {
        auth.logout(token);
        res.setHeader('Set-Cookie', sessionCookie('', 0));
        return sendJson(res, 200, { ok: true });
      }

      // ---- Everything below requires a signed-in user ----
      if (!user) throw new HttpError(401, 'Please sign in.');

      if (route === '/api/list' && req.method === 'GET') {
        return sendJson(res, 200, { path: q.get('path') || '/', entries: await files.list(user, q.get('path')) });
      }
      if (route === '/api/download' && (req.method === 'GET' || req.method === 'HEAD')) {
        const file = await files.fileForDownload(user, q.get('path'));
        return serveDownload(req, res, file, q.get('inline') === '1');
      }
      const changed = () => sync && sync.localChanged();
      if (route === '/api/upload' && req.method === 'PUT') {
        const name = await files.upload(user, q.get('path'), q.get('name'), req, { overwrite: q.get('overwrite') === '1' });
        changed();
        return sendJson(res, 200, { name });
      }
      if (route === '/api/mkdir' && req.method === 'POST') {
        const { path: p, name } = await readJsonBody(req);
        await files.mkdir(user, p, name);
        changed();
        return sendJson(res, 200, { ok: true });
      }
      if (route === '/api/move' && req.method === 'POST') {
        const { from, to } = await readJsonBody(req);
        await files.move(user, from, to);
        changed();
        return sendJson(res, 200, { ok: true });
      }
      if (route === '/api/delete' && req.method === 'POST') {
        const { paths } = await readJsonBody(req);
        if (!Array.isArray(paths) || !paths.length) throw new HttpError(400, 'Nothing to delete.');
        for (const p of paths) await files.trash(user, p);
        changed();
        return sendJson(res, 200, { ok: true });
      }
      if (route === '/api/usage' && req.method === 'GET') {
        return sendJson(res, 200, await files.usage(user));
      }

      // ---- Account and devices ----
      if (route === '/api/account' && req.method === 'GET') {
        const u = auth.getUser(user);
        return sendJson(res, 200, {
          user,
          hasPassword: !!u.hash,
          github: u.github ? u.github.login : null,
          githubAvailable: !!github,
        });
      }
      if (route === '/api/account/password' && req.method === 'POST') {
        const { current, next } = await readJsonBody(req);
        const u = auth.getUser(user);
        if (u.hash) {
          const wait = auth.lockedFor(ip);
          if (wait) throw new HttpError(429, `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`);
          if (!auth.verifyPassword(user, current)) {
            auth.recordFailure(ip);
            throw new HttpError(403, 'Current password is wrong.');
          }
        }
        const problem = auth.validatePassword(next);
        if (problem) throw new HttpError(400, problem);
        auth.setPassword(user, next, { keepToken: token });
        return sendJson(res, 200, { ok: true });
      }
      if (route === '/api/account/unlink-github' && req.method === 'POST') {
        try {
          auth.unlinkGithub(user);
        } catch (err) {
          throw new HttpError(400, err.message);
        }
        return sendJson(res, 200, { ok: true });
      }
      if (route === '/api/sessions' && req.method === 'GET') {
        return sendJson(res, 200, { sessions: auth.listSessions(user, token) });
      }
      if (route === '/api/sessions/revoke' && req.method === 'POST') {
        const { id } = await readJsonBody(req);
        if (!auth.revokeSession(user, String(id || ''))) throw new HttpError(404, 'That device is already signed out.');
        return sendJson(res, 200, { ok: true });
      }
      if (route === '/api/sessions/revoke-others' && req.method === 'POST') {
        auth.revokeUserSessions(user, token);
        return sendJson(res, 200, { ok: true });
      }

      // ---- Linked servers (sync). Everyone can see them; only the owner can change them. ----
      if (route === '/api/sync' && req.method === 'GET') {
        return sendJson(res, 200, { owner: auth.isOwner(user), available: !!sync, ...(sync ? sync.status() : {}) });
      }
      if (route.startsWith('/api/sync/')) {
        if (!sync) throw new HttpError(404, 'Sync is not available on this server.');
        if (!auth.isOwner(user)) throw new HttpError(403, 'Only the owner can manage linked servers.');
        if (route === '/api/sync/code' && req.method === 'POST') return sendJson(res, 200, sync.createCode());
        if (route === '/api/sync/link' && req.method === 'POST') {
          const { url: peerUrl, code, selfUrl } = await readJsonBody(req);
          return sendJson(res, 200, { peer: await sync.link(peerUrl, code, selfUrl) });
        }
        if (route === '/api/sync/unlink' && req.method === 'POST') {
          const { id } = await readJsonBody(req);
          await sync.unlink(id);
          return sendJson(res, 200, { ok: true });
        }
        if (route === '/api/sync/now' && req.method === 'POST') {
          sync.syncAll().catch((err) => console.error(err));
          return sendJson(res, 200, { ok: true });
        }
      }
      throw new HttpError(404, 'Not found.');
    } catch (err) {
      if (res.headersSent) return res.destroy();
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      console.error(err);
      return sendJson(res, 500, { error: 'Something went wrong on the server.' });
    }
  };
}

// ---------- CLI ----------

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      // Echo the prompt itself, but not what's typed.
      if (s.includes(question)) process.stdout.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function askNewPassword() {
  const pw = await askHidden('Password: ');
  const again = await askHidden('Repeat password: ');
  if (pw !== again) throw new Error('Passwords did not match.');
  return pw;
}

async function cli(cmd, args) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const auth = new Auth(DATA_DIR);
  const [name, ghLogin] = args;
  const need = (ok, usage) => {
    if (!ok) throw new Error(`Usage: node server.js ${usage}`);
  };
  if (cmd === 'users') {
    const users = auth.listUsers();
    if (!users.length) return console.log('(no users)');
    for (const u of users) {
      const how = [u.password && 'password', u.github && `GitHub @${u.github}`].filter(Boolean).join(', ');
      console.log(`${u.name.padEnd(20)} ${how}`);
    }
  } else if (cmd === 'adduser') {
    need(name, 'adduser <username>');
    const problem = auth.validateUsername(name);
    if (problem) throw new Error(problem);
    if (auth.getUser(name)) throw new Error(`User "${name}" already exists.`);
    auth.addUser(name, await askNewPassword());
    console.log(`Created user "${name}".`);
  } else if (cmd === 'adduser-github') {
    need(name && ghLogin, 'adduser-github <username> <github-username>');
    const gh = await lookupGithubUser(ghLogin);
    auth.addUser(name, null, { github: gh });
    console.log(`Created user "${name}", who signs in with GitHub account @${gh.login} (id ${gh.id}).`);
  } else if (cmd === 'link-github') {
    need(name && ghLogin, 'link-github <username> <github-username>');
    const gh = await lookupGithubUser(ghLogin);
    auth.linkGithub(name, gh);
    console.log(`"${name}" can now also sign in with GitHub account @${gh.login}.`);
  } else if (cmd === 'unlink-github') {
    need(name, 'unlink-github <username>');
    auth.unlinkGithub(name);
    console.log(`Removed GitHub sign-in from "${name}".`);
  } else if (cmd === 'passwd') {
    need(name, 'passwd <username>');
    auth.setPassword(name, await askNewPassword());
    console.log(`Password set for "${name}". Their existing sessions were signed out.`);
  } else if (cmd === 'set-owner') {
    need(name, 'set-owner <username>');
    auth.setOwner(name);
    console.log(`"${name}" is now the owner (can link servers for sync).`);
  } else if (cmd === 'deluser') {
    need(name, 'deluser <username>');
    auth.deleteUser(name);
    console.log(`Removed "${name}". Their files are still in ${path.join(DATA_DIR, 'files', name)}.`);
  } else {
    throw new Error(`Unknown command "${cmd}".`);
  }
}

function start() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const auth = new Auth(DATA_DIR);
  const files = new Files(DATA_DIR);
  const github = GitHubAuth.fromEnv(process.env);
  const publicHttps = /^https:/i.test(process.env.RDRIVE_PUBLIC_URL || '');
  const tlsInfo = USE_HTTPS ? loadOrCreateCert(DATA_DIR) : null;
  const sync = new Sync({
    dataDir: DATA_DIR,
    auth,
    files,
    name: process.env.RDRIVE_SERVER_NAME,
    url: publicHttps ? process.env.RDRIVE_PUBLIC_URL : null,
    certPem: tlsInfo && tlsInfo.cert,
    interval: Number(process.env.RDRIVE_SYNC_INTERVAL || 60),
  });
  const handler = createHandler({ auth, files, github, sync, secureCookies: USE_HTTPS || publicHttps });
  setInterval(() => auth.pruneSessions(), 60 * 60 * 1000).unref();
  sync.start();

  const server = tlsInfo ? https.createServer({ cert: tlsInfo.cert, key: tlsInfo.key }, handler) : http.createServer(handler);
  // Large uploads over slow links can take a long time; don't cut them off.
  server.requestTimeout = 0;

  server.listen(PORT, HOST, () => {
    const scheme = USE_HTTPS ? 'https' : 'http';
    console.log(`\nrdrive is running. Data folder: ${DATA_DIR}\n`);
    console.log(`  On this computer:  ${scheme}://localhost:${PORT}`);
    if (HOST === '0.0.0.0') {
      for (const ip of lanAddresses()) console.log(`  On your network:   ${scheme}://${ip}:${PORT}`);
    }
    if (process.env.RDRIVE_PUBLIC_URL) console.log(`  Public address:    ${process.env.RDRIVE_PUBLIC_URL}`);
    if (tlsInfo) {
      console.log(`\n  ${tlsInfo.generated ? 'Created a self-signed' : 'Using'} certificate. Fingerprint (SHA-256):`);
      console.log(`  ${tlsInfo.fingerprint}`);
      console.log('  Your browser will warn the first time; check this fingerprint matches, then continue.');
    }
    console.log(github ? `\n  GitHub sign-in: on (callback ${github.callbackUrl})` : '\n  GitHub sign-in: off (see README to enable)');
    const linked = Object.keys(sync.peers).length;
    console.log(`  Sync: this server is "${sync.name}", ${linked} linked server${linked === 1 ? '' : 's'}`);
    if (!auth.hasUsers()) {
      console.log(`\n  No accounts yet. Open ${scheme}://localhost:${PORT} on THIS computer to create one,`);
      console.log('  or run: npm run adduser -- <username>');
    }
    console.log('');
  });
}

if (require.main === module) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd) {
    cli(cmd, args).catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
  } else {
    try {
      start();
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }
}

module.exports = { createHandler };
