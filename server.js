#!/usr/bin/env node
// rdrive: a small self-hosted file drive.
//   node server.js              start the server
//   node server.js adduser NAME create a user (prompts for password)
//   node server.js passwd NAME  change a password (signs that user out everywhere)
//   node server.js deluser NAME remove a user (their files stay on disk)
//   node server.js users        list users
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const readline = require('node:readline');
const { Auth, SESSION_TTL_MS } = require('./lib/auth');
const { Files, HttpError } = require('./lib/files');
const { loadOrCreateCert, lanAddresses } = require('./lib/tls');

const DATA_DIR = path.resolve(process.env.RDRIVE_DATA || path.join(__dirname, 'data'));
const PORT = Number(process.env.PORT || 8443);
const HOST = process.env.HOST || '0.0.0.0';
// Plain HTTP is only for running behind something that already encrypts (e.g. `tailscale serve`).
const USE_HTTPS = process.env.RDRIVE_HTTP !== '1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE = 'rdrive_session';
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

function readJsonBody(req) {
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
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token, maxAgeSec) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${USE_HTTPS ? '; Secure' : ''}`;
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

function createHandler({ auth, files }) {
  return async function handle(req, res) {
    securityHeaders(res);
    const url = new URL(req.url, 'http://x');
    const route = url.pathname;
    const q = url.searchParams;

    try {
      if ((req.method === 'GET' || req.method === 'HEAD') && STATIC[route]) {
        const [file, type] = STATIC[route];
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        return res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(path.join(PUBLIC_DIR, file)));
      }
      if (!route.startsWith('/api/')) throw new HttpError(404, 'Not found.');

      // CSRF protection: browsers won't let another site add a custom header to a
      // cross-origin request without a CORS preflight, which this server never grants.
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-rdrive'] !== '1') {
        throw new HttpError(403, 'Missing X-Rdrive header.');
      }

      const ip = req.socket.remoteAddress || 'unknown';
      const token = parseCookies(req.headers.cookie)[COOKIE];
      const user = auth.userForToken(token);

      // ---- Unauthenticated routes ----
      if (route === '/api/status' && req.method === 'GET') {
        return sendJson(res, 200, {
          user,
          needsSetup: !auth.hasUsers(),
          setupAllowedHere: !auth.hasUsers() && isLoopback(req),
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
        const t = auth.login(username, password, ip);
        res.setHeader('Set-Cookie', sessionCookie(t, SESSION_TTL_MS / 1000));
        return sendJson(res, 200, { user: username });
      }
      if (route === '/api/login' && req.method === 'POST') {
        const wait = auth.lockedFor(ip);
        if (wait) throw new HttpError(429, `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`);
        const { username, password } = await readJsonBody(req);
        const t = auth.login(username, password, ip);
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
      if (route === '/api/upload' && req.method === 'PUT') {
        const name = await files.upload(user, q.get('path'), q.get('name'), req, { overwrite: q.get('overwrite') === '1' });
        return sendJson(res, 200, { name });
      }
      if (route === '/api/mkdir' && req.method === 'POST') {
        const { path: p, name } = await readJsonBody(req);
        await files.mkdir(user, p, name);
        return sendJson(res, 200, { ok: true });
      }
      if (route === '/api/move' && req.method === 'POST') {
        const { from, to } = await readJsonBody(req);
        await files.move(user, from, to);
        return sendJson(res, 200, { ok: true });
      }
      if (route === '/api/delete' && req.method === 'POST') {
        const { paths } = await readJsonBody(req);
        if (!Array.isArray(paths) || !paths.length) throw new HttpError(400, 'Nothing to delete.');
        for (const p of paths) await files.trash(user, p);
        return sendJson(res, 200, { ok: true });
      }
      if (route === '/api/usage' && req.method === 'GET') {
        return sendJson(res, 200, await files.usage(user));
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

async function cli(cmd, name) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const auth = new Auth(DATA_DIR);
  if (cmd === 'users') {
    console.log(auth.listUsers().join('\n') || '(no users)');
  } else if (cmd === 'adduser') {
    if (!name) throw new Error('Usage: node server.js adduser <username>');
    const problem = auth.validateNewCredentials(name, 'x'.repeat(64));
    if (problem) throw new Error(problem);
    auth.addUser(name, await askNewPassword());
    console.log(`Created user "${name}".`);
  } else if (cmd === 'passwd') {
    if (!name) throw new Error('Usage: node server.js passwd <username>');
    auth.setPassword(name, await askNewPassword());
    console.log(`Password changed for "${name}". Their existing sessions were signed out.`);
  } else if (cmd === 'deluser') {
    if (!name) throw new Error('Usage: node server.js deluser <username>');
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
  const handler = createHandler({ auth, files });
  setInterval(() => auth.pruneSessions(), 60 * 60 * 1000).unref();

  let server;
  let tlsInfo;
  if (USE_HTTPS) {
    tlsInfo = loadOrCreateCert(DATA_DIR);
    server = https.createServer({ cert: tlsInfo.cert, key: tlsInfo.key }, handler);
  } else {
    server = http.createServer(handler);
  }
  // Large uploads over slow links can take a long time; don't cut them off.
  server.requestTimeout = 0;

  server.listen(PORT, HOST, () => {
    const scheme = USE_HTTPS ? 'https' : 'http';
    console.log(`\nrdrive is running. Data folder: ${DATA_DIR}\n`);
    console.log(`  On this computer:  ${scheme}://localhost:${PORT}`);
    if (HOST === '0.0.0.0') {
      for (const ip of lanAddresses()) console.log(`  On your network:   ${scheme}://${ip}:${PORT}`);
    }
    if (tlsInfo) {
      console.log(`\n  ${tlsInfo.generated ? 'Created a' : 'Using'} ${tlsInfo.generated ? 'self-signed ' : ''}certificate. Fingerprint (SHA-256):`);
      console.log(`  ${tlsInfo.fingerprint}`);
      console.log('  Your browser will warn the first time; check this fingerprint matches, then continue.');
    }
    if (!auth.hasUsers()) {
      console.log(`\n  No accounts yet. Open ${scheme}://localhost:${PORT} on THIS computer to create one,`);
      console.log('  or run: npm run adduser -- <username>');
    }
    console.log('');
  });
}

if (require.main === module) {
  const [cmd, name] = process.argv.slice(2);
  if (cmd) {
    cli(cmd, name).catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
  } else {
    start();
  }
}

module.exports = { createHandler };
