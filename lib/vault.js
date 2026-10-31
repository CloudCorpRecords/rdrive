// Encrypted Private Vault ("Secure Folder") for rdrive.
// Manages master PIN setup, verification, and temporary unlocked session tokens.

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const VAULT_SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes auto-lock
const SCRYPT_KEYLEN = 64;

function hashPin(pin, salt) {
  return crypto.scryptSync(pin, salt, SCRYPT_KEYLEN).toString('hex');
}

class VaultManager {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'vault');
    fs.mkdirSync(this.dir, { recursive: true });
    this.configs = new Map();
    this.unlockedSessions = new Map(); // token -> { user, expiresAt }
  }

  userFile(user) {
    const safeUser = user.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return path.join(this.dir, `${safeUser}.json`);
  }

  loadConfig(user) {
    if (this.configs.has(user)) return this.configs.get(user);
    const file = this.userFile(user);
    try {
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.configs.set(user, data);
        return data;
      }
    } catch {}
    return null;
  }

  async saveConfig(user, cfg) {
    this.configs.set(user, cfg);
    const file = this.userFile(user);
    await fsp.writeFile(file, JSON.stringify(cfg, null, 2), 'utf8');
  }

  hasPin(user) {
    const cfg = this.loadConfig(user);
    return Boolean(cfg && cfg.hash && cfg.salt);
  }

  async setPin(user, pin) {
    const cleanPin = String(pin || '').trim();
    if (cleanPin.length < 4 || cleanPin.length > 32) {
      throw new Error('Vault PIN must be between 4 and 32 characters.');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPin(cleanPin, salt);
    await this.saveConfig(user, {
      salt,
      hash,
      updatedAt: Date.now(),
    });
  }

  unlock(user, pin) {
    const cfg = this.loadConfig(user);
    if (!cfg) throw new Error('Vault PIN is not set up.');
    const testHash = hashPin(String(pin || '').trim(), cfg.salt);
    const ok = crypto.timingSafeEqual(Buffer.from(testHash, 'hex'), Buffer.from(cfg.hash, 'hex'));
    if (!ok) return null;

    const token = crypto.randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + VAULT_SESSION_TTL_MS;
    this.unlockedSessions.set(token, { user, expiresAt });
    return { token, expiresAt };
  }

  lock(token) {
    if (token) this.unlockedSessions.delete(token);
  }

  isUnlocked(user, token) {
    if (!token) return false;
    const session = this.unlockedSessions.get(token);
    if (!session) return false;
    if (session.user !== user) return false;
    if (session.expiresAt < Date.now()) {
      this.unlockedSessions.delete(token);
      return false;
    }
    // Refresh activity on access
    session.expiresAt = Date.now() + VAULT_SESSION_TTL_MS;
    return true;
  }

  isVaultPath(filePath) {
    if (!filePath) return false;
    const norm = '/' + filePath.split('/').filter(Boolean).join('/');
    return norm === '/Vault' || norm.startsWith('/Vault/');
  }
}

module.exports = { VaultManager, VAULT_SESSION_TTL_MS };
