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
const fsp = fs.promises;
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const readline = require('node:readline');
const { Auth, SESSION_TTL_MS } = require('./lib/auth');
const { Files, HttpError, segments } = require('./lib/files');
const { GitHubAuth, lookupGithubUser } = require('./lib/github');
const { loadOrCreateCert, lanAddresses } = require('./lib/tls');
const { Sync } = require('./lib/sync');
const { Shares, isSheetName, isDocName, isEditableName } = require('./lib/shares');
const { streamFolderAsZip } = require('./lib/zip');
const { handleWebdav } = require('./lib/webdav');
const { McpServer, generateLlmsTxt } = require('./lib/mcp');
const { DevicePairing } = require('./lib/pair');
const { rdocToMarkdown, isRdocName } = require('./lib/rdoc');
const ai = require('./lib/ai_service');
const { getPhotosTimeline } = require('./lib/photos');
const { OCRStore, smartSearch } = require('./lib/smart_search');
const { WatcherManager } = require('./lib/watchers');
const { StarredManager } = require('./lib/starred');
const { VaultManager } = require('./lib/vault');
const { getStorageAnalytics } = require('./lib/storage_cleanup');

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
  '/sheet.js': ['sheet.js', 'text/javascript; charset=utf-8'],
  '/docs.js': ['docs.js', 'text/javascript; charset=utf-8'],
  '/interop.js': ['interop.js', 'text/javascript; charset=utf-8'],
  // Office/OpenDocument format libraries, loaded only when importing or exporting (see scripts/vendor.js).
  '/vendor/exceljs.min.js': ['vendor/exceljs.min.js', 'text/javascript; charset=utf-8'],
  '/vendor/jszip.min.js': ['vendor/jszip.min.js', 'text/javascript; charset=utf-8'],
  '/vendor/mammoth.browser.min.js': ['vendor/mammoth.browser.min.js', 'text/javascript; charset=utf-8'],
  '/vendor/docx.iife.js': ['vendor/docx.iife.js', 'text/javascript; charset=utf-8'],
  '/vendor/qrcode.js': ['vendor/qrcode.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/manifest.json': ['manifest.json', 'application/manifest+json; charset=utf-8'],
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
  '.csv': 'text/plain; charset=utf-8', '.tsv': 'text/plain; charset=utf-8',
  '.json': 'text/plain; charset=utf-8', '.rsheet': 'application/json; charset=utf-8',
  '.rdoc': 'application/json; charset=utf-8',
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

function readRawBody(req, limit = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
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

function defaultSheetPayload(title = 'Sheet 1') {
  return JSON.stringify(
    {
      format: 'rdrive-sheet',
      version: 1,
      activeSheet: 0,
      sheets: [
        {
          name: title,
          rows: 50,
          cols: 16,
          colWidths: {},
          frozenRows: 1,
          cells: {},
        },
      ],
    },
    null,
    2
  );
}

// options: { auth, files, github?, sync?, shares?, pairing?, secureCookies?, trustProxy? }
function createHandler({ auth, files, github = null, sync = null, shares = null, pairing = null, ocrStore = null, watchers = null, starred = null, vault = null, secureCookies = USE_HTTPS, trustProxy = TRUST_PROXY }) {
  if (!shares && files && files.filesDir) shares = new Shares(path.dirname(files.filesDir));
  if (!pairing) pairing = new DevicePairing();
  if (!ocrStore && files && files.filesDir) ocrStore = new OCRStore(path.dirname(files.filesDir));
  if (!watchers && files && files.filesDir) watchers = new WatcherManager(path.dirname(files.filesDir), ocrStore);
  if (!starred && files && files.filesDir) starred = new StarredManager(path.dirname(files.filesDir));
  if (!vault && files && files.filesDir) vault = new VaultManager(path.dirname(files.filesDir));
  const mcp = new McpServer({ auth, files, shares, onChanged: () => sync && sync.localChanged() });
  const secure = secureCookies ? '; Secure' : '';
  const sessionCookie = (token, maxAgeSec) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
  // Lax, because GitHub's redirect back to us is a cross-site navigation and Strict cookies aren't sent on it.
  const oauthCookie = (nonce, maxAgeSec) => `${OAUTH_COOKIE}=${nonce}; Path=/auth/github; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
  const shareCookieName = (id) => `rdrive_share_${id}`;
  const shareCookie = (id, token, maxAgeSec) => `${shareCookieName(id)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;

  const clientIp = (req) => {
    if (trustProxy && req.headers['x-forwarded-for']) {
      const parts = String(req.headers['x-forwarded-for']).split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
    return req.socket.remoteAddress || 'unknown';
  };

  // The address other devices and AI agents should use. Prefer the configured public URL over headers.
  const publicOrigin = (req) => {
    const configured = String(process.env.RDRIVE_PUBLIC_URL || '').replace(/\/+$/, '');
    if (/^https?:\/\/[^/]+$/i.test(configured)) return configured;
    const fwd = trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const proto = fwd === 'https' || fwd === 'http' ? fwd : USE_HTTPS ? 'https' : 'http';
    const host = /^[A-Za-z0-9.:[\]-]+$/.test(req.headers.host || '') ? req.headers.host : `${HOST}:${PORT}`;
    return `${proto}://${host}`;
  };

  return async function handle(req, res) {
    securityHeaders(res);
    const url = new URL(req.url, 'http://x');
    const route = url.pathname;
    const q = url.searchParams;
    const ip = clientIp(req);
    const cookies = parseCookies(req.headers.cookie);
    const authHeader = String(req.headers.authorization || '');
    const bearerMatch = /^Bearer\s+(\S+)$/i.exec(authHeader);
    const token = cookies[COOKIE] || (bearerMatch ? bearerMatch[1] : null);
    const vaultToken = req.headers['x-rdrive-vault'] || cookies['rdrive_vault'];
    const meta = { ip, userAgent: req.headers['user-agent'] };
    const changed = () => sync && sync.localChanged();

    try {
      if ((req.method === 'GET' || req.method === 'HEAD') && (STATIC[route] || route === '/pair' || /^\/s\/[A-Za-z0-9_-]+$/.test(route))) {
        const [file, type] = STATIC[route] || STATIC['/'];
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        return res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(path.join(PUBLIC_DIR, file)));
      }

      // ---- AI overview guide (/llms.txt) ----
      if (route === '/llms.txt' && (req.method === 'GET' || req.method === 'HEAD')) {
        const body = generateLlmsTxt({ origin: publicOrigin(req) });
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }

      // ---- Public share direct markdown (/s/:id.md) ----
      const mdShareMatch = /^\/s\/([A-Za-z0-9_-]+)\.md$/.exec(route);
      if (mdShareMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        if (!shares) throw new HttpError(404, 'Not found.');
        const shareId = mdShareMatch[1];
        const s = shares.get(shareId);
        if (!s || !auth.getUser(s.user)) throw new HttpError(404, 'This share link does not exist or has expired.');
        const unlocked = shares.isUnlocked(shareId, cookies[shareCookieName(shareId)]);
        if (!unlocked) throw new HttpError(401, 'Password required.');
        const file = await files.fileForDownload(s.user, s.path);
        if (!isRdocName(file.name) && !/\.(md|markdown|txt)$/i.test(file.name)) {
          throw new HttpError(415, 'Only documents and text files have a Markdown version.');
        }
        if (file.size > 2 * 1024 * 1024) throw new HttpError(413, 'This document is too large to show as Markdown.');
        const raw = await fsp.readFile(file.full, 'utf8');
        const mdText = isRdocName(file.name) ? rdocToMarkdown(raw) : raw;
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Cache-Control': 'private, no-cache',
        });
        return res.end(req.method === 'HEAD' ? undefined : mdText);
      }

      // ---- WebDAV network drive mount (/dav) ----
      if (route === '/dav' || route.startsWith('/dav/')) {
        return await handleWebdav(req, res, {
          auth,
          files,
          ip,
          sessionUser: auth.userForToken(token),
          serveDownload,
          onChanged: changed,
        });
      }

      // ---- Model Context Protocol (MCP) for AI Agents (/mcp) ----
      // Authenticated strictly per individual with a Personal Agent Token (Bearer rdrive_pat_...).
      if (route === '/mcp') {
        const wait = auth.lockedFor(ip);
        if (wait) throw new HttpError(429, 'Too many failed attempts. Try again later.');
        const authHeader = String(req.headers.authorization || '');
        const bearerMatch = /^Bearer\s+(\S+)$/i.exec(authHeader);
        const rawPat = bearerMatch ? bearerMatch[1] : String(req.headers['x-rdrive-token'] || '');
        const tokenInfo = auth.verifyAgentToken(rawPat, ip);
        if (!tokenInfo) {
          if (rawPat) auth.recordFailure(ip);
          res.writeHead(401, {
            'WWW-Authenticate': 'Bearer realm="rdrive-mcp"',
            'Content-Type': 'application/json; charset=utf-8',
          });
          return res.end(JSON.stringify({ error: 'Valid Personal Agent Token (Bearer rdrive_pat_...) required.' }));
        }
        if (req.method === 'GET') {
          if ((req.headers.accept || '').includes('text/event-stream')) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            });
            res.write(': rdrive-mcp stream ready\n\n');
            req.on('close', () => res.end());
            return;
          }
          return sendJson(res, 200, {
            name: 'rdrive-mcp',
            user: tokenInfo.user,
            scope: tokenInfo.scope,
            rootPath: tokenInfo.rootPath,
          });
        }
        if (req.method === 'DELETE') {
          res.writeHead(204);
          return res.end();
        }
        if (req.method === 'POST') {
          // Agents may write whole files or spreadsheets in one call, so allow up to 4 MB here.
          const body = parseJson(await readRawBody(req, 4 * 1024 * 1024));
          if (Array.isArray(body)) {
            const replies = (await Promise.all(body.map((msg) => mcp.handleJsonRpc(tokenInfo, msg)))).filter(Boolean);
            if (!replies.length) {
              res.writeHead(202);
              return res.end();
            }
            return sendJson(res, 200, replies);
          }
          const reply = await mcp.handleJsonRpc(tokenInfo, body);
          if (!reply) {
            res.writeHead(202);
            return res.end();
          }
          return sendJson(res, 200, reply);
        }
        throw new HttpError(405, 'Method not allowed.');
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

      // ---- Device pairing (unauthenticated side) ----
      if (route === '/api/pair/claim' && req.method === 'POST') {
        const wait = auth.lockedFor(ip);
        if (wait) throw new HttpError(429, `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`);
        const { token: linkToken } = await readJsonBody(req);
        const claimed = pairing.claimLinkToken(linkToken);
        if (!claimed || !auth.getUser(claimed.user)) {
          auth.recordFailure(ip);
          throw new HttpError(400, 'Invalid or expired pairing link.');
        }
        const t = auth.createSession(claimed.user, { ...meta, method: 'pair-link' });
        res.setHeader('Set-Cookie', sessionCookie(t, SESSION_TTL_MS / 1000));
        return sendJson(res, 200, { ok: true, user: claimed.user });
      }
      if (route === '/api/pair/request' && req.method === 'POST') {
        const wait = auth.lockedFor(ip);
        if (wait) throw new HttpError(429, `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`);
        const codeReq = pairing.createCodeRequest(ip);
        if (!codeReq) throw new HttpError(429, 'Too many sign-in codes waiting. Try again in a few minutes.');
        return sendJson(res, 200, codeReq);
      }
      if (route === '/api/pair/status' && req.method === 'GET') {
        const status = pairing.checkCodeStatus(q.get('id'));
        if (status.status === 'approved' && auth.getUser(status.user)) {
          // The session is made here, for the device that asked, not when the code was approved.
          const t = auth.createSession(status.user, { ...meta, method: 'pair-code' });
          res.setHeader('Set-Cookie', sessionCookie(t, SESSION_TTL_MS / 1000));
          return sendJson(res, 200, { status: 'approved', user: status.user });
        }
        return sendJson(res, 200, { status: status.status === 'pending' ? 'pending' : 'expired' });
      }

      // ---- Public share links (/api/public/share*) ----
      if (route.startsWith('/api/public/share')) {
        if (!shares) throw new HttpError(404, 'Not found.');
        if (route === '/api/public/share/unlock' && req.method === 'POST') {
          const wait = auth.lockedFor(ip);
          if (wait) throw new HttpError(429, `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`);
          const { id, password } = await readJsonBody(req);
          const s = shares.get(id);
          if (!s) throw new HttpError(404, 'This share link does not exist or has expired.');
          if (!shares.verifyPassword(id, password)) {
            auth.recordFailure(ip);
            throw new HttpError(401, 'Wrong password.');
          }
          res.setHeader('Set-Cookie', shareCookie(id, shares.unlockToken(id), 86400));
          return sendJson(res, 200, { ok: true });
        }

        const id = q.get('id');
        const s = shares.get(id);
        if (!s || !auth.getUser(s.user)) throw new HttpError(404, 'This share link does not exist or has expired.');
        const unlocked = shares.isUnlocked(id, cookies[shareCookieName(id)]);

        if (route === '/api/public/share' && req.method === 'GET') {
          shares.recordView(s.id);
          const baseName = path.posix.basename(s.path);
          if (!unlocked) return sendJson(res, 200, { id: s.id, locked: true, name: baseName });
          const full = files.resolve(s.user, s.path);
          const st = await files.stat(full);
          const isDir = st.isDirectory();
          const sub = q.get('sub') || '/';
          const subSegs = isDir ? segments(sub) : [];
          const subClientPath = isDir ? s.path + (subSegs.length ? '/' + subSegs.join('/') : '') : s.path;
          return sendJson(res, 200, {
            id: s.id,
            locked: false,
            name: baseName,
            type: isDir ? 'folder' : 'file',
            size: isDir ? null : st.size,
            modified: st.mtime.toISOString(),
            isSheet: !isDir && isSheetName(baseName),
            isDoc: !isDir && isDocName(baseName),
            allowEdit: !isDir && !!s.allowEdit,
            expires: s.expires ? new Date(s.expires).toISOString() : null,
            sub: '/' + subSegs.join('/'),
            entries: isDir ? await files.list(s.user, subClientPath) : undefined,
          });
        }

        if (!unlocked) throw new HttpError(401, 'Password required.');

        if (route === '/api/public/share/download' && (req.method === 'GET' || req.method === 'HEAD')) {
          shares.recordDownload(s.id);
          const rootFull = files.resolve(s.user, s.path);
          const rootStat = await files.stat(rootFull);
          const subSegs = rootStat.isDirectory() ? segments(q.get('sub') || '/') : [];
          const targetClientPath = s.path + (subSegs.length ? '/' + subSegs.join('/') : '');
          const targetFull = files.resolve(s.user, targetClientPath);
          const targetStat = await files.stat(targetFull);
          if (targetStat.isDirectory()) {
            const zipName = `${path.basename(targetFull)}.zip`;
            res.writeHead(200, {
              'Content-Type': 'application/zip',
              'Content-Disposition': contentDisposition('attachment', zipName),
              'Cache-Control': 'private, no-cache',
            });
            if (req.method === 'HEAD') return res.end();
            return await streamFolderAsZip(targetFull, path.basename(targetFull), res);
          }
          const file = await files.fileForDownload(s.user, targetClientPath);
          return serveDownload(req, res, file, q.get('inline') === '1');
        }

        if (route === '/api/public/share/save' && req.method === 'PUT') {
          if (!s.allowEdit || !isEditableName(s.path)) throw new HttpError(403, 'Editing is not enabled for this share link.');
          const segs = segments(s.path);
          const fileName = segs.pop();
          const dirPath = '/' + segs.join('/');
          await files.upload(s.user, dirPath, fileName, req, { overwrite: true });
          changed();
          return sendJson(res, 200, { ok: true, modified: new Date().toISOString() });
        }
        throw new HttpError(404, 'Not found.');
      }

      // ---- Everything below requires a signed-in user ----
      if (!user) throw new HttpError(401, 'Please sign in.');

      // ---- Device pairing (authenticated side) ----
      if (route === '/api/pair/link' && req.method === 'POST') {
        const linkToken = pairing.createLinkToken(user, meta);
        const origin = publicOrigin(req);
        const pairUrl = `${origin}/pair#${linkToken}`;
        const appUri = `rdrive://pair?url=${encodeURIComponent(origin)}&token=${linkToken}`;
        return sendJson(res, 200, { token: linkToken, url: pairUrl, appUri, expiresIn: 300 });
      }
      if (route === '/api/pair/approve' && req.method === 'POST') {
        const { code } = await readJsonBody(req);
        if (!pairing.approveCode(code, user)) throw new HttpError(400, 'Invalid, expired, or already used code.');
        return sendJson(res, 200, { ok: true });
      }

      // ---- Encrypted Private Vault ("Secure Folder") ----
      if (route === '/api/vault/status' && req.method === 'GET') {
        return sendJson(res, 200, {
          hasPin: vault.hasPin(user),
          unlocked: vault.isUnlocked(user, vaultToken),
        });
      }
      if (route === '/api/vault/setup' && req.method === 'POST') {
        const { pin } = await readJsonBody(req);
        await vault.setPin(user, pin);
        try { await files.mkdir(user, '/', 'Vault'); } catch {}
        const session = vault.unlock(user, pin);
        return sendJson(res, 200, { ok: true, vaultToken: session.token, ...session });
      }
      if (route === '/api/vault/unlock' && req.method === 'POST') {
        const { pin } = await readJsonBody(req);
        const session = vault.unlock(user, pin);
        if (!session) throw new HttpError(401, 'Incorrect Vault PIN.');
        return sendJson(res, 200, { ok: true, vaultToken: session.token, ...session });
      }
      if (route === '/api/vault/lock' && req.method === 'POST') {
        vault.lock(vaultToken);
        return sendJson(res, 200, { ok: true });
      }

      // ---- Storage Analytics & Duplicate Cleanup ----
      if (route === '/api/storage/analytics' && req.method === 'GET') {
        return sendJson(res, 200, await getStorageAnalytics(files, user));
      }

      // ---- In-Browser Code & Config Editor ----
      if (route === '/api/code/read' && req.method === 'GET') {
        const p = q.get('path');
        if (!p) throw new HttpError(400, 'Path is required.');
        if (vault.isVaultPath(p) && !vault.isUnlocked(user, vaultToken)) throw new HttpError(403, 'Vault is locked.');
        const full = files.resolve(user, p);
        const st = await files.stat(full);
        if (st.isDirectory()) throw new HttpError(400, 'Cannot edit a directory as code.');
        if (st.size > 5 * 1024 * 1024) throw new HttpError(413, 'File is too large to edit in the browser (> 5MB).');
        const content = await fsp.readFile(full, 'utf8');
        return sendJson(res, 200, {
          path: p,
          name: path.basename(full),
          size: st.size,
          modified: st.mtime.toISOString(),
          content,
        });
      }
      if (route === '/api/code/save' && req.method === 'POST') {
        const { path: p, content } = await readJsonBody(req);
        if (!p) throw new HttpError(400, 'Path is required.');
        if (typeof content !== 'string') throw new HttpError(400, 'Content must be text.');
        if (vault.isVaultPath(p) && !vault.isUnlocked(user, vaultToken)) throw new HttpError(403, 'Vault is locked.');
        const norm = '/' + segments(p).join('/');
        const dir = path.posix.dirname(norm);
        const name = path.posix.basename(norm);
        await files.writeBuffer(user, dir, name, Buffer.from(content, 'utf8'), { overwrite: true });
        changed();
        return sendJson(res, 200, { ok: true });
      }

      if (route === '/api/list' && req.method === 'GET') {
        const targetPath = q.get('path') || '/';
        const isVaultLocked = !vault.isUnlocked(user, vaultToken);
        if (vault.isVaultPath(targetPath) && isVaultLocked) {
          throw new HttpError(403, 'Vault is locked.');
        }
        let entries = await files.list(user, targetPath);
        if (targetPath === '/') {
          if (vault.hasPin(user) && !entries.some((e) => e.name === 'Vault')) {
            try { await files.mkdir(user, '/', 'Vault'); entries = await files.list(user, '/'); } catch {}
          }
          if (isVaultLocked) {
            entries = entries.map((e) => (e.name === 'Vault' ? { ...e, isVault: true, locked: true } : e));
          }
        }
        return sendJson(res, 200, {
          path: targetPath,
          entries,
          starred: starred.list(user),
          vault: {
            hasPin: vault.hasPin(user),
            unlocked: !isVaultLocked,
          },
        });
      }
      if (route === '/api/starred' && req.method === 'GET') {
        const list = starred.list(user);
        const items = [];
        for (const p of list) {
          try {
            const norm = '/' + segments(p).join('/');
            const parent = path.posix.dirname(norm);
            const name = path.posix.basename(norm);
            const entries = await files.list(user, parent);
            const found = entries.find((e) => e.name === name);
            if (found) {
              items.push({ ...found, path: norm, starred: true });
            } else {
              items.push({ name, path: norm, type: 'folder', starred: true });
            }
          } catch {}
        }
        return sendJson(res, 200, { items, starred: list });
      }
      if (route === '/api/starred/toggle' && req.method === 'POST') {
        const { path: p } = await readJsonBody(req);
        if (!p) throw new HttpError(400, 'Path is required.');
        const result = await starred.toggle(user, p);
        return sendJson(res, 200, result);
      }
      if (route === '/api/search' && req.method === 'GET') {
        let results = await smartSearch(files, ocrStore, user, q.get('q'));
        if (!vault.isUnlocked(user, vaultToken)) {
          results = results.filter((r) => !vault.isVaultPath(r.path));
        }
        return sendJson(res, 200, { results });
      }
      if (route === '/api/photos/timeline' && req.method === 'GET') {
        const filter = q.get('filter') || 'all';
        const limit = Number(q.get('limit') || 200);
        const offset = Number(q.get('offset') || 0);
        const data = await getPhotosTimeline(files, user, { filter, limit, offset });
        if (!vault.isUnlocked(user, vaultToken) && data.groups) {
          data.groups = data.groups.map((g) => ({
            ...g,
            items: g.items.filter((item) => !vault.isVaultPath(item.path)),
          })).filter((g) => g.items.length > 0);
        }
        return sendJson(res, 200, data);
      }
      if (route === '/api/watchers' && req.method === 'GET') {
        return sendJson(res, 200, { watchers: watchers.getWatchers(user) });
      }
      if (route === '/api/watchers' && req.method === 'POST') {
        const { watcher, toggleId } = await readJsonBody(req);
        const list = watchers.getWatchers(user);
        if (toggleId) {
          const item = list.find((w) => w.id === toggleId);
          if (item) item.enabled = !item.enabled;
        } else if (watcher) {
          list.push(watcher);
        }
        watchers.saveWatchers(user, list);
        return sendJson(res, 200, { ok: true, watchers: list });
      }
      if (route === '/api/download' && (req.method === 'GET' || req.method === 'HEAD')) {
        const file = await files.fileForDownload(user, q.get('path'));
        return serveDownload(req, res, file, q.get('inline') === '1');
      }
      if (route === '/api/zip' && (req.method === 'GET' || req.method === 'HEAD')) {
        const p = q.get('path') || '/';
        const full = files.resolve(user, p);
        const st = await files.stat(full);
        if (!st.isDirectory()) throw new HttpError(400, 'Not a folder.');
        const baseName = p === '/' || !segments(p).length ? `${user}-drive` : path.basename(full);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': contentDisposition('attachment', `${baseName}.zip`),
          'Cache-Control': 'private, no-cache',
        });
        if (req.method === 'HEAD') return res.end();
        return await streamFolderAsZip(full, baseName, res);
      }
      if (route === '/api/upload' && req.method === 'PUT') {
        const name = await files.upload(user, q.get('path'), q.get('name'), req, { overwrite: q.get('overwrite') === '1' });
        changed();
        const clientPath = (q.get('path') === '/' ? '' : q.get('path')) + '/' + name;
        watchers.onUpload(files, user, clientPath, name).catch(() => {});
        return sendJson(res, 200, { name });
      }
      if (route === '/api/ai/cell' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = await ai.evalAICell(body);
        return sendJson(res, 200, { result });
      }
      if (route === '/api/ai/formula-copilot' && req.method === 'POST') {
        const { prompt, formula, action = 'generate', cols } = await readJsonBody(req);
        if (action === 'explain') {
          return sendJson(res, 200, { explanation: ai.explainFormula(formula) });
        }
        const generated = ai.generateFormula(prompt, cols);
        return sendJson(res, 200, generated);
      }
      if (route === '/api/sheet/create' && req.method === 'POST') {
        const { path: dirPath = '/', name = 'Untitled spreadsheet.rsheet', format = 'rsheet' } = await readJsonBody(req);
        let cleanName = String(name || 'Untitled spreadsheet').trim();
        const ext = path.extname(cleanName).toLowerCase();
        if (format === 'csv') {
          if (ext !== '.csv') cleanName += '.csv';
        } else if (ext !== '.rsheet' && ext !== '.csv' && ext !== '.tsv') {
          cleanName += '.rsheet';
        }
        const isCsv = cleanName.toLowerCase().endsWith('.csv') || cleanName.toLowerCase().endsWith('.tsv');
        const initialBuf = Buffer.from(isCsv ? '' : defaultSheetPayload('Sheet 1'), 'utf8');
        const savedName = await files.writeBuffer(user, dirPath, cleanName, initialBuf, { overwrite: false });
        changed();
        const normDir = '/' + segments(dirPath).join('/');
        const fullClientPath = (normDir === '/' ? '' : normDir) + '/' + savedName;
        return sendJson(res, 200, { name: savedName, path: fullClientPath });
      }
      if (route === '/api/doc/create' && req.method === 'POST') {
        const { path: dirPath = '/', name = 'Untitled document.rdoc' } = await readJsonBody(req);
        let cleanName = String(name || 'Untitled document').trim();
        if (path.extname(cleanName).toLowerCase() !== '.rdoc') cleanName += '.rdoc';
        const initial = Buffer.from(JSON.stringify({ format: 'rdrive-doc', version: 1, html: '<p><br></p>' }, null, 2), 'utf8');
        const savedName = await files.writeBuffer(user, dirPath, cleanName, initial, { overwrite: false });
        changed();
        const normDir = '/' + segments(dirPath).join('/');
        return sendJson(res, 200, { name: savedName, path: (normDir === '/' ? '' : normDir) + '/' + savedName });
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
        await starred.rename(user, from, to);
        changed();
        return sendJson(res, 200, { ok: true });
      }
      if (route === '/api/copy' && req.method === 'POST') {
        const { from, to } = await readJsonBody(req);
        const name = await files.copy(user, from, to);
        changed();
        return sendJson(res, 200, { ok: true, name });
      }
      if (route === '/api/delete' && req.method === 'POST') {
        const { paths } = await readJsonBody(req);
        if (!Array.isArray(paths) || !paths.length) throw new HttpError(400, 'Nothing to delete.');
        for (const p of paths) {
          await files.trash(user, p);
          await starred.remove(user, p);
        }
        changed();
        return sendJson(res, 200, { ok: true });
      }
      if (route === '/api/trash' && req.method === 'GET') {
        return sendJson(res, 200, { items: await files.listTrash(user) });
      }
      if (route === '/api/trash/restore' && req.method === 'POST') {
        const { id } = await readJsonBody(req);
        const restored = await files.restoreTrash(user, id);
        changed();
        return sendJson(res, 200, { restored });
      }
      if (route === '/api/trash/delete' && req.method === 'POST') {
        const { id } = await readJsonBody(req);
        await files.deleteTrash(user, id);
        return sendJson(res, 200, { ok: true });
      }
      if (route === '/api/trash/empty' && req.method === 'POST') {
        await files.emptyTrash(user);
        return sendJson(res, 200, { ok: true });
      }
      if (route === '/api/shares' && req.method === 'GET') {
        return sendJson(res, 200, { shares: shares.list(user, q.get('path') || null) });
      }
      if (route === '/api/shares' && req.method === 'POST') {
        const { path: targetPath, expiresInHours, password, allowEdit, maxDownloads } = await readJsonBody(req);
        await files.stat(files.resolve(user, targetPath));
        const share = shares.create(user, { path: targetPath, expiresInHours, password, allowEdit, maxDownloads });
        return sendJson(res, 200, { share });
      }
      if (route === '/api/shares/revoke' && req.method === 'POST') {
        const { id } = await readJsonBody(req);
        if (!shares.revoke(user, String(id || ''))) throw new HttpError(404, 'Share link not found.');
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
      if (route === '/api/tokens' && req.method === 'GET') {
        return sendJson(res, 200, { tokens: auth.listAgentTokens(user) });
      }
      if (route === '/api/tokens' && req.method === 'POST') {
        const { label, scope, rootPath = '/', expiresInDays = 90 } = await readJsonBody(req);
        const normRoot = '/' + segments(rootPath || '/').join('/');
        if (normRoot !== '/') {
          const st = await files.stat(files.resolve(user, normRoot));
          if (!st.isDirectory()) throw new HttpError(400, 'Scoped path must be a folder.');
        }
        const created = auth.createAgentToken(user, { label, scope, rootPath: normRoot, expiresInDays });
        return sendJson(res, 200, created);
      }
      if (route === '/api/tokens/revoke' && req.method === 'POST') {
        const { id } = await readJsonBody(req);
        if (!auth.revokeAgentToken(user, String(id || ''))) throw new HttpError(404, 'Token not found.');
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
  } else if (cmd === 'add-token') {
    const [, label = 'CLI Agent', scope = 'write', rootPath = '/'] = args;
    need(name, 'add-token <username> [label] [read|write] [rootPath]');
    const { token, record } = auth.createAgentToken(name, { label, scope, rootPath, expiresInDays: 90 });
    console.log(`Created ${record.scope} MCP token for "${name}" (root: ${record.rootPath}):\n\n  ${token}\n\nSave this token now; it is only shown once.`);
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
