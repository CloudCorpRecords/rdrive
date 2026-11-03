// Share links: expiring, optionally password-protected links to a file, spreadsheet or folder.
const crypto = require('node:crypto');
const path = require('node:path');
const { readJson, writeJson } = require('./auth');
const { HttpError, segments } = require('./files');

const SCRYPT_KEYLEN = 64;
const SHEET_EXTS = new Set(['.rsheet', '.csv', '.tsv']);

function isSheetName(name) {
  return SHEET_EXTS.has(path.extname(String(name || '')).toLowerCase());
}

function isDocName(name) {
  return path.extname(String(name || '')).toLowerCase() === '.rdoc';
}

// Files a share link may let visitors edit in the browser.
function isEditableName(name) {
  return isSheetName(name) || isDocName(name);
}

function normalizeClientPath(p) {
  const segs = segments(p);
  if (!segs.length) throw new HttpError(400, 'Cannot share your entire root drive; pick a file or folder.');
  return '/' + segs.join('/');
}

class Shares {
  constructor(dataDir) {
    this.sharesFile = path.join(dataDir, 'shares.json');
    const loaded = readJson(this.sharesFile, { secret: null, shares: {} });
    this.secret = loaded.secret || crypto.randomBytes(32).toString('hex');
    this.shares = loaded.shares || {};
    this.dummy = this._hashPassword('dummy-share-password');
    this.prune();
  }

  save() {
    writeJson(this.sharesFile, { secret: this.secret, shares: this.shares });
  }

  _hashPassword(password, salt = crypto.randomBytes(16)) {
    const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
    return { salt: salt.toString('hex'), hash: hash.toString('hex') };
  }

  prune() {
    const now = Date.now();
    let changed = false;
    for (const [id, s] of Object.entries(this.shares)) {
      if ((s.expires && s.expires < now) || (s.maxDownloads && (s.downloads || 0) >= s.maxDownloads)) {
        delete this.shares[id];
        changed = true;
      }
    }
    if (changed) this.save();
  }

  create(user, { path: rawPath, expiresInHours = 168, password = '', allowEdit = false, maxDownloads = 0 } = {}) {
    this.prune();
    const clientPath = normalizeClientPath(rawPath);
    const id = crypto.randomBytes(16).toString('base64url');
    const now = Date.now();
    let expires = null;
    if (expiresInHours != null && Number(expiresInHours) > 0) {
      const hours = Math.min(Number(expiresInHours), 24 * 365);
      expires = now + Math.round(hours * 3600 * 1000);
    }
    const cleanPw = typeof password === 'string' ? password.trim() : '';
    const pwData = cleanPw ? this._hashPassword(cleanPw) : {};
    const cleanMaxDl = Number(maxDownloads) > 0 ? Math.floor(Number(maxDownloads)) : null;
    const rec = {
      id,
      user,
      path: clientPath,
      created: now,
      expires,
      maxDownloads: cleanMaxDl,
      downloads: 0,
      views: 0,
      allowEdit: !!allowEdit && isEditableName(clientPath),
      ...pwData,
    };
    this.shares[id] = rec;
    this.save();
    return this._publicRecord(rec);
  }

  recordDownload(id) {
    const s = this.shares[id];
    if (!s) return;
    s.downloads = (s.downloads || 0) + 1;
    this.save();
  }

  recordView(id) {
    const s = this.shares[id];
    if (!s) return;
    s.views = (s.views || 0) + 1;
    this.save();
  }

  list(user, filterPath = null) {
    this.prune();
    const normFilter = filterPath ? normalizeClientPath(filterPath) : null;
    return Object.values(this.shares)
      .filter((s) => s.user === user && (!normFilter || s.path === normFilter))
      .sort((a, b) => b.created - a.created)
      .map((s) => this._publicRecord(s));
  }

  revoke(user, id) {
    const s = this.shares[id];
    if (!s || s.user !== user) return false;
    delete this.shares[id];
    this.save();
    return true;
  }

  get(id) {
    this.prune();
    const s = this.shares[id];
    if (!s) return null;
    if (s.expires && s.expires < Date.now()) {
      delete this.shares[id];
      this.save();
      return null;
    }
    if (s.maxDownloads && (s.downloads || 0) >= s.maxDownloads) {
      delete this.shares[id];
      this.save();
      return null;
    }
    return s;
  }

  verifyPassword(id, password) {
    const s = this.get(id);
    const rec = s && s.hash ? s : this.dummy;
    const expected = Buffer.from(rec.hash, 'hex');
    const actual = crypto.scryptSync(String(password || ''), Buffer.from(rec.salt, 'hex'), SCRYPT_KEYLEN);
    return crypto.timingSafeEqual(expected, actual) && rec !== this.dummy;
  }

  unlockToken(id) {
    const s = this.get(id);
    if (!s || !s.hash) return '';
    return crypto
      .createHmac('sha256', this.secret)
      .update(`${id}:${s.hash}:${s.expires || 0}`)
      .digest('base64url');
  }

  isUnlocked(id, token) {
    const s = this.get(id);
    if (!s) return false;
    if (!s.hash) return true;
    if (!token || typeof token !== 'string') return false;
    const expected = Buffer.from(this.unlockToken(id));
    const actual = Buffer.from(token);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  _publicRecord(s) {
    return {
      id: s.id,
      path: s.path,
      name: path.posix.basename(s.path),
      created: new Date(s.created).toISOString(),
      expires: s.expires ? new Date(s.expires).toISOString() : null,
      maxDownloads: s.maxDownloads || null,
      downloads: s.downloads || 0,
      views: s.views || 0,
      hasPassword: !!s.hash,
      allowEdit: !!s.allowEdit,
      url: `/s/${s.id}`,
    };
  }
}

module.exports = { Shares, isSheetName, isDocName, isEditableName };
