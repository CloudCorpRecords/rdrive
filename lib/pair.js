// Signing in a new device from one that's already signed in. Two ways, both short-lived and single-use:
// 1. Link / QR code: a signed-in device makes a one-time link; opening it signs the new device in.
// 2. Approve a code: the new device shows a short code; a signed-in device types it in to let it in.
// State is in memory only, so a restart simply cancels anything in flight.
const crypto = require('node:crypto');

const LINK_EXPIRY_MS = 5 * 60 * 1000;
const CODE_EXPIRY_MS = 5 * 60 * 1000;
const MAX_PENDING_CODES = 200; // across everyone; codes are cheap to ask for, so cap what we hold
const MAX_PENDING_PER_IP = 5;
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 32 characters, no 0/O or 1/I lookalikes

class DevicePairing {
  constructor() {
    this.links = new Map(); // token -> { user, meta, expiresAt }
    this.requests = new Map(); // id -> { id, code, cleanCode, ip, status, user, expiresAt }
  }

  _sweep() {
    const now = Date.now();
    for (const [k, v] of this.links) if (v.expiresAt <= now) this.links.delete(k);
    for (const [k, v] of this.requests) if (v.expiresAt <= now) this.requests.delete(k);
  }

  createLinkToken(user, meta = {}) {
    this._sweep();
    const token = crypto.randomBytes(32).toString('hex');
    this.links.set(token, { user, meta, expiresAt: Date.now() + LINK_EXPIRY_MS });
    return token;
  }

  claimLinkToken(token) {
    this._sweep();
    if (!token || typeof token !== 'string') return null;
    const entry = this.links.get(token);
    if (!entry) return null;
    this.links.delete(token); // single-use
    return { user: entry.user, meta: entry.meta };
  }

  // Returns null when too many codes are already waiting (overall or from this address).
  createCodeRequest(ip = '') {
    this._sweep();
    if (this.requests.size >= MAX_PENDING_CODES) return null;
    let fromIp = 0;
    for (const r of this.requests.values()) if (r.ip === ip && r.status === 'pending') fromIp += 1;
    if (fromIp >= MAX_PENDING_PER_IP) return null;

    let cleanCode;
    do {
      const bytes = crypto.randomBytes(8);
      cleanCode = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join(''); // 256 % 32 == 0: no bias
    } while ([...this.requests.values()].some((r) => r.cleanCode === cleanCode));
    const id = crypto.randomBytes(16).toString('hex');
    const code = `${cleanCode.slice(0, 4)}-${cleanCode.slice(4)}`;
    const expiresAt = Date.now() + CODE_EXPIRY_MS;
    this.requests.set(id, { id, code, cleanCode, ip, status: 'pending', user: null, expiresAt });
    return { id, code, expiresAt, expiresIn: Math.floor(CODE_EXPIRY_MS / 1000) };
  }

  approveCode(rawCode, user) {
    this._sweep();
    if (!rawCode || typeof rawCode !== 'string' || !user) return false;
    const clean = rawCode.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    for (const req of this.requests.values()) {
      if (req.cleanCode === clean && req.status === 'pending') {
        req.status = 'approved';
        req.user = user;
        return true;
      }
    }
    return false;
  }

  // 'pending', 'expired', or 'approved' (once: the request is gone after that).
  checkCodeStatus(id) {
    this._sweep();
    const req = typeof id === 'string' ? this.requests.get(id) : null;
    if (!req) return { status: 'expired' };
    if (req.status === 'approved') {
      this.requests.delete(id);
      return { status: 'approved', user: req.user };
    }
    return { status: 'pending' };
  }
}

module.exports = { DevicePairing, LINK_EXPIRY_MS, CODE_EXPIRY_MS };
