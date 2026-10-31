// User accounts, password hashing, linked GitHub identities and login sessions.
// Users and sessions are stored as JSON files in the data directory.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TOUCH_INTERVAL_MS = 5 * 60 * 1000; // how often "last active" is written to disk
const SCRYPT_KEYLEN = 64;
const USERNAME_RE = /^[a-zA-Z0-9_.-]{1,32}$/;
const MIN_PASSWORD_LEN = 8;

// Failed-login throttling: after MAX_FAILS failures from one IP, lock it out for LOCK_MS.
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

// Write to a temp file then rename, so a crash never leaves a half-written file.
function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') {
      try {
        fs.copyFileSync(tmp, file);
        try { fs.unlinkSync(tmp); } catch (_) {}
        return;
      } catch (_) {}
    }
    throw err;
  }
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// A short readable label like "Chrome on Windows" from a User-Agent header.
function deviceLabel(ua) {
  ua = String(ua || '');
  const browser =
    /Edg\//.test(ua) ? 'Edge' :
    /OPR\/|Opera/.test(ua) ? 'Opera' :
    /Firefox\//.test(ua) ? 'Firefox' :
    /Chrome\//.test(ua) ? 'Chrome' :
    /Safari\//.test(ua) ? 'Safari' :
    /curl\//.test(ua) ? 'curl' : 'Browser';
  const os =
    /Android/.test(ua) ? 'Android' :
    /iPhone|iPad|iPod/.test(ua) ? 'iOS' :
    /Windows/.test(ua) ? 'Windows' :
    /Mac OS X|Macintosh/.test(ua) ? 'macOS' :
    /CrOS/.test(ua) ? 'ChromeOS' :
    /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

class Auth {
  constructor(dataDir) {
    this.usersFile = path.join(dataDir, 'users.json');
    this.sessionsFile = path.join(dataDir, 'sessions.json');
    this.tokensFile = path.join(dataDir, 'tokens.json');
    this.users = readJson(this.usersFile, {});
    // Sessions and agent tokens are keyed by sha256(token) so a leaked JSON file can't be replayed.
    this.sessions = readJson(this.sessionsFile, {});
    this.tokens = readJson(this.tokensFile, {});
    for (const s of Object.values(this.sessions)) {
      // Sessions from older versions have no id/metadata.
      if (!s.id) Object.assign(s, { id: crypto.randomBytes(9).toString('base64url'), created: Date.now(), lastSeen: Date.now() });
    }
    this.failures = new Map();
    // Dummy hash used to keep login timing the same for unknown usernames.
    this.dummy = hashPassword('dummy-password');
    this.pruneSessions();
  }

  saveUsers() {
    writeJson(this.usersFile, this.users);
  }

  saveSessions() {
    writeJson(this.sessionsFile, this.sessions);
  }

  saveTokens() {
    writeJson(this.tokensFile, this.tokens);
  }

  hasUsers() {
    return Object.keys(this.users).length > 0;
  }

  listUsers() {
    return Object.entries(this.users).map(([name, u]) => ({
      name,
      password: !!u.hash,
      github: u.github ? u.github.login : null,
    }));
  }

  getUser(username) {
    return Object.hasOwn(this.users, username) ? this.users[username] : null;
  }

  validateUsername(username) {
    return USERNAME_RE.test(username || '') ? null : 'Username must be 1-32 characters: letters, numbers, dot, dash or underscore.';
  }

  validatePassword(password) {
    return typeof password === 'string' && password.length >= MIN_PASSWORD_LEN ? null : `Password must be at least ${MIN_PASSWORD_LEN} characters.`;
  }

  validateNewCredentials(username, password) {
    return this.validateUsername(username) || this.validatePassword(password);
  }

  // password may be null for accounts that only sign in with GitHub.
  addUser(username, password, { github } = {}) {
    const problem = this.validateUsername(username) || (password == null ? null : this.validatePassword(password));
    if (problem) throw new Error(problem);
    if (password == null && !github) throw new Error('An account needs a password or a linked GitHub account.');
    if (this.getUser(username)) throw new Error(`User "${username}" already exists.`);
    if (github) this.assertGithubFree(github.id);
    this.users[username] = {
      // The first account is the owner: the only one who can link servers for sync.
      ...(this.hasUsers() ? {} : { owner: true }),
      ...(password == null ? {} : hashPassword(password)),
      ...(github ? { github: { id: github.id, login: github.login } } : {}),
      created: new Date().toISOString(),
    };
    this.saveUsers();
  }

  setPassword(username, password, { keepToken } = {}) {
    const user = this.getUser(username);
    if (!user) throw new Error(`No user "${username}".`);
    const problem = this.validatePassword(password);
    if (problem) throw new Error(problem);
    Object.assign(user, hashPassword(password));
    this.saveUsers();
    this.revokeUserSessions(username, keepToken);
  }

  deleteUser(username) {
    if (!this.getUser(username)) throw new Error(`No user "${username}".`);
    delete this.users[username];
    this.saveUsers();
    this.revokeUserSessions(username);
    this.revokeUserAgentTokens(username);
  }

  // ---- owner ----

  ownerName() {
    const names = Object.keys(this.users);
    const flagged = names.find((n) => this.users[n].owner);
    if (flagged) return flagged;
    // Installs from before owners were recorded: the oldest account, which first-run setup created.
    names.sort((a, b) => String(this.users[a].created).localeCompare(String(this.users[b].created)));
    return names[0] || null;
  }

  isOwner(username) {
    return !!username && this.ownerName() === username;
  }

  setOwner(username) {
    if (!this.getUser(username)) throw new Error(`No user "${username}".`);
    for (const u of Object.values(this.users)) delete u.owner;
    this.users[username].owner = true;
    this.saveUsers();
  }

  // ---- GitHub identities ----

  userByGithubId(id) {
    return Object.keys(this.users).find((name) => this.users[name].github && this.users[name].github.id === id) || null;
  }

  assertGithubFree(id, exceptUser) {
    const owner = this.userByGithubId(id);
    if (owner && owner !== exceptUser) throw new Error('That GitHub account is already linked to another rdrive user.');
  }

  linkGithub(username, github) {
    const user = this.getUser(username);
    if (!user) throw new Error(`No user "${username}".`);
    this.assertGithubFree(github.id, username);
    user.github = { id: github.id, login: github.login };
    this.saveUsers();
  }

  unlinkGithub(username) {
    const user = this.getUser(username);
    if (!user) throw new Error(`No user "${username}".`);
    if (!user.hash) throw new Error('Set a password before unlinking GitHub, or you would be locked out.');
    delete user.github;
    this.saveUsers();
  }

  // GitHub logins can be renamed; keep the stored one current for display.
  refreshGithubLogin(username, login) {
    const user = this.getUser(username);
    if (user && user.github && user.github.login !== login) {
      user.github.login = login;
      this.saveUsers();
    }
  }

  // ---- passwords and throttling ----

  verifyPassword(username, password) {
    const user = this.getUser(username);
    const rec = user && user.hash ? user : this.dummy;
    const expected = Buffer.from(rec.hash, 'hex');
    const actual = crypto.scryptSync(String(password), Buffer.from(rec.salt, 'hex'), SCRYPT_KEYLEN);
    return crypto.timingSafeEqual(expected, actual) && rec !== this.dummy;
  }

  // Returns seconds remaining if this IP is locked out, otherwise 0.
  lockedFor(ip) {
    const f = this.failures.get(ip);
    if (!f || !f.until) return 0;
    const left = f.until - Date.now();
    if (left <= 0) {
      this.failures.delete(ip);
      return 0;
    }
    return Math.ceil(left / 1000);
  }

  recordFailure(ip) {
    const f = this.failures.get(ip) || { count: 0, until: 0 };
    f.count += 1;
    if (f.count >= MAX_FAILS) {
      f.until = Date.now() + LOCK_MS;
      f.count = 0;
    }
    this.failures.set(ip, f);
  }

  // ---- sessions ----

  // meta: { ip, userAgent, method: 'password' | 'github' | 'setup' }
  createSession(username, meta = {}) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.sessions[sha256(token)] = {
      id: crypto.randomBytes(9).toString('base64url'),
      user: username,
      expires: now + SESSION_TTL_MS,
      created: now,
      lastSeen: now,
      ip: meta.ip || '',
      device: deviceLabel(meta.userAgent),
      method: meta.method || 'password',
    };
    this.saveSessions();
    return token;
  }

  login(username, password, meta = {}) {
    const ip = meta.ip || 'unknown';
    if (this.lockedFor(ip)) return null;
    if (!this.verifyPassword(String(username || ''), password)) {
      this.recordFailure(ip);
      return null;
    }
    this.failures.delete(ip);
    return this.createSession(username, { ...meta, method: meta.method || 'password' });
  }

  logout(token) {
    if (!token) return;
    delete this.sessions[sha256(token)];
    this.saveSessions();
  }

  sessionForToken(token) {
    if (!token) return null;
    const s = this.sessions[sha256(token)];
    if (!s) return null;
    if (s.expires < Date.now() || !this.users[s.user]) {
      this.logout(token);
      return null;
    }
    return s;
  }

  userForToken(token) {
    const s = this.sessionForToken(token);
    return s ? s.user : null;
  }

  // Record activity; only hits the disk every few minutes per session.
  touch(token, ip) {
    const s = this.sessionForToken(token);
    if (!s) return;
    const now = Date.now();
    if (ip) s.ip = ip;
    if (now - s.lastSeen > TOUCH_INTERVAL_MS) {
      s.lastSeen = now;
      this.saveSessions();
    }
  }

  listSessions(username, currentToken) {
    const currentKey = currentToken ? sha256(currentToken) : null;
    return Object.entries(this.sessions)
      .filter(([, s]) => s.user === username && s.expires > Date.now())
      .map(([key, s]) => ({
        id: s.id,
        device: s.device || 'Unknown device',
        ip: s.ip || '',
        method: s.method || 'password',
        created: new Date(s.created).toISOString(),
        lastSeen: new Date(s.lastSeen).toISOString(),
        current: key === currentKey,
      }))
      .sort((a, b) => (a.current ? -1 : b.current ? 1 : b.lastSeen.localeCompare(a.lastSeen)));
  }

  revokeSession(username, id) {
    const entry = Object.entries(this.sessions).find(([, s]) => s.user === username && s.id === id);
    if (!entry) return false;
    delete this.sessions[entry[0]];
    this.saveSessions();
    return true;
  }

  revokeUserSessions(username, keepToken) {
    const keep = keepToken ? sha256(keepToken) : null;
    for (const [k, s] of Object.entries(this.sessions)) {
      if (s.user === username && k !== keep) delete this.sessions[k];
    }
    this.saveSessions();
  }

  pruneSessions() {
    const now = Date.now();
    for (const [k, s] of Object.entries(this.sessions)) {
      if (s.expires < now) delete this.sessions[k];
    }
    this.saveSessions();
    if (this.tokens) {
      let changed = false;
      for (const [k, t] of Object.entries(this.tokens)) {
        if (t.expires && t.expires < now) {
          delete this.tokens[k];
          changed = true;
        }
      }
      if (changed) this.saveTokens();
    }
  }

  // ---- Per-user AI Agent / MCP tokens ----

  createAgentToken(username, { label = 'AI Agent', scope = 'write', rootPath = '/', expiresInDays = 90 } = {}) {
    if (!this.getUser(username)) throw new Error(`No user "${username}".`);
    const cleanLabel = String(label || 'AI Agent').trim().slice(0, 64) || 'AI Agent';
    const cleanScope = scope === 'read' ? 'read' : 'write';
    const normRoot = '/' + String(rootPath || '/').split('/').filter(Boolean).join('/');
    const now = Date.now();
    const days = Number(expiresInDays);
    const expires = days > 0 ? now + Math.min(days, 3650) * 86400 * 1000 : null;
    const rawToken = `rdrive_pat_${crypto.randomBytes(32).toString('base64url')}`;
    const rec = {
      id: crypto.randomBytes(9).toString('base64url'),
      user: username,
      label: cleanLabel,
      scope: cleanScope,
      rootPath: normRoot,
      created: now,
      lastUsed: null,
      expires,
      ip: '',
    };
    this.tokens[sha256(rawToken)] = rec;
    this.saveTokens();
    return { token: rawToken, record: this._formatTokenRecord(rec) };
  }

  verifyAgentToken(rawToken, ip = '') {
    if (typeof rawToken !== 'string' || !rawToken.startsWith('rdrive_pat_')) return null;
    const key = sha256(rawToken);
    const rec = this.tokens[key];
    if (!rec) return null;
    const now = Date.now();
    if ((rec.expires && rec.expires < now) || !this.users[rec.user]) {
      delete this.tokens[key];
      this.saveTokens();
      return null;
    }
    if (ip) rec.ip = ip;
    if (!rec.lastUsed || now - rec.lastUsed > TOUCH_INTERVAL_MS) {
      rec.lastUsed = now;
      this.saveTokens();
    }
    return {
      id: rec.id,
      user: rec.user,
      label: rec.label,
      scope: rec.scope || 'write',
      rootPath: rec.rootPath || '/',
    };
  }

  listAgentTokens(username) {
    const now = Date.now();
    return Object.values(this.tokens)
      .filter((t) => t.user === username && (!t.expires || t.expires > now))
      .sort((a, b) => b.created - a.created)
      .map((t) => this._formatTokenRecord(t));
  }

  revokeAgentToken(username, id) {
    const entry = Object.entries(this.tokens).find(([, t]) => t.user === username && t.id === id);
    if (!entry) return false;
    delete this.tokens[entry[0]];
    this.saveTokens();
    return true;
  }

  revokeUserAgentTokens(username) {
    let changed = false;
    for (const [k, t] of Object.entries(this.tokens)) {
      if (t.user === username) {
        delete this.tokens[k];
        changed = true;
      }
    }
    if (changed) this.saveTokens();
  }

  _formatTokenRecord(t) {
    return {
      id: t.id,
      label: t.label,
      scope: t.scope || 'write',
      rootPath: t.rootPath || '/',
      created: new Date(t.created).toISOString(),
      lastUsed: t.lastUsed ? new Date(t.lastUsed).toISOString() : null,
      expires: t.expires ? new Date(t.expires).toISOString() : null,
      ip: t.ip || '',
    };
  }
}

module.exports = { Auth, SESSION_TTL_MS, deviceLabel, readJson, writeJson };
