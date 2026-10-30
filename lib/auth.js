// User accounts, password hashing and login sessions.
// Users and sessions are stored as JSON files in the data directory.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
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
  fs.renameSync(tmp, file);
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

class Auth {
  constructor(dataDir) {
    this.usersFile = path.join(dataDir, 'users.json');
    this.sessionsFile = path.join(dataDir, 'sessions.json');
    this.users = readJson(this.usersFile, {});
    // Sessions are keyed by sha256(token) so a leaked sessions.json can't be replayed.
    this.sessions = readJson(this.sessionsFile, {});
    this.failures = new Map();
    // Dummy hash used to keep login timing the same for unknown usernames.
    this.dummy = hashPassword('dummy-password');
    this.pruneSessions();
  }

  hasUsers() {
    return Object.keys(this.users).length > 0;
  }

  listUsers() {
    return Object.keys(this.users);
  }

  validateNewCredentials(username, password) {
    if (!USERNAME_RE.test(username || '')) {
      return 'Username must be 1-32 characters: letters, numbers, dot, dash or underscore.';
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
      return `Password must be at least ${MIN_PASSWORD_LEN} characters.`;
    }
    return null;
  }

  addUser(username, password) {
    const problem = this.validateNewCredentials(username, password);
    if (problem) throw new Error(problem);
    if (this.users[username]) throw new Error(`User "${username}" already exists.`);
    this.users[username] = { ...hashPassword(password), created: new Date().toISOString() };
    writeJson(this.usersFile, this.users);
  }

  setPassword(username, password) {
    if (!this.users[username]) throw new Error(`No user "${username}".`);
    const problem = this.validateNewCredentials(username, password);
    if (problem) throw new Error(problem);
    this.users[username] = { ...this.users[username], ...hashPassword(password) };
    writeJson(this.usersFile, this.users);
    this.revokeUserSessions(username);
  }

  deleteUser(username) {
    if (!this.users[username]) throw new Error(`No user "${username}".`);
    delete this.users[username];
    writeJson(this.usersFile, this.users);
    this.revokeUserSessions(username);
  }

  verifyPassword(username, password) {
    const user = Object.hasOwn(this.users, username) ? this.users[username] : null;
    const rec = user || this.dummy;
    const expected = Buffer.from(rec.hash, 'hex');
    const actual = crypto.scryptSync(String(password), Buffer.from(rec.salt, 'hex'), SCRYPT_KEYLEN);
    return crypto.timingSafeEqual(expected, actual) && !!user;
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

  login(username, password, ip) {
    if (this.lockedFor(ip)) return null;
    if (!this.verifyPassword(String(username || ''), password)) {
      this.recordFailure(ip);
      return null;
    }
    this.failures.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions[sha256(token)] = { user: username, expires: Date.now() + SESSION_TTL_MS };
    writeJson(this.sessionsFile, this.sessions);
    return token;
  }

  logout(token) {
    if (!token) return;
    delete this.sessions[sha256(token)];
    writeJson(this.sessionsFile, this.sessions);
  }

  userForToken(token) {
    if (!token) return null;
    const s = this.sessions[sha256(token)];
    if (!s) return null;
    if (s.expires < Date.now() || !this.users[s.user]) {
      this.logout(token);
      return null;
    }
    return s.user;
  }

  revokeUserSessions(username) {
    for (const [k, s] of Object.entries(this.sessions)) {
      if (s.user === username) delete this.sessions[k];
    }
    writeJson(this.sessionsFile, this.sessions);
  }

  pruneSessions() {
    const now = Date.now();
    let changed = false;
    for (const [k, s] of Object.entries(this.sessions)) {
      if (s.expires < now) {
        delete this.sessions[k];
        changed = true;
      }
    }
    if (changed) writeJson(this.sessionsFile, this.sessions);
  }
}

module.exports = { Auth, SESSION_TTL_MS };
