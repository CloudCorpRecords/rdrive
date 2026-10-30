// Server-to-server sync. Servers pair once with a one-time code, then each one pulls
// changes from its peers onto its own disk. Peers can only read each other. See docs/sync.md.
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { readJson, writeJson } = require('./auth');
const { HttpError, validateName, segments, PART_SUFFIX } = require('./files');
const { fingerprint } = require('./tls');

const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_MAX_TRIES = 5;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no 0/O or 1/I
const CODE_LEN = 20; // 100 bits
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const PART_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const NUDGE_DELAY_MS = 3000;
const HEX32 = /^[0-9a-f]{32}$/;

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest('hex');

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function hashFile(full) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(full).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}

function newCode() {
  return Array.from(crypto.randomBytes(CODE_LEN), (b) => CODE_ALPHABET[b % 32]).join('');
}

function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function formatCode(code) {
  return code.match(/.{1,5}/g).join('-');
}

// Server names end up in conflict file names, so keep them to characters every disk accepts.
function cleanServerName(name) {
  const s = String(name || '').replace(/[<>:"/\\|?*()\x00-\x1f]/g, '').trim().slice(0, 40).replace(/[. ]+$/, '');
  return s || 'server';
}

function checkPeerUrl(url) {
  let u;
  try {
    u = new URL(String(url || '').trim());
  } catch {
    throw new HttpError(400, 'Enter the server address, like https://other-machine:8443');
  }
  if (u.protocol !== 'https:') throw new HttpError(400, 'Linked servers must use an https:// address.');
  if (u.username || u.password) throw new HttpError(400, 'The address must not contain a user name or password.');
  return u.origin;
}

const parentOf = (p) => path.posix.dirname(p);

function conflictName(name, server, mtime) {
  const ext = path.extname(name);
  let base = ext ? name.slice(0, -ext.length) : name;
  const suffix = ` (conflict from ${server} ${new Date(mtime).toISOString().slice(0, 10)})`;
  base = base.slice(0, Math.max(1, 255 - suffix.length - ext.length));
  return base + suffix + ext;
}

// Turn a peer's manifest into a map of path -> entry, dropping anything that isn't a clean path.
function parseManifest(list) {
  if (!Array.isArray(list)) throw new Error('The linked server sent an invalid file list.');
  const entries = new Map();
  let rejected = 0;
  for (const e of list) {
    try {
      if (!e || typeof e.path !== 'string') throw new Error();
      const segs = segments(e.path);
      const p = '/' + segs.join('/');
      if (!segs.length || p !== e.path) throw new Error();
      if (e.type === 'folder') entries.set(p, { path: p, type: 'folder' });
      else if (e.type === 'file' && /^[0-9a-f]{64}$/.test(e.sha256) && Number.isSafeInteger(e.size) && e.size >= 0 && Number.isFinite(e.mtime)) {
        entries.set(p, { path: p, type: 'file', size: e.size, mtime: e.mtime, sha256: e.sha256 });
      } else throw new Error();
    } catch {
      rejected += 1;
    }
  }
  return { entries, rejected };
}

function readJsonResponse(res, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    res.on('data', (c) => {
      size += c.length;
      if (size > limit) res.destroy(new Error('The linked server sent too much data.'));
      else chunks.push(c);
    });
    res.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve({});
      }
    });
    res.on('error', reject);
  });
}

// Connect once to find out whether the server's certificate is trusted by the system.
// Returns null if it is, or its PEM so it can be pinned.
function probeCert(origin) {
  const u = new URL(origin);
  return new Promise((resolve, reject) => {
    const sock = tls.connect(
      {
        host: u.hostname.replace(/^\[|\]$/g, ''),
        port: Number(u.port || 443),
        servername: net.isIP(u.hostname.replace(/^\[|\]$/g, '')) ? undefined : u.hostname,
        rejectUnauthorized: false,
      },
      () => {
        const cert = sock.getPeerCertificate();
        const trusted = sock.authorized;
        sock.end();
        if (trusted) resolve(null);
        else if (cert && cert.raw) resolve(new crypto.X509Certificate(cert.raw).toString());
        else reject(new HttpError(502, `${u.host} did not present a certificate.`));
      }
    );
    sock.setTimeout(REQUEST_TIMEOUT_MS, () => sock.destroy(new Error('timed out')));
    sock.on('error', (err) => reject(new HttpError(502, `Could not reach ${u.host}: ${err.message}`)));
  });
}

class Sync {
  // options: { dataDir, auth, files, name?, url?, certPem?, interval? (seconds), auto? }
  constructor({ dataDir, auth, files, name, url, certPem, interval = 60, auto = true, log = console }) {
    this.auth = auth;
    this.files = files;
    this.log = log;
    this.dir = path.join(dataDir, 'sync');
    this.peersFile = path.join(dataDir, 'peers.json');
    fs.mkdirSync(this.dir, { recursive: true });
    const idFile = path.join(this.dir, 'server.json');
    let ident = readJson(idFile, null);
    if (!ident || !HEX32.test(ident.id || '')) {
      ident = { id: crypto.randomBytes(16).toString('hex'), created: new Date().toISOString() };
      writeJson(idFile, ident);
    }
    this.id = ident.id;
    this.name = cleanServerName(name || os.hostname());
    this.url = url ? checkPeerUrl(url) : null;
    this.certPem = certPem ? String(certPem) : null;
    this.fingerprint = this.certPem ? fingerprint(this.certPem) : null;
    this.peers = readJson(this.peersFile, {});
    this.intervalMs = Math.max(10, Number(interval) || 60) * 1000;
    this.auto = auto;
    this.code = null;
    this.nonces = new Map();
    this.running = null;
    this.again = false;
    this.timers = {};
  }

  start() {
    if (!this.auto) return;
    this.timers.interval = setInterval(() => this.syncAll().catch((err) => this.log.error(err)), this.intervalMs);
    this.timers.interval.unref();
    this.schedule('first', 5000, () => this.syncAll());
  }

  stop() {
    for (const t of Object.values(this.timers)) clearTimeout(t);
    this.timers = {};
  }

  schedule(key, ms, fn) {
    clearTimeout(this.timers[key]);
    this.timers[key] = setTimeout(() => {
      delete this.timers[key];
      Promise.resolve(fn()).catch((err) => this.log.error(err));
    }, ms);
    this.timers[key].unref();
  }

  savePeers() {
    writeJson(this.peersFile, this.peers);
  }

  getPeer(id) {
    return Object.hasOwn(this.peers, id) ? this.peers[id] : null;
  }

  status() {
    return {
      id: this.id,
      name: this.name,
      url: this.url,
      fingerprint: this.fingerprint,
      syncing: !!this.running,
      peers: Object.values(this.peers).map((p) => ({
        id: p.id,
        name: p.name,
        url: p.url,
        fingerprint: p.cert ? fingerprint(p.cert) : null,
        added: p.added,
        lastSync: p.lastSync || null,
        lastError: p.lastError || null,
      })),
    };
  }

  // ---- pairing ----

  pairProof(code, f) {
    return hmac(code, ['rdrive-pair-v1', f.id, f.name, f.url, f.certFp, f.serverFp, f.nonce].join('\n'));
  }

  replyMac(code, f) {
    return hmac(code, ['rdrive-pair-ok-v1', f.id, f.name, f.secret, f.nonce].join('\n'));
  }

  secretMask(code, nonce) {
    return Buffer.from(crypto.hkdfSync('sha256', code, Buffer.from(nonce, 'hex'), 'rdrive-pair-secret', 32));
  }

  createCode() {
    const code = newCode();
    this.code = { code, expires: Date.now() + CODE_TTL_MS, tries: 0 };
    return { code: formatCode(code), expires: new Date(this.code.expires).toISOString(), fingerprint: this.fingerprint, name: this.name };
  }

  // Server A: another server proves it knows our code. The code itself never crosses the network.
  acceptPair(body, ip) {
    const c = this.code;
    if (!c || c.expires < Date.now()) {
      this.code = null;
      this.auth.recordFailure(ip);
      throw new HttpError(403, 'No pairing code is active on that server. Show a new code and try again.');
    }
    const { id, name, url, cert, pinned, nonce, proof } = body || {};
    if (!HEX32.test(id || '') || id === this.id || !HEX32.test(nonce || '') || typeof proof !== 'string') throw new HttpError(400, 'Invalid pairing request.');
    if (typeof name !== 'string' || !name || name.length > 64) throw new HttpError(400, 'Invalid server name.');
    const origin = checkPeerUrl(url);
    let certFp = '';
    if (cert != null) {
      try {
        certFp = fingerprint(String(cert));
      } catch {
        throw new HttpError(400, 'Invalid certificate.');
      }
    }
    const expected = this.pairProof(c.code, { id, name, url: origin, certFp, serverFp: pinned ? this.fingerprint || '' : '', nonce });
    if (!safeEqualHex(expected, proof)) {
      c.tries += 1;
      if (c.tries >= CODE_MAX_TRIES) this.code = null;
      this.auth.recordFailure(ip);
      throw new HttpError(403, 'Wrong pairing code, or the connection between the servers was intercepted.');
    }
    this.code = null;
    const secret = crypto.randomBytes(32);
    this.peers[id] = { id, name: cleanServerName(name), url: origin, cert: cert == null ? null : String(cert), secret: secret.toString('hex'), added: new Date().toISOString() };
    this.savePeers();
    const mask = this.secretMask(c.code, nonce);
    const enc = Buffer.from(secret.map((b, i) => b ^ mask[i])).toString('hex');
    if (this.auto) this.schedule('first', 2000, () => this.syncAll());
    return { id: this.id, name: this.name, secret: enc, mac: this.replyMac(c.code, { id: this.id, name: this.name, secret: enc, nonce }) };
  }

  // Server B: the owner typed A's address and code here.
  async link(url, code, selfUrl) {
    code = normalizeCode(code);
    if (code.length !== CODE_LEN) throw new HttpError(400, 'That pairing code is not complete.');
    const origin = checkPeerUrl(url);
    const self = checkPeerUrl(selfUrl || this.url);
    const remoteCert = await probeCert(origin);
    const nonce = crypto.randomBytes(16).toString('hex');
    const proof = this.pairProof(code, {
      id: this.id,
      name: this.name,
      url: self,
      certFp: this.certPem ? this.fingerprint : '',
      serverFp: remoteCert ? fingerprint(remoteCert) : '',
      nonce,
    });
    const res = await this.request({ url: origin, cert: remoteCert }, 'POST', '/sync/pair', {
      body: { id: this.id, name: this.name, url: self, cert: this.certPem, pinned: !!remoteCert, nonce, proof },
      signed: false,
    });
    const data = await readJsonResponse(res);
    // Never pass the other server's 401 through: the browser would take it as being signed out here.
    if (res.statusCode !== 200) throw new HttpError(res.statusCode === 400 ? 400 : 403, data.error || `The other server refused (${res.statusCode}).`);
    if (!HEX32.test(data.id || '') || data.id === this.id || typeof data.name !== 'string' || !/^[0-9a-f]{64}$/.test(data.secret || '')) {
      throw new HttpError(502, 'The other server sent an invalid reply.');
    }
    if (!safeEqualHex(this.replyMac(code, { id: data.id, name: data.name, secret: data.secret, nonce }), data.mac || '')) {
      throw new HttpError(502, 'The reply was not signed with the pairing code. Not linking.');
    }
    const mask = this.secretMask(code, nonce);
    const secret = Buffer.from(Buffer.from(data.secret, 'hex').map((b, i) => b ^ mask[i]));
    this.peers[data.id] = { id: data.id, name: cleanServerName(data.name), url: origin, cert: remoteCert, secret: secret.toString('hex'), added: new Date().toISOString() };
    this.savePeers();
    if (this.auto) this.schedule('first', 1000, () => this.syncAll());
    return this.status().peers.find((p) => p.id === data.id);
  }

  async unlink(id) {
    const peer = this.getPeer(String(id || ''));
    if (!peer) throw new HttpError(404, 'That server is not linked.');
    try {
      const res = await this.request(peer, 'POST', '/sync/unpair', { body: {} });
      res.resume();
    } catch {
      // Best effort: the other side may be offline. Its requests will be refused from now on.
    }
    this.removePeer(peer.id);
  }

  removePeer(id) {
    if (!this.getPeer(id)) return;
    delete this.peers[id];
    this.savePeers();
    fs.rmSync(path.join(this.dir, 'base', id), { recursive: true, force: true });
    fs.rmSync(path.join(this.dir, 'partial', id), { recursive: true, force: true });
  }

  // ---- signed requests ----

  signature(peer, method, pathQuery, payload) {
    const ts = String(Date.now());
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = hmac(Buffer.from(peer.secret, 'hex'), [method, pathQuery, this.id, ts, nonce, sha256(payload)].join('\n'));
    return `RdriveSync id=${this.id}, ts=${ts}, nonce=${nonce}, sig=${sig}`;
  }

  // Returns the peer that signed this request, or null.
  authenticate(req, rawBody) {
    const m = /^RdriveSync id=([0-9a-f]{32}), ts=(\d{1,15}), nonce=([0-9a-f]{32}), sig=([0-9a-f]{64})$/.exec(req.headers.authorization || '');
    if (!m) return null;
    const [, id, ts, nonce, sig] = m;
    const peer = this.getPeer(id);
    if (!peer || Math.abs(Date.now() - Number(ts)) > CLOCK_SKEW_MS) return null;
    const expected = hmac(Buffer.from(peer.secret, 'hex'), [req.method, req.url, id, ts, nonce, sha256(rawBody)].join('\n'));
    if (!safeEqualHex(expected, sig)) return null;
    const now = Date.now();
    for (const [n, exp] of this.nonces) if (exp < now) this.nonces.delete(n);
    if (this.nonces.has(nonce)) return null; // replayed
    this.nonces.set(nonce, now + 2 * CLOCK_SKEW_MS);
    return peer;
  }

  // peer: { url, cert, secret? }. A pinned peer must present exactly the certificate saved at pairing.
  request(peer, method, pathQuery, { body, headers = {}, signed = true } = {}) {
    const u = new URL(pathQuery, peer.url);
    const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const h = { ...headers, 'Content-Length': payload.length };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (signed) h.Authorization = this.signature(peer, method, u.pathname + u.search, payload);
    const opts = { method, headers: h, agent: false, timeout: REQUEST_TIMEOUT_MS };
    if (peer.cert) {
      const pinned = fingerprint(peer.cert);
      opts.ca = peer.cert;
      opts.checkServerIdentity = (host, cert) =>
        cert.fingerprint256 === pinned ? undefined : new Error('The linked server presented a different certificate than when it was paired.');
    }
    return new Promise((resolve, reject) => {
      const r = https.request(u, opts, resolve);
      r.on('timeout', () => r.destroy(new Error(`Timed out talking to ${u.host}.`)));
      r.on('error', reject);
      r.end(payload);
    });
  }

  // ---- what peers may read from us ----

  checkUser(user) {
    if (typeof user !== 'string' || this.auth.validateUsername(user) || user === '.' || user === '..') throw new HttpError(400, 'Invalid user.');
    if (!this.auth.getUser(user)) throw new HttpError(404, 'No such user here.');
    return user;
  }

  async manifest(user) {
    return [...(await this.scan(this.checkUser(user))).values()];
  }

  async fileFor(user, p, sha) {
    const full = this.files.resolve(this.checkUser(user), p);
    const st = await this.files.stat(full);
    if (!st.isFile()) throw new HttpError(400, 'Not a file.');
    if (sha && (await hashFile(full)) !== sha) throw new HttpError(409, 'The file changed since the list was made.');
    return { full, size: st.size, mtime: st.mtime, name: path.basename(full) };
  }

  nudged(peer) {
    if (this.auto) this.schedule(`nudge-${peer.id}`, 1000, () => this.syncAll());
  }

  // Called after a change through the web UI: ask peers to pull from us soon.
  localChanged() {
    if (!this.auto) return;
    this.schedule('nudge-out', NUDGE_DELAY_MS, async () => {
      for (const peer of Object.values(this.peers)) {
        try {
          (await this.request(peer, 'POST', '/sync/nudge', { body: {} })).resume();
        } catch {
          // The peer is offline; it will catch up on its own schedule.
        }
      }
    });
  }

  // ---- local state ----

  jsonPath(kind, ...parts) {
    return path.join(this.dir, kind, ...parts.slice(0, -1), `${parts[parts.length - 1]}.json`);
  }

  saveJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJson(file, data);
  }

  // Every file and folder of a user, with content hashes. Hashes are cached by size + mtime.
  async scan(user) {
    const root = this.files.userRoot(user);
    const cacheFile = this.jsonPath('hashes', user);
    const cache = readJson(cacheFile, {});
    const next = {};
    const out = new Map();
    const walk = async (dir, rel) => {
      let dirents;
      try {
        dirents = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of dirents) {
        if (d.name.endsWith(PART_SUFFIX)) continue;
        try {
          validateName(d.name);
        } catch {
          continue; // made on disk with a name rdrive can't represent; leave it alone
        }
        const p = `${rel}/${d.name}`;
        const full = path.join(dir, d.name);
        if (d.isDirectory()) {
          out.set(p, { path: p, type: 'folder' });
          await walk(full, p);
        } else if (d.isFile()) {
          try {
            const st = await fsp.stat(full);
            const c = Object.hasOwn(cache, p) ? cache[p] : null;
            const sha = c && c[0] === st.size && c[1] === st.mtimeMs ? c[2] : await hashFile(full);
            next[p] = [st.size, st.mtimeMs, sha];
            out.set(p, { path: p, type: 'file', size: st.size, mtime: Math.round(st.mtimeMs), sha256: sha });
          } catch {
            // Vanished or unreadable mid-scan; it'll be picked up next time.
          }
        }
      }
    };
    await walk(root, '');
    this.saveJson(cacheFile, next);
    return out;
  }

  // ---- pulling from peers ----

  syncAll() {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      const results = {};
      do {
        this.again = false;
        let changed = false;
        for (const peer of Object.values(this.peers)) {
          const stats = await this.syncPeer(peer);
          results[peer.id] = stats;
          if (stats.downloaded || stats.trashed || stats.moved) changed = true;
        }
        if (changed) this.localChanged(); // let other peers pick up what we just received
      } while (this.again);
      this.cleanParts();
      return results;
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async syncPeer(peer) {
    const stats = { downloaded: 0, trashed: 0, moved: 0, conflicts: 0, rejected: 0, errors: [] };
    try {
      for (const { name } of this.auth.listUsers()) {
        if (name === '.' || name === '..') continue;
        await this.syncUser(peer, name, stats);
      }
      peer.lastSync = new Date().toISOString();
      peer.lastError = stats.errors[0] || (stats.rejected ? `Refused ${stats.rejected} item(s) with invalid paths from ${peer.name}.` : null);
    } catch (err) {
      peer.lastError = err.message;
      stats.errors.push(err.message);
    }
    if (this.getPeer(peer.id) === peer) this.savePeers();
    return stats;
  }

  async syncUser(peer, user, stats) {
    const res = await this.request(peer, 'GET', `/sync/manifest?user=${encodeURIComponent(user)}`);
    if (res.statusCode === 404) {
      res.resume();
      return; // that username doesn't exist there
    }
    const data = await readJsonResponse(res, MAX_MANIFEST_BYTES);
    if (res.statusCode !== 200) throw new Error(`${peer.name}: ${data.error || `HTTP ${res.statusCode}`}`);
    const { entries: R, rejected } = parseManifest(data.entries);
    stats.rejected += rejected;
    const L = await this.scan(user);
    const baseFile = this.jsonPath('base', peer.id, user);
    const B = readJson(baseFile, {});
    const base = (p) => (Object.hasOwn(B, p) ? B[p] : null);
    const val = (e) => (e ? (e.type === 'folder' ? 'folder' : e.sha256) : null);
    const fail = (p, err) => stats.errors.push(`${user}${p}: ${err.message}`);

    // 1. Renames: a file vanished there and the same content appeared elsewhere. Move ours instead of downloading.
    const movable = new Map();
    for (const p of Object.keys(B)) {
      const l = L.get(p);
      if (!R.has(p) && l && l.type === 'file' && l.sha256 === B[p]) {
        if (!movable.has(l.sha256)) movable.set(l.sha256, []);
        movable.get(l.sha256).push(p);
      }
    }
    for (const [p, r] of R) {
      if (r.type !== 'file' || L.has(p) || base(p) !== null) continue;
      const from = (movable.get(r.sha256) || []).shift();
      if (!from) continue;
      try {
        await this.mkdirp(user, parentOf(p));
        await fsp.rename(this.files.resolve(user, from), this.files.resolve(user, p));
        L.set(p, { ...L.get(from), path: p });
        L.delete(from);
        stats.moved += 1;
      } catch (err) {
        fail(p, err);
      }
    }

    const all = [...new Set([...L.keys(), ...R.keys(), ...Object.keys(B)])].sort();
    const handled = new Set();

    // 2. Folders deleted there: trash them as a whole if nothing inside changed here.
    for (const p of all) {
      const l = L.get(p);
      if (handled.has(p) || !l || l.type !== 'folder' || base(p) !== 'folder' || R.has(p)) continue;
      const inside = all.filter((q) => q.startsWith(p + '/'));
      if (!inside.every((q) => !R.has(q) && val(L.get(q)) === (L.has(q) ? base(q) : null))) continue;
      try {
        const full = this.files.resolve(user, p);
        if ((await fsp.readdir(full)).length) await this.files.trash(user, p);
        else await fsp.rmdir(full);
        for (const q of [p, ...inside]) handled.add(q);
        stats.trashed += 1;
      } catch (err) {
        fail(p, err);
      }
    }

    // 3. Everything else, parents before children.
    const skip = [];
    const next = {};
    for (const p of all) {
      if (handled.has(p) || skip.some((s) => p.startsWith(s))) continue;
      const lo = L.get(p);
      const ro = R.get(p);
      const l = val(lo);
      const r = val(ro);
      const b = base(p);
      let now = l;
      try {
        if (l === r || r === b) {
          // Same on both sides, or only changed here (the peer will pull it from us).
        } else if (l === b || l === null) {
          // Changed only there, or edited there and deleted here (an edit beats a delete).
          now = await this.applyRemote(peer, user, p, lo, ro, stats);
        } else if (r === null) {
          // Edited here, deleted there: keep ours.
        } else {
          now = await this.resolveConflict(peer, user, p, lo, ro, stats, skip);
        }
      } catch (err) {
        fail(p, err);
      }
      // The base is what both sides last agreed on; only move it when they agree now.
      const agreed = now === r ? r : b;
      if (agreed !== null) next[p] = agreed;
    }
    this.saveJson(baseFile, next);
  }

  async mkdirp(user, p) {
    await fsp.mkdir(this.files.resolve(user, p), { recursive: true });
  }

  // Before replacing or trashing a local file, make sure nobody changed it since the scan.
  async assertUnchanged(user, p, sha) {
    if ((await hashFile(this.files.resolve(user, p))) !== sha) throw new Error('changed here during sync; will retry');
  }

  async applyRemote(peer, user, p, lo, ro, stats) {
    if (!ro) {
      if (lo.type === 'folder') return 'folder'; // something inside changed here, so keep it
      await this.assertUnchanged(user, p, lo.sha256);
      await this.files.trash(user, p);
      stats.trashed += 1;
      return null;
    }
    if (ro.type === 'folder') {
      if (lo && lo.type === 'file') {
        await this.assertUnchanged(user, p, lo.sha256);
        await this.files.trash(user, p);
        stats.trashed += 1;
      }
      await this.mkdirp(user, p);
      return 'folder';
    }
    if (lo && lo.type === 'folder') {
      await this.downloadAs(peer, user, ro, path.posix.join(parentOf(p), conflictName(path.posix.basename(p), peer.name, ro.mtime)), stats);
      stats.conflicts += 1;
      return 'folder';
    }
    if (lo) await this.assertUnchanged(user, p, lo.sha256);
    await this.download(peer, user, ro, p, stats);
    return ro.sha256;
  }

  // Both sides changed. Both servers pick the same winner (newest, then highest hash) so they
  // end up with identical files: the winner at the original name, the other as a conflict copy.
  async resolveConflict(peer, user, p, lo, ro, stats, skip) {
    if (lo.type === 'file' && ro.type === 'folder') {
      skip.push(p + '/');
      throw new Error(`is a file here but a folder on ${peer.name}; rename one of them`);
    }
    const dir = parentOf(p);
    const name = path.posix.basename(p);
    if (lo.type === 'folder') {
      await this.downloadAs(peer, user, ro, path.posix.join(dir, conflictName(name, peer.name, ro.mtime)), stats);
      stats.conflicts += 1;
      return 'folder';
    }
    const remoteWins = ro.mtime !== lo.mtime ? ro.mtime > lo.mtime : ro.sha256 > lo.sha256;
    stats.conflicts += 1;
    if (remoteWins) {
      await this.assertUnchanged(user, p, lo.sha256);
      const dirFull = this.files.resolve(user, dir);
      const loser = await this.files.freeName(dirFull, conflictName(name, this.name, lo.mtime));
      await fsp.rename(this.files.resolve(user, p), path.join(dirFull, loser));
      await this.download(peer, user, ro, p, stats);
      return ro.sha256;
    }
    await this.downloadAs(peer, user, ro, path.posix.join(dir, conflictName(name, peer.name, ro.mtime)), stats);
    return lo.sha256;
  }

  // Download to a name that may already hold this exact content (from an earlier pass).
  async downloadAs(peer, user, ro, p, stats) {
    const full = this.files.resolve(user, p);
    if (fs.existsSync(full)) {
      if ((await fsp.stat(full)).isFile() && (await hashFile(full)) === ro.sha256) return;
      p = path.posix.join(parentOf(p), await this.files.freeName(path.dirname(full), path.posix.basename(p)));
    }
    await this.download(peer, user, ro, p, stats);
  }

  // Resumable download into data/sync/partial, verified against the hash, then moved into place.
  async download(peer, user, ro, p, stats) {
    const dest = this.files.resolve(user, p);
    const partDir = path.join(this.dir, 'partial', peer.id);
    await fsp.mkdir(partDir, { recursive: true });
    const part = path.join(partDir, ro.sha256 + PART_SUFFIX);
    let have = 0;
    try {
      have = (await fsp.stat(part)).size;
    } catch {}
    if (have > ro.size) {
      await fsp.rm(part, { force: true });
      have = 0;
    }
    if (ro.size === 0) await fsp.writeFile(part, '');
    else if (have < ro.size) {
      const q = `user=${encodeURIComponent(user)}&path=${encodeURIComponent(ro.path)}&sha256=${ro.sha256}`;
      const res = await this.request(peer, 'GET', `/sync/file?${q}`, { headers: have ? { Range: `bytes=${have}-` } : {} });
      const resumed = res.statusCode === 206 && String(res.headers['content-range'] || '').startsWith(`bytes ${have}-`);
      if (res.statusCode !== 200 && !resumed) {
        const data = await readJsonResponse(res);
        throw new Error(data.error || `download failed (HTTP ${res.statusCode})`);
      }
      const limit = resumed ? ro.size - have : ro.size;
      let received = 0;
      const guard = new Transform({
        transform(chunk, enc, cb) {
          received += chunk.length;
          cb(received > limit ? new Error('the linked server sent more data than expected') : null, chunk);
        },
      });
      await pipeline(res, guard, fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' }));
    }
    if ((await hashFile(part)) !== ro.sha256) {
      await fsp.rm(part, { force: true });
      throw new Error('downloaded data did not match its checksum');
    }
    await this.mkdirp(user, parentOf(p));
    await fsp.rename(part, dest);
    const t = new Date(ro.mtime);
    await fsp.utimes(dest, t, t);
    stats.downloaded += 1;
  }

  // Forget half-finished downloads nobody has touched for a week.
  cleanParts() {
    const root = path.join(this.dir, 'partial');
    const old = Date.now() - PART_MAX_AGE_MS;
    let peers = [];
    try {
      peers = fs.readdirSync(root);
    } catch {
      return;
    }
    for (const id of peers) {
      for (const f of fs.readdirSync(path.join(root, id))) {
        const full = path.join(root, id, f);
        try {
          if (fs.statSync(full).mtimeMs < old) fs.rmSync(full, { force: true });
        } catch {}
      }
    }
  }
}

module.exports = { Sync, conflictName, parseManifest, normalizeCode };
